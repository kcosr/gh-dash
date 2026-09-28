import { describe, expect, it } from 'vitest';
import { GitHubRestClient } from './rest';
import { GitHubError } from './transport';

const API = 'https://api.github.com';
const RL = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '4070908800' };
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...RL, ...headers } });

function client(responses: ((url: string) => Response)[], opts: { token?: string; minRemaining?: number } = {}) {
  const sleeps: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const c = new GitHubRestClient({
    token: opts.token ?? 't0ken',
    minRemaining: opts.minRemaining,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init! });
      return responses[Math.min(calls.length - 1, responses.length - 1)]!(url);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, sleeps, calls };
}

describe('GitHubRestClient', () => {
  it('only ever sends GETs to api.github.com with the API version and token', async () => {
    const { c, calls } = client([
      () => json({ ok: 1 }),
      () => json([1], { link: `<${API}/repositories/1/items?page=2>; rel="next"` }),
      () => json([2]),
      () => new Response('a'.repeat(40), { headers: RL }),
      () => new Response('text', { headers: { 'content-type': 'application/vnd.github.raw+json' } }),
    ]);
    await c.json('/repos/o/r/pulls/1');
    await c.paginate<number[], number>('/repos/o/r/items', (p) => p, 10, { query: { per_page: 100 } });
    await c.sha('/repos/o/r/commits/pull/1/head');
    await c.raw('/repos/o/r/contents/a%20b.txt', 100, { query: { ref: 'abc1234' } });
    expect(calls.map((x) => x.url)).toEqual([
      `${API}/repos/o/r/pulls/1`,
      `${API}/repos/o/r/items?per_page=100`,
      `${API}/repositories/1/items?page=2`,
      `${API}/repos/o/r/commits/pull/1/head`,
      `${API}/repos/o/r/contents/a%20b.txt?ref=abc1234`,
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.headers).toMatchObject({ Authorization: 'Bearer t0ken', 'User-Agent': 'gh-dash', 'X-GitHub-Api-Version': '2026-03-10' });
    }
    expect(calls.map((x) => (x.init.headers as Record<string, string>).Accept)).toEqual([
      'application/vnd.github+json',
      'application/vnd.github+json',
      'application/vnd.github+json',
      'application/vnd.github.sha',
      'application/vnd.github.raw+json',
    ]);
  });

  it('refuses to follow a pagination link off GitHub (the token would go with it)', async () => {
    const { c, calls } = client([() => json([1], { link: '<https://evil.example/steal?page=2>; rel="next"' })]);
    await expect(c.paginate<number[], number>('/repos/o/r/items', (p) => p, 10)).rejects.toThrow(/Refusing/);
    expect(calls).toHaveLength(1);
  });

  it('follows Link rel="next" and stops at the item limit', async () => {
    const page = (n: number, next: boolean) => () =>
      json([n * 10 + 1, n * 10 + 2], next ? { link: `<${API}/x?page=${n + 1}>; rel="next", <${API}/x?page=9>; rel="last"` } : {});
    const all = client([page(1, true), page(2, true), page(3, false)]);
    expect((await all.c.paginate<number[], number>('/x', (p) => p, 100)).items).toEqual([11, 12, 21, 22, 31, 32]);
    const capped = client([page(1, true), page(2, true), page(3, false)]);
    const res = await capped.c.paginate<number[], number>('/x', (p) => p, 3);
    expect(res).toEqual({ first: [11, 12], items: [11, 12, 21] });
    expect(capped.calls).toHaveLength(2);
    // A Link chain that never ends stops at a hard page cap.
    const endless = client([() => json([1], { link: `<${API}/x?page=next>; rel="next"` })]);
    expect((await endless.c.paginate<number[], number>('/x', (p) => p, 10_000)).items).toHaveLength(40);
    expect(endless.calls).toHaveLength(40);
  });

  it('stops retrying once the caller gives up', async () => {
    const ctrl = new AbortController();
    const { c, calls } = client([
      () => {
        ctrl.abort();
        return new Response('', { status: 502 });
      },
    ]);
    const err = await c.json('/a', { signal: ctrl.signal }).catch((e: GitHubError) => e);
    expect(err).toMatchObject({ kind: 'transient', message: expect.stringContaining('Gave up') });
    expect(calls).toHaveLength(1);
  });

  it('tracks the REST rate limit from headers and keeps headroom', async () => {
    const { c, calls } = client([() => json({}, { 'x-ratelimit-remaining': '50' })], { minRemaining: 100 });
    await c.json('/a');
    expect(c.rateLimit).toEqual({ limit: 5000, remaining: 50, resetAt: '2099-01-01T00:00:00.000Z' });
    await expect(c.json('/a')).rejects.toMatchObject({ kind: 'rate-limit', resetAt: '2099-01-01T00:00:00.000Z' });
    expect(calls).toHaveLength(1);
  });

  it('fails fast on an exhausted primary limit, with the reset time', async () => {
    for (const status of [403, 429]) {
      const { c, sleeps } = client([() => json({ message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }, status)]);
      const err = await c.json('/a').catch((e: GitHubError) => e);
      expect(err).toMatchObject({ kind: 'rate-limit', status, resetAt: '2099-01-01T00:00:00.000Z' });
      expect(sleeps).toEqual([]);
    }
    // A bare 429 (no rate-limit headers) is still a rate limit, not a server failure.
    const bare = await client([() => new Response('', { status: 429 })]).c.json('/a').catch((e: GitHubError) => e);
    expect(bare).toMatchObject({ kind: 'rate-limit', status: 429 });
    expect(Date.parse((bare as GitHubError).resetAt!)).toBeGreaterThan(Date.now());
  });

  it('retries short secondary limits and gives up on long ones', async () => {
    const short = client([() => json({ message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '3' }, 403), () => json({ ok: 1 })]);
    expect(await short.c.json('/a')).toEqual({ ok: 1 });
    expect(short.sleeps).toEqual([3000]);
    // Without Retry-After GitHub asks for at least a minute: too long to hold a page load.
    const long = client([() => json({ message: 'You have exceeded a secondary rate limit' }, {}, 403)]);
    const err = (await long.c.json('/a').catch((e: GitHubError) => e)) as GitHubError;
    expect(err).toMatchObject({ kind: 'rate-limit' });
    expect(Date.parse(err.resetAt!)).toBeGreaterThan(Date.now() + 50_000);
    expect(long.sleeps).toEqual([]);
  });

  it('retries server errors with backoff, then reports them as transient', async () => {
    const flaky = client([() => new Response('', { status: 502 }), () => new Response('{bad json'), () => json({ ok: 1 })]);
    expect(await flaky.c.json('/a')).toEqual({ ok: 1 });
    expect(flaky.sleeps).toHaveLength(2);
    const down = client([() => new Response('', { status: 503 })]);
    await expect(down.c.json('/a')).rejects.toMatchObject({ kind: 'transient' });
    expect(down.calls).toHaveLength(3);
  });

  it('classifies 401, 404 and other client errors without retrying', async () => {
    await expect(client([() => json({}, {}, 401)]).c.json('/a')).rejects.toMatchObject({ kind: 'auth', status: 401 });
    await expect(client([() => json({ message: 'Not Found' }, {}, 404)]).c.json('/a')).rejects.toMatchObject({ kind: 'not-found', status: 404 });
    const unprocessable = client([() => json({ message: 'No commit found for SHA: abc1234' }, {}, 422)]);
    await expect(unprocessable.c.json('/repos/o/r/commits/abc1234')).rejects.toMatchObject({
      kind: 'http',
      status: 422,
      message: 'GitHub returned 422 for /repos/o/r/commits/abc1234: No commit found for SHA: abc1234',
    });
    expect(unprocessable.calls).toHaveLength(1);
    const forbidden = client([() => json({ message: 'Resource not accessible by personal access token' }, {}, 403)]);
    await expect(forbidden.c.json('/a')).rejects.toMatchObject({ kind: 'http', status: 403 });
  });

  it('makes a conditional SHA request that treats 304 as unchanged', async () => {
    const sha = 'b'.repeat(40);
    const same = client([() => new Response(null, { status: 304, headers: RL })]);
    expect(await same.c.sha('/repos/o/r/commits/pull/1/head', sha)).toBe(sha);
    expect((same.calls[0]!.init.headers as Record<string, string>)['If-None-Match']).toBe(`"${sha}"`);
    const moved = client([() => new Response('c'.repeat(40), { headers: RL })]);
    expect(await moved.c.sha('/repos/o/r/commits/pull/1/head', sha)).toBe('c'.repeat(40));
  });

  it('returns ETags and sends them back verbatim, treating 304 as unchanged', async () => {
    const etag = 'W/"46be1d56"';
    const first = client([() => json({ n: 1 }, { etag })]);
    expect(await first.c.versioned('/repos/o/r/pulls/1')).toEqual({ body: { n: 1 }, etag });
    expect((first.calls[0]!.init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
    const same = client([() => new Response(null, { status: 304, headers: { etag } })]);
    expect(await same.c.versioned('/repos/o/r/pulls/1', etag)).toBeNull();
    expect((same.calls[0]!.init.headers as Record<string, string>)['If-None-Match']).toBe(etag);
    const changed = client([() => json({ n: 2 }, { etag: 'W/"other"' })]);
    expect(await changed.c.versioned('/repos/o/r/pulls/1', etag)).toEqual({ body: { n: 2 }, etag: 'W/"other"' });
  });

  it('reads raw contents up to a size limit and recognises non-file answers', async () => {
    const raw = (body: string, headers: Record<string, string> = {}) => () =>
      new Response(body, { headers: { 'content-type': 'application/vnd.github.raw+json', ...headers } });
    const ok = await client([raw('hello')]).c.raw('/f', 10);
    expect({ ...ok, bytes: Buffer.from(ok.bytes).toString() }).toEqual({ bytes: 'hello', tooLarge: false, isFile: true });
    expect(await client([raw('x', { 'content-length': '11' })]).c.raw('/f', 10)).toMatchObject({ tooLarge: true });
    // No Content-Length: the stream is cut off once it passes the limit.
    const stream = new ReadableStream({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(6));
      },
    });
    expect(await client([() => new Response(stream)]).c.raw('/f', 10)).toMatchObject({ tooLarge: true });
    expect(await client([() => json([{ name: 'dir' }])]).c.raw('/f', 1000)).toMatchObject({ isFile: false });
  });

  it('never puts the token in an error message', async () => {
    const secret = 'secret-token-0123456789';
    const { c } = client([() => { throw new Error(`connect failed for Bearer ${secret}`); }], { token: secret });
    const msg = ((await c.json('/a').catch((e: Error) => e)) as Error).message;
    expect(msg).toBe('network error: connect failed for Bearer [token]');
    const bad = client([() => json({})], { token: `${secret}\nX` });
    const err = await bad.c.json('/a').catch((e: Error) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as Error).message).not.toContain(secret);
    expect(bad.calls).toHaveLength(0);
  });
});
