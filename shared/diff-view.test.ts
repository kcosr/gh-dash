import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isClientError, isUnreachable, rateLimitResetAt } from '../web/src/api/client';
import { fmtBytes } from '../web/src/lib/time';
import { OVERLAY_KEYS, branchDiffId, canonicalQuery, carrySearch, commitDiffId, parseDiffId, parseUrlState, patchSearch } from '../web/src/lib/urlState';

describe('diff URL state', () => {
  it('parses PR and commit diff ids and rejects malformed ones', () => {
    expect(parseDiffId('kcosr/gh-dash#12')).toEqual({ kind: 'pr', repo: 'kcosr/gh-dash', number: 12 });
    expect(parseDiffId('kcosr/gh-dash@6df2155')).toEqual({ kind: 'commit', repo: 'kcosr/gh-dash', oid: '6df2155' });
    expect(parseDiffId(commitDiffId('kcosr/my.repo', '6df21550c42ff69731e827d728f33f1577aba87f'))).toMatchObject({ kind: 'commit', repo: 'kcosr/my.repo' });
    // A SHA-256 repository's SHAs are 64 characters, and its abbreviations any length from 7.
    for (const oid of ['a'.repeat(64), 'a'.repeat(45)]) expect(parseDiffId(commitDiffId('gitlab.example.com/alice/app', oid))).toEqual({ kind: 'commit', repo: 'gitlab.example.com/alice/app', oid });
    for (const bad of [null, '', 'kcosr/gh-dash', 'kcosr/gh-dash#0', 'kcosr/gh-dash#x', '#12', 'kcosr/gh-dash@6df215', 'kcosr/gh-dash@xyz1234', `kcosr/gh-dash@${'a'.repeat(65)}`, 'a b#1', 'a#1@abcdefg']) {
      expect(parseDiffId(bad)).toBeNull();
    }
  });

  it("parses a branch's diff id at its first '~', before a '#' or '@' in the name could make it a PR or commit", () => {
    expect(parseDiffId('kcosr/gh-dash~fix/login')).toEqual({ kind: 'branch', repo: 'kcosr/gh-dash', branch: 'fix/login' });
    expect(parseDiffId(branchDiffId('gitlab.example.com/alice/app', 'feature/x'))).toEqual({ kind: 'branch', repo: 'gitlab.example.com/alice/app', branch: 'feature/x' });
    // Git allows '#' and '@' in a name (not "@{", not a lone "@"): still the branch.
    for (const branch of ['issue#12', 'user@host', 'a#1@abcdef1', 'release/1.2', 'x|y']) {
      expect(parseDiffId(branchDiffId('alice/app', branch)), branch).toEqual({ kind: 'branch', repo: 'alice/app', branch });
    }
    // The repo part: not empty, no whitespace. The branch: a name git allows (no second '~', '..', a space, "@", …).
    for (const bad of ['~fix', 'a b~fix', 'alice/app~', 'alice/app~a~b', 'alice/app~a..b', 'alice/app~a b', 'alice/app~@', 'alice/app~a@{1}', 'alice/app~-x', 'alice/app~x.lock', 'alice/app~/x']) {
      expect(parseDiffId(bad), bad).toBeNull();
    }
  });

  it("writes a branch's diff readable, its '#' escaped, and reads it back with its file and thread", () => {
    const open = patchSearch('?state=open', 'prs', { diff: branchDiffId('alice/app', 'fix/issue#12'), file: 'src/a.ts', thread: 4 });
    expect(open).toBe('?state=open&diff=alice/app~fix/issue%2312&file=src/a.ts&thread=4');
    expect(parseUrlState(open, 'prs')).toMatchObject({ diff: 'alice/app~fix/issue#12', file: 'src/a.ts', thread: 4 });
    expect(parseUrlState('?diff=alice/app~a..b&file=a.ts&thread=4', 'prs')).toMatchObject({ diff: null, file: null, thread: null });
    expect(canonicalQuery(`?who=me${open.replace('?', '&')}`)).toBe('state=open&who=me');
  });

  it('keeps diff and file next to pr, and ignores a file without a valid diff', () => {
    const s = parseUrlState('?pr=kcosr/gh-dash%232&diff=kcosr/gh-dash%232&file=web/src/App.tsx', 'prs');
    expect(s).toMatchObject({ pr: 'kcosr/gh-dash#2', diff: 'kcosr/gh-dash#2', file: 'web/src/App.tsx' });
    expect(parseUrlState('?file=web/src/App.tsx', 'prs').file).toBeNull();
    expect(parseUrlState('?diff=nope&file=a.ts', 'prs')).toMatchObject({ diff: null, file: null });
  });

  it('writes readable diff params after pr, and drops file with the diff', () => {
    const open = patchSearch('?state=open&pr=kcosr/gh-dash%232', 'prs', { diff: 'kcosr/gh-dash@6df2155' });
    expect(open).toBe('?state=open&pr=kcosr/gh-dash%232&diff=kcosr/gh-dash@6df2155');
    const withFile = patchSearch(open, 'prs', { file: 'web/src/lib/url State.ts' });
    expect(withFile).toBe('?state=open&pr=kcosr/gh-dash%232&diff=kcosr/gh-dash@6df2155&file=web/src/lib/url%20State.ts');
    expect(parseUrlState(withFile, 'prs').file).toBe('web/src/lib/url State.ts');
    expect(patchSearch(withFile, 'prs', { diff: null })).toBe('?state=open&pr=kcosr/gh-dash%232');
  });

  it('never saves or carries what is open on top of a view', () => {
    expect(OVERLAY_KEYS).toEqual(['pr', 'diff', 'file', 'thread', 'only']);
    expect(canonicalQuery('?who=me&diff=kcosr/gh-dash%232&file=a.ts&pr=kcosr/gh-dash%232&range=7d')).toBe('range=7d&who=me');
    expect(canonicalQuery('?range=7d&who=me')).toBe(canonicalQuery('?who=me&range=7d&diff=x@abcdef1'));
    expect(parseUrlState(carrySearch('?repos=alice/app&diff=alice/app@abcdef1&file=a.ts'), 'activity')).toMatchObject({ repos: ['alice/app'], diff: null, file: null });
  });
});

