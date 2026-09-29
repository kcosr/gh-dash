import type { GqlError, GqlRateLimit } from './types';
import { checkToken, defaultSleep, GitHubError, limitError, RetryableError, withRetries } from './transport';

export { GitHubError, type GitHubErrorKind } from './transport';

const ENDPOINT = 'https://api.github.com/graphql';
const REQUEST_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Refuse to spend below this many remaining points (keeps headroom for the UI and other tools). */
  minRemaining?: number;
  /** Secondary limits asking for a longer wait fail as 'rate-limit' instead of sleeping (default: always wait). */
  maxRetryWaitMs?: number;
  onRateLimit?: (rl: GqlRateLimit) => void;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: GqlError[];
}

/** Error types a partial response may carry: the field is null, the rest of the data is good. */
const NOT_FOUND = new Set(['NOT_FOUND']);
const PARTIAL = new Set(['NOT_FOUND', 'FORBIDDEN']);
const NONE = new Set<string>();

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
      maxRetryWaitMs: Infinity,
      ...opts,
    };
  }

  /**
   * `allowNotFound`: return partial data when the only errors are NOT_FOUND (e.g. lookups by number).
   * `signal`: the caller's deadline; it aborts the request in flight and stops further retries.
   * Errors: every GraphQL error NOT_FOUND is kind 'not-found', any FORBIDDEN is 'forbidden' (with the errors attached).
   */
  async query<T extends { rateLimit?: GqlRateLimit }>(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { allowNotFound?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    return (await this.request<T>(query, variables, opts.allowNotFound ? NOT_FOUND : NONE, opts.signal)).data;
  }

  /**
   * Like `query`, but a field the token can't see (NOT_FOUND) or may not read (FORBIDDEN) comes back null with its
   * error, and the rest of the data is returned: one inaccessible repo doesn't sink a batch. Anything else throws,
   * except errors of any kind under an `optional` top-level field (a nice-to-have, like a search count).
   */
  async queryPartial<T extends { rateLimit?: GqlRateLimit }>(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; optional?: string[] } = {},
  ): Promise<{ data: T; errors: GqlError[] }> {
    return this.request<T>(query, variables, PARTIAL, opts.signal, opts.optional ?? []);
  }

  private async request<T extends { rateLimit?: GqlRateLimit }>(
    query: string,
    variables: Record<string, unknown>,
    tolerated: Set<string>,
    signal: AbortSignal | undefined,
    optional: string[] = [],
  ): Promise<{ data: T; errors: GqlError[] }> {
    if (!/^\s*query\b/.test(query)) throw new Error('Only read-only GraphQL queries are allowed');
    checkToken(this.opts.token);
    const rl = this.rateLimit;
    if (rl && rl.remaining < this.opts.minRemaining && Date.parse(rl.resetAt) > Date.now()) {
      throw new GitHubError('rate-limit', `GraphQL rate limit nearly exhausted (${rl.remaining} left, resets ${rl.resetAt})`, { resetAt: rl.resetAt });
    }
    return withRetries(this.opts, () => {
      if (signal?.aborted) throw new GitHubError('transient', 'Gave up waiting for GitHub (GraphQL)');
      return this.attempt<T>(query, variables, tolerated, optional, signal);
    });
  }

  private async attempt<T extends { rateLimit?: GqlRateLimit }>(
    query: string,
    variables: Record<string, unknown>,
    tolerated: Set<string>,
    optional: string[],
    signal: AbortSignal | undefined,
  ): Promise<{ data: T; errors: GqlError[] }> {
    this.requests++;
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      res = await this.opts.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${this.opts.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'gh-dash',
        },
        body: JSON.stringify({ query, variables }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw new RetryableError(`network error: ${(err as Error).message}`, null);
    }

    if (res.status === 401) throw new GitHubError('auth', 'GitHub rejected the token (401)', { status: 401 });
    const text = await res.text();
    if (res.status === 403 || res.status === 429) {
      throw limitError(res, text, 'GraphQL') ?? new GitHubError('http', `GitHub returned ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
    }
    if (res.status >= 500) throw new RetryableError(`GitHub returned ${res.status}`, null);
    if (!res.ok) throw new GitHubError('http', `GitHub returned ${res.status}: ${text.slice(0, 200)}`, { status: res.status });

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
    const errors = body.errors ?? [];
    const messages = errors.map((e) => e.message).join('; ');
    // A rate limit stops the request wherever it is reported, optional fields included.
    if (errors.some((e) => e.type === 'RATE_LIMITED')) throw new GitHubError('rate-limit', messages, { errors });
    const ok = (e: GqlError) => (e.type !== undefined && tolerated.has(e.type)) || (e.path !== undefined && optional.includes(String(e.path[0])));
    if (errors.length && !(body.data && errors.every(ok))) {
      if (/timeout|something went wrong/i.test(messages)) throw new RetryableError(messages, null);
      const kind = errors.every((e) => e.type === 'NOT_FOUND') ? 'not-found' : errors.some((e) => e.type === 'FORBIDDEN') ? 'forbidden' : 'graphql';
      throw new GitHubError(kind, messages, { errors });
    }
    if (!body.data) throw new GitHubError('graphql', 'empty GraphQL response');
    return { data: body.data, errors };
  }
}
