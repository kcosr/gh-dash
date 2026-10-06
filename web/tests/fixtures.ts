import { mkdir, writeFile } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
import type { BranchListResponse, Diff, PullRequestDetail, Repo, Source, StatsResponse, SyncStatus } from '../../shared/api';

const at = '2026-10-05T10:00:00Z';
const actor = { login: 'owner', name: 'Test Owner', avatarUrl: null, isMe: true };
export const repos: Repo[] = [
  { key: 'owner/alpha', source: 'github.com', provider: 'github', name: 'alpha', nameWithOwner: 'owner/alpha', owner: 'owner' },
  { key: 'gitlab.example.com/team/beta', source: 'gitlab.example.com', provider: 'gitlab', name: 'beta', nameWithOwner: 'team/beta', owner: 'team' },
].map((r) => ({
  ...r, provider: r.provider as Repo['provider'], description: 'Browser regression fixture', url: `https://${r.source}/${r.nameWithOwner}`,
  visibility: 'public', isArchived: false, isFork: false, language: { name: 'TypeScript', color: '#3178c6' }, topics: [],
  defaultBranch: 'main', stars: 2, forks: 0, createdAt: at, pushedAt: at, lastActivityAt: at, pinned: false, hidden: false,
  setIds: [], stats: { openPrs: 1, openIssues: 0, mergedPrs30d: 0, commits30d: 1, newStars30d: 0, weeklyCommits: Array(12).fill(1) },
  syncedAt: at, trackedBy: 'owned', addedAt: null, unavailable: null, commentCount: 0,
}));
export const prs: PullRequestDetail[] = repos.map((r, i) => ({
  id: `${r.key}#${i ? 34 : 12}`, repo: r.key, number: i ? 34 : 12,
  title: i ? 'Update deployment documentation' : 'Improve cache refresh', body: 'Review the **updated behavior**.',
  state: 'open', isDraft: false, author: actor, mergedBy: null, createdAt: at, updatedAt: at, mergedAt: null,
  closedAt: null, activityAt: at, additions: 1, deletions: 1, changedFiles: 2, commitCount: 1,
  headRef: 'feature/a', baseRef: 'main', labels: [{ name: 'enhancement', color: 'a2eeef' }],
  url: `${r.url}/${i ? '-/merge_requests/34' : 'pull/12'}`, comments: { threads: 0, unresolved: 0 },
  commits: [], closingIssues: [],
}));
export const branches: BranchListResponse = {
  items: ['feature/a', 'feature/b'].map((name) => ({ name, headOid: 'b'.repeat(40), committedAt: at, pr: null })),
  defaultBranch: 'main', more: false,
};
const sources: Source[] = repos.map((r) => ({
  host: r.source, kind: r.provider, name: r.provider === 'github' ? 'GitHub' : 'GitLab', url: `https://${r.source}`,
  configured: true, removable: false, viewer: { login: 'owner', name: 'Test Owner', avatarUrl: null },
  account: null, repos: { owned: 1, added: 0, hidden: 0 },
  sync: { source: r.source, running: false, progress: null, lastSyncAt: at, lastResult: { newItems: 0, errors: [] }, rateLimit: null, tokenSource: 'env', viewer: 'owner', problem: null },
}));
const sync: SyncStatus = {
  running: false, trigger: null, progress: null, lastSyncAt: at, lastSyncDurationMs: 100,
  lastResult: { newItems: 0, errors: [] }, nextSyncAt: null, rateLimit: null, tokenSource: 'env', viewer: 'owner', sources: sources.map((s) => s.sync),
};
export const stats: StatsResponse = {
  range: { from: '2026-09-01', to: '2026-10-05', prevFrom: '2026-07-28', prevTo: '2026-08-31', bucket: 'week', tz: 'UTC' },
  tiles: Object.fromEntries(['prsMerged', 'commits', 'newStars', 'medianHoursToMerge', 'issuesClosed', 'activeRepos'].map((key) => [key, { value: 2, previous: 1, spark: [0, 1, 2] }])) as StatsResponse['tiles'],
  series: ['2026-09-21', '2026-09-28', '2026-10-05'].map((start) => ({ start, commits: 2, commitsMine: 1, prsOpened: 1, prsMerged: 1, prsMergedMine: 1, issuesOpened: 1, issuesClosed: 1, releases: 0, stars: 1, medianHoursToMerge: 4 })),
  stars: [{ date: '2026-10-04', total: 1, added: 1 }, { date: '2026-10-05', total: 2, added: 1 }],
  commitCalendar: [{ date: '2026-10-04', count: 1 }, { date: '2026-10-05', count: 2 }],
  byRepo: [{ repo: repos[0].key, commits: 2, prsMerged: 1, issues: 1, releases: 0, stars: 1, total: 5 }],
  contributors: [{ actor, commits: 2, prsMerged: 1, total: 3 }],
};
const empty = { items: [], nextCursor: null, total: 0, facets: { byRepo: {} } };

