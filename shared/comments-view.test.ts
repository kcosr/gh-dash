import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadListItem } from './api';
import { api } from '../web/src/api/client';
import { exportTarget, exportUrl, tabCountParams, threadCountParams, threadListParams } from '../web/src/lib/apiQuery';
import { viewHref } from '../web/src/lib/contexts';
import type { Places } from '../web/src/lib/contexts';
import { byFileOrder, groupThreads, sortThreads, threadTarget, withHeld } from '../web/src/lib/threadList';
import { carrySearch, defaultsFor, parseUrlState, patchSearch, viewFromPath } from '../web/src/lib/urlState';

describe('Comments URL state', () => {
  it('has its own path and defaults', () => {
    for (const p of ['/comments', '/comments/']) expect(viewFromPath(p)).toBe('comments');
    expect(viewFromPath('/commentary')).toBe('prs');
    expect(parseUrlState('', 'comments')).toMatchObject({ status: 'open', kind: 'all', threadGroup: 'target', threadSort: 'recent', q: '' });
    expect(defaultsFor('prs')).toMatchObject({ status: 'open', kind: 'all', threadGroup: 'target', threadSort: 'recent' });
  });

  it('parses its filters, and falls back to the defaults for values it does not know', () => {
    expect(parseUrlState('?status=resolved&kind=commit&group=none&sort=file&q=race', 'comments'))
      .toMatchObject({ status: 'resolved', kind: 'commit', threadGroup: 'none', threadSort: 'file', q: 'race' });
    expect(parseUrlState('?status=all&kind=pr&group=repo&sort=oldest', 'comments'))
      .toMatchObject({ status: 'all', kind: 'pr', threadGroup: 'repo', threadSort: 'oldest' });
    expect(parseUrlState('?status=closed&kind=issue&group=week&sort=stars', 'comments'))
      .toMatchObject({ status: 'open', kind: 'all', threadGroup: 'target', threadSort: 'recent' });
  });

  it('reads `group` and `sort` as its own, leaving the other views their meaning', () => {
    // `repo` is a grouping in both; `stars` and `file` belong to one view each.
    const c = parseUrlState('?group=repo&sort=file', 'comments');
    expect(c).toMatchObject({ threadGroup: 'repo', threadSort: 'file', group: 'week', sort: 'activity' });
    expect(parseUrlState('?group=repo&sort=stars', 'prs')).toMatchObject({ group: 'repo', threadGroup: 'target' });
    expect(parseUrlState('?group=target&sort=file', 'prs')).toMatchObject({ group: 'week', sort: 'activity' });
    expect(parseUrlState('?sort=stars&group=none', 'repos')).toMatchObject({ sort: 'stars', threadGroup: 'target' });
    expect(parseUrlState('?sort=oldest', 'repos').sort).toBe('activity');
    // Only /comments has a status and kind.
    expect(parseUrlState('?status=resolved&kind=commit', 'prs')).toMatchObject({ status: 'open', kind: 'all' });
  });

  it('writes its params in order, omitting defaults, as `group` and `sort`', () => {
    expect(patchSearch('', 'comments', { status: 'open', kind: 'all', threadGroup: 'target', threadSort: 'recent' })).toBe('');
    expect(patchSearch('?q=race', 'comments', { threadSort: 'file', threadGroup: 'none', kind: 'commit', status: 'all' }))
      .toBe('?status=all&kind=commit&group=none&q=race&sort=file');
    const scoped = '?source=gitlab.example.com&repos=gitlab.example.com/alice/app&who=me&range=7d';
    expect(patchSearch(scoped, 'comments', { status: 'resolved' })).toBe(`${scoped}&status=resolved`);
    // Opening a thread's diff over the list, and closing it again.
    const open = patchSearch('?status=all&group=repo', 'comments', { diff: 'alice/app#12', thread: 7 });
    expect(open).toBe('?status=all&group=repo&diff=alice/app%2312&thread=7');
    expect(patchSearch(open, 'comments', { diff: null })).toBe('?status=all&group=repo');
    // A PR's details over it.
    expect(patchSearch('?sort=oldest', 'comments', { pr: 'alice/app#12' })).toBe('?sort=oldest&pr=alice/app%2312');
  });

  it("leaves the other views' URLs as they were", () => {
    expect(patchSearch('?group=month&state=open', 'prs', { density: 'full' })).toBe('?state=open&group=month&density=full');
    expect(patchSearch('?sort=stars&layout=list', 'repos', { q: 'x' })).toBe('?q=x&sort=stars&layout=list');
    // The Comments view's params mean nothing elsewhere and are dropped there.
    expect(patchSearch('?status=resolved&kind=commit&group=repo', 'prs', {})).toBe('?group=repo');
  });

  it('carries the scope across tabs, not its filters', () => {
    const from = '?source=github.com&repos=alice/app&vis=private&own=mine&status=all&kind=pr&group=none&sort=file&q=x';
    expect(carrySearch(from)).toBe('?source=github.com&repos=alice/app&vis=private&own=mine');
    expect(parseUrlState(carrySearch(from), 'comments')).toMatchObject({ source: 'github.com', repos: ['alice/app'], status: 'open', threadGroup: 'target', q: '' });
    expect(parseUrlState(carrySearch('?group=month&sort=stars&state=open'), 'comments')).toMatchObject({ threadGroup: 'target', threadSort: 'recent' });
  });
});

