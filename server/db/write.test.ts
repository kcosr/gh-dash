import { describe, expect, it } from 'vitest';
import { type Db, openDb } from './db';
import type { RepoRecord } from './records';
import { addManual, markReposRemoved, markUnavailable, refreshManual, releaseKey, upsertOwned } from './write';

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
    `INSERT INTO repos (node_id, name, name_with_owner, owner, url, visibility, created_at, tracked_by, added_at, unavailable_at, unavailable_reason)
     VALUES (?, ?, ?, ?, ?, 'public', ?, 'manual', ?, ?, ?)`,
    [nodeId, r.name, r.nameWithOwner, r.owner, r.url, r.createdAt, '2026-09-01T00:00:00Z', over.unavailable ? NOW : null, over.unavailable ? 'gone' : null],
  ).lastInsertRowid;
}

interface Row { id: number; name: string; name_with_owner: string; tracked_by: string; removed_at: string | null; added_at: string | null; unavailable_at: string | null; pinned: number; hidden: number }
const row = (db: Db, id: number) => db.get<Row>('SELECT * FROM repos WHERE id = ?', [id])!;
const live = (db: Db) => db.all<{ name_with_owner: string }>('SELECT name_with_owner FROM repos WHERE removed_at IS NULL ORDER BY id').map((r) => r.name_with_owner);

describe('upsertOwned', () => {
  it('inserts an owned, live repo', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    expect(row(db, id)).toMatchObject({ name: 'app', name_with_owner: 'alice/app', tracked_by: 'owned', removed_at: null, added_at: null });
  });

  it('follows a rename by node id, keeping the id and local preferences', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    db.run('UPDATE repos SET pinned = 1, hidden = 1 WHERE id = ?', [id]);
    expect(upsertOwned(db, rec('alice/app2', 'R_app'), NOW)).toBe(id);
    expect(row(db, id)).toMatchObject({ name: 'app2', name_with_owner: 'alice/app2', pinned: 1, hidden: 1 });
  });

  it('claims a repo that was added by hand (transferred to the viewer)', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'bob/tool', 'R_tool', { unavailable: true });
    db.run('UPDATE repos SET hidden = 1 WHERE id = ?', [id]);
    expect(upsertOwned(db, rec('alice/tool', 'R_tool'), NOW)).toBe(id);
    expect(row(db, id)).toMatchObject({
      name_with_owner: 'alice/tool', tracked_by: 'owned', added_at: null, unavailable_at: null, removed_at: null, hidden: 1,
    });
  });

  it('releases the key from another live repo without renaming it', () => {
    const db = openDb(':memory:');
    const old = upsertOwned(db, rec('alice/app', 'R_old'), NOW);
    const fresh = upsertOwned(db, rec('alice/app', 'R_new'), NOW);
    expect(row(db, old)).toMatchObject({ name: 'app', name_with_owner: 'alice/app', removed_at: NOW });
    expect(row(db, fresh)).toMatchObject({ name: 'app', removed_at: null });
    expect(live(db)).toEqual(['alice/app']);
  });

  it('releases a key held in another case (the key index ignores case)', () => {
    const db = openDb(':memory:');
    const old = upsertOwned(db, rec('alice/Foo', 'R_old'), NOW);
    const fresh = upsertOwned(db, rec('alice/foo', 'R_new'), NOW);
    expect(row(db, old).removed_at).toBe(NOW);
    expect(row(db, fresh).removed_at).toBeNull();
  });

  it('also releases a key held by a repo added by hand', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'alice/app', 'R_gone');
    upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    expect(row(db, id)).toMatchObject({ tracked_by: 'manual', removed_at: NOW });
  });

  it('revives a removed repo, and leaves other removed rows with its key alone', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    const other = upsertOwned(db, rec('alice/lib', 'R_lib'), NOW);
    expect(markReposRemoved(db, [], '2026-09-28T00:00:00Z')).toBe(2);
    expect(upsertOwned(db, rec('alice/app', 'R_app'), NOW)).toBe(id);
    expect(row(db, id).removed_at).toBeNull();
    expect(row(db, other).removed_at).toBe('2026-09-28T00:00:00Z');
  });

  it('keeps a repo of the same short name under another owner live', () => {
    const db = openDb(':memory:');
    const theirs = manual(db, 'dlvhdr/gh-dash', 'R_theirs');
    upsertOwned(db, rec('kcosr/gh-dash', 'R_mine'), NOW);
    expect(row(db, theirs).removed_at).toBeNull();
    expect(live(db)).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash']);
  });
});

describe('releaseKey', () => {
  it('counts the live rows it released; the holder and removed rows are untouched', () => {
    const db = openDb(':memory:');
    const holder = upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    expect(releaseKey(db, 'ALICE/APP', 'R_app', NOW)).toBe(0);
    expect(releaseKey(db, 'alice/app', 'R_other', '2026-09-30T00:00:00Z')).toBe(1);
    expect(releaseKey(db, 'alice/app', 'R_other', '2026-10-01T00:00:00Z')).toBe(0);
    expect(row(db, holder).removed_at).toBe('2026-09-30T00:00:00Z');
  });
});

