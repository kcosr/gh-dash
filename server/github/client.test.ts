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
    await expect(client([partial]).c.query('query { x }')).rejects.toMatchObject({ kind: 'graphql' });
  });

  it('stops spending when the remaining budget is nearly exhausted', async () => {
    const { c, calls } = client([() => new Response(JSON.stringify({ data: { rateLimit: { ...RL, remaining: 50 } } }))]);
    await c.query('query { x }');
    await expect(c.query('query { x }')).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(calls()).toBe(1);
  });
});
