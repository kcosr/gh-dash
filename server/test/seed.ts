import { type Db, openDb } from '../db/db';
import type { ActorRecord, CommitRecord, IssueRecord, PrRecord, RepoRecord } from '../db/records';
import { patchSettings } from '../db/settings';
import { setRepoPrefs } from '../db/repos';
import { GITHUB_HOST, GITHUB_SOURCE_ID, type SourceRef, type SourceViewer, sourceKey } from '../db/sources';
import { upsertCommit, upsertIssue, upsertPr, upsertRelease, upsertOwned, upsertStar } from '../db/write';

/** The github.com source, as the write helpers take it. */
export const GITHUB: SourceRef = { id: GITHUB_SOURCE_ID, host: GITHUB_HOST };

/**
 * Stores `v` as the account of source `sourceId` (github.com by default), unconditionally, or forgets it (null): the
 * state a claim leaves, or another process's claim.
 */
export function setViewer(db: Db, v: (Partial<SourceViewer> & { login: string }) | null, sourceId = GITHUB_SOURCE_ID): void {
  db.run(
    'UPDATE sources SET viewer_id = ?, viewer_login = ?, viewer_name = ?, viewer_avatar = ?, viewer_emails = ? WHERE id = ?',
    [v?.id ?? null, v?.login ?? null, v?.name ?? null, v?.avatarUrl ?? null, JSON.stringify(v?.emails ?? []), sourceId],
  );
}

export const actor = (login: string | null, email: string | null = null): ActorRecord => ({
  login,
  name: login ? login[0]!.toUpperCase() + login.slice(1) : 'Alice (work)',
  email,
  avatarUrl: login ? `https://avatars.example/${login}` : null,
});

function repo(name: string, over: Partial<RepoRecord> = {}): RepoRecord {
  return {
    nodeId: `R_${name}`,
    name,
    nameWithOwner: `alice/${name}`,
    owner: 'alice',
    description: null,
    url: `https://github.com/alice/${name}`,
    visibility: 'public',
    isArchived: false,
    isFork: false,
    languageName: 'TypeScript',
    languageColor: '#3178c6',
    topics: [],
    defaultBranch: 'main',
    stars: 0,
    forks: 0,
    createdAt: '2025-01-01T00:00:00Z',
    pushedAt: '2026-09-25T12:00:00Z',
    ...over,
  };
}

function pr(number: number, over: Partial<PrRecord> & Pick<PrRecord, 'state' | 'createdAt'>): PrRecord {
  const mergedAt = over.mergedAt ?? null;
  const closedAt = over.closedAt ?? mergedAt;
  return {
    number,
    title: `PR ${number}`,
    body: '',
    isDraft: false,
    author: actor('alice'),
    mergedBy: mergedAt ? 'alice' : null,
    updatedAt: closedAt ?? over.createdAt,
    closedAt,
    mergedAt,
    activityAt: over.state === 'merged' ? mergedAt! : over.state === 'closed' ? closedAt! : over.createdAt,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    commitCount: 1,
    headRef: 'feature',
    headOid: String(number).repeat(40).slice(0, 40),
    baseRef: 'main',
    labels: [],
    closingIssues: [],
    url: `https://github.com/alice/x/pull/${number}`,
    commits: [],
    ...over,
  };
}

function commit(oid: string, committedAt: string, author: ActorRecord, prNumber: number | null, headline = `Commit ${oid}`): CommitRecord {
  return { oid: oid.padEnd(40, '0'), headline, body: '', author, committedAt, url: `https://github.com/c/${oid}`, additions: 1, deletions: 0, prNumber };
}

function issue(number: number, over: Partial<IssueRecord> & Pick<IssueRecord, 'state' | 'createdAt'>): IssueRecord {
  const closedAt = over.closedAt ?? null;
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    author: actor('bob'),
    closedBy: null,
    updatedAt: closedAt ?? over.createdAt,
    closedAt,
    activityAt: over.state === 'closed' ? closedAt! : over.createdAt,
    labels: [],
    url: `https://github.com/alice/x/issues/${number}`,
    ...over,
  };
}

/**
 * A repository added by hand, stored as adding one will store it (tracked_by 'manual'). Returns its id.
 * `path` is the provider path (owner/name on GitHub); the owner is everything before the last '/'. On github.com (the
 * default `source`) the path is the key; elsewhere the key is `<host>/<path>`.
 */
