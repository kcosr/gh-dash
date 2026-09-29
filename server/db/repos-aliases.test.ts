import { describe, expect, it, vi } from 'vitest';
import { seedDb } from '../test/seed';
import { createSet } from './repos';

// Once keys become owner/name, a bare name and different casings are aliases of one repo. Simulate that resolver
// here: every spelling of `app` resolves to the same id.
vi.mock('./repo-key', async (importActual) => {
  const actual = await importActual<typeof import('./repo-key')>();
  return {
    ...actual,
    resolveRepoIds: (db: Parameters<typeof actual.resolveRepoIds>[0], keys: string[]) => {
      const canonical = (k: string) => (k.toLowerCase() === 'app' || k.toLowerCase() === 'alice/app' ? 'app' : k);
      const ids = actual.resolveRepoIds(db, keys.map(canonical));
      return new Map(keys.flatMap((k) => (ids.has(canonical(k)) ? [[k, ids.get(canonical(k))!] as const] : [])));
    },
  };
});

describe('set members named by several aliases', () => {
  it('adds the repo once, at its first alias', () => {
    const db = seedDb();
    const set = createSet(db, 'aliases', ['secret', 'app', 'alice/app', 'APP', 'fork']);
    expect(set.repos).toEqual(['secret', 'app', 'fork']);
    expect(db.all<{ position: number }>('SELECT position FROM repo_set_members WHERE set_id = ? ORDER BY position', [set.id]).map((r) => r.position)).toEqual([0, 1, 4]);
  });
});
