// Shared by the GraphQL client (sync) and the REST client (diffs): errors, token checks, rate-limit
// classification and retries with backoff.

export type GitHubErrorKind = 'auth' | 'rate-limit' | 'transient' | 'graphql' | 'http' | 'not-found';

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  /** HTTP status GitHub answered with, when the error came from a response. */
  readonly status: number | null;
  /** For 'rate-limit': when requests may resume (ISO), if known. */
  readonly resetAt: string | null;
  constructor(kind: GitHubErrorKind, message: string, opts: { status?: number | null; resetAt?: string | null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.resetAt = opts.resetAt ?? null;
  }
}

export class RetryableError extends Error {
  /** null = use exponential backoff. */
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s … capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

// Checked before any request (not left to fetch) because fetch's header errors quote the offending value.
export function checkToken(token: string): void {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new GitHubError('auth', 'The GitHub token contains characters that are not allowed in an HTTP header; check GITHUB_TOKEN');
  }
}

/** Error messages end up in logs, /sync/status and API errors: never let the token through. */
export function redact(token: string, message: string): string {
  return token.length >= 8 ? message.split(token).join('[token]') : message;
}

export function resetAt(res: Response): string | null {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return reset ? new Date(reset * 1000).toISOString() : null;
}

/**
 * Classifies a 403/429: secondary limits (Retry-After or GitHub's wording) are retryable, an exhausted
 * primary limit fails fast, and so does any other 429 (GitHub asks for at least a minute's wait then).
 * null for a 403 that is neither (a plain permission error).
 */
export function limitError(res: Response, text: string, api: string): Error | null {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (/secondary rate limit|abuse/i.test(text) || retryAfter > 0) {
    return new RetryableError(`secondary rate limit (${res.status})`, retryAfter > 0 ? retryAfter * 1000 : 60_000);
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = resetAt(res);
    return new GitHubError('rate-limit', `${api} rate limit exhausted (resets ${reset ?? 'unknown'})`, { status: res.status, resetAt: reset });
  }
  if (res.status === 429) {
    const resume = new Date(Date.now() + 60_000).toISOString();
    return new GitHubError('rate-limit', `${api} rate limited (429); retry after ${resume}`, { status: 429, resetAt: resume });
  }
  return null;
}

export interface RetryOptions {
  token: string;
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
  /** A secondary limit asking for a longer wait fails as 'rate-limit' instead of sleeping. */
  maxRetryWaitMs?: number;
}

/** Runs `attempt` until it succeeds, retrying RetryableErrors; every error that escapes is redacted. */
export async function withRetries<T>(opts: RetryOptions, attempt: () => Promise<T>): Promise<T> {
  const clean = (err: GitHubError) => new GitHubError(err.kind, redact(opts.token, err.message), { status: err.status, resetAt: err.resetAt });
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err instanceof GitHubError ? clean(err) : err;
      if (err.retryAfterMs !== null && err.retryAfterMs > (opts.maxRetryWaitMs ?? Infinity)) {
        const resumeAt = new Date(Date.now() + err.retryAfterMs).toISOString();
        throw new GitHubError('rate-limit', `GitHub ${err.message}; retry after ${resumeAt}`, { resetAt: resumeAt });
      }
      if (n >= opts.maxAttempts) throw clean(new GitHubError('transient', err.message));
      await opts.sleep(err.retryAfterMs ?? backoffMs(n));
    }
  }
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
