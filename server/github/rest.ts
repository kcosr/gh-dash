import { checkToken, defaultSleep, GitHubError, limitError, resetAt, RetryableError, withRetries } from './transport';

const API = 'https://api.github.com';
// Newest version as of 2026-09 (GET /versions); its breaking changes don't touch the endpoints used here.
const API_VERSION = '2026-03-10';
const JSON_TYPE = 'application/vnd.github+json';
const SHA_TYPE = 'application/vnd.github.sha';
/** Safety net against a runaway Link chain (GitHub's 3000-file lists need at most 30 pages). */
const MAX_PAGES = 40;

export interface RestRateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface RestClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Fewer than the sync client: a person is waiting for the response. */
  maxAttempts?: number;
  /** Refuse to spend below this many remaining requests (REST has its own hourly bucket, separate from GraphQL points). */
  minRemaining?: number;
  /** Secondary limits asking for a longer wait fail as 'rate-limit' rather than holding the request open. */
  maxRetryWaitMs?: number;
  timeoutMs?: number;
}

type Query = Record<string, string | number>;

export interface CallOptions {
  query?: Query;
  /** Aborts the call, including its retries (e.g. an overall deadline for building one diff). */
  signal?: AbortSignal;
}

interface Fetched<T> {
  /** null for a 304 Not Modified. */
  body: T | null;
  /** Link rel="next", for paginated resources. */
  next: string | null;
  etag: string | null;
}

export interface RawFile {
  bytes: Uint8Array;
  /** The body exceeded maxBytes; `bytes` holds only the first part. */
  tooLarge: boolean;
  /** Directories, submodules and symlinks outside the repo come back as JSON descriptions, not content. */
  isFile: boolean;
}

/**
 * Read-only GitHub REST client. Every request is a GET to api.github.com: there is deliberately no way to pass
 * a method or body, and pagination links pointing anywhere else are refused so the token never leaves GitHub.
 */
export class GitHubRestClient {
  requests = 0;
  rateLimit: RestRateLimit | null = null;
  private readonly opts: Required<RestClientOptions>;

  constructor(opts: RestClientOptions) {
    this.opts = {
      fetchImpl: fetch,
      sleep: defaultSleep,
      maxAttempts: 3,
      minRemaining: 100,
      maxRetryWaitMs: 10_000,
      timeoutMs: 30_000,
      ...opts,
    };
  }

  async json<T>(path: string, opts: CallOptions = {}): Promise<T> {
    return (await this.get(url(path, opts.query), JSON_TYPE, readJson<T>, opts)).body!;
  }

  /**
   * A JSON resource with its ETag. Given the ETag of an earlier response, the request is conditional and an
   * unchanged resource answers 304 (null here), which doesn't count against the rate limit.
   */
  async versioned<T>(path: string, etag: string | null = null, opts: CallOptions = {}): Promise<{ body: T; etag: string | null } | null> {
    const res = await this.get(url(path, opts.query), JSON_TYPE, readJson<T>, opts, etag ?? undefined);
    return res.body === null ? null : { body: res.body, etag: res.etag };
  }

  /** Follows Link rel="next" until there is none or `limit` items were collected (serially, as GitHub asks). */
  async paginate<P, I>(path: string, items: (page: P) => I[], limit: number, opts: CallOptions = {}): Promise<{ first: P; items: I[] }> {
    let next: string | null = url(path, opts.query);
    let first: P | undefined;
    const out: I[] = [];
    for (let pages = 0; next && out.length < limit && pages < MAX_PAGES; pages++) {
      const page: Fetched<P> = await this.get(next, JSON_TYPE, readJson<P>, opts);
      first ??= page.body!;
      out.push(...items(page.body!));
      next = page.next;
    }
    return { first: first!, items: out.slice(0, limit) };
  }

  /**
   * The commit a ref points to. With `known` (the SHA we expect) the request is conditional: an unchanged ref
   * answers 304, which doesn't count against the rate limit.
   */
  async sha(path: string, known?: string, opts: CallOptions = {}): Promise<string> {
    // This media type's ETag is the quoted SHA.
    const { body } = await this.get(url(path), SHA_TYPE, readText, opts, known && `"${known}"`);
    return body === null ? known! : body.trim();
  }

