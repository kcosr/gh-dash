import { describe, expect, it } from 'vitest';
import { addBranch, branchesSynced } from '../test/branches';
import { sha } from '../test/github';
import { GITLAB_HOST, prRecord, seedDb, seedGitLab } from '../test/seed';
import { BRANCH_FROM, BRANCH_SELECT, listBranches, NO_PR_SQL } from './branches';
import { createThread, getPrincipal, SELF_PRINCIPAL_ID, setThreadStatus } from './comments';
import type { Db } from './db';
import { loadQueryCtx, type Scope } from './filters';
import type { CursorKey } from './lists';
import { upsertPr } from './write';

const day = (d: number, time = '12:00:00') => `2026-09-${String(d).padStart(2, '0')}T${time}Z`;

const scope = (over: Partial<Scope> = {}): Scope => ({
  repos: null,
  visibility: 'all',
  ownership: 'all',
  who: 'everyone',
  from: Date.parse('2026-09-01T00:00:00Z'),
  to: Date.parse('2026-09-28T00:00:00Z'),
  tz: 'UTC',
  q: null,
  ...over,
});

const repoId = (db: Db, key: string) => db.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', [key])!.id;
const list = (db: Db, s: Partial<Scope> = {}, ctx = loadQueryCtx(db)) => listBranches(db, ctx, scope(s), null);
const ids = (db: Db, s: Partial<Scope> = {}, ctx = loadQueryCtx(db)) => list(db, s, ctx).items.map((b) => b.id);

/**
 * The seed (alice/app's PRs 1 merged, 2 open and 3 closed are from `feature`, heads sha('1'), sha('2') and sha('3'), the
 * sync not knowing yet whether they are from a fork), with branches besides `main` in app: fix/login by alice, docs by
 * her work address (no login), wip by bob; and spike in secret, whose author the code host didn't give.
 */
function fixture(): Db {
  const db = seedDb();
  addBranch(db, 'alice/app', 'main', { head: sha('m'), at: day(27) });
  addBranch(db, 'alice/app', 'fix/login', { head: sha('a'), at: day(25) });
  addBranch(db, 'alice/app', 'docs', { head: sha('b'), at: day(20), by: { name: 'Alice (work)', email: 'alice@work.example' } });
  addBranch(db, 'alice/app', 'wip', { head: sha('c'), at: day(26), by: { login: 'bob', name: 'Bob' } });
  addBranch(db, 'alice/secret', 'spike', { head: sha('d'), at: day(24), by: null });
  return db;
}

/** PR `number` of repo `key` from branch `headRef` at head `headOid`: open, or merged or closed on `ended`. */
function pr(db: Db, key: string, number: number, headRef: string, headOid: string, state: 'open' | 'merged' | 'closed', crossRepo: boolean | null = false, ended = day(22)) {
  upsertPr(db, repoId(db, key), prRecord(number, {
    state, createdAt: day(21), headRef, headOid, crossRepo,
    ...(state === 'merged' ? { mergedAt: ended } : state === 'closed' ? { closedAt: ended } : {}),
  }));
}

