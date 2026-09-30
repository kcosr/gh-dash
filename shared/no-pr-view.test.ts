import type { Query } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Branch, PullRequest } from './api';
import { api } from '../web/src/api/client';
import { followsDefaultSelection, qk, refetchAfterSync } from '../web/src/api/hooks';
import { branchListParams, exportTarget, exportUrl, issueListParams, prFetchParams } from '../web/src/lib/apiQuery';
import { branchItem, groupListItems } from '../web/src/lib/grouping';
import type { ListItem } from '../web/src/lib/grouping';
import { branchDiffId, carrySearch, parseUrlState, patchSearch } from '../web/src/lib/urlState';

/** A branch as GET /branches lists it, committed on September `day` at `hour`, local time. */
const branch = (repo: string, name: string, day: number, hour = 10): Branch => ({
  id: branchDiffId(repo, name), repo, name, headOid: 'a'.repeat(40), committedAt: new Date(2026, 8, day, hour).toISOString(),
  author: { login: 'alice', name: 'Alice', avatarUrl: null, isMe: true }, url: `https://github.com/${repo}/compare/main...${name}`,
  comments: { threads: 0, unresolved: 0 },
});

describe('"No PR yet" URL state', () => {
  it("is the PR list's own state, written and read back as the others are", () => {
    expect(parseUrlState('?state=nopr', 'prs').state).toBe('nopr');
    expect(patchSearch('?who=others', 'prs', { state: 'nopr' })).toBe('?who=others&state=nopr');
    expect(parseUrlState(patchSearch('?state=nopr', 'prs', { state: 'merged' }), 'prs').state).toBe('merged');
    // No other view has it: Issues keep their default state, the rest the PR list's.
    expect(parseUrlState('?state=nopr', 'issues').state).toBe('open');
    expect(parseUrlState('?state=nopr', 'activity').state).toBe('merged');
    // A PR filter: not carried to the other tabs.
    expect(carrySearch('?state=nopr&who=others')).toBe('?who=others');
  });

  it('keeps the grouping, density and filters, and a branch diff opened over it', () => {
    const search = patchSearch('?state=nopr&group=repo&density=titles&q=fix', 'prs', { diff: 'alice/app~fix/login' });
    expect(search).toBe('?state=nopr&group=repo&density=titles&q=fix&diff=alice/app~fix/login');
    expect(parseUrlState(search, 'prs')).toMatchObject({ state: 'nopr', group: 'repo', density: 'titles', q: 'fix', diff: 'alice/app~fix/login' });
  });
});

describe('"No PR yet" API params and export', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const s = parseUrlState('?repos=alice/app,alice/lib&vis=private&who=others&range=custom&from=2026-09-01&to=2026-09-30&state=nopr&comments=any&rel=0&q=login', 'prs');

  it('asks GET /branches for the PR list\'s scope, without its PR filters', () => {
    expect(branchListParams(s)).toEqual({ repos: 'alice/app,alice/lib', visibility: 'private', who: 'others', from: '2026-09-01', to: '2026-09-30', tz: expect.any(String), q: 'login' });
    // No PR state is asked for (and no PRs are, in this state); Issues read it as none of theirs.
    expect(prFetchParams(s).state).toBeUndefined();
    expect(issueListParams(s).state).toBe('open');
  });

  it('exports as JSON only, at /api/v1/branches; the PR states as before', () => {
    expect(exportTarget('prs', s)).toEqual({ endpoint: 'branches', params: branchListParams(s), md: false, label: 'branches with no pull request yet' });
    expect(exportUrl(exportTarget('prs', s))).toMatch(/^\/api\/v1\/branches\?repos=alice%2Fapp,alice%2Flib&visibility=private&who=others&from=2026-09-01&to=2026-09-30&tz=.+&q=login$/);
    expect(exportTarget('prs', parseUrlState('?state=open', 'prs'))).toMatchObject({ endpoint: 'prs', md: true, params: { state: 'open' } });
  });

  it('fetches GET /branches, which the sync refreshes and the default selection narrows', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [], total: 0, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.branchList({ repos: 'alice/app', who: 'me', limit: 1000 })).resolves.toEqual({ items: [], total: 0, nextCursor: null });
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/branches?repos=alice%2Fapp&who=me&limit=1000');
    const q = (queryKey: readonly unknown[]) => ({ queryKey }) as unknown as Query;
    expect(refetchAfterSync(q(qk.branchList(branchListParams(s))))).toBe(true);
    expect(followsDefaultSelection(q(qk.branchList(branchListParams(s))))).toBe(true);
  });
});

describe('"No PR yet" grouping', () => {
  const now = new Date(2026, 8, 30, 12);
  const items = [branch('alice/app', 'fix/login', 29), branch('alice/lib', 'docs', 29, 8), branch('alice/app', 'wip', 22), branch('alice/app', 'old', 2)].map(branchItem);

  it("groups branches by their head commit's day, week or month, newest first, counting them", () => {
    const byDay = groupListItems(items, 'day', () => false, now);
    expect(byDay.map((g) => [g.branches, g.prs, g.releases])).toEqual([[2, 0, 0], [1, 0, 0], [1, 0, 0]]);
    expect(byDay[0]!.title).toBe('Yesterday');
    expect(byDay[0]!.items.map((i) => (i as Extract<ListItem, { kind: 'branch' }>).branch.name)).toEqual(['fix/login', 'docs']);
    expect(groupListItems(items, 'week', () => false, now).map((g) => [g.title, g.branches])).toEqual([
      ['This week', 2], ['Last week', 1], ['Aug 31 – Sep 6', 1],
    ]);
    expect(groupListItems(items, 'month', () => false, now).map((g) => g.branches)).toEqual([4]);
  });

  it('groups them by repo, the fullest first, a private one marked', () => {
    const byRepo = groupListItems(items, 'repo', (repo) => repo === 'alice/lib', now);
    expect(byRepo.map((g) => [g.key, g.sub, g.branches])).toEqual([['alice/app', '', 3], ['alice/lib', 'private', 1]]);
  });

  it('dates a branch by its head commit, and one without (never listed) at the epoch rather than now', () => {
    expect(branchItem(branch('alice/app', 'x', 29)).at).toEqual(new Date(2026, 8, 29, 10));
    expect(branchItem({ ...branch('alice/app', 'x', 29), committedAt: null }).at.getTime()).toBe(0);
  });

  it('counts PRs and releases apart from branches, as before', () => {
    const pr = { id: 'alice/app#1', repo: 'alice/app', activityAt: new Date(2026, 8, 29).toISOString() } as PullRequest;
    const [g] = groupListItems([{ kind: 'pr', at: new Date(pr.activityAt), pr }], 'month', () => false, now);
    expect([g!.prs, g!.releases, g!.branches]).toEqual([1, 0, 0]);
  });
});
