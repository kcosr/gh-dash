// Shared by the GraphQL client (sync) and the REST client (diffs): errors, token checks, rate-limit
// classification and retries with backoff. The provider-neutral helpers (backoff, redaction) are in provider/transport.

import { SourceError, type SourceErrorKind, type SourceErrorOptions } from '../provider/errors';
import { backoffMs, redact, RetryableError } from '../provider/transport';
import type { GqlError } from './types';

export type GitHubErrorKind = SourceErrorKind;

/** A failed GitHub request: a SourceError, so provider-neutral code handles it by kind. */
export class GitHubError extends SourceError {
  /** A GraphQL response's errors, each with the path of the field that failed; empty for other failures. */
  readonly errors: GqlError[];
  constructor(kind: GitHubErrorKind, message: string, opts: SourceErrorOptions & { errors?: GqlError[] } = {}) {
    super(kind, message, opts);
    this.name = 'GitHubError';
    this.errors = opts.errors ?? [];
  }
}

// Checked before any request (not left to fetch) because fetch's header errors quote the offending value.
export function checkToken(token: string): void {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new GitHubError('auth', 'The GitHub token contains characters that are not allowed in an HTTP header; check GITHUB_TOKEN');
  }
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
  const clean = (err: GitHubError) =>
    new GitHubError(err.kind, redact(opts.token, err.message), { status: err.status, resetAt: err.resetAt, errors: err.errors, access: err.access });
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
