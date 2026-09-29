// Shared by the GraphQL client and the REST client: the instance's URL, the token, error classification, rate-limit
// readings and retries with backoff.

import { SourceError, type SourceErrorKind, type SourceErrorOptions } from '../provider/errors';
import { backoffMs, defaultSleep, redact, RetryableError } from '../provider/transport';
import type { RateLimitInfo } from '../provider/types';

export interface GitLabOptions {
  /** The instance's URL, including any relative root: "https://gitlab.example.com" or "https://example.com/gitlab". */
  baseUrl: string;
  /** A personal (or group/project) access token with the read_api scope. */
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per request (default: the client's own, e.g. 5 for the sync). */
  maxAttempts?: number;
  /**
   * A 429 asking for a longer wait fails as 'rate-limit' instead of sleeping (default: the client's own, e.g. 120 s for
   * the sync). A client a person waits on (the Add dialog) passes a short one.
   */
  maxRetryWaitMs?: number;
}

/** A failed GitLab request: a SourceError, so provider-neutral code handles it by kind. */
export class GitLabError extends SourceError {
  constructor(kind: SourceErrorKind, message: string, opts: SourceErrorOptions = {}) {
    super(kind, message, opts);
    this.name = 'GitLabError';
  }
}

/** A failure worth retrying, with the HTTP status behind it (a 429 that outlasts the retries is a rate limit). */
class Retry extends RetryableError {
  readonly status: number | null;
  constructor(message: string, retryAfterMs: number | null, status: number | null = null) {
    super(message, retryAfterMs);
    this.status = status;
  }
}

/** Per-request cap; GitLab itself gives up on a GraphQL query after 30 s. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface TransportDefaults {
  maxAttempts: number;
  /** A 429 asking for a longer wait fails as 'rate-limit' instead of sleeping. */
  maxRetryWaitMs: number;
}

export interface SendOptions {
  method?: 'GET' | 'POST';
  /** JSON request body (GraphQL only). */
  body?: string;
  /** Aborts the request and stops further retries (e.g. the diff service's build deadline). */
  signal?: AbortSignal;
}

/**
 * The instance URL without a trailing slash. Credentials, queries and fragments are refused: the API paths are
 * appended to it, and a URL carrying its own secrets has no business next to the token. Errors don't quote the URL,
 * since a malformed one may still hold a password.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Invalid GitLab URL: expected something like https://gitlab.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('GitLab URL must start with https:// or http://');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('GitLab URL must not contain credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Every request goes to the configured instance's /api/ with the token as a Bearer header (never PRIVATE-TOKEN: fetch
 * drops Authorization on a cross-origin redirect but would forward a custom header). Redirects aren't followed at all,
 * and URLs outside the API root are refused, so the token can't leave the instance.
 */
export class GitLabTransport {
  requests = 0;
  /** Only set when the instance has throttling enabled (self-managed defaults send no RateLimit-* headers). */
  rateLimit: RateLimitInfo | null = null;
  readonly base: string;
  private readonly apiRoot: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxRetryWaitMs: number;

  constructor(opts: GitLabOptions, defaults: TransportDefaults) {
    this.base = normalizeBaseUrl(opts.baseUrl);
    this.apiRoot = `${this.base}/api/`;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? defaults.maxAttempts;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? defaults.maxRetryWaitMs;
  }

  /** `path` below the instance URL, e.g. "/api/v4/projects/1". */
  url(path: string): string {
    if (!path.startsWith('/api/')) throw new Error(`GitLab API path must start with /api/: ${path}`);
    return `${this.base}${path}`;
  }

  /**
   * Sends one request, retrying network failures, 5xx and short 429s. `read` turns a 2xx response into the result; it
   * may throw a RetryableError (a body that didn't parse, a GraphQL timeout) to retry. Every error that escapes is
   * redacted.
   */
  async send<T>(target: string, read: (res: Response) => Promise<T>, opts: SendOptions = {}): Promise<T> {
    const url = this.inside(target);
    checkToken(this.token);
    const what = url.pathname;
    const gaveUp = () => new GitLabError('transient', `Gave up waiting for GitLab (${what})`);
    for (let n = 1; ; n++) {
      if (opts.signal?.aborted) throw gaveUp();
      try {
        return await this.attempt(url.href, what, read, opts);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err instanceof GitLabError ? this.clean(err) : err;
        if (opts.signal?.aborted) throw gaveUp();
        if (err.retryAfterMs !== null && err.retryAfterMs > this.maxRetryWaitMs) {
          const resumeAt = new Date(Date.now() + err.retryAfterMs).toISOString();
          throw this.clean(new GitLabError('rate-limit', `GitLab ${err.message}; retry after ${resumeAt}`, { status: 429, resetAt: resumeAt }));
        }
        if (n >= this.maxAttempts) {
          // Still throttled after every retry: stop (the sync stops the run) rather than report a passing hiccup.
          if (err instanceof Retry && err.status === 429) {
            const resetAt = new Date(Date.now() + (err.retryAfterMs ?? 0)).toISOString();
            throw this.clean(new GitLabError('rate-limit', `GitLab ${err.message}; retry after ${resetAt}`, { status: 429, resetAt }));
          }
          throw this.clean(new GitLabError('transient', err.message));
        }
        await this.sleep(err.retryAfterMs ?? backoffMs(n));
      }
    }
  }

