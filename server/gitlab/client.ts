import { RetryableError } from '../provider/transport';
import { GitLabError, readJson, type GitLabTransport } from './transport';

/** GitLab refuses longer query documents. */
export const MAX_QUERY_CHARS = 10_000;

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

/** Read-only client for {base}/api/graphql: queries only, never mutations. */
export class GitLabClient {
  constructor(private readonly transport: GitLabTransport) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!/^\s*query\b/.test(query)) throw new Error('Only read-only GraphQL queries are allowed');
    if (query.length > MAX_QUERY_CHARS) throw new Error(`GraphQL query of ${query.length} characters exceeds GitLab's ${MAX_QUERY_CHARS}`);
    const target = this.transport.url('/api/graphql');
    const read = (res: Response) => readData<T>(res, (text) => this.transport.scrub(text, 500));
    return this.transport.send(target, read, { method: 'POST', body: JSON.stringify({ query, variables }), signal });
  }
}

/**
 * The response's data; any error fails the query (a timeout is retried, since load comes and goes). `scrub` makes
 * GitLab's messages safe to quote.
 */
async function readData<T>(res: Response, scrub: (text: string) => string): Promise<T> {
  const body = await readJson<GqlResponse<T>>(res);
  if (body.errors?.length) {
    const messages = body.errors.map((e) => (e.path ? `${e.message} (at ${e.path.join('.')})` : e.message)).join('; ');
    if (/timed out|timeout/i.test(messages)) throw new RetryableError(scrub(messages), null);
    throw new GitLabError('graphql', scrub(messages));
  }
  if (!body.data) throw new GitLabError('graphql', 'empty GraphQL response');
  return body.data;
}
