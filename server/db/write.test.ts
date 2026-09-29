import { describe, expect, it } from 'vitest';
import { type Db, openDb } from './db';
import type { CommitRecord, PrRecord, RepoRecord } from './records';
import { GITHUB } from '../test/seed';
import { ensureSource } from './sources';
import {
  addManual,
  linkCommitsToPrs,
  markReposRemoved,
  markUnavailable,
  refreshManual,
  releaseKey,
  storedRepoRecord,
  upsertCommit,
  upsertOwned,
  upsertPr,
} from './write';

const NOW = '2026-09-29T12:00:00Z';

function rec(nameWithOwner: string, nodeId: string, over: Partial<RepoRecord> = {}): RepoRecord {
  const [owner, name] = nameWithOwner.split('/') as [string, string];
  return {
    nodeId, name, nameWithOwner, owner, description: null, url: `https://github.com/${nameWithOwner}`, visibility: 'public',
    isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main', stars: 0, forks: 0,
    createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-25T00:00:00Z', ...over,
  };
}

/** A repo added by hand (POST /repos comes later; the row is what it will write). */
function manual(db: Db, nameWithOwner: string, nodeId: string, over: { unavailable?: boolean } = {}): number {
  const r = rec(nameWithOwner, nodeId);
  return db.run(
    `INSERT INTO repos (source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at, tracked_by, added_at, unavailable_at, unavailable_reason)
     VALUES (1, ?, ?, ?, ?, ?, ?, 'public', ?, 'manual', ?, ?, ?)`,
    [r.nameWithOwner, nodeId, r.name, r.nameWithOwner, r.owner, r.url, r.createdAt, '2026-09-01T00:00:00Z', over.unavailable ? NOW : null, over.unavailable ? 'gone' : null],
  ).lastInsertRowid;
}

interface Row { id: number; name: string; name_with_owner: string; tracked_by: string; removed_at: string | null; added_at: string | null; unavailable_at: string | null; pinned: number; hidden: number }
const row = (db: Db, id: number) => db.get<Row>('SELECT * FROM repos WHERE id = ?', [id])!;
const live = (db: Db) => db.all<{ name_with_owner: string }>('SELECT name_with_owner FROM repos WHERE removed_at IS NULL ORDER BY id').map((r) => r.name_with_owner);

describe('upsertOwned', () => {
  it('inserts an owned, live repo', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    expect(row(db, id)).toMatchObject({ name: 'app', name_with_owner: 'alice/app', tracked_by: 'owned', removed_at: null, added_at: null });
  });

  it('follows a rename by node id, keeping the id and local preferences', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    db.run('UPDATE repos SET pinned = 1, hidden = 1 WHERE id = ?', [id]);
    expect(upsertOwned(db, GITHUB, rec('alice/app2', 'R_app'), NOW)).toBe(id);
    expect(row(db, id)).toMatchObject({ name: 'app2', name_with_owner: 'alice/app2', pinned: 1, hidden: 1 });
  });

  it('claims a repo that was added by hand (transferred to the viewer)', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'bob/tool', 'R_tool', { unavailable: true });
    db.run('UPDATE repos SET hidden = 1 WHERE id = ?', [id]);
    expect(upsertOwned(db, GITHUB, rec('alice/tool', 'R_tool'), NOW)).toBe(id);
    expect(row(db, id)).toMatchObject({
      name_with_owner: 'alice/tool', tracked_by: 'owned', added_at: null, unavailable_at: null, removed_at: null, hidden: 1,
    });
  });

  it('releases the key from another live repo without renaming it', () => {
    const db = openDb(':memory:');
    const old = upsertOwned(db, GITHUB, rec('alice/app', 'R_old'), NOW);
    const fresh = upsertOwned(db, GITHUB, rec('alice/app', 'R_new'), NOW);
    expect(row(db, old)).toMatchObject({ name: 'app', name_with_owner: 'alice/app', removed_at: NOW });
    expect(row(db, fresh)).toMatchObject({ name: 'app', removed_at: null });
    expect(live(db)).toEqual(['alice/app']);
  });

  it('releases a key held in another case (the key index ignores case)', () => {
    const db = openDb(':memory:');
    const old = upsertOwned(db, GITHUB, rec('alice/Foo', 'R_old'), NOW);
    const fresh = upsertOwned(db, GITHUB, rec('alice/foo', 'R_new'), NOW);
    expect(row(db, old).removed_at).toBe(NOW);
    expect(row(db, fresh).removed_at).toBeNull();
  });

  it('also releases a key held by a repo added by hand', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'alice/app', 'R_gone');
    upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    expect(row(db, id)).toMatchObject({ tracked_by: 'manual', removed_at: NOW });
  });

  it('revives a removed repo, and leaves other removed rows with its key alone', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    const other = upsertOwned(db, GITHUB, rec('alice/lib', 'R_lib'), NOW);
    expect(markReposRemoved(db, GITHUB, [], '2026-09-28T00:00:00Z')).toBe(2);
    expect(upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW)).toBe(id);
    expect(row(db, id).removed_at).toBeNull();
    expect(row(db, other).removed_at).toBe('2026-09-28T00:00:00Z');
  });

  it('keeps a repo of the same short name under another owner live', () => {
    const db = openDb(':memory:');
    const theirs = manual(db, 'dlvhdr/gh-dash', 'R_theirs');
    upsertOwned(db, GITHUB, rec('kcosr/gh-dash', 'R_mine'), NOW);
    expect(row(db, theirs).removed_at).toBeNull();
    expect(live(db)).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash']);
  });
});

