import { describe, expect, it } from 'vitest';
import { createThread, getPrincipal, SELF_PRINCIPAL_ID } from '../../db/comments';
import { ensureSource } from '../../db/sources';
import { upsertPr } from '../../db/write';
import * as comments from '../../services/comments';
import { addedFile, commitDiff, mcpHarness, serveBranch, servePr, sha } from '../../test/mcp';
import { actor, addManualRepo, GITLAB_HOST, prRecord, seedDb, seedGitLab } from '../../test/seed';

const HEAD = sha('a');
const BASE = sha('b');

function withGitLab() {
  const db = seedDb();
  seedGitLab(db);
  return db;
}

describe('whoami', () => {
  it("names the calling agent, the version and the sources", async () => {
    const { ok, agent, config } = mcpHarness({ db: withGitLab() });
    expect(await ok('whoami')).toEqual({
      agent: { id: agent.id, name: 'Claude' },
      server: { version: config.version },
      sources: [{ host: 'github.com', kind: 'github' }, { host: GITLAB_HOST, kind: 'gitlab' }],
    });
  });
});

describe('list_repos', () => {
  it('lists every live repo, most recent first, with open PRs and threads', async () => {
    const h = mcpHarness({ db: withGitLab() });
    addManualRepo(h.db, 'bob/lib');
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    createThread(h.db, { repoId: app, kind: 'pr', number: 2 }, { commitOid: HEAD, baseOid: null, anchor: { path: null, side: null, startLine: null, endLine: null, snippet: null }, body: 'Hm' }, getPrincipal(h.db, SELF_PRINCIPAL_ID)!);
    const { repos, total } = await h.ok('list_repos');
    expect(total).toBe(7);
    expect(repos.find((r: { key: string }) => r.key === 'alice/app')).toEqual({
      key: 'alice/app', provider: 'github', url: 'https://github.com/alice/app', defaultBranch: 'main', trackedBy: 'owned', openPrs: 0, openThreads: 1,
    });
    expect(repos.find((r: { key: string }) => r.key === 'alice/old')).toMatchObject({ archived: true });
    expect(repos.find((r: { key: string }) => r.key === 'alice/hidden')).toMatchObject({ hidden: true });
    expect(repos.find((r: { key: string }) => r.key === `${GITLAB_HOST}/platform/app`)).toMatchObject({ provider: 'gitlab', openThreads: 0 });
  });

  it('filters by text, source and ownership, and limits', async () => {
    const h = mcpHarness({ db: withGitLab() });
    addManualRepo(h.db, 'bob/lib');
    const keys = async (args: Record<string, unknown>) => (await h.ok('list_repos', args)).repos.map((r: { key: string }) => r.key);
    expect(await keys({ ownership: 'others' })).toEqual(['bob/lib']);
    expect(await keys({ source: GITLAB_HOST })).toEqual([`${GITLAB_HOST}/platform/app`]);
    expect(await keys({ query: 'secr' })).toEqual(['alice/secret']);
    expect(await keys({ limit: 2 })).toHaveLength(2);
    expect(await h.fails('list_repos', { source: 'gitlab.other.example' })).toContain("isn't a source");
    expect(await h.fails('list_repos', { limit: 0 })).toMatch(/^Invalid arguments: limit/);
  });
});