export function addManualRepo(
  db: Db,
  path: string,
  over: Partial<RepoRecord> & { hidden?: boolean; addedAt?: string; source?: SourceRef } = {},
): number {
  const { hidden, addedAt, source = GITHUB, ...fields } = over;
  const i = path.lastIndexOf('/');
  const r: RepoRecord = { ...repo(path.slice(i + 1)), nodeId: `R_${path}`, nameWithOwner: path, owner: path.slice(0, i), url: `https://${source.host}/${path}`, ...fields };
  return db.run(
    `INSERT INTO repos (source_id, key, node_id, name, name_with_owner, owner, description, url, visibility, is_archived, is_fork, language_name,
       language_color, topics, default_branch, stars, forks, created_at, pushed_at, hidden, tracked_by, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    [
      source.id, sourceKey(source, r.nameWithOwner), r.nodeId, r.name, r.nameWithOwner, r.owner, r.description, r.url, r.visibility,
      Number(r.isArchived), Number(r.isFork), r.languageName, r.languageColor, JSON.stringify(r.topics), r.defaultBranch, r.stars, r.forks,
      r.createdAt, r.pushedAt, Number(hidden ?? false), addedAt ?? '2026-09-27T12:00:00Z',
    ],
  ).lastInsertRowid;
}

/**
 * Viewer "alice"; repos: app (public, 5 stargazers), secret (private), old (archived), fork (fork), hidden (hidden).
 * Keys are alice/<name>. All times are September 2026 UTC.
 */
export function seedDb(): Db {
  const db = openDb(':memory:');
  setViewer(db, { login: 'Alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice' });
  const now = '2026-09-27T12:00:00Z';
  const app = upsertOwned(db, GITHUB, repo('app', { stars: 5 }), now);
  const secret = upsertOwned(db, GITHUB, repo('secret', { visibility: 'private' }), now);
  const old = upsertOwned(db, GITHUB, repo('old', { isArchived: true, stars: 1 }), now);
  const fork = upsertOwned(db, GITHUB, repo('fork', { isFork: true }), now);
  const hidden = upsertOwned(db, GITHUB, repo('hidden'), now);
  setRepoPrefs(db, 'hidden', { hidden: true });

  upsertPr(db, app, pr(1, {
    state: 'merged', createdAt: '2026-09-20T10:00:00Z', mergedAt: '2026-09-21T10:00:00Z', title: 'Fix login flow',
    body: '## Summary\n\nFixes the **login** flow for [SSO](https://sso.example) users.\n\n- second paragraph', labels: [{ name: 'bug', color: 'd73a4a' }],
    closingIssues: [{ number: 10, title: 'Issue 10', state: 'closed', url: 'https://github.com/alice/app/issues/10' }],
    commits: [{ oid: 'p1', headline: 'fix login', committedAt: '2026-09-20T09:00:00Z', url: 'u', author: actor('alice') }],
  }));
  upsertPr(db, app, pr(2, { state: 'open', createdAt: '2026-09-22T09:00:00Z', author: actor('bob'), title: 'Add parser' }));
  upsertPr(db, app, pr(3, { state: 'closed', createdAt: '2026-09-01T00:00:00Z', closedAt: '2026-09-23T08:00:00Z', author: actor('bob') }));
  upsertPr(db, secret, pr(1, {
    state: 'merged', createdAt: '2026-09-24T00:00:00Z', mergedAt: '2026-09-24T02:00:00Z', labels: [{ name: 'feature', color: 'a2eeef' }],
  }));
  upsertPr(db, old, pr(1, { state: 'merged', createdAt: '2026-09-09T00:00:00Z', mergedAt: '2026-09-10T00:00:00Z' }));
  upsertPr(db, fork, pr(1, { state: 'merged', createdAt: '2026-09-10T00:00:00Z', mergedAt: '2026-09-11T00:00:00Z', author: actor('bob') }));
  upsertPr(db, hidden, pr(1, { state: 'merged', createdAt: '2026-09-11T00:00:00Z', mergedAt: '2026-09-12T00:00:00Z' }));

  upsertCommit(db, app, commit('c1', '2026-09-21T10:00:00Z', actor('alice'), 1, 'Merge pull request #1'));
  upsertCommit(db, app, commit('c2', '2026-09-22T23:30:00Z', actor(null, 'alice@work.example'), null, 'Tweak config'));
  upsertCommit(db, app, commit('c3', '2026-09-25T12:00:00Z', actor('bob'), null, 'Refactor parser module'));
  upsertCommit(db, secret, commit('c4', '2026-09-24T02:00:00Z', actor('alice'), 1));

  upsertIssue(db, app, issue(10, { state: 'closed', createdAt: '2026-09-05T00:00:00Z', closedAt: '2026-09-22T12:00:00Z', closedBy: actor('alice') }));
  upsertIssue(db, app, issue(11, { state: 'open', createdAt: '2026-09-26T00:00:00Z', author: actor('alice') }));

  upsertRelease(db, app, {
    tag: 'v1.0.0', name: 'First', body: 'First release', author: actor('alice'), publishedAt: '2026-09-23T15:00:00Z',
    isPrerelease: false, url: 'https://github.com/alice/app/releases/tag/v1.0.0',
  });

  for (const [login, at] of [['frank', '2026-08-01T00:00:00Z'], ['carol', '2026-09-20T00:00:00Z'], ['dave', '2026-09-25T06:00:00Z'], ['erin', '2026-09-27T00:00:00Z']] as const) {
    upsertStar(db, app, { login, name: null, avatarUrl: null, starredAt: at });
  }
  upsertStar(db, old, { login: 'gina', name: null, avatarUrl: null, starredAt: '2026-09-21T00:00:00Z' });

  patchSettings(db, { myEmails: ['alice@work.example'] });
  return db;
}