  /**
   * `target` as the URL fetch will actually request, if that is under the API root. Checked on the parsed URL, not the
   * string: dot segments ("..", "%2E%2E") are resolved by the URL parser, so "…/api/v4/%2E%2E/%2E%2E/x" would
   * otherwise pass a prefix check and then leave a relative-root install's API.
   */
  private inside(target: string): URL {
    let url: URL | null = null;
    try {
      url = new URL(target);
    } catch {
      // Refused below.
    }
    const root = new URL(this.apiRoot);
    if (!url || url.origin !== root.origin || url.username || url.password || !url.pathname.startsWith(root.pathname)) {
      throw new GitLabError('http', `Refusing to send the GitLab token outside ${this.apiRoot}: ${target.slice(0, 100)}`);
    }
    return url;
  }

  /**
   * `text` from a response, safe for an error message: the token masked, then cut to `max` characters. In that order: a
   * token cut in half would no longer match and part of it would survive.
   */
  scrub(text: string, max: number): string {
    return redact(this.token, text).slice(0, max);
  }

  private clean(err: GitLabError): GitLabError {
    return new GitLabError(err.kind, redact(this.token, err.message), { status: err.status, resetAt: err.resetAt, access: err.access });
  }

  private async attempt<T>(target: string, what: string, read: (res: Response) => Promise<T>, opts: SendOptions): Promise<T> {
    this.requests++;
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      res = await this.fetchImpl(target, {
        method: opts.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'gh-dash',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body,
        redirect: 'manual',
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
    } catch (err) {
      throw new RetryableError(`network error: ${(err as Error).message}`, null);
    }
    this.trackRateLimit(res);
    if (!res.ok) throw await failure(res, what, (text) => this.scrub(text, 200));
    try {
      return await read(res);
    } catch (err) {
      if (err instanceof GitLabError || err instanceof RetryableError) throw err;
      throw new RetryableError(`reading the response for ${what} failed: ${(err as Error).message}`, null);
    }
  }

  private trackRateLimit(res: Response): void {
    const limit = res.headers.get('ratelimit-limit');
    const remaining = res.headers.get('ratelimit-remaining');
    if (limit === null || remaining === null) return;
    this.rateLimit = { limit: Number(limit), remaining: Number(remaining), resetAt: rateLimitReset(res) };
  }
}

// Checked before any request (not left to fetch) because fetch's header errors quote the offending value.
function checkToken(token: string): void {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new GitLabError('auth', 'The GitLab token contains characters that are not allowed in an HTTP header');
  }
}

/** RateLimit-Reset is the Unix time the window resets. */
function rateLimitReset(res: Response): string | null {
  const reset = Number(res.headers.get('ratelimit-reset'));
  return reset > 0 ? new Date(reset * 1000).toISOString() : null;
}

/** Retry-After in ms, from delta-seconds or an HTTP date; null when absent or unparsable. */
function retryAfterMs(res: Response): number | null {
  const value = res.headers.get('retry-after');
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * The error a non-2xx response stands for: a GitLabError, or a RetryableError for what may pass. `scrub` makes what
 * the response said safe to quote.
 */
async function failure(res: Response, what: string, scrub: (text: string) => string): Promise<Error> {
  const text = await res.text().catch(() => '');
  const detail = scrub(message(text));
  const status = res.status;
  if (status >= 300 && status < 400) {
    const to = res.headers.get('location') ?? 'elsewhere';
    return new GitLabError('http', `GitLab redirected ${what} to ${scrub(to)}; check the GitLab URL`, { status });
  }
  // Invalid, expired and revoked tokens (GitLab says which in error_description).
  if (status === 401) return new GitLabError('auth', `GitLab rejected the token (401): ${detail}`, { status });
  // A REST 403 is a token problem only when the token lacks a scope; otherwise it is about this resource (say a project
  // whose repository a Guest can't read), which mustn't stop a whole sync. GraphQL answers 403 only for a blocked or
  // deactivated account ("API not accessible for user"): resources it can't show just come back null.
  if (status === 403) {
    if (/insufficient_scope/.test(text)) return new GitLabError('auth', `The GitLab token lacks the read_api scope (403): ${detail}`, { status });
    if (what.endsWith('/api/graphql')) return new GitLabError('auth', `GitLab refused the account (403): ${detail}`, { status });
    return new GitLabError('http', `GitLab returned 403 for ${what}: ${detail}`, { status });
  }
  if (status === 429) {
    const wait = retryAfterMs(res);
    if (wait !== null) return new Retry(`rate limited (429) for ${what}`, wait, status);
    const resetAt = rateLimitReset(res) ?? new Date(Date.now() + 60_000).toISOString();
    return new GitLabError('rate-limit', `GitLab rate limited ${what} (429); retry after ${resetAt}`, { status, resetAt });
  }
  if (status >= 500) return new Retry(`GitLab returned ${status} for ${what}`, null, status);
  const kind = status === 404 ? 'not-found' : 'http';
  return new GitLabError(kind, `GitLab returned ${status} for ${what}: ${detail}`, { status });
}

/** GitLab's JSON error (REST `message` or OAuth-style `error_description`/`error`, GraphQL `errors`), else the body. */
function message(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown; error_description?: unknown; errors?: { message?: unknown }[] };
    const msg = body.message ?? body.error_description ?? body.error ?? body.errors?.map((e) => e.message).join('; ');
    if (msg !== undefined) return typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch {
    // Not JSON: fall through.
  }
  return text.trim();
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RetryableError('invalid JSON from GitLab', null);
  }
}