describe('Comments API params and export', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks for the scope and filters, without who or the date range', () => {
    const s = parseUrlState('?source=github.com&repos=alice/app,alice/lib&vis=private&own=mine&who=me&range=7d&status=all&kind=commit&sort=oldest&q=race', 'comments');
    expect(threadListParams(s)).toEqual({
      source: 'github.com', repos: 'alice/app,alice/lib', visibility: 'private', ownership: 'mine', q: 'race', status: 'all', kind: 'commit', sort: 'oldest',
    });
    // File order is the client's, within the newest-first list; the defaults stay out of the URL but the status.
    const d = parseUrlState('?sort=file&group=none', 'comments');
    expect(Object.fromEntries(Object.entries(threadListParams(d)).filter(([, v]) => v !== undefined))).toEqual({ status: 'open' });
    expect(threadListParams(parseUrlState('?repos=', 'comments')).repos).toBe('');
  });

  it('exports the same list as the API and as Markdown', () => {
    const s = parseUrlState('?source=gitlab.example.com&status=resolved&kind=pr&q=a%20b', 'comments');
    const t = exportTarget('comments', s);
    expect(t).toEqual({ endpoint: 'threads', md: true, csv: false, label: 'comments', params: threadListParams(s) });
    expect(exportUrl(t)).toBe('/api/v1/threads?source=gitlab.example.com&q=a%20b&status=resolved&kind=pr');
    expect(exportUrl(t, { format: 'md' })).toBe('/api/v1/threads?source=gitlab.example.com&q=a%20b&status=resolved&kind=pr&format=md');
  });

  it("counts the tab's unresolved threads in the scope alone", () => {
    const s = parseUrlState('?source=github.com&repos=alice/app&status=resolved&kind=commit&q=x', 'comments');
    expect(threadCountParams(s)).toEqual({ source: 'github.com', repos: 'alice/app', visibility: undefined, ownership: undefined, status: 'open', limit: 1 });
  });

  it('counts the tab for where it leads: from Settings, the Comments list as remembered', () => {
    const places: Places = { v: 1, last: 'github.com', places: {}, views: { 'github.com': { comments: '/comments?source=github.com&repos=alice/app&vis=private&own=mine&status=all&group=repo' } } };
    const scope = (pathname: string, search: string) => {
      const q = tabCountParams(viewHref(places, 'github.com', '/comments', pathname, search));
      return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined));
    };
    expect(scope('/settings', '')).toEqual({ source: 'github.com', repos: 'alice/app', visibility: 'private', ownership: 'mine', status: 'open', limit: 1 });
    // Elsewhere the page's scope goes with the tab, and is what it counts.
    expect(scope('/prs', '?source=github.com&repos=alice/lib&state=open')).toEqual({ source: 'github.com', repos: 'alice/lib', status: 'open', limit: 1 });
    // Nothing remembered: from Settings, the context's default selection.
    const none: Places = { v: 1, last: 'github.com', places: {}, views: {} };
    expect(tabCountParams(viewHref(none, 'github.com', '/comments', '/settings', ''))).toMatchObject({ source: 'github.com', repos: undefined, status: 'open' });
    expect(tabCountParams('/comments')).toMatchObject({ source: undefined, repos: undefined, visibility: undefined, ownership: undefined });
  });

  it('fetches GET /threads', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [], total: 0, nextCursor: null, counts: { open: 0, resolved: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.threadList({ repos: 'alice/app', status: 'all', limit: 1000 })).resolves.toMatchObject({ counts: { open: 0, resolved: 0 } });
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/threads?repos=alice%2Fapp&status=all&limit=1000');
  });
});