describe('GET /branches: the branches with no PR yet', () => {
  it('lists them newest first, the default branch left out, each with its diff id, compare page and author', () => {
    const db = fixture();
    const res = list(db);
    expect(res.items.map((b) => b.id)).toEqual(['alice/app~wip', 'alice/app~fix/login', 'alice/secret~spike', 'alice/app~docs']);
    expect([res.total, res.nextCursor]).toEqual([4, null]);
    expect(res.items[1]).toEqual({
      id: 'alice/app~fix/login', repo: 'alice/app', name: 'fix/login', headOid: sha('a'), committedAt: day(25),
      author: { login: 'alice', name: 'Alice', avatarUrl: 'https://avatars.example/alice', isMe: true },
      url: 'https://github.com/alice/app/compare/main...fix/login', comments: { threads: 0, unresolved: 0 },
    });
    // A commit address of the viewer's is me; an author the code host didn't give is none.
    expect(res.items[3]!.author).toEqual({ login: null, name: 'Alice (work)', avatarUrl: null, isMe: true });
    expect(res.items[2]!.author).toBeNull();
    expect(res.items[0]!.author).toMatchObject({ login: 'bob', isMe: false });
    // A capped listing's branches are real ones as of that sync: listed as well.
    branchesSynced(db, 'alice/app', false);
    expect(ids(db)).toEqual(res.items.map((b) => b.id));
  });

  it('leaves out a branch with an open PR from it, whatever its head', () => {
    const db = fixture();
    addBranch(db, 'alice/app', 'feature', { head: sha('e'), at: day(23) });
    // app#2 is open from feature, at another head: the branch is reviewed there.
    expect(ids(db, { repos: ['app'] })).not.toContain('alice/app~feature');
    pr(db, 'alice/app', 2, 'feature', sha('2'), 'closed');
    expect(ids(db, { repos: ['app'] })).toContain('alice/app~feature');
  });

  it("leaves out a branch whose head a PR from it has, merged or closed, and lists it again once it's moved on", () => {
    const db = fixture();
    pr(db, 'alice/app', 2, 'feature', sha('2'), 'closed');
    const head = (oid: string) => db.run("UPDATE branches SET head_oid = ? WHERE name = 'feature'", [oid]);
    addBranch(db, 'alice/app', 'feature', { head: sha('1'), at: day(23) });
    // At merged app#1's head, then at closed app#3's: nothing new since those were reviewed.
    expect(ids(db, { repos: ['app'] })).not.toContain('alice/app~feature');
    head(sha('3'));
    expect(ids(db, { repos: ['app'] })).not.toContain('alice/app~feature');
    // Reused after its PRs ended: new work, which no PR shows.
    head(sha('e'));
    expect(ids(db, { repos: ['app'] })).toContain('alice/app~feature');
    // A PR's own head with no head recorded (synced before it was) hides nothing.
    db.run('UPDATE pull_requests SET head_oid = NULL');
    head(sha('1'));
    expect(ids(db, { repos: ['app'] })).toContain('alice/app~feature');
  });

  it("counts a fork's PR out, and a PR the sync hasn't classified yet in", () => {
    const db = fixture();
    addBranch(db, 'alice/app', 'feature', { head: sha('e'), at: day(23) });
    addBranch(db, 'alice/app', 'pushed', { head: sha('f'), at: day(23) });
    pr(db, 'alice/app', 4, 'pushed', sha('f'), 'merged', null);
    const listed = () => ids(db, { repos: ['app'] }).filter((id) => id.endsWith('~feature') || id.endsWith('~pushed'));
    // cross_repo unknown: the open app#2 and the merged app#4 hide their branches (they may well be from them).
    expect(listed()).toEqual([]);
    // From a fork's branches of those names: this repo's are unreviewed.
    db.run('UPDATE pull_requests SET cross_repo = 1 WHERE number IN (2, 4)');
    expect(listed()).toEqual(['alice/app~feature', 'alice/app~pushed']);
    db.run('UPDATE pull_requests SET cross_repo = 0 WHERE number IN (2, 4)');
    expect(listed()).toEqual([]);
  });

  it("leaves out the default branch, and the branches of a repo whose default branch isn't known", () => {
    const db = fixture();
    db.run("UPDATE repos SET default_branch = 'wip' WHERE key = 'alice/app'");
    expect(ids(db, { repos: ['app'] })).toEqual(['alice/app~main', 'alice/app~fix/login', 'alice/app~docs']);
    expect(list(db, { repos: ['app'] }).items[0]!.url).toBe('https://github.com/alice/app/compare/wip...main');
    db.run("UPDATE repos SET default_branch = NULL WHERE key = 'alice/app'");
    expect(ids(db)).toEqual(['alice/secret~spike']);
  });

  it("isn't hidden by another repo's PR from a branch of the same name", () => {
    const db = fixture();
    pr(db, 'alice/secret', 5, 'wip', sha('c'), 'open');
    expect(ids(db, { repos: ['app'] })).toContain('alice/app~wip');
  });
});