describe('markReposRemoved', () => {
  it('removes owned repos missing from the owned list, never repos added by hand', () => {
    const db = openDb(':memory:');
    upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    upsertOwned(db, rec('alice/old', 'R_old'), NOW);
    manual(db, 'dlvhdr/gh-dash', 'R_theirs');
    expect(markReposRemoved(db, ['R_app'], NOW)).toBe(1);
    expect(live(db)).toEqual(['alice/app', 'dlvhdr/gh-dash']);
  });
});

describe('refreshManual', () => {
  it('updates a live repo added by hand and clears unavailable', () => {
    const db = openDb(':memory:');
    const id = manual(db, 'bob/tool', 'R_tool', { unavailable: true });
    db.run('UPDATE repos SET pinned = 1, hidden = 1 WHERE id = ?', [id]);
    expect(refreshManual(db, rec('bob/tool2', 'R_tool', { description: 'renamed' }), NOW)).toBe(id);
    expect(row(db, id)).toMatchObject({ name_with_owner: 'bob/tool2', tracked_by: 'manual', unavailable_at: null, added_at: '2026-09-01T00:00:00Z', pinned: 1, hidden: 1 });
  });

  it('never inserts, and leaves removed or owned rows alone', () => {
    const db = openDb(':memory:');
    expect(refreshManual(db, rec('bob/new', 'R_new'), NOW)).toBeNull();
    const gone = manual(db, 'bob/gone', 'R_gone');
    db.run('UPDATE repos SET removed_at = ? WHERE id = ?', [NOW, gone]);
    expect(refreshManual(db, rec('bob/gone', 'R_gone', { description: 'x' }), NOW)).toBeNull();
    upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    expect(refreshManual(db, rec('alice/app', 'R_app', { description: 'x' }), NOW)).toBeNull();
    expect(db.all('SELECT name_with_owner, description FROM repos ORDER BY id')).toEqual([
      { name_with_owner: 'bob/gone', description: null }, { name_with_owner: 'alice/app', description: null },
    ]);
  });

  it('releases the key from another live row holding it', () => {
    const db = openDb(':memory:');
    const stale = manual(db, 'bob/tool', 'R_old');
    const id = manual(db, 'bob/tool-v1', 'R_tool');
    expect(refreshManual(db, rec('bob/tool', 'R_tool'), NOW)).toBe(id);
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
    const owned = upsertOwned(db, rec('alice/app', 'R_app'), NOW);
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
    const res = addManual(db, rec('bob/tool', 'R_tool'), { hidden: true }, NOW);
    expect(res).toEqual({ added: true, id: expect.any(Number) });
    expect(row(db, (res as { id: number }).id)).toMatchObject({ tracked_by: 'manual', added_at: NOW, hidden: 1, removed_at: null });
  });

  it('reports a live repo with that node id instead of touching it', () => {
    const db = openDb(':memory:');
    const owned = upsertOwned(db, rec('alice/app', 'R_app'), NOW);
    db.run('UPDATE repos SET hidden = 1 WHERE id = ?', [owned]);
    expect(addManual(db, rec('alice/app', 'R_app'), { hidden: false }, NOW)).toEqual({ added: false, id: owned, trackedBy: 'owned', hidden: true });
    const tool = manual(db, 'bob/tool', 'R_tool');
    expect(addManual(db, rec('bob/tool', 'R_tool'), { hidden: true }, NOW)).toEqual({ added: false, id: tool, trackedBy: 'manual', hidden: false });
    expect(row(db, tool).hidden).toBe(0);
  });

  it('revives a removed row with its earlier data (an owned repo transferred away, then added)', () => {
    const db = openDb(':memory:');
    const id = upsertOwned(db, rec('alice/lib', 'R_lib'), NOW);
    db.run('UPDATE repos SET pinned = 1 WHERE id = ?', [id]);
    db.run(`INSERT INTO pull_requests (repo_id, number, title, state, created_at, updated_at, activity_at, url) VALUES (?, 1, 'Old', 'open', 'x', 'x', 'x', 'u')`, [id]);
    markReposRemoved(db, [], NOW);
    const res = addManual(db, rec('carol/lib', 'R_lib'), { hidden: false }, '2026-09-30T00:00:00Z');
    expect(res).toEqual({ added: true, id });
    expect(row(db, id)).toMatchObject({ name_with_owner: 'carol/lib', tracked_by: 'manual', added_at: '2026-09-30T00:00:00Z', removed_at: null, pinned: 1 });
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM pull_requests WHERE repo_id = ?', [id])!.n).toBe(1);
  });

  it('releases the key from another live row holding it', () => {
    const db = openDb(':memory:');
    const stale = manual(db, 'bob/tool', 'R_old');
    addManual(db, rec('bob/tool', 'R_new'), { hidden: false }, NOW);
    expect(row(db, stale).removed_at).toBe(NOW);
    expect(live(db)).toEqual(['bob/tool']);
  });
});