export const test = base.extend<{ mockApi: void }>({
  mockApi: [async ({ page }, use, info) => {
    const unexpected: string[] = [];
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname.replace('/api/v1/', ''));
      let body: unknown;
      if (path === 'stream') { await route.fulfill({ status: 404, json: { error: 'No stream in synthetic browser fixture' } }); return; }
      if (path === 'repos') body = { items: repos };
      else if (path.startsWith('repos/')) body = repos.find((r) => r.key === path.slice(6));
      else if (path === 'sources') body = { items: sources };
      else if (path === 'sync/status' || path === 'sync') body = sync;
      else if (path === 'me') body = { ...actor, tokenSource: 'env' };
      else if (path === 'account') body = { source: 'env', choice: 'auto', locked: true, login: 'owner', name: actor.name, avatarUrl: null, dbLogin: 'owner', mismatch: false, kind: 'fine-grained', expiresAt: null, scopes: null, repos: { total: 1, private: 0 }, error: null, gh: { available: false, path: null, login: null }, tokenFile: null, checkedAt: at };
      else if (path === 'instance') body = { version: 'browser-fixture', desktop: false, apiUrl: 'http://127.0.0.1:4187', mcpUrl: null, auth: { password: false, apiKey: false }, configPath: null, settings: { sources: [], ...Object.fromEntries(Object.entries({ host: '127.0.0.1', port: 4187, dbPath: 'synthetic', cacheDbPath: 'synthetic', sync: false, allowedHosts: [], tokenFile: null, defaultTz: 'UTC', glabPath: null }).map(([key, value]) => [key, { value, source: 'default' }])) } };
      else if (path === 'settings') body = { syncIntervalMinutes: 30, backfillDays: 365, myEmails: [], includeForks: false, diffCacheMb: 200 };
      else if (['sets', 'views', 'agents'].includes(path) || path.endsWith('/threads')) body = { items: [] };
      else if (path === 'threads') body = { ...empty, counts: { open: 0, resolved: 0 } };
      else if (path === 'prs') {
        const q = url.searchParams.get('q')?.toLowerCase();
        const selected = url.searchParams.get('repos')?.split(',');
        const source = url.searchParams.get('source');
        const items = prs.filter((p) => (!q || p.title.toLowerCase().includes(q)) && (!selected || selected.includes(p.repo)) && (!source || repos.find((r) => r.key === p.repo)?.source === source) && (!url.searchParams.get('state') || ['all', p.state].includes(url.searchParams.get('state')!)));
        body = { items, nextCursor: null, total: items.length, facets: { byRepo: Object.fromEntries(items.map((p) => [p.repo, 1])) } };
      } else if (path.endsWith('/diff')) {
        const match = /^(prs|branches)\/(.+)\/([^/]+(?:\/[^/]+)?)\/diff$/.exec(path);
        const pr = prs.find((p) => path.startsWith(`prs/${p.repo}/${p.number}/`)) ?? prs[0];
        body = {
          kind: path.startsWith('branches/') ? 'branch' : 'pr', repo: pr.repo, number: path.startsWith('branches/') ? null : pr.number,
          branch: match?.[3], baseRef: 'main', title: pr.title, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
          files: ['src/cache.ts', 'src/index.ts'].map((path) => ({ path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;' })),
          totalFiles: 2, additions: 2, deletions: 2, fetchedAt: at, url: `${pr.url}/files`,
        } satisfies Diff;
      } else if (path.startsWith('prs/')) body = prs.find((p) => path === `prs/${p.repo}/${p.number}`);
      else if (path.startsWith('branches/')) body = branches;
      else if (path === 'stats') body = stats;
      else if (path === 'diff-cache') body = { bytes: 0, entries: 0, maxBytes: 200 * 1024 * 1024 };
      else if (path === 'activity') body = { items: !url.searchParams.has('types') || url.searchParams.get('types')!.split(',').includes('pr') ? [{ type: 'pr', kind: 'opened', at, repo: prs[0].repo, actor, pr: prs[0] }] : [], total: 1, nextCursor: null, facets: { byRepo: { [prs[0].repo]: 1 }, byType: { pr: 1 }, byDay: { '2026-10-05': 1 } } };
      else if (['issues', 'releases', 'branches'].includes(path)) body = empty;
      else if (path.startsWith('blob/')) { await route.fulfill({ contentType: 'text/plain', body: 'export const value = 2;\n' }); return; }
      if (body === undefined) { unexpected.push(`${route.request().method()} ${url.pathname}`); await route.fulfill({ status: 501, json: { error: 'Unimplemented fixture endpoint' } }); return; }
      await route.fulfill({ json: body });
    });
    await use();
    await mkdir(info.outputDir, { recursive: true });
    const errorsPath = info.outputPath('browser-errors.json');
    await writeFile(errorsPath, JSON.stringify({ pageErrors: errors, consoleErrors, unexpectedApiRequests: unexpected }, null, 2));
    await info.attach('browser-errors', { path: errorsPath, contentType: 'application/json' });
    expect(unexpected, 'Every API request must have an explicit fixture').toEqual([]);
    expect(errors, 'No uncaught browser errors').toEqual([]);
    expect(consoleErrors, 'No JavaScript console errors').toEqual([]);
  }, { auto: true }],
});
export { expect };