  /** Raw file contents, reading at most `maxBytes` of the body. */
  async raw(path: string, maxBytes: number, opts: CallOptions = {}): Promise<RawFile> {
    return (await this.get(url(path, opts.query), 'application/vnd.github.raw+json', (res) => readLimited(res, maxBytes), opts)).body!;
  }

  /** `etag`: sent verbatim as If-None-Match (including any W/ prefix). */
  private async get<T>(target: string, accept: string, read: (res: Response) => Promise<T>, opts: CallOptions, etag?: string): Promise<Fetched<T>> {
    if (!target.startsWith(`${API}/`)) throw new GitHubError('http', `Refusing to send the GitHub token outside ${API}: ${target.slice(0, 100)}`);
    checkToken(this.opts.token);
    const rl = this.rateLimit;
    if (rl && rl.remaining < this.opts.minRemaining && Date.parse(rl.resetAt) > Date.now()) {
      throw new GitHubError('rate-limit', `GitHub REST rate limit nearly exhausted (${rl.remaining} left, resets ${rl.resetAt})`, { resetAt: rl.resetAt });
    }
    return withRetries(this.opts, () => {
      if (opts.signal?.aborted) throw new GitHubError('transient', `Gave up waiting for GitHub (${new URL(target).pathname})`);
      return this.attempt(target, accept, read, etag, opts.signal);
    });
  }

  private async attempt<T>(
    target: string,
    accept: string,
    read: (res: Response) => Promise<T>,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Fetched<T>> {
    this.requests++;
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      res = await this.opts.fetchImpl(target, {
        method: 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.opts.token}`,
          'User-Agent': 'gh-dash',
          'X-GitHub-Api-Version': API_VERSION,
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw new RetryableError(`network error: ${(err as Error).message}`, null);
    }
    const path = new URL(target).pathname;
    // A 304's rate-limit headers don't reflect the bucket (and it costs nothing).
    if (res.status === 304) return { body: null, next: null, etag: etag ?? null };
    this.trackRateLimit(res);
    if (res.status === 401) throw new GitHubError('auth', 'GitHub rejected the token (401)', { status: 401 });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 403 || res.status === 429) {
        throw limitError(res, text, 'GitHub REST') ?? new GitHubError('http', `GitHub returned ${res.status} for ${path}: ${message(text)}`, { status: res.status });
      }
      if (res.status >= 500) throw new RetryableError(`GitHub returned ${res.status} for ${path}`, null);
      const kind = res.status === 404 ? 'not-found' : 'http';
      throw new GitHubError(kind, `GitHub returned ${res.status} for ${path}: ${message(text)}`, { status: res.status });
    }
    let body: T;
    try {
      body = await read(res);
    } catch (err) {
      if (err instanceof GitHubError || err instanceof RetryableError) throw err;
      throw new RetryableError(`reading the response for ${path} failed: ${(err as Error).message}`, null);
    }
    return { body, next: nextLink(res.headers.get('link')), etag: res.headers.get('etag') };
  }

  private trackRateLimit(res: Response): void {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = resetAt(res);
    if (limit && remaining !== null && reset) this.rateLimit = { limit, remaining: Number(remaining), resetAt: reset };
  }
}

function url(path: string, query: Query = {}): string {
  if (!path.startsWith('/')) throw new Error(`GitHub API path must start with /: ${path}`);
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  return `${API}${path}${qs ? `?${qs}` : ''}`;
}

function nextLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1] ?? null;
}

/** GitHub's JSON error `message`, else the start of the body. */
function message(text: string): string {
  try {
    return String((JSON.parse(text) as { message?: unknown }).message ?? text).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RetryableError('invalid JSON from GitHub', null);
  }
}

const readText = (res: Response) => res.text();

async function readLimited(res: Response, maxBytes: number): Promise<RawFile> {
  const isFile = !/^application\/json\b/i.test(res.headers.get('content-type') ?? '');
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    return { bytes: new Uint8Array(), tooLarge: true, isFile };
  }
  if (!res.body) return { bytes: new Uint8Array(), tooLarge: false, isFile };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { bytes: new Uint8Array(), tooLarge: true, isFile };
    }
  }
  return { bytes: Buffer.concat(chunks), tooLarge: false, isFile };
}
