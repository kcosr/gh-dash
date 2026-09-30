import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BranchListResponse, BranchSummary } from './api';
import { MAX_BRANCH_CHARS, isBranchQuery } from './branch';
import { branchQuery, qk, refetchAfterSync } from '../web/src/api/hooks';
import { hostBranchQuery } from '../web/src/lib/branches';

const HEAD = 'a'.repeat(40);
const branch = (name: string, pr: BranchSummary['pr'] = null): BranchSummary => ({ name, headOid: HEAD, committedAt: '2026-09-29T10:00:00Z', pr });
const list = (items: BranchSummary[], more = false): BranchListResponse => ({ items, defaultBranch: 'main', more });
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('branch filters: what the host is asked for', () => {
  it('takes any part of a name, as the list does: not a whole name\'s rules', () => {
    for (const q of ['feature/', '/login', 'fix/a', '-x', '.lock', 'a..b', 'x~', ' login ']) expect(isBranchQuery(q), q).toBe(true);
    // The list's own limits: not blank, at most the longest name once trimmed, no control characters.
    for (const q of ['', '   ', 'a\tb', 'a\u0000', 'x\u007f', 'x'.repeat(MAX_BRANCH_CHARS + 1)]) expect(isBranchQuery(q), JSON.stringify(q)).toBe(false);
    expect(isBranchQuery(`  ${'x'.repeat(MAX_BRANCH_CHARS)}  `)).toBe(true);
  });

  it('asks past the listed branches for a prefix or a suffix, when the host has more than it listed', () => {
    const more = list([], true);
    expect(hostBranchQuery(more, 'feature/')).toBe('feature/');
    expect(hostBranchQuery(more, ' /login ')).toBe('/login');
    // All listed already, nothing typed, or nothing a list takes: the listed ones are narrowed here alone.
    expect(hostBranchQuery(list([]), 'feature/')).toBeNull();
    expect(hostBranchQuery(undefined, 'feature/')).toBeNull();
    expect(hostBranchQuery(more, '  ')).toBeNull();
    expect(hostBranchQuery(more, 'a\tb')).toBeNull();
  });
});

describe("a branch diff's header: the branch's PR", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('shows the PR a list already loaded names, and asks nothing while that list is fresh', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.branches('alice/app', ''), list([branch('fix/a', { number: 9, state: 'open', title: 'Fix' })]));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const o = new QueryObserver(qc, branchQuery(qc, 'alice/app', 'fix/a'));
    const off = o.subscribe(() => {});
    expect(o.getCurrentResult().data?.pr?.number).toBe(9);
    expect(fetch).not.toHaveBeenCalled();
    off();
  });

  it('shows a PR synced after the branch was listed: after the sync, and when the diff opens again later', async () => {
    const qc = new QueryClient();
    // The repo page listed the branch before its PR existed.
    qc.setQueryData(qk.branches('alice/app', ''), list([branch('fix/a'), branch('fix/b')]));
    let pr: BranchSummary['pr'] = null;
    const fetch = vi.fn(async (_url: string) => answer(list([branch('fix/a', pr), branch('fix/a-2')])));
    vi.stubGlobal('fetch', fetch);
    const o = new QueryObserver(qc, branchQuery(qc, 'alice/app', 'fix/a'));
    const off = o.subscribe(() => {});
    expect(o.getCurrentResult().data).toMatchObject({ name: 'fix/a', pr: null });
    // The PR is synced: the shell invalidates what refetchAfterSync names, and the open diff's header asks again.
    pr = { number: 12, state: 'open', title: 'Fix a' };
    await qc.invalidateQueries({ predicate: refetchAfterSync });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/api/v1/branches/alice%2Fapp?q=fix%2Fa']);
    expect(o.getCurrentResult().data?.pr?.number).toBe(12);
    off();

    // Closed, and opened again a few minutes later (the list that seeded it long unmounted): asked again on opening.
    pr = { number: 12, state: 'merged', title: 'Fix a' };
    vi.useFakeTimers({ now: Date.now() + 5 * 60_000 });
    const again = new QueryObserver(qc, branchQuery(qc, 'alice/app', 'fix/a'));
    const off2 = again.subscribe(() => {});
    await vi.waitFor(() => { expect(again.getCurrentResult().data?.pr?.state).toBe('merged'); });
    expect(fetch).toHaveBeenCalledTimes(2);
    off2();
  });

  it('asks at once when no list has the branch, and keeps its own answer apart from the lists narrowed by name', async () => {
    const qc = new QueryClient();
    const fetch = vi.fn(async (_url: string) => answer(list([branch('fix/a', { number: 3, state: 'merged', title: 'x' }), branch('fix/a-2')])));
    vi.stubGlobal('fetch', fetch);
    const o = new QueryObserver(qc, branchQuery(qc, 'alice/app', 'fix/a'));
    const off = o.subscribe(() => {});
    await vi.waitFor(() => { expect(o.getCurrentResult().data?.pr?.number).toBe(3); });
    // Not the palette's list for the same text: that one is the host's whole answer, this one only seeds from a list.
    expect(qk.branch('alice/app', 'fix/a')).not.toEqual(qk.branches('alice/app', 'fix/a'));
    expect(qc.getQueryData(qk.branches('alice/app', 'fix/a'))).toBeUndefined();
    off();
  });
});
