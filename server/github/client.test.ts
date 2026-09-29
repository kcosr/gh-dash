import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError } from './client';

const RL = { limit: 5000, remaining: 4000, resetAt: '2099-01-01T00:00:00Z', cost: 2 };
const ok = (data: object = {}) => new Response(JSON.stringify({ data: { ...data, rateLimit: RL } }), { status: 200 });

function client(responses: (() => Response)[]) {
  const sleeps: number[] = [];
  let calls = 0;
  const c = new GitHubClient({
    token: 't',
    fetchImpl: async () => responses[Math.min(calls++, responses.length - 1)]!(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, sleeps, calls: () => calls };
}

describe('GitHubClient', () => {
  it('returns data and tracks rate limit and points', async () => {
    const { c } = client([() => ok({ viewer: { login: 'alice' } })]);
    expect(await c.query('query { viewer { login } }')).toMatchObject({ viewer: { login: 'alice' } });
    expect(c.pointsUsed).toBe(2);
    expect(c.rateLimit?.remaining).toBe(4000);
  });

  it('never puts the token in an error message', async () => {
    const secret = 'synthetic-token-for-redaction-test';
    // fetch's own header validation quotes the header value.
    const bad = new GitHubClient({ token: `${secret}\nX`, maxAttempts: 1, sleep: async () => {} });
    const err = await bad.query('query { viewer { login } }').catch((e: Error) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as Error).message).not.toContain(secret);
    const echo = new GitHubClient({
      token: secret,
      maxAttempts: 2,
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error(`connect failed for bearer ${secret}`);
      },
    });
    const msg = ((await echo.query('query { viewer { login } }').catch((e: Error) => e)) as Error).message;
    expect(msg).toBe('network error: connect failed for bearer [token]');
  });

  it('refuses anything but read queries', async () => {
    const { c, calls } = client([() => ok()]);
    await expect(c.query('mutation { addStar(input: {}) { clientMutationId } }')).rejects.toThrow(/read-only/);
    expect(calls()).toBe(0);
  });

  it('retries 502s and GraphQL timeouts with backoff', async () => {
    const { c, sleeps, calls } = client([
      () => new Response('bad gateway', { status: 502 }),
      () => new Response(JSON.stringify({ errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout' }] })),
      () => ok({ viewer: { login: 'alice' } }),
    ]);
    await c.query('query { viewer { login } }');
    expect(calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it('honours Retry-After on secondary rate limits', async () => {
    const { c, sleeps } = client([
      () => new Response('You have exceeded a secondary rate limit', { status: 403, headers: { 'retry-after': '7' } }),
      () => ok(),
    ]);
    await c.query('query { viewer { login } }');
    expect(sleeps).toEqual([7000]);
  });

  it('waits out long secondary limits during sync, but not with maxRetryWaitMs', async () => {
    const secondary = () => new Response('You have exceeded a secondary rate limit', { status: 403 });
    const sync = client([secondary, () => ok()]);
    await sync.c.query('query { x }');
    expect(sync.sleeps).toEqual([60_000]);
    const sleeps: number[] = [];
    const interactive = new GitHubClient({ token: 't', maxRetryWaitMs: 10_000, fetchImpl: async () => secondary(), sleep: async (ms) => void sleeps.push(ms) });
    await expect(interactive.query('query { x }')).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(sleeps).toEqual([]);
  });

  it("aborts at the caller's signal and doesn't retry after it", async () => {
    const controller = new AbortController();
    let calls = 0;
    const c = new GitHubClient({
      token: 't',
      sleep: async () => {},
      fetchImpl: async (_input, init) => {
        calls++;
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    });
    const pending = c.query('query { x }', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'transient', message: 'Gave up waiting for GitHub (GraphQL)' });
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts', async () => {
    const { c, calls } = client([() => new Response('', { status: 503 })]);
    await expect(c.query('query { x }')).rejects.toMatchObject({ kind: 'transient' });
    expect(calls()).toBe(5);
  });

  it('fails fast on auth errors, primary rate limits and GraphQL errors', async () => {
    await expect(client([() => new Response('', { status: 401 })]).c.query('query { x }')).rejects.toMatchObject({ kind: 'auth' });
    const limited = new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }));
    await expect(client([() => limited]).c.query('query { x }')).rejects.toMatchObject({ kind: 'rate-limit' });
    const notFound = new Response(JSON.stringify({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    await expect(client([() => notFound]).c.query('query { x }')).rejects.toBeInstanceOf(GitHubError);
  });

  it('returns partial data for NOT_FOUND-only errors when asked to', async () => {
    const partial = () =>
      new Response(JSON.stringify({ data: { repository: { pr7: null }, rateLimit: RL }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    expect(await client([partial]).c.query('query { x }', {}, { allowNotFound: true })).toMatchObject({ repository: { pr7: null } });
    await expect(client([partial]).c.query('query { x }')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('queryPartial returns the data with path-tagged NOT_FOUND and FORBIDDEN errors', async () => {
    const errors = [
      { type: 'NOT_FOUND', path: ['nodes', 0], message: "Could not resolve to a node with the global id of 'R_x'" },
      { type: 'FORBIDDEN', path: ['nodes', 2], message: 'Resource protected by organization SAML enforcement.' },
    ];
    const partial = () => new Response(JSON.stringify({ data: { nodes: [null, { id: 'R_b' }, null], rateLimit: RL }, errors }));
    expect(await client([partial]).c.queryPartial('query { x }')).toEqual({ data: { nodes: [null, { id: 'R_b' }, null], rateLimit: RL }, errors });
    const clean = () => ok({ nodes: [{ id: 'R_a' }] });
    expect(await client([clean]).c.queryPartial('query { x }')).toEqual({ data: { nodes: [{ id: 'R_a' }], rateLimit: RL }, errors: [] });
  });

  it('queryPartial tolerates any error under an optional top-level field', async () => {
    const errors = [{ type: 'SERVICE_UNAVAILABLE', path: ['prs'], message: 'search is down' }];
    const reply = () => new Response(JSON.stringify({ data: { repository: { id: 'R' }, prs: null, rateLimit: RL }, errors }));
    expect(await client([reply]).c.queryPartial('query { x }', {}, { optional: ['prs'] })).toMatchObject({ data: { prs: null }, errors });
    await expect(client([reply]).c.queryPartial('query { x }')).rejects.toMatchObject({ kind: 'graphql' });
  });

  it('queryPartial still throws for other errors, and for no data at all', async () => {
    const other = () => new Response(JSON.stringify({ data: { nodes: [null] }, errors: [{ type: 'INTERNAL', message: 'boom' }, { type: 'NOT_FOUND', message: 'x' }] }));
    await expect(client([other]).c.queryPartial('query { x }')).rejects.toMatchObject({ kind: 'graphql', message: 'boom; x' });
    const limited = () => new Response(JSON.stringify({ data: { nodes: [null] }, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }));
    await expect(client([limited]).c.queryPartial('query { x }')).rejects.toMatchObject({ kind: 'rate-limit' });
    const nothing = () => new Response(JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] }));
    await expect(client([nothing]).c.queryPartial('query { x }')).rejects.toMatchObject({ kind: 'forbidden' });
    const timeout = () => new Response(JSON.stringify({ data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout' }] }));
    const retried = client([timeout, () => ok({ nodes: [] })]);
    expect((await retried.c.queryPartial('query { x }')).errors).toEqual([]);
    expect(retried.calls()).toBe(2);
  });

  it('classifies a failed query: all NOT_FOUND is not-found, any FORBIDDEN is forbidden; the errors stay attached', async () => {
    const reply = (errors: object[]) => () => new Response(JSON.stringify({ data: { repository: null }, errors }));
    const notFound = [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'o/n'." }];
    const err = await client([reply(notFound)]).c.query('query { x }').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'not-found', errors: notFound });
    const forbidden = [{ type: 'FORBIDDEN', path: ['repository', 'openPrs'], message: 'Resource not accessible by personal access token' }];
    await expect(client([reply([...forbidden, ...notFound])]).c.query('query { x }')).rejects.toMatchObject({ kind: 'forbidden', errors: [...forbidden, ...notFound] });
  });

  it('stops spending when the remaining budget is nearly exhausted', async () => {
    const { c, calls } = client([() => new Response(JSON.stringify({ data: { rateLimit: { ...RL, remaining: 50 } } }))]);
    await c.query('query { x }');
    await expect(c.query('query { x }')).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(calls()).toBe(1);
  });
});