let seq = 0;
/** A thread in the list; `at` is its last activity (minutes into the day, for readable orders). */
function item(o: Partial<ThreadListItem> & { at: number }): ThreadListItem {
  const { at, ...rest } = o;
  const id = rest.id ?? ++seq;
  return {
    id, kind: 'pr', repo: 'alice/app', number: 1, commitOid: 'a'.repeat(40), baseOid: null, path: 'src/a.ts', side: 'new', startLine: 1, endLine: 1,
    snippet: null, status: 'open', resolvedAt: null, resolvedBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 8, 1, 0, at)).toISOString(),
    comments: [{ id: id * 10, author: { id: 1, kind: 'self', name: 'You' }, body: `thread ${id}`, createdAt: '2026-09-01T00:00:00.000Z', editedAt: null }],
    targetTitle: 'A PR', prState: 'open', targetUrl: 'https://github.com/alice/app/pull/1', earlierPush: false,
    ...rest,
  };
}

describe('Comments grouping and order', () => {
  const commit = 'c'.repeat(40);
  // Two PRs and a commit in alice/app, one PR in alice/lib. Activity (minutes): higher is newer.
  const t = {
    a1: item({ id: 1, number: 1, path: 'src/b.ts', startLine: 20, endLine: 22, at: 50 }),
    a2: item({ id: 2, number: 1, path: null, side: null, startLine: null, endLine: null, at: 10 }),
    a3: item({ id: 3, number: 1, path: 'src/a.ts', startLine: 5, endLine: 5, at: 30, status: 'resolved' }),
    b1: item({ id: 4, number: 2, path: 'README.md', at: 40 }),
    c1: item({ id: 5, kind: 'commit', number: null, commitOid: commit, path: 'src/z.ts', startLine: 3, endLine: 3, at: 60, prState: null }),
    c2: item({ id: 6, kind: 'commit', number: null, commitOid: commit, path: 'src/z.ts', startLine: null, endLine: null, at: 20, prState: null }),
    l1: item({ id: 7, repo: 'alice/lib', number: 9, path: 'lib.ts', at: 45 }),
  };
  const all = Object.values(t);
  const ids = (xs: { id: number }[]) => xs.map((x) => x.id);
  const shape = (gs: ReturnType<typeof groupThreads>) => gs.map((g) => [g.key, ids(g.items)]);

  it('names the diff a thread opens in', () => {
    expect(threadTarget(t.a1)).toBe('alice/app#1');
    expect(threadTarget(t.c1)).toBe(`alice/app@${commit}`);
  });

  it('reads general threads first, then by path and line', () => {
    expect(ids(sortThreads([t.a1, t.a3, t.a2]))).toEqual([2, 3, 1]);
    // A thread on a whole file comes before the file's lines; ties by id.
    expect(ids(sortThreads([t.c1, t.c2]))).toEqual([6, 5]);
    expect(byFileOrder(item({ id: 20, at: 0 }), item({ id: 21, at: 0 }))).toBeLessThan(0);
  });

  it('per PR or commit: groups by their newest thread, threads by activity or in file order', () => {
    expect(shape(groupThreads(all, 'target', 'recent'))).toEqual([
      [`alice/app@${commit}`, [5, 6]], ['alice/app#1', [1, 3, 2]], ['alice/lib#9', [7]], ['alice/app#2', [4]],
    ]);
    expect(shape(groupThreads(all, 'target', 'file'))).toEqual([
      [`alice/app@${commit}`, [6, 5]], ['alice/app#1', [2, 3, 1]], ['alice/lib#9', [7]], ['alice/app#2', [4]],
    ]);
    // Oldest first: groups by their oldest thread.
    expect(shape(groupThreads(all, 'target', 'oldest'))).toEqual([
      ['alice/app#1', [2, 3, 1]], [`alice/app@${commit}`, [6, 5]], ['alice/app#2', [4]], ['alice/lib#9', [7]],
    ]);
  });

  it('per repo: by activity, or each target read in turn', () => {
    expect(shape(groupThreads(all, 'repo', 'recent'))).toEqual([['alice/app', [5, 1, 4, 3, 6, 2]], ['alice/lib', [7]]]);
    expect(shape(groupThreads(all, 'repo', 'oldest'))).toEqual([['alice/app', [2, 6, 3, 4, 1, 5]], ['alice/lib', [7]]]);
    expect(shape(groupThreads(all, 'repo', 'file'))).toEqual([['alice/app', [6, 5, 2, 3, 1, 4]], ['alice/lib', [7]]]);
  });

  it('ungrouped: one flat list, and in file order by repo, target, path and line', () => {
    expect(shape(groupThreads(all, 'none', 'recent'))).toEqual([['', [5, 1, 7, 4, 3, 6, 2]]]);
    expect(shape(groupThreads(all, 'none', 'oldest'))).toEqual([['', [2, 6, 3, 4, 7, 1, 5]]]);
    expect(shape(groupThreads(all, 'none', 'file'))).toEqual([['', [6, 5, 2, 3, 1, 4, 7]]]);
    expect(groupThreads([], 'none', 'recent')).toEqual([]);
    expect(groupThreads([], 'target', 'file')).toEqual([]);
  });

  it('breaks ties in activity by id, as the server pages them', () => {
    const x = item({ id: 30, number: 5, at: 5 }), y = item({ id: 31, number: 5, at: 5 });
    expect(ids(groupThreads([x, y], 'none', 'recent')[0]!.items)).toEqual([31, 30]);
    expect(ids(groupThreads([y, x], 'none', 'oldest')[0]!.items)).toEqual([30, 31]);
  });

  it("counts a group's unresolved threads and knows its last activity", () => {
    const g = groupThreads(all, 'target', 'recent').find((x) => x.key === 'alice/app#1')!;
    expect(g).toMatchObject({ repo: 'alice/app', open: 2, lastAt: t.a1.updatedAt });
    expect(groupThreads(all, 'none', 'recent')[0]).toMatchObject({ repo: null, open: 6 });
  });

  it('orders by the time given, so a row can keep its place after a change', () => {
    const moved = { ...t.a2, updatedAt: new Date(Date.UTC(2026, 8, 1, 2)).toISOString() };
    const list = all.map((x) => (x.id === moved.id ? moved : x));
    expect(ids(groupThreads(list, 'none', 'recent')[0]!.items)[0]).toBe(2);
    const held = new Map(all.map((x) => [x.id, x.updatedAt]));
    const g = groupThreads(list, 'none', 'recent', (x) => held.get(x.id)!);
    expect(ids(g[0]!.items)).toEqual([5, 1, 7, 4, 3, 6, 2]);
    // The group still reports the real last activity.
    expect(g[0]!.lastAt).toBe(moved.updatedAt);
  });
});