describe('resolve_repo', () => {
  function setup() {
    const db = withGitLab();
    // A GitLab instance under a relative root, with a project there.
    const corp = ensureSource(db, { kind: 'gitlab', host: 'git.corp.example', baseUrl: 'https://git.corp.example/gitlab' });
    addManualRepo(db, 'team/tools/cli', { source: corp, url: 'https://git.corp.example/gitlab/team/tools/cli' });
    return mcpHarness({ db });
  }

  it('reads every form of git remote, offline', async () => {
    const h = setup();
    const key = async (remote_url: string) => (await h.ok('resolve_repo', { remote_url })).key;
    for (const url of [
      'https://github.com/alice/app.git',
      'https://github.com/alice/app',
      'http://www.github.com/Alice/App/',
      'git@github.com:alice/app.git',
      'ssh://git@github.com/alice/app.git',
      'ssh://git@github.com:22/alice/app',
      'https://x-access-token:s3cret@github.com/alice/app.git',
      'https://github.com/alice/app/pull/2',
      'alice/app',
      'app',
    ]) {
      expect(await key(url), url).toBe('alice/app');
    }
    for (const url of [
      `git@${GITLAB_HOST}:platform/app.git`,
      `https://${GITLAB_HOST}/platform/app.git`,
      `https://oauth2:tok@${GITLAB_HOST}/platform/app`,
      `ssh://git@${GITLAB_HOST}:2222/platform/app.git`,
      `https://${GITLAB_HOST}/platform/app/-/merge_requests/2`,
      `${GITLAB_HOST}/platform/app`,
    ]) {
      expect(await key(url), url).toBe(`${GITLAB_HOST}/platform/app`);
    }
    expect(await key('https://git.corp.example/gitlab/team/tools/cli.git')).toBe('git.corp.example/team/tools/cli');
    expect(await key('git@git.corp.example:team/tools/cli.git')).toBe('git.corp.example/team/tools/cli');
    expect(await h.ok('resolve_repo', { remote_url: `git@${GITLAB_HOST}:platform/app.git` })).toEqual({
      key: `${GITLAB_HOST}/platform/app`, provider: 'gitlab', url: `https://${GITLAB_HOST}/platform/app`, tracked: true,
    });
  });

  it('says when the host is no source, or the repository isn\'t tracked, and where the user adds them', async () => {
    const h = setup();
    expect(await h.fails('resolve_repo', { remote_url: 'git@gitlab.other.example:x/y.git' })).toBe(
      "gitlab.other.example isn't a source in gh-dash. The user can add it in gh-dash (Settings → Sources), then track the repository.",
    );
    expect(await h.fails('resolve_repo', { remote_url: 'gitlab.other.example/x/y' })).toContain("gitlab.other.example isn't a source");
    expect(await h.fails('resolve_repo', { remote_url: 'https://github.com/bob/nope.git' })).toBe(
      "bob/nope isn't tracked in gh-dash. The user can add it in gh-dash (Repositories → Add).",
    );
    expect(await h.fails('resolve_repo', { remote_url: `https://${GITLAB_HOST}/platform/other.git` })).toContain(`${GITLAB_HOST}/platform/other isn't tracked`);
    // The project is at the relative root, not beside it.
    expect(await h.fails('resolve_repo', { remote_url: 'https://git.corp.example/team/tools/cli.git' })).toContain("Can't read a GitLab project");
    expect(await h.fails('resolve_repo', { remote_url: 'not a remote' })).toContain("Can't read a GitHub repository");
  });
});