describe('diff API helpers', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves missing, binary and oversized files to null for the viewer', async () => {
    for (const status of [404, 413, 415]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no' }), { status })));
      await expect(api.blob('kcosr/gh-dash', 'abc1234', 'a.ts')).resolves.toBeNull();
    }
    const fetch = vi.fn(async (_url: string) => new Response('line 1\n', { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.blob('kcosr/gh dash', 'abc1234', 'web/src/a b.ts')).resolves.toBe('line 1\n');
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/blob/kcosr%2Fgh%20dash?ref=abc1234&path=web%2Fsrc%2Fa%20b.ts');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'GitHub request failed' }), { status: 502 })));
    await expect(api.blob('kcosr/gh-dash', 'abc1234', 'a.ts')).rejects.toMatchObject({ status: 502, message: 'GitHub request failed' });
  });

  it('asks GitHub again only when refreshing', async () => {
    const fetch = vi.fn(async (_url: string) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await api.prDiff('kcosr/gh-dash', 2);
    await api.prDiff('kcosr/gh-dash', 2, true);
    await api.commitDiff('kcosr/gh-dash', '6df2155', true);
    await api.branchDiff('kcosr/gh-dash', 'fix/a#b');
    await api.branchDiff('kcosr/gh-dash', 'fix/a#b', true);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/prs/kcosr%2Fgh-dash/2/diff',
      '/api/v1/prs/kcosr%2Fgh-dash/2/diff?refresh=1',
      '/api/v1/commits/kcosr%2Fgh-dash/6df2155/diff?refresh=1',
      // A branch's name is one path segment, its slashes encoded like the repo's.
      '/api/v1/branches/kcosr%2Fgh-dash/fix%2Fa%23b/diff',
      '/api/v1/branches/kcosr%2Fgh-dash/fix%2Fa%23b/diff?refresh=1',
    ]);
  });

  it("asks for a repo's branches, narrowed by name on the host, and a branch's threads", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await api.branches('gitlab.example.com/alice/app');
    await api.branches('gitlab.example.com/alice/app', 'fix/');
    await api.branches('alice/app', '', true);
    await api.branchThreads('alice/app', 'fix/login');
    await api.createBranchThread('alice/app', 'fix/login', { commitOid: 'a'.repeat(40), body: 'x' });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/branches/gitlab.example.com%2Falice%2Fapp',
      '/api/v1/branches/gitlab.example.com%2Falice%2Fapp?q=fix%2F',
      '/api/v1/branches/alice%2Fapp?refresh=1',
      '/api/v1/branches/alice%2Fapp/fix%2Flogin/threads',
      '/api/v1/branches/alice%2Fapp/fix%2Flogin/threads',
    ]);
    expect(fetch.mock.calls[4]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ commitOid: 'a'.repeat(40), body: 'x' }) });
  });

  it('tells server errors from an unreachable server, and reads the rate limit reset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No GitHub token' }), { status: 503 })));
    const noToken = await api.prDiff('kcosr/gh-dash', 2).catch((e: unknown) => e);
    expect(noToken).toMatchObject({ status: 503, message: 'No GitHub token' });
    expect(isUnreachable(noToken)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad gateway', { status: 503 })));
    expect(isUnreachable(await api.prDiff('kcosr/gh-dash', 2).catch((e: unknown) => e))).toBe(true);
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