describe('releaseKey', () => {
  it('counts the live rows it released; the holder and removed rows are untouched', () => {
    const db = openDb(':memory:');
    const holder = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    expect(releaseKey(db, 'ALICE/APP', 'R_app', NOW)).toBe(0);
    expect(releaseKey(db, 'alice/app', 'R_other', '2026-09-30T00:00:00Z')).toBe(1);
    expect(releaseKey(db, 'alice/app', 'R_other', '2026-10-01T00:00:00Z')).toBe(0);
    expect(row(db, holder).removed_at).toBe('2026-09-30T00:00:00Z');
  });
});

describe('markReposRemoved', () => {
  it('removes owned repos missing from the owned list, never repos added by hand', () => {
    const db = openDb(':memory:');
    upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    upsertOwned(db, GITHUB, rec('alice/old', 'R_old'), NOW);
    manual(db, 'dlvhdr/gh-dash', 'R_theirs');
    expect(markReposRemoved(db, GITHUB, ['R_app'], NOW)).toBe(1);
    expect(live(db)).toEqual(['alice/app', 'dlvhdr/gh-dash']);
  });
});

describe('refreshManual', () => {
  it('updates a live repo added by hand and clears unavailable', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'bob/tool', 'R_tool', { unavailable: true });
    db.run('UPDATE repos SET pinned = 1, hidden = 1 WHERE id = ?', [id]);
    expect(refreshManual(db, GITHUB, rec('bob/tool2', 'R_tool', { description: 'renamed' }), NOW)).toBe(id);
    expect(row(db, id)).toMatchObject({ name_with_owner: 'bob/tool2', tracked_by: 'manual', unavailable_at: null, added_at: '2026-09-01T00:00:00Z', pinned: 1, hidden: 1 });
  });

  it('never inserts, and leaves removed or owned rows alone', () => {
    const db = openDb(':memory:');
    expect(refreshManual(db, GITHUB, rec('bob/new', 'R_new'), NOW)).toBeNull();
    const gone = manual(db, 'bob/gone', 'R_gone');
    db.run('UPDATE repos SET removed_at = ? WHERE id = ?', [NOW, gone]);
    expect(refreshManual(db, GITHUB, rec('bob/gone', 'R_gone', { description: 'x' }), NOW)).toBeNull();
    upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    expect(refreshManual(db, GITHUB, rec('alice/app', 'R_app', { description: 'x' }), NOW)).toBeNull();
    expect(db.all('SELECT name_with_owner, description FROM repos ORDER BY id')).toEqual([
      { name_with_owner: 'bob/gone', description: null }, { name_with_owner: 'alice/app', description: null },
    ]);
  });

  it('releases the key from another live row holding it', () => {
    const db = openDb(':memory:');
    const stale = manual(db, 'bob/tool', 'R_old');
    const id = manual(db, 'bob/tool-v1', 'R_tool');
    expect(refreshManual(db, GITHUB, rec('bob/tool', 'R_tool'), NOW)).toBe(id);
    expect(row(db, stale).removed_at).toBe(NOW);
  });
});

