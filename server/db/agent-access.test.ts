import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { addManualRepo, GITHUB, setViewer } from '../test/seed';
import { listAgentAccess, repoAgentAccessSql, setRepoAgentAccess, setSourceAgentAccess } from './agent-access';
import { Db, openDb } from './db';
import { migrate, versionOf } from './schema';
import { ensureSource } from './sources';
import { storedRepoRecord, upsertOwned } from './write';

const NOW = '2026-11-22T01:00:00Z';
const addSource = (db: Db, host: string) => ensureSource(db, { kind: 'gitlab', host, baseUrl: `https://${host}` });
const allowed = (db: Db) => db.all<{ id: number }>(`SELECT r.id FROM repos r WHERE ${repoAgentAccessSql('r')} ORDER BY r.id`).map((r) => r.id);

describe('repository agent access', () => {
  it('preserves access only for sources in use when an existing database is upgraded', () => {
    const db = new Db(new DatabaseSync(':memory:'));
    migrate(db, true, { upTo: versionOf('repo-agent-access') - 1 });
    const tracked = addSource(db, 'tracked.example.com');
    const claimed = addSource(db, 'claimed.example.com');
    const repoId = addManualRepo(db, 'owner/tracked', { source: tracked });
    setViewer(db, { login: 'alice' }, claimed.id);

    migrate(db, false);
    expect(listAgentAccess(db).sources.map((s) => [s.host, s.defaultAccess])).toEqual([
      ['github.com', 'block'], [tracked.host, 'allow'], [claimed.host, 'allow'],
    ]);
    expect(listAgentAccess(db).repos).toEqual([
      { id: repoId, key: `${tracked.host}/owner/tracked`, nameWithOwner: 'owner/tracked', source: tracked.host, access: 'inherit' },
    ]);
    expect(allowed(db)).toEqual([repoId]);
    db.close();
  });

  it('applies defaults to new and inherited repositories while preserving explicit choices', () => {
    const db = openDb(':memory:');
    const gitlab = addSource(db, 'gitlab.example.com');
    const inherited = addManualRepo(db, 'owner/inherited');
    const blocked = addManualRepo(db, 'owner/blocked');
    const granted = addManualRepo(db, 'owner/granted', { source: gitlab });
    expect(allowed(db)).toEqual([]);

    setRepoAgentAccess(db, [blocked], 'block');
    setRepoAgentAccess(db, [granted], 'allow');
    setSourceAgentAccess(db, 'GitHub.com', 'allow');
    const discovered = addManualRepo(db, 'owner/discovered');
    expect(allowed(db)).toEqual([inherited, granted, discovered]);

    setSourceAgentAccess(db, 'github.com', 'block');
    expect(allowed(db)).toEqual([granted]);
    setRepoAgentAccess(db, [granted], 'inherit');
    expect(allowed(db)).toEqual([]);
    db.close();
  });

  it('keeps an override on rename and never applies a stale bulk edit to a replacement at the same path', () => {
    const db = openDb(':memory:');
    const id = addManualRepo(db, 'owner/original');
    const record = storedRepoRecord(db, GITHUB, 'R_owner/original')!;
    setRepoAgentAccess(db, [id], 'allow');

    const renamed = { ...record, name: 'renamed', nameWithOwner: 'owner/renamed', url: 'https://github.com/owner/renamed' };
    expect(upsertOwned(db, GITHUB, renamed, NOW)).toBe(id);
    const newAtOriginal = upsertOwned(db, GITHUB, { ...record, nodeId: 'R_new' }, NOW);
    expect(allowed(db)).toEqual([id]);

    const replacement = upsertOwned(db, GITHUB, { ...renamed, nodeId: 'R_replacement' }, NOW);
    expect(allowed(db)).toEqual([]);
    expect(() => setRepoAgentAccess(db, [newAtOriginal, id], 'allow')).toThrow('no longer tracked');
    expect(listAgentAccess(db).repos.map((r) => [r.id, r.access])).toEqual([
      [newAtOriginal, 'inherit'], [replacement, 'inherit'],
    ]);
    db.close();
  });
});
