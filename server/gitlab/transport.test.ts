import { describe, expect, it } from 'vitest';
import { BASE, fakeGitLab, graphql, page, type Handler } from '../test/gitlab';
import { GitLabClient, MAX_QUERY_CHARS } from './client';
import { encodeSegment, GitLabRestClient } from './rest';
import { GitLabError, GitLabTransport, normalizeBaseUrl, type GitLabOptions } from './transport';

const TOKEN = 'glpat-SECRETsecret123';

function setup(routes: Record<string, Handler>, opts: Partial<GitLabOptions> = {}, maxRetryWaitMs = 10_000) {
  const fake = fakeGitLab(routes);
  const sleeps: number[] = [];
  const transport = new GitLabTransport(
    { baseUrl: BASE, token: TOKEN, fetchImpl: fake.fetchImpl, sleep: async (ms) => void sleeps.push(ms), ...opts },
    { maxAttempts: 3, maxRetryWaitMs },
  );
  return { ...fake, sleeps, transport, rest: new GitLabRestClient(transport), gql: new GitLabClient(transport) };
}

const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as GitLabError);

describe('normalizeBaseUrl', () => {
  it('keeps a relative root and drops trailing slashes', () => {
    expect(normalizeBaseUrl('https://gitlab.example.com/')).toBe('https://gitlab.example.com');
    expect(normalizeBaseUrl(' https://example.com/gitlab// ')).toBe('https://example.com/gitlab');
    expect(normalizeBaseUrl('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
  });

  it('refuses URLs that are not plain http(s) instance URLs', () => {
    expect(() => normalizeBaseUrl('gitlab.example.com')).toThrow(/Invalid/);
    expect(() => normalizeBaseUrl('ftp://gitlab.example.com')).toThrow(/http/);
    expect(() => normalizeBaseUrl('https://user:pw@gitlab.example.com')).toThrow(/credentials/);
    expect(() => normalizeBaseUrl('https://gitlab.example.com/?x=1')).toThrow(/query/);
  });
});

describe('GitLab transport', () => {
  it('sends REST GETs and GraphQL POSTs under the base URL with a Bearer token, never following redirects', async () => {
    const { rest, gql, calls } = setup({
      '/api/v4/projects/1': { body: { id: 1 } },
      '/api/graphql': graphql({ Viewer: () => ({ currentUser: { username: 'alice' } }) }),
    });
    expect(await rest.json('/projects/1', { query: { statistics: false } })).toEqual({ id: 1 });
    expect(await gql.query('query Viewer { currentUser { username } }', { a: 1 })).toEqual({ currentUser: { username: 'alice' } });
    expect(calls.map((c) => [c.method, c.url.href])).toEqual([
      ['GET', `${BASE}/api/v4/projects/1?statistics=false`],
      ['POST', `${BASE}/api/graphql`],
    ]);
    expect(calls[1]!.body).toEqual({ query: 'query Viewer { currentUser { username } }', variables: { a: 1 } });
    for (const c of calls) {
      expect(c.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'gh-dash' });
      expect(c.headers).not.toHaveProperty('PRIVATE-TOKEN');
    }
  });

  it('refuses to send the token anywhere but the API root', async () => {
    const { transport, calls } = setup({});
    await expect(transport.send('https://evil.example/api/v4/x', async () => 1)).rejects.toThrow(/Refusing/);
    await expect(transport.send('https://gitlab.example.com/api/v4/x', async () => 1)).rejects.toThrow(/Refusing/);
    expect(() => transport.url('/users/sign_in')).toThrow(/\/api\//);
    expect(calls).toHaveLength(0);
  });

  it('checks where a URL really goes: dot segments, literal or encoded, cannot climb out of the API root', async () => {
    const { transport, calls } = setup({});
    for (const sneaky of [
      `${BASE}/api/v4/../../x`,
      `${BASE}/api/v4/projects/%2E%2E/%2E%2E/%2E%2E/x`,
      `${BASE}/api/v4/projects/.%2e/%2e./%2E%2E/x`,
      `${BASE}/api/./../x`,
    ]) {
      await expect(transport.send(sneaky, async () => 1)).rejects.toThrow(/Refusing/);
    }
    expect(calls).toHaveLength(0);
  });

  it('sends the URL it checked', async () => {
    const { transport, calls } = setup({ '/api/v4/b': { body: {} } });
    await transport.send(`${BASE}/api/v4/a/../b`, async () => 1);
    expect(calls.map((c) => c.url.href)).toEqual([`${BASE}/api/v4/b`]);
  });

  it('reports a redirect instead of following it', async () => {
    const { rest, calls } = setup({ '/api/v4/x': { status: 301, headers: { location: 'https://other.example/api/v4/x' } } });
    const err = await fail(rest.json('/x'));
    expect(err).toMatchObject({ kind: 'http', status: 301, message: expect.stringContaining('check the GitLab URL') });
    expect(calls).toHaveLength(1);
  });

  it('classifies auth failures: 401 always, 403 only for a missing scope', async () => {
    const expired = setup({ '/api/v4/x': { status: 401, body: { error: 'invalid_token', error_description: 'Token is expired.' } } });
    expect(await fail(expired.rest.json('/x'))).toMatchObject({ kind: 'auth', status: 401, message: expect.stringContaining('Token is expired') });
    expect(expired.calls).toHaveLength(1);
    const scope = setup({ '/api/v4/x': { status: 403, body: { error: 'insufficient_scope', error_description: 'The request requires higher privileges' } } });
    expect(await fail(scope.rest.json('/x'))).toMatchObject({ kind: 'auth', status: 403, message: expect.stringContaining('read_api') });
    // A resource the user may not see (a Guest and a private repository) is not a token problem.
    const forbidden = setup({ '/api/v4/x': { status: 403, body: { message: '403 Forbidden' } } });
    expect(await fail(forbidden.rest.json('/x'))).toMatchObject({ kind: 'http', status: 403, message: 'GitLab returned 403 for /gitlab/api/v4/x: 403 Forbidden' });
    // GraphQL has no per-resource 403 (it answers null): there it means a blocked or deactivated account.
    const blocked = setup({ '/api/graphql': { status: 403, body: { errors: [{ message: 'API not accessible for user' }] } } });
    expect(await fail(blocked.gql.query('query V { currentUser { id } }'))).toMatchObject({ kind: 'auth', status: 403, message: expect.stringContaining('API not accessible') });
  });

  it('maps 404 to not-found and other client errors to http, without retrying', async () => {
    const missing = setup({});
    expect(await fail(missing.rest.json('/projects/9'))).toMatchObject({ kind: 'not-found', status: 404, message: expect.stringContaining('404 Not Found') });
    const bad = setup({ '/api/v4/x': { status: 400, body: { message: { base: ['invalid'] } } } });
    expect(await fail(bad.rest.json('/x'))).toMatchObject({ kind: 'http', status: 400, message: expect.stringContaining('invalid') });
    expect([missing.calls.length, bad.calls.length]).toEqual([1, 1]);
  });

  it('retries server errors, network errors and unreadable bodies with backoff, then reports them as transient', async () => {
    let n = 0;
    const flaky = setup({
      '/api/v4/x': () => (++n === 1 ? { status: 502, text: 'Bad Gateway' } : n === 2 ? { text: '{not json' } : { body: { ok: 1 } }),
    });
    expect(await flaky.rest.json('/x')).toEqual({ ok: 1 });
    expect(flaky.sleeps).toHaveLength(2);
    const down = setup({ '/api/v4/x': { status: 503, text: 'Service Unavailable' } });
    expect(await fail(down.rest.json('/x'))).toMatchObject({ kind: 'transient', message: expect.stringContaining('503') });
    expect(down.calls).toHaveLength(3);
    const offline = setup({}, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await fail(offline.rest.json('/x'))).toMatchObject({ kind: 'transient', message: 'network error: ECONNREFUSED' });
  });

  it('waits out a 429 as Retry-After asks, and gives up on a wait longer than the caller allows', async () => {
    let n = 0;
    const short = setup({ '/api/v4/x': () => (++n === 1 ? { status: 429, text: 'Retry later\n', headers: { 'retry-after': '3' } } : { body: { ok: 1 } }) });
    expect(await short.rest.json('/x')).toEqual({ ok: 1 });
    expect(short.sleeps).toEqual([3000]);
    const long = setup({ '/api/v4/x': { status: 429, text: 'Retry later\n', headers: { 'retry-after': '600' } } });
    const err = await fail(long.rest.json('/x'));
    expect(err).toMatchObject({ kind: 'rate-limit', status: 429 });
    expect(Date.parse(err.resetAt!)).toBeGreaterThan(Date.now() + 590_000);
    expect(long.sleeps).toEqual([]);
    // Without Retry-After, the window's reset time is the best guess.
    const bare = setup({ '/api/v4/x': { status: 429, text: 'Retry later\n', headers: { 'ratelimit-reset': '4070908800' } } });
    expect(await fail(bare.rest.json('/x'))).toMatchObject({ kind: 'rate-limit', resetAt: '2099-01-01T00:00:00.000Z' });
  });

  it('reads RateLimit-* headers when throttling is enabled, and has no reading otherwise', async () => {
    const plain = setup({ '/api/v4/x': { body: {} } });
    await plain.rest.json('/x');
    expect(plain.transport.rateLimit).toBeNull();
    const throttled = setup({
      '/api/v4/x': { body: {}, headers: { 'ratelimit-limit': '600', 'ratelimit-remaining': '598', 'ratelimit-reset': '4070908800' } },
    });
    await throttled.rest.json('/x');
    expect(throttled.transport.rateLimit).toEqual({ limit: 600, remaining: 598, resetAt: '2099-01-01T00:00:00.000Z' });
  });

  it('never puts the token in an error message', async () => {
    const echo = setup({}, {
      fetchImpl: async () => {
        throw new Error(`connect failed for Bearer ${TOKEN}`);
      },
    });
    expect((await fail(echo.rest.json('/x'))).message).toBe('network error: connect failed for Bearer [token]');
    const reflected = setup({ '/api/v4/x': { status: 400, body: { message: `bad header ${TOKEN}` } } });
    expect((await fail(reflected.rest.json('/x'))).message).not.toContain(TOKEN);
    // fetch's own header validation would quote the value.
    const bad = setup({}, { token: `${TOKEN}\nX` });
    const err = await fail(bad.rest.json('/x'));
    expect(err).toMatchObject({ kind: 'auth' });
    expect(err.message).not.toContain(TOKEN);
    expect(bad.calls).toHaveLength(0);
  });

  it('masks the token before cutting a message short, so no part of it survives the cut', async () => {
    // Each placement puts the token across the point where that detail is truncated (200, or 500 for GraphQL).
    const across = (limit: number) => `${'e'.repeat(limit - 10)}${TOKEN} and more`;
    const leaks = (msg: string) => msg.includes(TOKEN.slice(0, 10));
    const json = setup({ '/api/v4/x': { status: 400, body: { message: across(200) } } });
    const text = setup({ '/api/v4/x': { status: 400, text: across(200) } });
    const redirect = setup({ '/api/v4/x': { status: 302, headers: { location: `https://other.example/${across(200 - 'https://other.example/'.length)}` } } });
    const gql = setup({ '/api/graphql': { body: { errors: [{ message: across(500) }] } } });
    const errors = {
      json: await fail(json.rest.json('/x')),
      text: await fail(text.rest.json('/x')),
      redirect: await fail(redirect.rest.json('/x')),
      graphql: await fail(gql.gql.query('query Q { x }')),
    };
    expect(Object.fromEntries(Object.entries(errors).map(([k, e]) => [k, leaks(e.message)]))).toEqual({ json: false, text: false, redirect: false, graphql: false });
    for (const err of Object.values(errors)) expect(err.message).toContain('eeee[token]');
  });

  it('does not echo a malformed base URL, which may carry credentials', () => {
    for (const raw of ['ftp://alice:s3cret@gitlab.example.com', 'alice:s3cret@gitlab.example.com', 'https://alice:s3cret@gitlab.example.com', 'http://[s3cret']) {
      expect(() => normalizeBaseUrl(raw)).toThrow();
      expect(() => normalizeBaseUrl(raw)).not.toThrow(/s3cret/);
    }
  });

  it('stops retrying once the caller gives up', async () => {
    const ctrl = new AbortController();
    const { rest, calls } = setup({
      '/api/v4/x': () => {
        ctrl.abort();
        return { status: 502, text: '' };
      },
    });
    expect(await fail(rest.json('/x', { signal: ctrl.signal }))).toMatchObject({ kind: 'transient', message: expect.stringContaining('Gave up') });
    expect(calls).toHaveLength(1);
  });
});

describe('GitLab REST pagination', () => {
  it('follows X-Next-Page with URLs it builds itself, ignoring the Link header', async () => {
    const { rest, requests } = setup({
      '/api/v4/items?per_page=2&page=1': page([1, 2], 2, { link: '<https://evil.example/api/v4/items?page=2>; rel="next"', 'x-total': '5' }),
      '/api/v4/items?per_page=2&page=2': page([3, 4], 3),
      '/api/v4/items?per_page=2&page=3': page([5], null),
    });
    expect(await rest.all<number>('/items', 100, { query: { per_page: 2 } })).toEqual({ items: [1, 2, 3, 4, 5], total: 5 });
    expect(requests).toEqual(['/api/v4/items?per_page=2&page=1', '/api/v4/items?per_page=2&page=2', '/api/v4/items?per_page=2&page=3']);
  });

  it('stops at the item limit, and on a next page that does not move forward', async () => {
    const capped = setup({
      '/api/v4/items?page=1': page([1, 2], 2),
      '/api/v4/items?page=2': page([3, 4], 3),
    });
    expect((await capped.rest.all<number>('/items', 3)).items).toEqual([1, 2, 3]);
    expect(capped.requests).toHaveLength(2);
    const stuck = setup({ '/api/v4/items': page([1], 1) });
    expect(await stuck.rest.all<number>('/items', 100)).toEqual({ items: [1], total: null });
    expect(stuck.requests).toHaveLength(1);
  });

  it('reports the next page and total of a single page', async () => {
    const { rest } = setup({ '/api/v4/items': page([], null, { 'x-total': '0' }) });
    expect(await rest.page('/items')).toEqual({ body: [], nextPage: null, total: 0 });
  });

  it('encodes project and file paths as single segments, dots included', () => {
    expect(encodeSegment('group/sub/my.project')).toBe('group%2Fsub%2Fmy%2Eproject');
    expect(encodeSegment('lib/class.rb')).toBe('lib%2Fclass%2Erb');
    expect(encodeSegment('x y#?/.env')).toBe('x%20y%23%3F%2F%2Eenv');
  });

  it('refuses paths with . or .. components, which a server or proxy could resolve after decoding', () => {
    for (const bad of ['..', '.', '../x', 'a/../b', 'a/./b', 'a/..']) expect(() => encodeSegment(bad)).toThrow(/\.\./);
  });
});

describe('GitLab raw downloads', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(97);

  it('reads a file up to the byte cap, and refuses larger ones by header or while streaming', async () => {
    const { rest } = setup({
      '/api/v4/small': { text: bytes(10) },
      '/api/v4/declared': { text: bytes(10), headers: { 'content-length': '5000' } },
      '/api/v4/streamed': { text: bytes(5000) },
    });
    const small = await rest.raw('/small', 100);
    expect([small.tooLarge, small.bytes.byteLength]).toEqual([false, 10]);
    expect(await rest.raw('/declared', 100)).toEqual({ bytes: new Uint8Array(), tooLarge: true });
    expect(await rest.raw('/streamed', 100)).toEqual({ bytes: new Uint8Array(), tooLarge: true });
  });
});

describe('GitLab GraphQL client', () => {
  it('refuses mutations and over-long documents before sending anything', async () => {
    const { gql, calls } = setup({});
    await expect(gql.query('mutation { starProject }')).rejects.toThrow(/read-only/);
    await expect(gql.query(`query Big { ${'x '.repeat(MAX_QUERY_CHARS)} }`)).rejects.toThrow(/10000/);
    expect(calls).toHaveLength(0);
  });

  it('fails on GraphQL errors, naming where they happened', async () => {
    const { gql } = setup({
      '/api/graphql': {
        body: { data: { project: null }, errors: [{ message: 'Query has complexity of 300, which exceeds max complexity of 250', path: ['project', 'mergeRequests'] }] },
      },
    });
    expect(await fail(gql.query('query P { project { id } }'))).toMatchObject({
      kind: 'graphql',
      message: 'Query has complexity of 300, which exceeds max complexity of 250 (at project.mergeRequests)',
    });
  });

  it('retries a query that timed out, and rejects an empty response', async () => {
    let n = 0;
    const timeout = setup({
      '/api/graphql': () => (++n === 1 ? { body: { errors: [{ message: 'Request timed out. Please try a less complex query or a smaller page size.' }] } } : { body: { data: { ok: 1 } } }),
    });
    expect(await timeout.gql.query('query Q { ok }')).toEqual({ ok: 1 });
    expect(timeout.sleeps).toHaveLength(1);
    const empty = setup({ '/api/graphql': { body: { data: null } } });
    expect(await fail(empty.gql.query('query Q { ok }'))).toMatchObject({ kind: 'graphql', message: 'empty GraphQL response' });
  });
});