describe('markUnavailable', () => {
  it('keeps the first time and the latest reason, for live repos added by hand only', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'bob/tool', 'R_tool');
    markUnavailable(db, id, 'R_tool', 'first', '2026-09-29T01:00:00Z');
    markUnavailable(db, id, 'R_tool', 'second', '2026-09-29T02:00:00Z');
    expect(db.get('SELECT unavailable_at, unavailable_reason FROM repos WHERE id = ?', [id])).toEqual({ unavailable_at: '2026-09-29T01:00:00Z', unavailable_reason: 'second' });
    const owned = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    markUnavailable(db, owned, 'R_app', 'x', NOW);
    expect(row(db, owned).unavailable_at).toBeNull();
    // Another repo that has this id now (the one it was meant for is gone) is never marked.
    const other = manual(db, 'bob/lib', 'R_lib');
    markUnavailable(db, other, 'R_tool', 'x', NOW);
    expect(row(db, other).unavailable_at).toBeNull();
  });
});

describe('addManual', () => {
  it('inserts a repo tracked by hand, hidden from the default selection if asked', () => {
    const db = openDb(':memory:');
    const res = addManual(db, GITHUB, rec('bob/tool', 'R_tool'), { hidden: true }, NOW);
    expect(res).toEqual({ added: true, id: expect.any(Number) });
    expect(row(db, (res as { id: number }).id)).toMatchObject({ tracked_by: 'manual', added_at: NOW, hidden: 1, removed_at: null });
  });

  it('reports a live repo with that node id instead of touching it', () => {
    const db = openDb(':memory:');
    const owned = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    db.run('UPDATE repos SET hidden = 1 WHERE id = ?', [owned]);
    expect(addManual(db, GITHUB, rec('alice/app', 'R_app'), { hidden: false }, NOW)).toEqual({ added: false, id: owned, trackedBy: 'owned', hidden: true });
    const tool = manual(db, 'bob/tool', 'R_tool');
    expect(addManual(db, GITHUB, rec('bob/tool', 'R_tool'), { hidden: true }, NOW)).toEqual({ added: false, id: tool, trackedBy: 'manual', hidden: false });
    expect(row(db, tool).hidden).toBe(0);
  });

  it('revives a removed row with its earlier data (an owned repo transferred away, then added)', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, GITHUB, rec('alice/lib', 'R_lib'), NOW);
    db.run('UPDATE repos SET pinned = 1 WHERE id = ?', [id]);
    db.run(`INSERT INTO pull_requests (repo_id, number, title, state, created_at, updated_at, activity_at, url) VALUES (?, 1, 'Old', 'open', 'x', 'x', 'x', 'u')`, [id]);
    markReposRemoved(db, GITHUB, [], NOW);
    const res = addManual(db, GITHUB, rec('carol/lib', 'R_lib'), { hidden: false }, '2026-09-30T00:00:00Z');
    expect(res).toEqual({ added: true, id });
    expect(row(db, id)).toMatchObject({ name_with_owner: 'carol/lib', tracked_by: 'manual', added_at: '2026-09-30T00:00:00Z', removed_at: null, pinned: 1 });
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM pull_requests WHERE repo_id = ?', [id])!.n).toBe(1);
  });

  it('marks a revived repo as waiting for its sync, keeping its high-water marks', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, GITHUB, rec('alice/lib', 'R_lib'), NOW);
    db.run(`INSERT INTO sync_state (repo_id, synced_at, prs_hwm, commits_head) VALUES (?, '2026-09-01T00:00:00Z', '2026-08-31T00:00:00Z', 'abc')`, [id]);
    markReposRemoved(db, GITHUB, [], NOW);
    addManual(db, GITHUB, rec('carol/lib', 'R_lib'), { hidden: false }, NOW);
    expect(db.get('SELECT synced_at, prs_hwm, commits_head FROM sync_state WHERE repo_id = ?', [id])).toEqual({ synced_at: null, prs_hwm: '2026-08-31T00:00:00Z', commits_head: 'abc' });
  });

  it('releases the key from another live row holding it', () => {
    const db = openDb(':memory:');
    const stale = manual(db, 'bob/tool', 'R_old');
    addManual(db, GITHUB, rec('bob/tool', 'R_new'), { hidden: false }, NOW);
    expect(row(db, stale).removed_at).toBe(NOW);
    expect(live(db)).toEqual(['bob/tool']);
  });
});