describe('list_prs', () => {
  it('lists open PRs by default, however old, with their head and comment counts', async () => {
    const h = mcpHarness();
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    upsertPr(h.db, app, prRecord(4, { state: 'open', createdAt: '2024-01-01T00:00:00Z', title: 'Ancient', headOid: HEAD, headRef: 'old-branch' }));
    const { items, total, nextCursor } = await h.ok('list_prs', { repo: 'alice/app' });
    expect(total).toBe(2);
    expect(nextCursor).toBeNull();
    expect(items.map((p: { number: number }) => p.number)).toEqual([2, 4]);
    expect(items[0]).toEqual({
      id: 'alice/app#2', repo: 'alice/app', number: 2, ref: 'alice/app#2', title: 'Add parser', state: 'open', author: 'bob', headRef: 'feature',
      baseRef: 'main', headOid: '2'.repeat(40), updatedAt: '2026-09-22T09:00:00Z', comments: { threads: 0, unresolved: 0 }, url: 'https://github.com/alice/x/pull/2',
    });
    expect(items[1]).toMatchObject({ title: 'Ancient', headOid: HEAD });
  });

  it('filters by state, comments and words, pages, and words GitLab refs with !', async () => {
    const h = mcpHarness({ db: withGitLab() });
    const numbers = async (args: Record<string, unknown>) => (await h.ok('list_prs', args)).items.map((p: { ref: string }) => p.ref);
    expect(await numbers({ repo: 'alice/app', state: 'all' })).toEqual(['alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(await numbers({ repo: 'alice/app', state: 'merged' })).toEqual(['alice/app#1']);
    expect(await numbers({ repo: 'alice/app', state: 'all', q: 'parser' })).toEqual(['alice/app#2']);
    expect(await numbers({ repo: 'alice/app', comments: 'any' })).toEqual([]);
    expect(await numbers({ repo: `${GITLAB_HOST}/platform/app` })).toEqual([`${GITLAB_HOST}/platform/app!2`]);
    const first = await h.ok('list_prs', { repo: 'alice/app', state: 'all', limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await h.ok('list_prs', { repo: 'alice/app', state: 'all', limit: 2, cursor: first.nextCursor });
    expect(second.items.map((p: { number: number }) => p.number)).toEqual([1]);
    expect(await h.fails('list_prs', { repo: 'alice/nope' })).toContain("alice/nope isn't tracked");
  });
});

describe('find_pr', () => {
  function setup() {
    const h = mcpHarness();
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    upsertPr(h.db, app, prRecord(5, {
      state: 'open', createdAt: '2026-09-26T00:00:00Z', headRef: 'topic/x', headOid: sha('e'), author: actor('carol'),
      commits: [{ oid: sha('d'), headline: 'one', committedAt: '2026-09-25T00:00:00Z', url: 'u', author: actor('carol') }],
    }));
    upsertPr(h.db, app, prRecord(6, {
      state: 'merged', createdAt: '2026-09-20T00:00:00Z', mergedAt: '2026-09-21T00:00:00Z', headRef: 'topic/x', headOid: sha('9'), squashCommitOid: sha('f'),
    }));
    return h;
  }

  it('finds PRs by head branch, open ones first', async () => {
    const h = setup();
    const found = await h.ok('find_pr', { repo: 'alice/app', branch: 'topic/x' });
    expect(found.items.map((p: { number: number; match: string }) => [p.number, p.match])).toEqual([[5, 'branch'], [6, 'branch']]);
    expect(found.items[0]).toMatchObject({ ref: 'alice/app#5', state: 'open', author: 'carol', headOid: sha('e') });
    expect((await h.ok('find_pr', { repo: 'alice/app', branch: 'refs/heads/topic/x' })).items).toHaveLength(2);
    expect(found.note).toBeUndefined();
    expect((await h.ok('find_pr', { repo: 'alice/app', branch: 'nope' })).items).toEqual([]);
  });

  it('points a branch with no PR to get_branch and add_comment, unless it is the default branch or no branch name', async () => {
    const h = setup();
    const none = await h.ok('find_pr', { repo: 'alice/app', branch: 'refs/heads/new/work' });
    expect(none).toEqual({
      items: [],
      note: "No pull request from new/work in gh-dash. If it's pushed, get_branch reads it and add_comment with branch comments on it " +
        '(shared with a PR opened from it later); if it only exists locally, push it first.',
    });
    // Nothing to suggest for the default branch (branches are compared against it), a name git refuses, or a search by commit.
    expect(await h.ok('find_pr', { repo: 'alice/app', branch: 'main' })).toEqual({ items: [] });
    expect(await h.ok('find_pr', { repo: 'alice/app', branch: 'a..b' })).toEqual({ items: [] });
    expect(await h.ok('find_pr', { repo: 'alice/app', commit: sha('7') })).toEqual({ items: [] });
  });

  it('finds PRs by a commit: their head, one of theirs, or what they were squashed as; short SHAs too', async () => {
    const h = setup();
    const match = async (commit: string) => (await h.ok('find_pr', { repo: 'alice/app', commit })).items.map((p: { number: number; match: string }) => `${p.number} ${p.match}`);
    expect(await match(sha('e'))).toEqual(['5 head']);
    expect(await match('EEEEEEE')).toEqual(['5 head']);
    expect(await match(sha('d'))).toEqual(['5 commit']);
    expect(await match(sha('f').slice(0, 10))).toEqual(['6 merged']);
    expect(await match(sha('7'))).toEqual([]);
  });

  it('needs exactly one of branch or commit', async () => {
    const h = setup();
    expect(await h.fails('find_pr', { repo: 'alice/app' })).toContain('exactly one of branch or commit');
    expect(await h.fails('find_pr', { repo: 'alice/app', branch: 'a', commit: sha('e') })).toContain('exactly one');
    expect(await h.fails('find_pr', { repo: 'alice/app', commit: 'zz' })).toContain('commit SHA');
  });
});

describe('get_pr', () => {
  it("gives the PR's revisions, fetch refspec and files from its diff", async () => {
    const h = mcpHarness();
    servePr(h.code, 'alice/app', 2, HEAD, BASE, [addedFile('src/a.ts', ['x']), addedFile('src/b.ts', ['y'], { previousPath: 'src/old.ts', status: 'renamed' })]);
    h.db.run("UPDATE pull_requests SET body = ? WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE key = 'alice/app')", [`  Adds a parser.\n\n${'x'.repeat(3000)}`]);
    const pr = await h.ok('get_pr', { repo: 'app', number: 2 });
    expect(pr).toMatchObject({
      repo: 'alice/app', number: 2, ref: 'alice/app#2', title: 'Add parser', state: 'open', headRef: 'feature', baseRef: 'main',
      headOid: HEAD, baseOid: BASE, fetch: 'pull/2/head', commits: 1, comments: { threads: 0, unresolved: 0 },
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
        { path: 'src/b.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 1, deletions: 0 },
      ],
    });
    expect(pr.body).toMatch(/^Adds a parser\.\n\nx+… \(1016 more characters\)$/);
    expect(pr.note).toBeUndefined();
  });

  it('counts the files the host did not list, whatever the number', async () => {
    const h = mcpHarness();
    servePr(h.code, 'alice/app', 2, HEAD, BASE, [addedFile('src/a.ts', ['x']), addedFile('src/b.ts', ['y'])]);
    h.code.prs.get('alice/app#2')!.totalFiles = 5;
    const pr = await h.ok('get_pr', { repo: 'alice/app', number: 2 });
    expect(pr.files).toHaveLength(2);
    expect(pr.moreFiles).toBe(3);
    servePr(h.code, 'alice/app', 2, HEAD, BASE, [addedFile('src/a.ts', ['x'])]);
    h.db.run("UPDATE pull_requests SET updated_at = '2099-01-01T00:00:00Z' WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE key = 'alice/app')");
    expect((await h.ok('get_pr', { repo: 'alice/app', number: 2 })).moreFiles).toBeUndefined();
  });

  it("leaves files and baseOid out, with a note, when there's no diff", async () => {
    const h = mcpHarness({ db: withGitLab() });
    h.code.down = 'No GitLab token';
    const mr = await h.ok('get_pr', { repo: `${GITLAB_HOST}/platform/app`, number: 2 });
    expect(mr).toMatchObject({ ref: `${GITLAB_HOST}/platform/app!2`, fetch: 'merge-requests/2/head', headOid: '2'.repeat(40) });
    expect(mr.files).toBeUndefined();
    expect(mr.baseOid).toBeUndefined();
    expect(mr.note).toContain('No GitLab token');
    expect(await h.fails('get_pr', { repo: 'alice/app', number: 99 })).toBe('Pull request not found');
  });
});

describe('list_branches', () => {
  const at = (h: ReturnType<typeof mcpHarness>) => {
    serveBranch(h.code, 'alice/app', 'topic/x', sha('1'), BASE, [], '2026-09-28T10:00:00Z');
    serveBranch(h.code, 'alice/app', 'feature', sha('2'), BASE, [], '2026-09-29T10:00:00Z');
    serveBranch(h.code, 'alice/app', 'old', sha('3'), BASE, [], '2026-09-01T10:00:00Z');
    serveBranch(h.code, 'alice/app', 'undated', sha('4'), BASE, []);
    serveBranch(h.code, 'alice/app', 'main', sha('5'), BASE, [], '2026-09-30T10:00:00Z');
    // Another repo's branches aren't this one's.
    serveBranch(h.code, 'alice/secret', 'other', sha('6'), BASE, []);
    h.db.run("UPDATE pull_requests SET cross_repo = 0 WHERE repo_id = (SELECT id FROM repos WHERE key = 'alice/app') AND number IN (2, 3)");
    return h;
  };

  it("lists the code host's branches newest first, compactly, with the newest PR from each, and not the default branch", async () => {
    const h = at(mcpHarness());
    const out = await h.ok('list_branches', { repo: 'alice/app' });
    expect(out).toEqual({
      defaultBranch: 'main',
      items: [
        // PRs 1, 2 and 3 are all from "feature": the newest is 3 (the seed's closed one).
        { name: 'feature', headOid: sha('2'), committedAt: '2026-09-29T10:00:00Z', pr: { number: 3, ref: 'alice/app#3', state: 'closed', title: 'PR 3' } },
        { name: 'topic/x', headOid: sha('1'), committedAt: '2026-09-28T10:00:00Z' },
        { name: 'old', headOid: sha('3'), committedAt: '2026-09-01T10:00:00Z' },
        { name: 'undated', headOid: sha('4') },
      ],
    });
    expect(h.code.requests).toEqual(['branches alice/app']);
  });

  it('filters by name, cuts to a limit, and says when there are more', async () => {
    const h = at(mcpHarness());
    expect((await h.ok('list_branches', { repo: 'app', query: 'X' })).items.map((b: { name: string }) => b.name)).toEqual(['topic/x']);
    expect(h.code.requests).toContain('branches alice/app X');
    const cut = await h.ok('list_branches', { repo: 'alice/app', limit: 2 });
    expect(cut.items.map((b: { name: string }) => b.name)).toEqual(['feature', 'topic/x']);
    expect(cut.more).toBe(true);
    expect((await h.ok('list_branches', { repo: 'alice/app', limit: 4 })).more).toBeUndefined();
    expect((await h.ok('list_branches', { repo: 'alice/app', query: 'nothing' })).items).toEqual([]);
  });

  it("words a GitLab project's PRs as its merge requests, and says when the code host can't be asked or the repo isn't tracked", async () => {
    const h = mcpHarness({ db: withGitLab() });
    const key = `${GITLAB_HOST}/platform/app`;
    serveBranch(h.code, key, 'rework', sha('7'), BASE, []);
    h.db.run("UPDATE pull_requests SET head_ref = 'rework', cross_repo = 0 WHERE repo_id = (SELECT id FROM repos WHERE key = ?) AND number = 2", [key]);
    expect((await h.ok('list_branches', { repo: key })).items).toEqual([
      { name: 'rework', headOid: sha('7'), pr: { number: 2, ref: `${GITLAB_HOST}/platform/app!2`, state: 'open', title: 'Rework config' } },
    ]);
    h.code.down = 'No GitLab token';
    expect(await h.fails('list_branches', { repo: key, query: 'other' })).toContain('No GitLab token');
    expect(await h.fails('list_branches', { repo: 'alice/nope' })).toContain("alice/nope isn't tracked");
  });
});

describe('get_branch', () => {
  const BHEAD = sha('d');
  /** topic/x of alice/app at BHEAD over BASE, with two changed files. */
  function setup() {
    const h = mcpHarness();
    serveBranch(h.code, 'alice/app', 'topic/x', BHEAD, BASE, [addedFile('src/a.ts', ['x']), addedFile('src/b.ts', ['y'], { previousPath: 'src/old.ts', status: 'renamed' })]);
    return h;
  }

  it("gives the branch's revisions, fetch name, compare link and files from its diff", async () => {
    const h = setup();
    expect(await h.ok('get_branch', { repo: 'app', branch: 'topic/x' })).toEqual({
      repo: 'alice/app', name: 'topic/x', ref: 'alice/app branch topic/x', baseRef: 'main', url: 'https://github.com/alice/app/compare/main...topic/x',
      fetch: 'topic/x', headOid: BHEAD, baseOid: BASE, comments: { threads: 0, unresolved: 0 },
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
        { path: 'src/b.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 1, deletions: 0 },
      ],
    });
    expect(h.code.requests).toEqual(['branch alice/app~topic/x', 'compare alice/app~topic/x']);
  });

  it('names the newest PR from it that is synced, and counts the threads its review shows', async () => {
    const h = setup();
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    upsertPr(h.db, app, prRecord(5, { state: 'open', createdAt: '2026-09-26T00:00:00Z', headRef: 'topic/x', title: 'Topic', crossRepo: false }));
    // From a fork of the same branch name: not this branch's.
    upsertPr(h.db, app, prRecord(6, { state: 'open', createdAt: '2026-09-27T00:00:00Z', headRef: 'topic/x', title: 'Fork topic', crossRepo: true }));
    const deps = { db: h.db, bus: h.bus };
    const self = getPrincipal(h.db, SELF_PRINCIPAL_ID)!;
    const resolved = comments.createBranchThread(deps, self, 'alice/app', 'topic/x', { commitOid: BHEAD, body: 'On the branch' });
    comments.setThreadStatus(deps, self, resolved.id, 'resolved');
    comments.createBranchThread(deps, self, 'alice/app', 'topic/x', { commitOid: BHEAD, body: 'Still open' });
    comments.createPrThread(deps, self, 'alice/app', 5, { commitOid: BHEAD, body: 'On the PR' });
    comments.createPrThread(deps, self, 'alice/app', 6, { commitOid: BHEAD, body: "On the fork's PR" });
    comments.createBranchThread(deps, self, 'alice/app', 'other', { commitOid: BHEAD, body: 'Another branch' });
    expect(await h.ok('get_branch', { repo: 'alice/app', branch: 'topic/x' })).toMatchObject({
      pr: { number: 5, ref: 'alice/app#5', state: 'open', title: 'Topic' }, comments: { threads: 3, unresolved: 2 },
    });
    // A branch nobody has written on or opened a PR from.
    serveBranch(h.code, 'alice/app', 'quiet', sha('8'), BASE, []);
    const quiet = await h.ok('get_branch', { repo: 'alice/app', branch: 'quiet' });
    expect(quiet.pr).toBeUndefined();
    expect(quiet.comments).toEqual({ threads: 0, unresolved: 0 });
  });

  it('lists 300 files and counts the rest', async () => {
    const h = setup();
    serveBranch(h.code, 'alice/app', 'big', sha('9'), BASE, Array.from({ length: 302 }, (_, i) => addedFile(`f${i}.ts`, ['x'])));
    const big = await h.ok('get_branch', { repo: 'alice/app', branch: 'big' });
    expect(big.files).toHaveLength(300);
    expect(big.moreFiles).toBe(2);
    expect((await h.ok('get_branch', { repo: 'alice/app', branch: 'topic/x' })).moreFiles).toBeUndefined();
  });

  it('counts the files the host left out of a comparison that timed out, below the 300 the tool lists', async () => {
    const h = setup();
    // GitLab's compare_timeout: it lists ten files, and says there are more by counting one above them.
    serveBranch(h.code, 'alice/app', 'slow', sha('9'), BASE, Array.from({ length: 10 }, (_, i) => addedFile(`f${i}.ts`, ['x'])));
    h.code.branches.get('alice/app~slow')!.totalFiles = 11;
    const slow = await h.ok('get_branch', { repo: 'alice/app', branch: 'slow' });
    expect(slow.files).toHaveLength(10);
    expect(slow.moreFiles).toBe(1);
    // Beyond both the tool's cut and the files the host sent: what the host counted, less what is listed.
    serveBranch(h.code, 'alice/app', 'huge', sha('8'), BASE, Array.from({ length: 302 }, (_, i) => addedFile(`f${i}.ts`, ['x'])));
    h.code.branches.get('alice/app~huge')!.totalFiles = 3000;
    const huge = await h.ok('get_branch', { repo: 'alice/app', branch: 'huge' });
    expect(huge.files).toHaveLength(300);
    expect(huge.moreFiles).toBe(2700);
    // Exactly 300 files, all listed: nothing is missing.
    serveBranch(h.code, 'alice/app', 'full', sha('7'), BASE, Array.from({ length: 300 }, (_, i) => addedFile(`f${i}.ts`, ['x'])));
    expect((await h.ok('get_branch', { repo: 'alice/app', branch: 'full' })).moreFiles).toBeUndefined();
  });

  it("notes a stale diff (the host couldn't be asked), and serves what it has", async () => {
    const h = setup();
    await h.ok('get_branch', { repo: 'alice/app', branch: 'topic/x' });
    h.code.down = 'No GitHub token';
    const stale = await h.ok('get_branch', { repo: 'alice/app', branch: 'topic/x' });
    expect(stale).toMatchObject({ headOid: BHEAD, baseOid: BASE, files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] });
    expect(stale.note).toBe("The code host couldn't be asked: files and revisions are from gh-dash's cache and may be behind");
  });

  it("leaves the revisions and files out, with a note, when there's no diff: the rest is still given", async () => {
    const h = mcpHarness({ db: withGitLab() });
    const key = `${GITLAB_HOST}/platform/app`;
    h.code.down = 'No GitLab token';
    const out = await h.ok('get_branch', { repo: key, branch: 'topic/x' });
    expect(out).toMatchObject({
      repo: key, name: 'topic/x', ref: `${key} branch topic/x`, baseRef: 'main', url: `https://${GITLAB_HOST}/platform/app/-/compare/main...topic/x`, fetch: 'topic/x',
      comments: { threads: 0, unresolved: 0 },
    });
    for (const field of ['headOid', 'baseOid', 'files']) expect(out[field], field).toBeUndefined();
    expect(out.note).toContain('No diff (No GitLab token');
    expect(out.note).toContain('headOid, baseOid and files are left out');
  });

  it('says to push a branch the host has not got, in a note beside what gh-dash knows of it', async () => {
    const h = setup();
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    upsertPr(h.db, app, prRecord(7, { state: 'merged', createdAt: '2026-09-20T00:00:00Z', mergedAt: '2026-09-21T00:00:00Z', headRef: 'gone', title: 'Gone', crossRepo: false }));
    const out = await h.ok('get_branch', { repo: 'alice/app', branch: 'gone' });
    expect(out.note).toBe("No diff (Branch gone not found on GitHub: if it's local, push it first; else check the name): headOid, baseOid and files are left out");
    expect(out.pr).toEqual({ number: 7, ref: 'alice/app#7', state: 'merged', title: 'Gone' });
    expect(out.headOid).toBeUndefined();
  });

  it('refuses the default branch and bad names, and says when the repo or its default branch is not known', async () => {
    const h = setup();
    expect(await h.fails('get_branch', { repo: 'alice/app', branch: 'main' })).toBe('main is the default branch: branches are compared against it');
    expect(await h.fails('get_branch', { repo: 'alice/app', branch: 'a:b' })).toContain('expected a git branch name');
    expect(await h.fails('get_branch', { repo: 'alice/app' })).toContain('branch');
    expect(await h.fails('get_branch', { repo: 'alice/nope', branch: 'x' })).toContain("alice/nope isn't tracked");
    h.db.run("UPDATE repos SET default_branch = NULL WHERE key = 'alice/app'");
    const out = await h.ok('get_branch', { repo: 'alice/app', branch: 'topic/x' });
    expect(out.note).toContain("The default branch isn't known yet");
    expect(out.baseRef).toBeUndefined();
    expect(out.url).toBeUndefined();
  });
});

describe('get_thread', () => {
  it('gives the conversation from the agent\'s side, placed on the current diff', async () => {
    const h = mcpHarness();
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    const self = getPrincipal(h.db, SELF_PRINCIPAL_ID)!;
    const earlier = sha('c');
    const t = createThread(
      h.db,
      { repoId: app, kind: 'pr', number: 2 },
      { commitOid: earlier, baseOid: BASE, anchor: { path: 'src/a.ts', side: 'new', startLine: 7, endLine: 8, snippet: 'two\nthree' }, body: 'Why this?' },
      self,
    );
    h.db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [t.id, h.agent.id, 'Because.', '2026-09-28T10:00:00Z']);
    h.db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [t.id, h.other.id, 'Agreed.', '2026-09-28T11:00:00Z']);
    // The head moved: the lines are found again two lines up.
    servePr(h.code, 'alice/app', 2, HEAD, BASE, [addedFile('src/a.ts', ['one', 'two', 'three', 'four'])]);
    const got = await h.ok('get_thread', { id: t.id });
    expect(got).toMatchObject({
      id: t.id, repo: 'alice/app', ref: 'alice/app#2', target: { kind: 'pr', number: 2, title: 'Add parser' }, status: 'open', resolvedBy: null,
      anchor: { commit: earlier, base: BASE, path: 'src/a.ts', side: 'new', startLine: 7, endLine: 8, snippet: 'two\nthree' },
      placement: { kind: 'line', startLine: 2, endLine: 3, relocated: true },
      openedBy: 'you',
      counts: { comments: 3 },
    });
    expect(got.comments.map((c: { by: string; body: string }) => `${c.by}: ${c.body}`)).toEqual(['you: Why this?', 'me: Because.', 'agent:Codex: Agreed.']);
    expect(got.lastComment).toBeUndefined();
  });

  it('places commit threads and says unknown when the diff is out of reach', async () => {
    const h = mcpHarness();
    const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    const self = getPrincipal(h.db, SELF_PRINCIPAL_ID)!;
    const oid = sha('c');
    const line = { path: 'x.ts', side: 'new' as const, startLine: 1, endLine: 1, snippet: 'x' };
    const onCommit = createThread(h.db, { repoId: app, kind: 'commit', oid }, { commitOid: oid, baseOid: BASE, anchor: line, body: 'n' }, self);
    const gone = createThread(h.db, { repoId: app, kind: 'commit', oid }, { commitOid: oid, baseOid: BASE, anchor: { ...line, path: 'gone.ts' }, body: 'n' }, self);
    const general = createThread(h.db, { repoId: app, kind: 'pr', number: 3 }, { commitOid: HEAD, baseOid: null, anchor: { path: null, side: null, startLine: null, endLine: null, snippet: null }, body: 'n' }, self);
    h.code.commits.set(`alice/app@${oid}`, commitDiff(oid, BASE, [addedFile('x.ts', ['x'])]));
    expect((await h.ok('get_thread', { id: onCommit.id })).placement).toEqual({ kind: 'line', startLine: 1, endLine: 1, relocated: false });
    expect((await h.ok('get_thread', { id: gone.id })).placement).toEqual({ kind: 'outdated', reason: 'file' });
    expect(await h.ok('get_thread', { id: general.id })).toMatchObject({ placement: { kind: 'target' }, anchor: { commit: HEAD, base: null } });
    h.code.commits.clear();
    const other = createThread(h.db, { repoId: app, kind: 'commit', oid: sha('d') }, { commitOid: sha('d'), baseOid: null, anchor: line, body: 'n' }, self);
    expect((await h.ok('get_thread', { id: other.id })).placement).toEqual({ kind: 'unknown', reason: expect.stringContaining('no diff: Commit') });
    expect(await h.fails('get_thread', { id: 9999 })).toBe('Thread not found');
  });
});
