import { RetryableError } from '../github/transport';
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
    return this.transport.send(target, (res) => readData<T>(res), { method: 'POST', body: JSON.stringify({ query, variables }), signal });
  }
}

/** The response's data; any error fails the query (a timeout is retried, since load comes and goes). */
async function readData<T>(res: Response): Promise<T> {
  const body = await readJson<GqlResponse<T>>(res);
  if (body.errors?.length) {
    const messages = body.errors.map((e) => (e.path ? `${e.message} (at ${e.path.join('.')})` : e.message)).join('; ');
    if (/timed out|timeout/i.test(messages)) throw new RetryableError(messages, null);
    throw new GitLabError('graphql', messages.slice(0, 500));
  }
  if (!body.data) throw new GitLabError('graphql', 'empty GraphQL response');
  return body.data;
}
