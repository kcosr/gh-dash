// In-memory stand-in for api.github.com, for tests that must never touch the network.

export type Reply = { status?: number; body?: unknown; text?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> };
type Handler = Reply | ((req: { url: URL; headers: Record<string, string>; body: unknown }) => Reply);

export const API = 'https://api.github.com';
const RATE = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '4070908800' };

/**
 * Routes are matched on path + query first, then path alone. Unmatched requests get a 404 like GitHub's.
 * `requests` records every call (URL without origin) so tests can assert what was spent.
 */
export function fakeGitHub(routes: Record<string, Handler> = {}) {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    requests.push(path);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const handler = routes[path] ?? routes[url.pathname];
    const reply: Reply = !handler
      ? { status: 404, body: { message: 'Not Found' } }
      : typeof handler === 'function'
        ? handler({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null })
        : handler;
    const status = reply.status ?? 200;
    const payload = reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(status === 304 ? null : payload, {
      status,
      headers: { 'content-type': reply.text === undefined ? 'application/json; charset=utf-8' : 'application/vnd.github.raw+json', ...RATE, ...reply.headers },
    });
  };
  return { fetchImpl, requests, routes };
}

/** A page of a paginated resource with a Link to the next one. */
export function page(body: unknown, next: string | null): Reply {
  return { body, headers: next ? { link: `<${API}${next}>; rel="next"` } : {} };
}

export const sha = (c: string) => c.repeat(40).slice(0, 40);

export function restFile(i: number, over: Record<string, unknown> = {}) {
  return { filename: `src/f${i}.ts`, status: 'modified', additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-a${i}\n+b${i}`, ...over };
}
