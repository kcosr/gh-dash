import type { GqlRateLimit } from './types';
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
  onRateLimit?: (rl: GqlRateLimit) => void;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: { type?: string; message: string }[];
}

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
    checkToken(this.opts.token);
    const rl = this.rateLimit;
    if (rl && rl.remaining < this.opts.minRemaining && Date.parse(rl.resetAt) > Date.now()) {
      throw new GitHubError('rate-limit', `GraphQL rate limit nearly exhausted (${rl.remaining} left, resets ${rl.resetAt})`, { resetAt: rl.resetAt });
    }
    return withRetries(this.opts, () => this.attempt<T>(query, variables, !!opts.allowNotFound));
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
