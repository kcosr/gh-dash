import { readCapped, type CappedBody } from '../provider/transport';
import { readJson, type GitLabTransport } from './transport';

/** Query parameters; an array repeats its key (GitLab's `iids[]=1&iids[]=2`). */
type Query = Record<string, string | number | boolean | readonly (string | number)[]>;

export interface CallOptions {
  query?: Query;
  /** Aborts the call, including its retries. */
  signal?: AbortSignal;
}

export interface RestPage<T> {
  body: T;
  /** X-Next-Page: the next page's number; null on the last page. */
  nextPage: number | null;
  /** X-Total, when GitLab counted (some endpoints never do, none do beyond 10,000 items). */
  total: number | null;
}

/** Safety net against an X-Next-Page chain that never ends. */
const MAX_PAGES = 100;

/**
 * Read-only client for {base}/api/v4: every request is a GET. Offset pagination follows X-Next-Page, building the next
 * URL here from the page number rather than taking the Link header's, so where the token goes never depends on what
 * the server answered.
 */
export class GitLabRestClient {
  constructor(private readonly transport: GitLabTransport) {}

  async json<T>(path: string, opts: CallOptions = {}): Promise<T> {
    return (await this.page<T>(path, opts)).body;
  }

  /** One page of a paginated resource (`page` and `per_page` go in `opts.query`). */
  page<T>(path: string, opts: CallOptions = {}): Promise<RestPage<T>> {
    const read = async (res: Response) => ({ body: await readJson<T>(res), nextPage: headerInt(res, 'x-next-page') || null, total: headerInt(res, 'x-total') });
    return this.transport.send(this.url(path, opts.query), read, { signal: opts.signal });
  }

  /** Items of a paginated list from page 1 on, until the last page or `limit` items; `total` is page 1's X-Total. */
  async all<T>(path: string, limit: number, opts: CallOptions = {}): Promise<{ items: T[]; total: number | null }> {
    const items: T[] = [];
    let total: number | null = null;
    let page: number | null = 1;
    for (let n = 0; page !== null && items.length < limit && n < MAX_PAGES; n++) {
      const res: RestPage<T[]> = await this.page<T[]>(path, { ...opts, query: { ...opts.query, page } });
      if (n === 0) total = res.total;
      items.push(...res.body);
      page = res.nextPage !== null && res.nextPage > page ? res.nextPage : null;
    }
    return { items: items.slice(0, limit), total };
  }

  /** Raw bytes (a file's contents), reading at most `maxBytes` of the body: GitLab itself sends files of any size. */
  raw(path: string, maxBytes: number, opts: CallOptions = {}): Promise<CappedBody> {
    return this.transport.send(this.url(path, opts.query), (res) => readCapped(res, maxBytes), { signal: opts.signal });
  }

  private url(path: string, query: Query = {}): string {
    if (!path.startsWith('/')) throw new Error(`GitLab API path must start with /: ${path}`);
    const qs = new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]))).toString();
    return this.transport.url(`/api/v4${path}${qs ? `?${qs}` : ''}`);
  }
}

/**
 * A path segment for a GitLab URL: a project's full path ("group/sub/project"), a file path or a ref, as one segment
 * with slashes encoded. Dots are encoded too, as GitLab's docs do ("lib%2Fclass%2Erb"): the API would otherwise take a
 * trailing ".rb" or ".json" for a format suffix. "." and ".." components are refused: once a server or proxy decodes
 * the segment they could climb out of the path they're in.
 */
export function encodeSegment(value: string): string {
  if (value.split('/').some((part) => part === '.' || part === '..')) throw new Error(`GitLab path with a "." or ".." component: ${value.slice(0, 100)}`);
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

/** A non-negative integer header; null when absent or empty (GitLab sends an empty X-Next-Page on the last page). */
function headerInt(res: Response, name: string): number | null {
  const value = res.headers.get(name)?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}
