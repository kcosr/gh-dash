// Claiming a database for an account must be atomic across processes: another gh-dash instance on the same database
// (a second connection here) must not be able to claim it between a claim's read of the viewer and its write.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/db';
import { DEFAULT_SETTINGS } from '../db/settings';
import { GITHUB_SOURCE_ID, getSource } from '../db/sources';
import { GitHubSyncSource } from '../github/sync-source';
import { fakeGitHub } from '../test/github';
import { fakeGraphQL, repoNode } from '../test/graphql';
import { testTokens } from '../test/tokens';
import { SyncManager } from './manager';
import { runSync } from './sync';

/** Runs once, right after the next read of a stored source (its viewer) through a watched handle. */
const hook: { afterViewerRead: (() => void) | null } = { afterViewerRead: null };

function watchViewerReads(db: Db): Db {
  const get = db.get.bind(db);
  db.get = (<T>(sql: string, params?: Parameters<Db['get']>[1]): T | undefined => {
    const row = get<T>(sql, params);
    if (/\bFROM sources\b/.test(sql) && /viewer_login/.test(sql) && hook.afterViewerRead) {
      const run = hook.afterViewerRead;
      hook.afterViewerRead = null;
      run();
    }
    return row;
  }) as Db['get'];
  return db;
}

const dirs: string[] = [];
afterEach(() => {
  hook.afterViewerRead = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An unclaimed database file, this process's handle on it, and another process's (which never waits for a lock). */
function shared(): { db: Db; other: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ghd-claim-'));
  dirs.push(dir);
  const path = join(dir, 'dash.db');
  return { db: watchViewerReads(openDb(path)), other: new DatabaseSync(path, { timeout: 0 }), path };
}

/** The other process claims the database for Bob, as its POST /repos would; reports what happened. */
function otherClaims(other: DatabaseSync): () => string {
  let outcome = 'not tried';
  hook.afterViewerRead = () => {
    try {
      other.exec(`UPDATE sources SET viewer_id = 'U_bob', viewer_login = 'bob' WHERE id = 1`);
      outcome = 'claimed';
    } catch (err) {
      outcome = /locked|busy/i.test(String(err)) ? 'kept waiting' : String(err);
    }
  };
  return () => outcome;
}

const viewerOf = (other: DatabaseSync) => (other.prepare('SELECT viewer_login FROM sources WHERE id = 1').get() as { viewer_login: string }).viewer_login;

describe('claiming the database for an account', () => {
  it('keeps another process out while a sync claims it', async () => {
    const { db, other } = shared();
    const gql = fakeGraphQL();
    gql.state.owned.push(repoNode('alice/app'));
    const gh = fakeGitHub({ '/graphql': gql.handler });
    let outcome = () => 'not armed';
    // Once GitHub has named the account, the other process tries to claim the database first.
    const fetchImpl: typeof fetch = async (input, init) => {
      const res = await gh.fetchImpl(input, init);
      if (/query ViewerRepos/.test(String(init?.body))) outcome = otherClaims(other);
      return res;
    };
    const src = getSource(db, GITHUB_SOURCE_ID)!;
    const res = await runSync({ db, source: new GitHubSyncSource({ token: 't', fetchImpl }), src, settings: DEFAULT_SETTINGS }).catch((e: unknown) => e);
    expect(outcome()).toBe('kept waiting');
    expect(res).toMatchObject({ errors: [] });
    expect(viewerOf(other)).toBe('alice');
    db.close();
    other.close();
  });

  it('keeps another process out while ensureViewer claims it', async () => {
    const { db, other } = shared();
    let outcome = () => 'not armed';
    const fetchImpl: typeof fetch = async () => {
      outcome = otherClaims(other);
      return new Response(JSON.stringify({ data: { viewer: { id: 'U_alice', login: 'alice', name: null, avatarUrl: null }, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } } }));
    };
    const m = new SyncManager({ db, schedule: false, tokens: testTokens('t'), log: () => {}, fetchImpl });
    await m.ensureViewer();
    expect(outcome()).toBe('kept waiting');
    expect(viewerOf(other)).toBe('alice');
    await m.shutdown();
    db.close();
    other.close();
  });
});