describe('GET /branches: scope', () => {
  it("follows the PR list's repo scope: the default selection, explicit repos, visibility, ownership and sources", () => {
    const db = fixture();
    for (const key of ['alice/old', 'alice/fork', 'alice/hidden']) addBranch(db, key, `on-${key.slice(6)}`, { head: sha('e'), at: day(23) });
    const { repoId: gitlab } = seedGitLab(db);
    addBranch(db, `${GITLAB_HOST}/platform/app`, 'gl-branch', { head: sha('f'), at: day(22), by: { name: 'Bob (laptop)', email: 'bob@corp.example' } });
    expect(ids(db)).toEqual(['alice/app~wip', 'alice/app~fix/login', 'alice/secret~spike', `${GITLAB_HOST}/platform/app~gl-branch`, 'alice/app~docs']);
    expect(ids(db, {}, { ...loadQueryCtx(db), includeForks: true })).toContain('alice/fork~on-fork');
    expect(ids(db, { repos: ['old', 'hidden'] })).toEqual(['alice/hidden~on-hidden', 'alice/old~on-old']);
    expect(ids(db, { repos: [] })).toEqual([]);
    expect(ids(db, { visibility: 'private' })).toEqual(['alice/secret~spike']);
    expect(ids(db, { ownership: 'others' })).toEqual([]);
    expect(ids(db, { source: [GITLAB_HOST] })).toEqual([`${GITLAB_HOST}/platform/app~gl-branch`]);
    // GitLab's compare page, and its account's own address as me there.
    expect(list(db, { source: [GITLAB_HOST] }).items[0]).toMatchObject({
      url: `https://${GITLAB_HOST}/platform/app/-/compare/main...gl-branch`, author: { login: null, name: 'Bob (laptop)', isMe: true },
    });
    // A repo the sync marked removed lists nothing, even by name.
    db.run('UPDATE repos SET removed_at = ? WHERE id = ?', [day(27), gitlab]);
    expect(ids(db, { repos: [`${GITLAB_HOST}/platform/app`] })).toEqual([]);
  });

  it("takes `who` as the head commit's author, by login or commit address, on each branch's own source", () => {
    const db = fixture();
    seedGitLab(db);
    addBranch(db, `${GITLAB_HOST}/platform/app`, 'by-alice', { head: sha('e'), at: day(22), by: { login: 'alice', name: 'Alice' } });
    expect(ids(db, { who: 'me' })).toEqual(['alice/app~fix/login', 'alice/app~docs']);
    // Everyone else's, the branch no author is known for among them; GitHub's alice isn't GitLab's.
    expect(ids(db, { who: 'others' })).toEqual(['alice/app~wip', 'alice/secret~spike', `${GITLAB_HOST}/platform/app~by-alice`]);
    expect(list(db, { who: 'others' }).total).toBe(3);
  });

  it("takes the range on the head commit's date, and never lists a branch that has none", () => {
    const db = fixture();
    addBranch(db, 'alice/app', 'undated', { head: sha('e'), at: null });
    expect(ids(db, { from: Date.parse(day(24, '00:00:00')), to: Date.parse(day(26, '00:00:00')) })).toEqual(['alice/app~fix/login', 'alice/secret~spike']);
    // `to` is exclusive; whole seconds, as the code hosts write them.
    expect(ids(db, { from: Date.parse(day(25)), to: Date.parse(day(26)) })).toEqual(['alice/app~fix/login']);
    expect(ids(db, { from: 0, to: Date.parse('2999-01-01T00:00:00Z') })).not.toContain('alice/app~undated');
  });

  it('takes `q` as a part of the name, without regard to case, % and _ matching themselves', () => {
    const db = fixture();
    addBranch(db, 'alice/app', 'wip_2', { head: sha('e'), at: day(21) });
    addBranch(db, 'alice/app', 'wipx2', { head: sha('f'), at: day(21) });
    expect(ids(db, { q: 'LOGIN' })).toEqual(['alice/app~fix/login']);
    expect(ids(db, { q: 'fix/' })).toEqual(['alice/app~fix/login']);
    expect(ids(db, { q: 'o' })).toEqual(['alice/app~fix/login', 'alice/app~docs']);
    expect(ids(db, { q: '_' })).toEqual(['alice/app~wip_2']);
    expect(ids(db, { q: '%' })).toEqual([]);
    expect(list(db, { q: 'wip' }).total).toBe(3);
  });
});