describe('Comments: threads held in view after a change from the list', () => {
  const open = (id: number) => item({ id, at: id });
  const resolved = (id: number) => item({ id, at: id, status: 'resolved' });
  const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

  it('shows a held thread the filter now leaves out, from the answer without the status filter', () => {
    // Unresolved: 2 was resolved from the list; the list's answer no longer has it, the other one does.
    expect(ids(withHeld([open(1), open(3)], [open(1), resolved(2), open(3), resolved(4)], new Set([2])))).toEqual([1, 3, 2]);
    // Only what was held: 4 (resolved elsewhere, or long ago) stays out.
    expect(ids(withHeld([open(1)], [open(1), resolved(4)], new Set()))).toEqual([1]);
  });

  it('lets go of a held thread that was deleted or left the scope (neither answer has it)', () => {
    expect(ids(withHeld([open(1), open(3)], [open(1), open(3)], new Set([2])))).toEqual([1, 3]);
    // Its repo hidden from the default selection: both answers drop it together.
    expect(ids(withHeld([open(3)], [open(3)], new Set([1, 2])))).toEqual([3]);
  });

  it("takes the list's own copy of a held thread that matches the filter again", () => {
    const again = open(2);
    const out = withHeld([open(1), again], [open(1), { ...again, updatedAt: '2000-01-01T00:00:00.000Z' }], new Set([2]));
    expect(ids(out)).toEqual([1, 2]);
    expect(out[1]).toBe(again);
  });

  it('shows the list alone until the other answer is in', () => {
    expect(ids(withHeld([open(1)], undefined, new Set([2])))).toEqual([1]);
  });
});
