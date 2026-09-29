// In-memory stand-in for a GitLab instance, for tests that must never touch the network.

export type Reply = { status?: number; body?: unknown; text?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> };
export interface FakeRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** Everything the client passed to fetch, e.g. to check `redirect`. */
  init: RequestInit | undefined;
}
export type Handler = Reply | ((req: FakeRequest) => Reply);

/** A relative-root install, so every test also checks that the root is kept in front of /api/. */
export const BASE = 'https://gitlab.example.com/gitlab';

/**
 * Routes are keyed by the path below BASE ("/api/v4/projects/1"), matched with the query string first, then without.
 * Unmatched requests get GitLab's 404. `requests` records every call: REST as path + query, GraphQL as
 * "graphql <OperationName>", so tests can assert what was spent.
 */
export function fakeGitLab(routes: Record<string, Handler> = {}, base = BASE) {
  const requests: string[] = [];
  const calls: FakeRequest[] = [];
  const root = new URL(base).pathname.replace(/\/$/, '');
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    const req: FakeRequest = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body, init };
    calls.push(req);
    const inside = url.origin === new URL(base).origin && url.pathname.startsWith(`${root}/`);
    const path = inside ? url.pathname.slice(root.length) : url.href;
    requests.push(path === '/api/graphql' ? `graphql ${operationName(body)}` : path + url.search);
    const handler = inside ? (routes[path + url.search] ?? routes[path]) : undefined;
    const reply: Reply = !handler ? { status: 404, body: { message: '404 Not Found' } } : typeof handler === 'function' ? handler(req) : handler;
    const payload = reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(payload, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.text === undefined ? 'application/json' : 'text/plain; charset=utf-8', ...reply.headers },
    });
  };
  return { fetchImpl, requests, calls, routes };
}

function operationName(body: unknown): string {
  const query = (body as { query?: string } | null)?.query ?? '';
  return /^\s*query\s+(\w+)/.exec(query)?.[1] ?? '?';
}

/** What an operation returns to make GitLab answer with GraphQL errors (say, a field the schema doesn't have) instead of data. */
export class GraphqlErrors {
  constructor(readonly messages: string[]) {}
}
export const graphqlErrors = (...messages: string[]) => new GraphqlErrors(messages);

/**
 * The GraphQL endpoint's handler: dispatches on the operation name to a function of the variables returning `data`
 * (or graphqlErrors(…)).
 */
export function graphql(ops: Record<string, (vars: Record<string, unknown>) => unknown>): Handler {
  return (req) => {
    const { query, variables } = req.body as { query: string; variables?: Record<string, unknown> };
    const op = ops[operationName({ query })];
    if (!op) return { body: { errors: [{ message: `no fake for ${operationName({ query })}` }] } };
    const result = op(variables ?? {});
    if (result instanceof GraphqlErrors) return { body: { errors: result.messages.map((message) => ({ message })) } };
    return { body: { data: result } };
  };
}

/** One page of an offset-paginated list; `next` is the next page number (GitLab sends an empty header on the last). */
export function page(body: unknown, next: number | null, extra: Record<string, string> = {}): Reply {
  return { body, headers: { 'x-next-page': next === null ? '' : String(next), ...extra } };
}

export const sha = (c: string) => c.repeat(40).slice(0, 40);