describe('by source', () => {
  /** github.com plus two GitLab instances; GitLab node ids (gid://gitlab/Project/N) repeat across instances. */
  function sources() {
    const db = openDb(':memory:');
    const gl = ensureSource(db, { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' });
    const gl2 = ensureSource(db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    return { db, gl, gl2 };
  }
  const gid = (n: number) => `gid://gitlab/Project/${n}`;
  const keys = (db: Db) => db.all<{ key: string }>('SELECT key FROM repos WHERE removed_at IS NULL ORDER BY id').map((r) => r.key);
  const repoRow = (db: Db, id: number) => db.get<{ source_id: number; key: string; name_with_owner: string; removed_at: string | null }>(
    'SELECT source_id, key, name_with_owner, removed_at FROM repos WHERE id = ?', [id])!;

  it('upsertOwned keys a repo by its source, and follows a rename on that source', () => {
    const { db, gl } = sources();
    const lab = upsertOwned(db, gl, rec('alice/app', gid(5)), NOW);
    const hub = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    expect(repoRow(db, lab)).toEqual({ source_id: gl.id, key: 'gitlab.example.com/alice/app', name_with_owner: 'alice/app', removed_at: null });
    expect(repoRow(db, hub)).toEqual({ source_id: 1, key: 'alice/app', name_with_owner: 'alice/app', removed_at: null });
    expect(upsertOwned(db, gl, rec('alice/app2', gid(5)), NOW)).toBe(lab);
    expect(keys(db)).toEqual(['gitlab.example.com/alice/app2', 'alice/app']);
  });

  it('the same GitLab node id on two sources is two repos', () => {
    const { db, gl, gl2 } = sources();
    const a = upsertOwned(db, gl, rec('alice/app', gid(5)), NOW);
    const b = upsertOwned(db, gl2, rec('alice/app', gid(5)), NOW);
    expect(b).not.toBe(a);
    const c = addManual(db, gl, rec('bob/tool', gid(9)), { hidden: false }, NOW);
    const d = addManual(db, gl2, rec('bob/tool', gid(9)), { hidden: false }, NOW);
    expect([c.added, d.added]).toEqual([true, true]);
    expect(keys(db)).toEqual(['gitlab.example.com/alice/app', 'gitlab2.example.com/alice/app', 'gitlab.example.com/bob/tool', 'gitlab2.example.com/bob/tool']);
  });

  it('addManual reports a live repo with that node id on the same source only', () => {
    const { db, gl, gl2 } = sources();
    const owned = upsertOwned(db, gl, rec('alice/app', gid(5)), NOW);
    expect(addManual(db, gl, rec('alice/app', gid(5)), { hidden: true }, NOW)).toEqual({ added: false, id: owned, trackedBy: 'owned', hidden: false });
    expect(addManual(db, gl2, rec('alice/app', gid(5)), { hidden: true }, NOW)).toMatchObject({ added: true });
    expect(addManual(db, GITHUB, rec('alice/app', gid(5)), { hidden: true }, NOW)).toMatchObject({ added: true });
  });

  it('refreshManual and storedRepoRecord look a node up on its source', () => {
    const { db, gl, gl2 } = sources();
    const res = addManual(db, gl, rec('bob/tool', gid(7)), { hidden: false }, NOW);
    const id = (res as { id: number }).id;
    expect(refreshManual(db, gl2, rec('bob/tool', gid(7), { description: 'other instance' }), NOW)).toBeNull();
    expect(refreshManual(db, GITHUB, rec('bob/tool', gid(7), { description: 'github' }), NOW)).toBeNull();
    expect(refreshManual(db, gl, rec('bob/tool2', gid(7), { description: 'renamed' }), NOW)).toBe(id);
    expect(repoRow(db, id)).toMatchObject({ key: 'gitlab.example.com/bob/tool2', name_with_owner: 'bob/tool2' });
    expect(storedRepoRecord(db, gl, gid(7))).toMatchObject({ nameWithOwner: 'bob/tool2', description: 'renamed' });
    expect(storedRepoRecord(db, gl2, gid(7))).toBeNull();
    expect(storedRepoRecord(db, GITHUB, gid(7))).toBeNull();
  });

  it("markReposRemoved for one source leaves every other source's repos live", () => {
    const { db, gl, gl2 } = sources();
    upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    upsertOwned(db, gl, rec('alice/notes', gid(1)), NOW);
    upsertOwned(db, gl2, rec('alice/notes', gid(1)), NOW);
    addManual(db, gl, rec('bob/tool', gid(2)), { hidden: false }, NOW);
    // A GitHub run's owned list names no GitLab project.
    expect(markReposRemoved(db, GITHUB, [], NOW)).toBe(1);
    expect(keys(db)).toEqual(['gitlab.example.com/alice/notes', 'gitlab2.example.com/alice/notes', 'gitlab.example.com/bob/tool']);
    // Node ids are compared on the source's own rows: gl2's project 1 goes, gl's stays.
    expect(markReposRemoved(db, gl2, [gid(3)], NOW)).toBe(1);
    expect(markReposRemoved(db, gl, [gid(1)], NOW)).toBe(0);
    expect(keys(db)).toEqual(['gitlab.example.com/alice/notes', 'gitlab.example.com/bob/tool']);
  });

  it('releaseKey releases a host-prefixed key, in any case, and never a namesake on another source', () => {
    const { db, gl } = sources();
    const hub = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    const old = upsertOwned(db, gl, rec('alice/app', gid(5)), NOW);
    // The project was deleted and another one took its path.
    const fresh = upsertOwned(db, gl, rec('alice/app', gid(6)), NOW);
    expect(repoRow(db, old).removed_at).toBe(NOW);
    expect(repoRow(db, fresh).removed_at).toBeNull();
    expect(repoRow(db, hub).removed_at).toBeNull();
    expect(releaseKey(db, 'GITLAB.EXAMPLE.COM/Alice/App', gid(6), NOW)).toBe(0);
    expect(releaseKey(db, 'gitlab.example.com/alice/app', gid(7), '2026-09-30T00:00:00Z')).toBe(1);
    expect(repoRow(db, fresh).removed_at).toBe('2026-09-30T00:00:00Z');
    expect(keys(db)).toEqual(['alice/app']);
  });
});

describe('linkCommitsToPrs', () => {
  const sha = (c: string) => c.repeat(40).slice(0, 40);
  const commit = (c: string): CommitRecord => ({
    oid: sha(c), headline: `Commit ${c}`, body: '', author: { login: null, name: 'Al', email: 'al@example.com', avatarUrl: null },
    committedAt: '2026-09-20T00:00:00Z', url: 'u', additions: 1, deletions: 0, prNumber: null,
  });
  function pr(number: number, over: Partial<PrRecord> = {}): PrRecord {
    const at = over.mergedAt ?? '2026-09-21T00:00:00Z';
    return {
      number, title: `MR ${number}`, body: '', state: 'merged', isDraft: false, author: null, mergedBy: null, createdAt: at, updatedAt: at, mergedAt: at,
      closedAt: at, activityAt: at, additions: 0, deletions: 0, changedFiles: 0, commitCount: 0, headRef: 'topic', headOid: sha('f'), baseRef: 'main',
      labels: [], closingIssues: [], url: 'u', commits: [], mergeCommitOid: null, squashCommitOid: null, ...over,
    };
  }
  const listed = (...cs: string[]) => cs.map((c) => ({ oid: sha(c), headline: c, committedAt: '2026-09-19T00:00:00Z', url: 'u', author: { login: null, name: null, email: null, avatarUrl: null } }));
  const links = (db: Db, repoId: number) =>
    Object.fromEntries(db.all<{ oid: string; pr_number: number | null }>('SELECT oid, pr_number FROM commits WHERE repo_id = ? ORDER BY oid', [repoId]).map((r) => [r.oid[0], r.pr_number]));

  it('gives commits the merged PR that landed them: its merge or squash commit, else one it listed', () => {
    const db = openDb(':memory:');
    const gl = ensureSource(db, { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' });
    const repo = upsertOwned(db, gl, rec('alice/app', 'gid://gitlab/Project/1'), NOW);
    for (const c of ['1', '2', '3', '4', '5', '6', '7', '8']) upsertCommit(db, repo, commit(c));
    upsertPr(db, repo, pr(10, { mergeCommitOid: sha('1'), commits: listed('2', '3') }));
    upsertPr(db, repo, pr(11, { squashCommitOid: sha('4'), commits: listed('9') }));
    // 5 is listed by two merged MRs, and 3 by !10 and !14: the one merged first landed it. !14 lists 1 too, but 1 is
    // !10's merge commit, which says more.
    upsertPr(db, repo, pr(12, { mergedAt: '2026-09-23T00:00:00Z', commits: listed('5') }));
    upsertPr(db, repo, pr(13, { mergedAt: '2026-09-22T00:00:00Z', commits: listed('5') }));
    upsertPr(db, repo, pr(14, { mergedAt: '2026-09-20T00:00:00Z', commits: listed('3', '1') }));
    // Not merged: an open MR's commits and a closed one's merge commit land nothing.
    upsertPr(db, repo, pr(15, { state: 'open', mergedAt: null, closedAt: null, commits: listed('6') }));
    upsertPr(db, repo, pr(16, { state: 'closed', mergedAt: null, mergeCommitOid: sha('7') }));
    // Another repo's merged MR names 8.
    const other = upsertOwned(db, gl, rec('alice/lib', 'gid://gitlab/Project/2'), NOW);
    upsertPr(db, other, pr(17, { mergeCommitOid: sha('8') }));

    expect(linkCommitsToPrs(db, repo)).toBe(5);
    expect(links(db, repo)).toEqual({ 1: 10, 2: 10, 3: 14, 4: 11, 5: 13, 6: null, 7: null, 8: null });
    // Linked commits keep their PR; nothing left to do.
    expect(linkCommitsToPrs(db, repo)).toBe(0);
    db.run('UPDATE commits SET pr_number = 99 WHERE oid = ?', [sha('6')]);
    upsertPr(db, repo, pr(15, { commits: listed('6') }));
    expect(linkCommitsToPrs(db, repo)).toBe(0);
    expect(links(db, repo)[6]).toBe(99);
  });

  it('stores what a merge landed with the PR', () => {
    const db = openDb(':memory:');
    const repo = upsertOwned(db, GITHUB, rec('alice/app', 'R_app'), NOW);
    upsertPr(db, repo, pr(1, { mergeCommitOid: sha('a'), squashCommitOid: sha('b') }));
    expect(db.get('SELECT merge_commit_oid, squash_commit_oid FROM pull_requests WHERE number = 1')).toEqual({ merge_commit_oid: sha('a'), squash_commit_oid: sha('b') });
    upsertPr(db, repo, pr(1));
    expect(db.get('SELECT merge_commit_oid, squash_commit_oid FROM pull_requests WHERE number = 1')).toEqual({ merge_commit_oid: null, squash_commit_oid: null });
  });
});
