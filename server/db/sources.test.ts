import { describe, expect, it } from 'vitest';
import { GITHUB, seedDb, setViewer } from '../test/seed';
import { type Db, openDb } from './db';
import type { RepoRecord } from './records';
import { createSet } from './repos';
import {
  ensureSource,
  GITHUB_SOURCE_ID,
  getSource,
  listSources,
  removeSource,
  setSourceRateLimit,
  sourceByHost,
  sourceKey,
  sourceLabel,
  tryClaimViewer,
  viewerMismatch,
} from './sources';
import { updateSyncState, upsertCommit, upsertIssue, upsertOwned, upsertPr, upsertRelease, upsertStar } from './write';

const GITLAB = { kind: 'gitlab' as const, host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' };

describe('the sources table', () => {
  it('has github.com as source 1 from the start', () => {
    expect(listSources(openDb(':memory:'))).toEqual([
      { id: 1, kind: 'github', host: 'github.com', baseUrl: 'https://github.com', name: 'GitHub', viewer: null, lastSync: null, rateLimit: null },
    ]);
  });

  it('ensureSource adds a host once, lower-cased, and refreshes its base URL', () => {
    const db = openDb(':memory:');
    expect(ensureSource(db, { kind: 'github', host: 'github.com', baseUrl: 'https://github.com' }).id).toBe(GITHUB_SOURCE_ID);
    const gl = ensureSource(db, { ...GITLAB, host: 'GitLab.Example.COM' });
    expect(gl).toMatchObject({ id: 2, kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com', name: 'GitLab', viewer: null });
    // The scheme, port and relative root may change in config: the host is the identity.
    expect(ensureSource(db, { ...GITLAB, baseUrl: 'http://gitlab.example.com:8080/gitlab' })).toMatchObject({ id: 2, baseUrl: 'http://gitlab.example.com:8080/gitlab' });
    expect(sourceByHost(db, 'GITLAB.example.com')?.id).toBe(2);
    expect(sourceByHost(db, 'gitlab.test')).toBeNull();
    expect(getSource(db, 99)).toBeNull();
    expect(() => ensureSource(db, { kind: 'github', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' })).toThrow(
      'gitlab.example.com is already a gitlab source here',
    );
  });

  it('names GitLab sources by host while there are several', () => {
    const db = openDb(':memory:');
    ensureSource(db, GITLAB);
    const second = ensureSource(db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    expect(listSources(db).map((s) => s.name)).toEqual(['GitHub', 'gitlab.example.com', 'gitlab2.example.com']);
    removeSource(db, second.id);
    expect(listSources(db).map((s) => s.name)).toEqual(['GitHub', 'GitLab']);
  });

  it('records a rate limit per source', () => {
    const db = openDb(':memory:');
    const gl = ensureSource(db, GITLAB);
    setSourceRateLimit(db, gl.id, { limit: 2000, remaining: 1990, resetAt: '2026-09-29T13:00:00Z' });
    expect(getSource(db, gl.id)!.rateLimit).toEqual({ limit: 2000, remaining: 1990, resetAt: '2026-09-29T13:00:00Z' });
    expect(getSource(db, GITHUB_SOURCE_ID)!.rateLimit).toBeNull();
  });
});

describe('sourceKey / sourceLabel', () => {
  it('key github.com repos by path and every other source by host and path', () => {
    expect(sourceKey(GITHUB, 'alice/app')).toBe('alice/app');
    expect(sourceKey({ id: 2, host: 'gitlab.example.com' }, 'alice/app')).toBe('gitlab.example.com/alice/app');
    expect(sourceKey({ id: 2, host: 'gitlab.example.com' }, 'platform/team/app')).toBe('gitlab.example.com/platform/team/app');
  });

  it('name a source in messages', () => {
    expect(sourceLabel({ id: 1, host: 'github.com', name: 'GitHub' })).toBe('GitHub');
    expect(sourceLabel({ id: 2, host: 'gitlab.example.com', name: 'GitLab' })).toBe('GitLab (gitlab.example.com)');
    expect(sourceLabel({ id: 3, host: 'gitlab2.example.com', name: 'gitlab2.example.com' })).toBe('gitlab2.example.com');
  });
});

describe('claiming a source for an account', () => {
  const alice = { id: 'U_alice', login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice' };
  const aliceGl = { id: 'gid://gitlab/User/7', login: 'alice', name: 'Alice', avatarUrl: null, emails: ['alice@example.com'] };

  it('claims each source for its own account', () => {
    const db = openDb(':memory:');
    const gl = ensureSource(db, GITLAB);
    expect(tryClaimViewer(db, GITHUB_SOURCE_ID, alice)).toBeNull();
    expect(tryClaimViewer(db, gl.id, aliceGl)).toBeNull();
    expect(getSource(db, GITHUB_SOURCE_ID)!.viewer).toEqual({ ...alice, emails: [] });
    expect(getSource(db, gl.id)!.viewer).toEqual(aliceGl);
  });

  it('refuses another account on one source without affecting the others', () => {
    const db = openDb(':memory:');
    const gl = ensureSource(db, GITLAB);
    tryClaimViewer(db, gl.id, aliceGl);
    expect(tryClaimViewer(db, gl.id, { id: 'gid://gitlab/User/8', login: 'bob' })).toBe(
      "This database's GitLab (gitlab.example.com) account is @alice, but the token is for @bob. Switch back to @alice, or remove the source and add it again (its data is deleted).",
    );
    expect(getSource(db, gl.id)!.viewer).toEqual(aliceGl);
    // github.com is still unclaimed, and anyone's to claim: a mismatch on source 2 doesn't block source 1.
    expect(tryClaimViewer(db, GITHUB_SOURCE_ID, { id: 'U_bob', login: 'bob', name: null, avatarUrl: null })).toBeNull();
    expect(getSource(db, GITHUB_SOURCE_ID)!.viewer).toMatchObject({ id: 'U_bob', login: 'bob' });
    expect(tryClaimViewer(db, GITHUB_SOURCE_ID, alice)).toBe(
      "This database's GitHub account is @bob, but the token is for @alice. Switch back to @bob, or use a different database.",
    );
  });

  it('follows a renamed account by id, matches logins where no id was stored, and keeps what the provider left out', () => {
    const db = openDb(':memory:');
    const gl = ensureSource(db, GITLAB);
    setViewer(db, { login: 'Alice', emails: ['old@example.com'] }, gl.id);
    // Stored by login only: the login decides (in any case), and the claim adds the id.
    expect(tryClaimViewer(db, gl.id, { id: aliceGl.id, login: 'alice' })).toBeNull();
    expect(getSource(db, gl.id)!.viewer).toEqual({ id: aliceGl.id, login: 'alice', name: null, avatarUrl: null, emails: ['old@example.com'] });
    // Known by id: a new login is the same account, renamed. Emails are replaced only when given.
    expect(tryClaimViewer(db, gl.id, { id: aliceGl.id, login: 'alice2', name: 'Alice', emails: ['alice@example.com'] })).toBeNull();
    expect(getSource(db, gl.id)!.viewer).toMatchObject({ login: 'alice2', emails: ['alice@example.com'] });
    // An id is never dropped by a provider that sends none.
    expect(tryClaimViewer(db, gl.id, { id: null, login: 'alice2' })).toBeNull();
    expect(getSource(db, gl.id)!.viewer).toMatchObject({ id: aliceGl.id });
    expect(tryClaimViewer(db, gl.id, { id: 'gid://gitlab/User/9', login: 'alice2' })).toContain('account is @alice2');
  });

  it('viewerMismatch is null for an unclaimed source', () => {
    expect(viewerMismatch({ id: 2, host: 'gitlab.example.com', name: 'GitLab', viewer: null }, { login: 'anyone' })).toBeNull();
  });
});

describe('removeSource', () => {
  function project(path: string, nodeId: string): RepoRecord {
    const i = path.lastIndexOf('/');
    return {
      nodeId, name: path.slice(i + 1), nameWithOwner: path, owner: path.slice(0, i), description: null, url: `https://gitlab.example.com/${path}`,
      visibility: 'private', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
      stars: 0, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-20T00:00:00Z',
    };
  }
  const actor = { login: 'alice', name: null, email: null, avatarUrl: null };
  const CHILDREN = ['sync_state', 'pull_requests', 'commits', 'issues', 'releases', 'stars', 'repo_set_members'];
  const count = (db: Db, sql: string, params: (string | number)[] = []) => db.get<{ n: number }>(sql, params)!.n;
  const perTable = (db: Db) => Object.fromEntries(['repos', ...CHILDREN, 'pr_commits'].map((t) => [t, count(db, `SELECT count(*) AS n FROM ${t}`)]));

  /** seedDb's GitHub repos, and two GitLab projects with data in every table (one a set member, one with a parser PR). */
  function withGitLabData() {
    const db = seedDb();
    const gl = ensureSource(db, GITLAB);
    const ids = [upsertOwned(db, gl, project('alice/app', 'gid://gitlab/Project/1'), '2026-09-27T00:00:00Z'), upsertOwned(db, gl, project('platform/team/svc', 'gid://gitlab/Project/2'), '2026-09-27T00:00:00Z')];
    for (const [i, id] of ids.entries()) {
      updateSyncState(db, id, { synced_at: '2026-09-27T00:00:00Z' });
      upsertPr(db, id, {
        number: 1, title: 'Parser rework', body: 'parser', state: 'open', isDraft: false, author: actor, mergedBy: null, createdAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:00:00Z', mergedAt: null, closedAt: null, activityAt: '2026-09-20T00:00:00Z', additions: 1, deletions: 0, changedFiles: 1,
        commitCount: 1, headRef: 'x', headOid: 'a'.repeat(40), baseRef: 'main', crossRepo: null, labels: [], closingIssues: [], url: 'u', mergeCommitOid: null, squashCommitOid: null,
        commits: [{ oid: 'b'.repeat(40), headline: 'parser', committedAt: '2026-09-20T00:00:00Z', url: 'u', author: actor }],
      });
      upsertCommit(db, id, { oid: `${i}`.repeat(40), headline: 'Parser fix', body: '', author: actor, committedAt: '2026-09-20T00:00:00Z', url: 'u', additions: 1, deletions: 0, prNumber: null });
      upsertIssue(db, id, { number: 2, title: 'Parser crash', body: '', state: 'open', author: actor, closedBy: null, createdAt: 'x', updatedAt: 'x', closedAt: null, activityAt: 'x', labels: [], url: 'u' });
      upsertRelease(db, id, { tag: 'v1', name: 'Parser', body: '', author: actor, publishedAt: 'x', isPrerelease: false, url: 'u' });
      upsertStar(db, id, { login: 'carol', name: null, avatarUrl: null, starredAt: 'x' });
    }
    createSet(db, 'mixed', ['alice/app', 'gitlab.example.com/alice/app']);
    return { db, gl, ids };
  }

  it('deletes the source, its repos and all their data, and nothing of other sources', () => {
    const { db, gl, ids } = withGitLabData();
    const before = perTable(db);
    const github = perTable(seedDb());
    expect(removeSource(db, gl.id)).toEqual({ repos: 2 });

    expect(getSource(db, gl.id)).toBeNull();
    for (const t of CHILDREN) expect(count(db, `SELECT count(*) AS n FROM ${t} WHERE repo_id IN (${ids.join(', ')})`), t).toBe(0);
    // Only the GitHub data is left: seedDb's, and the set's GitHub member.
    expect(perTable(db)).toEqual({ ...github, repo_set_members: 1 });
    expect(before.repos).toBe(github.repos + 2);
    for (const t of ['pull_requests_fts', 'issues_fts', 'commits_fts', 'releases_fts']) db.exec(`INSERT INTO ${t}(${t}) VALUES ('integrity-check')`);
    expect(count(db, `SELECT count(*) AS n FROM commits_fts WHERE commits_fts MATCH 'parser'`)).toBe(count(db, `SELECT count(*) AS n FROM commits WHERE headline LIKE '%parser%'`));
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it("refuses github.com and a source that doesn't exist", () => {
    const db = openDb(':memory:');
    expect(() => removeSource(db, GITHUB_SOURCE_ID)).toThrow("github.com is built in and can't be removed");
    expect(() => removeSource(db, 5)).toThrow('No source 5');
    expect(listSources(db)).toHaveLength(1);
  });
});
