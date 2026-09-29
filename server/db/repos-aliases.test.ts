import { describe, expect, it } from 'vitest';
import { seedDb } from '../test/seed';
import { createSet } from './repos';

describe('set members named by several aliases', () => {
  it('adds the repo once, at its first alias', () => {
    const db = seedDb();
    const set = createSet(db, 'aliases', ['secret', 'app', 'alice/app', 'APP', 'fork']);
    expect(set.repos).toEqual(['alice/secret', 'alice/app', 'alice/fork']);
    expect(db.all<{ position: number }>('SELECT position FROM repo_set_members WHERE set_id = ? ORDER BY position', [set.id]).map((r) => r.position)).toEqual([0, 1, 4]);
  });
});
