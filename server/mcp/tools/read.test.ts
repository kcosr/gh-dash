import { describe, expect, it } from 'vitest';
import { createThread, getPrincipal, SELF_PRINCIPAL_ID } from '../../db/comments';
import { ensureSource } from '../../db/sources';
import { upsertPr } from '../../db/write';
import { addedFile, commitDiff, mcpHarness, servePr, sha } from '../../test/mcp';
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
    expect((await h.ok('find_pr', { repo: 'alice/app', branch: 'nope' })).items).toEqual([]);
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
    expect(await h.fails('get_thread', { id: 9999 })).toBe('Thread 9999 not found');
  });
});