describe('GET /branches: pages and counts', () => {
  it('walks every branch once, newest first, repo then name breaking ties, the total counting every page', () => {
    const db = fixture();
    for (const name of ['b', 'a']) addBranch(db, 'alice/secret', name, { head: sha('e'), at: day(25) });
    addBranch(db, 'alice/app', 'z', { head: sha('e'), at: day(25) });
    const all = ids(db);
    expect(all).toEqual(['alice/app~wip', 'alice/app~fix/login', 'alice/app~z', 'alice/secret~a', 'alice/secret~b', 'alice/secret~spike', 'alice/app~docs']);
    const ctx = loadQueryCtx(db);
    const seen: string[] = [];
    let after: CursorKey | null = null;
    let pages = 0;
    do {
      const page = listBranches(db, ctx, scope(), { limit: 3, after });
      expect(page.total).toBe(all.length);
      seen.push(...page.items.map((b) => b.id));
      after = page.nextCursor;
      pages++;
    } while (after);
    expect([seen, pages]).toEqual([all, 3]);
    expect(listBranches(db, ctx, scope(), { limit: 1, after: [day(25), 'alice/app', 'z'] }).items[0]!.id).toBe('alice/secret~a');
  });

  it("counts the threads of each branch's review: its current group, not its PRs' own or those before its last merge", () => {
    const db = fixture();
    const you = getPrincipal(db, SELF_PRINCIPAL_ID)!;
    const general = { path: null, side: null, startLine: null, endLine: null, snippet: null };
    const open = (key: string, target: { kind: 'branch'; branch: string } | { kind: 'pr'; number: number } | { kind: 'commit'; oid: string }, at: string) =>
      createThread(db, { repoId: repoId(db, key), ...target }, { commitOid: sha('a'), baseOid: null, anchor: general, body: 'x' }, you, at);
    // fix/login was merged as app#7 on the 23rd, at another head than the branch's now: the thread before is the PR's.
    open('alice/app', { kind: 'branch', branch: 'fix/login' }, '2026-09-22T12:00:00.000Z');
    pr(db, 'alice/app', 7, 'fix/login', sha('7'), 'merged', false, day(23));
    open('alice/app', { kind: 'branch', branch: 'fix/login' }, '2026-09-24T12:00:00.000Z');
    setThreadStatus(db, open('alice/app', { kind: 'branch', branch: 'fix/login' }, '2026-09-24T13:00:00.000Z').id, 'resolved', you);
    // None of these is fix/login's: a PR's own, a commit's, and a branch of that name in another repo.
    open('alice/app', { kind: 'pr', number: 7 }, '2026-09-24T14:00:00.000Z');
    open('alice/app', { kind: 'commit', oid: sha('a') }, '2026-09-24T14:00:00.000Z');
    open('alice/secret', { kind: 'branch', branch: 'fix/login' }, '2026-09-24T14:00:00.000Z');
    setThreadStatus(db, open('alice/app', { kind: 'branch', branch: 'wip' }, '2026-09-24T14:00:00.000Z').id, 'resolved', you);
    const counts = Object.fromEntries(list(db).items.map((b) => [b.id, b.comments]));
    expect(counts).toEqual({
      'alice/app~wip': { threads: 1, unresolved: 0 },
      'alice/app~fix/login': { threads: 2, unresolved: 1 },
      'alice/secret~spike': { threads: 0, unresolved: 0 },
      'alice/app~docs': { threads: 0, unresolved: 0 },
    });
  });

  it("hides by the PRs' head branch index and counts a page's rows by the threads' branch index, never scanning either", () => {
    const db = fixture();
    const detail = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT ${BRANCH_SELECT} FROM ${BRANCH_FROM} WHERE ${NO_PR_SQL} LIMIT 10`).map((r) => r.detail);
    expect(detail.filter((d) => /^SEARCH p USING INDEX pull_requests_head_ref \(repo_id=\? AND head_ref=\?\)$/.test(d))).toHaveLength(1);
    expect(detail.filter((d) => /^SEARCH t USING (COVERING )?INDEX comment_threads_branch \(repo_id=\? AND branch=\?\)$/.test(d))).toHaveLength(2);
    expect(detail.some((d) => d.startsWith('SCAN p') || d.startsWith('SCAN t'))).toBe(false);
  });
});
