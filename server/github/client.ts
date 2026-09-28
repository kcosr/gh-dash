import type { GqlRateLimit } from './types';

const ENDPOINT = 'https://api.github.com/graphql';
const REQUEST_TIMEOUT_MS = 60_000;

export type GitHubErrorKind = 'auth' | 'rate-limit' | 'transient' | 'graphql' | 'http';

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  constructor(kind: GitHubErrorKind, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
  }
}

export interface ClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Refuse to spend below this many remaining points (keeps headroom for the UI and other tools). */
  minRemaining?: number;
  onRateLimit?: (rl: GqlRateLimit) => void;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: { type?: string; message: string }[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GitHubClient {
  pointsUsed = 0;
  requests = 0;
  rateLimit: GqlRateLimit | null = null;
  private readonly opts: Required<Omit<ClientOptions, 'onRateLimit'>> & Pick<ClientOptions, 'onRateLimit'>;

  constructor(opts: ClientOptions) {
    this.opts = {
      fetchImpl: fetch,
      sleep: defaultSleep,
      maxAttempts: 5,
      minRemaining: 100,
      ...opts,
    };
  }

  /** `allowNotFound`: return partial data when the only errors are NOT_FOUND (e.g. lookups by number). */
  async query<T extends { rateLimit?: GqlRateLimit }>(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { allowNotFound?: boolean } = {},
  ): Promise<T> {
    if (!/^\s*query\b/.test(query)) throw new Error('Only read-only GraphQL queries are allowed');
    // Checked here (not left to fetch) because fetch's header errors quote the offending value.
    if (!/^[\x21-\x7e]+$/.test(this.opts.token)) {
      throw new GitHubError('auth', 'The GitHub token contains characters that are not allowed in an HTTP header; check GITHUB_TOKEN');
    }
    const rl = this.rateLimit;
    if (rl && rl.remaining < this.opts.minRemaining && Date.parse(rl.resetAt) > Date.now()) {
      throw new GitHubError('rate-limit', `GraphQL rate limit nearly exhausted (${rl.remaining} left, resets ${rl.resetAt})`);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt<T>(query, variables, !!opts.allowNotFound);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err instanceof GitHubError ? new GitHubError(err.kind, this.redact(err.message)) : err;
        if (attempt >= this.opts.maxAttempts) throw new GitHubError('transient', this.redact(err.message));
        await this.opts.sleep(err.retryAfterMs ?? backoffMs(attempt));
      }
    }
  }

  /** Error messages end up in logs and /sync/status: never let the token through. */
  private redact(message: string): string {
    return this.opts.token.length >= 8 ? message.split(this.opts.token).join('[token]') : message;
  }

  private async attempt<T extends { rateLimit?: GqlRateLimit }>(
    query: string,
    variables: Record<string, unknown>,
    allowNotFound: boolean,
  ): Promise<T> {
    this.requests++;
    let res: Response;
    try {
      res = await this.opts.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${this.opts.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'gh-dash',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new RetryableError(`network error: ${(err as Error).message}`, null);
    }

    if (res.status === 401) throw new GitHubError('auth', 'GitHub rejected the token (401)');
    const text = await res.text();
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (/secondary rate limit|abuse/i.test(text) || retryAfter > 0) {
        throw new RetryableError(`secondary rate limit (${res.status})`, retryAfter > 0 ? retryAfter * 1000 : 60_000);
      }
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        throw new GitHubError('rate-limit', `GraphQL rate limit exhausted (resets ${resetHeader(res)})`);
      }
      throw new GitHubError('http', `GitHub returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status >= 500) throw new RetryableError(`GitHub returned ${res.status}`, null);
    if (!res.ok) throw new GitHubError('http', `GitHub returned ${res.status}: ${text.slice(0, 200)}`);

    let body: GqlResponse<T>;
    try {
      body = JSON.parse(text) as GqlResponse<T>;
    } catch {
      throw new RetryableError('invalid JSON from GitHub', null);
    }
    const rl = body.data?.rateLimit;
    if (rl) {
      this.rateLimit = rl;
      this.pointsUsed += rl.cost;
      this.opts.onRateLimit?.(rl);
    }
    const notFoundOnly = !!body.errors?.length && body.errors.every((e) => e.type === 'NOT_FOUND');
    if (body.errors?.length && !(allowNotFound && notFoundOnly && body.data)) {
      const messages = body.errors.map((e) => e.message).join('; ');
      if (body.errors.some((e) => e.type === 'RATE_LIMITED')) throw new GitHubError('rate-limit', messages);
      if (/timeout|something went wrong/i.test(messages)) throw new RetryableError(messages, null);
      throw new GitHubError('graphql', messages);
    }
    if (!body.data) throw new GitHubError('graphql', 'empty GraphQL response');
    return body.data;
  }

}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s … capped at 30s. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

class RetryableError extends Error {
  /** null = use exponential backoff. */
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function resetHeader(res: Response): string {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return reset ? new Date(reset * 1000).toISOString() : 'unknown';
}
