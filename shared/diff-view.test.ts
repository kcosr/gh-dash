import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isClientError, isUnreachable, rateLimitResetAt } from '../web/src/api/client';
import { fmtBytes } from '../web/src/lib/time';
import { OVERLAY_KEYS, canonicalQuery, carrySearch, commitDiffId, parseDiffId, parseUrlState, patchSearch } from '../web/src/lib/urlState';

describe('diff URL state', () => {
  it('parses PR and commit diff ids and rejects malformed ones', () => {
    expect(parseDiffId('gh-dash#12')).toEqual({ kind: 'pr', repo: 'gh-dash', number: 12 });
    expect(parseDiffId('gh-dash@6df2155')).toEqual({ kind: 'commit', repo: 'gh-dash', oid: '6df2155' });
    expect(parseDiffId(commitDiffId('my.repo', '6df21550c42ff69731e827d728f33f1577aba87f'))).toMatchObject({ kind: 'commit', repo: 'my.repo' });
    for (const bad of [null, '', 'gh-dash', 'gh-dash#0', 'gh-dash#x', '#12', 'gh-dash@6df215', 'gh-dash@xyz1234', `gh-dash@${'a'.repeat(41)}`, 'a b#1', 'a#1@abcdefg']) {
      expect(parseDiffId(bad)).toBeNull();
    }
  });

  it('keeps diff and file next to pr, and ignores a file without a valid diff', () => {
    const s = parseUrlState('?pr=gh-dash%232&diff=gh-dash%232&file=web/src/App.tsx', 'prs');
    expect(s).toMatchObject({ pr: 'gh-dash#2', diff: 'gh-dash#2', file: 'web/src/App.tsx' });
    expect(parseUrlState('?file=web/src/App.tsx', 'prs').file).toBeNull();
    expect(parseUrlState('?diff=nope&file=a.ts', 'prs')).toMatchObject({ diff: null, file: null });
  });

  it('writes readable diff params after pr, and drops file with the diff', () => {
    const open = patchSearch('?state=open&pr=gh-dash%232', 'prs', { diff: 'gh-dash@6df2155' });
    expect(open).toBe('?state=open&pr=gh-dash%232&diff=gh-dash@6df2155');
    const withFile = patchSearch(open, 'prs', { file: 'web/src/lib/url State.ts' });
    expect(withFile).toBe('?state=open&pr=gh-dash%232&diff=gh-dash@6df2155&file=web/src/lib/url%20State.ts');
    expect(parseUrlState(withFile, 'prs').file).toBe('web/src/lib/url State.ts');
    expect(patchSearch(withFile, 'prs', { diff: null })).toBe('?state=open&pr=gh-dash%232');
  });

  it('never saves or carries what is open on top of a view', () => {
    expect(OVERLAY_KEYS).toEqual(['pr', 'diff', 'file']);
    expect(canonicalQuery('?who=me&diff=gh-dash%232&file=a.ts&pr=gh-dash%232&range=7d')).toBe('range=7d&who=me');
    expect(canonicalQuery('?range=7d&who=me')).toBe(canonicalQuery('?who=me&range=7d&diff=x@abcdef1'));
    expect(parseUrlState(carrySearch('?repos=app&diff=app@abcdef1&file=a.ts'), 'activity')).toMatchObject({ repos: ['app'], diff: null, file: null });
  });
});

describe('diff API helpers', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves missing, binary and oversized files to null for the viewer', async () => {
    for (const status of [404, 413, 415]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no' }), { status })));
      await expect(api.blob('gh-dash', 'abc1234', 'a.ts')).resolves.toBeNull();
    }
    const fetch = vi.fn(async (_url: string) => new Response('line 1\n', { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.blob('gh dash', 'abc1234', 'web/src/a b.ts')).resolves.toBe('line 1\n');
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/blob/gh%20dash?ref=abc1234&path=web%2Fsrc%2Fa%20b.ts');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'GitHub request failed' }), { status: 502 })));
    await expect(api.blob('gh-dash', 'abc1234', 'a.ts')).rejects.toMatchObject({ status: 502, message: 'GitHub request failed' });
  });

  it('asks GitHub again only when refreshing', async () => {
    const fetch = vi.fn(async (_url: string) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await api.prDiff('gh-dash', 2);
    await api.prDiff('gh-dash', 2, true);
    await api.commitDiff('gh-dash', '6df2155', true);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/prs/gh-dash/2/diff',
      '/api/v1/prs/gh-dash/2/diff?refresh=1',
      '/api/v1/commits/gh-dash/6df2155/diff?refresh=1',
    ]);
  });

  it('tells server errors from an unreachable server, and reads the rate limit reset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No GitHub token' }), { status: 503 })));
    const noToken = await api.prDiff('gh-dash', 2).catch((e: unknown) => e);
    expect(noToken).toMatchObject({ status: 503, message: 'No GitHub token' });
    expect(isUnreachable(noToken)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad gateway', { status: 503 })));
    expect(isUnreachable(await api.prDiff('gh-dash', 2).catch((e: unknown) => e))).toBe(true);
    expect(isClientError(new ApiError(404, 'x'))).toBe(true);
    expect(isClientError(new ApiError(502, 'x'))).toBe(false);

    const at = '2026-09-28T20:15:00.000Z';
    expect(rateLimitResetAt(new ApiError(429, 'x', { resetAt: at }))?.toISOString()).toBe(at);
    expect(rateLimitResetAt(new ApiError(429, 'x', { reset: Date.parse(at) / 1000 }))?.toISOString()).toBe(at);
    expect(rateLimitResetAt(new ApiError(429, 'x', at))?.toISOString()).toBe(at);
    expect(rateLimitResetAt(new ApiError(429, 'x'))).toBeNull();
    expect(rateLimitResetAt(new ApiError(429, 'x', { resetAt: 'soon' }))).toBeNull();
  });

  it('formats cache sizes', () => {
    expect(fmtBytes(0)).toBe('0 bytes');
    expect(fmtBytes(1)).toBe('1 byte');
    expect(fmtBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(fmtBytes(200 * 1024 * 1024)).toBe('200 MB');
    expect(fmtBytes(840 * 1024)).toBe('840 KB');
  });
});
