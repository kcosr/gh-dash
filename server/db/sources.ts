import { GITHUB_HOST, type ProviderKind } from '../../shared/api';
import type { Db } from './db';
import type { RateLimitMeta } from './meta';

// A source is one code host this database tracks repositories on: github.com (always source 1, created by the
// migration and never removed) and any GitLab instance configured. Its identity is its host, which is also the
// prefix of its repos' keys (none for github.com). The row holds what the database must remember about the source:
// the account its data belongs to (claimed by the first sync, like meta.viewer was for GitHub) and its last sync and
// rate limit. Credentials never live here: they come from config and env (design §1.6).

export const GITHUB_SOURCE_ID = 1;
export { GITHUB_HOST };

/** The account a source's data belongs to. `emails` count as "me" for commits (GitLab commits carry no login). */
export interface SourceViewer {
  /** Provider-stable id; null in databases that stored the account by login only. */
  id: string | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  emails: string[];
}

/** A source's own part of the last sync run. */
export interface SourceSyncMeta {
  at: string;
  durationMs: number;
  newItems: number;
  errors: string[];
  requests: number;
  /** GitHub GraphQL points; null for providers without them. */
  points: number | null;
}

export interface SourceRow {
  id: number;
  kind: ProviderKind;
  /** Lower-case hostname without port: identity, API/URL id, and the key prefix (except for github.com). */
  host: string;
  baseUrl: string;
  /** Display name: 'GitHub', 'GitLab', or the host when there is more than one GitLab source. */
  name: string;
  viewer: SourceViewer | null;
  lastSync: SourceSyncMeta | null;
  rateLimit: RateLimitMeta | null;
}

/** What the key and write helpers need of a source. */
export type SourceRef = Pick<SourceRow, 'id' | 'host'>;

/** The account a provider reports for a token (ViewerInfo; GitHub's GqlViewer fits too). */
export interface ClaimedViewer {
  id?: string | null;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  /** Replaces the stored emails when given; left as they are when absent. */
  emails?: string[];
}

interface Row {
  id: number;
  kind: string;
  host: string;
  base_url: string;
  name: string;
  viewer_id: string | null;
  viewer_login: string | null;
  viewer_name: string | null;
  viewer_avatar: string | null;
  viewer_emails: string;
  last_sync: string | null;
  rate_limit: string | null;
}

const SELECT = 'SELECT id, kind, host, base_url, name, viewer_id, viewer_login, viewer_name, viewer_avatar, viewer_emails, last_sync, rate_limit FROM sources';

const json = <T>(text: string | null): T | null => (text ? (JSON.parse(text) as T) : null);

function toSource(r: Row): SourceRow {
  return {
    id: r.id,
    kind: r.kind === 'gitlab' ? 'gitlab' : 'github',
    host: r.host,
    baseUrl: r.base_url,
    name: r.name,
    viewer:
      r.viewer_login === null
        ? null
        : {
            id: r.viewer_id, login: r.viewer_login, name: r.viewer_name, avatarUrl: r.viewer_avatar,
            emails: json<string[]>(r.viewer_emails) ?? [],
          },
    lastSync: json<SourceSyncMeta>(r.last_sync),
    rateLimit: json<RateLimitMeta>(r.rate_limit),
  };
}

export function listSources(db: Db): SourceRow[] {
  return db.all<Row>(`${SELECT} ORDER BY id`).map(toSource);
}

export function getSource(db: Db, id: number): SourceRow | null {
  const r = db.get<Row>(`${SELECT} WHERE id = ?`, [id]);
  return r ? toSource(r) : null;
}

export function sourceByHost(db: Db, host: string): SourceRow | null {
  const r = db.get<Row>(`${SELECT} WHERE host = ?`, [host.toLowerCase()]);
  return r ? toSource(r) : null;
}

/** GitLab sources are called 'GitLab' while there is one; with several, each is called by its host. */
function nameGitLabSources(db: Db): void {
  db.run(`UPDATE sources SET name = CASE WHEN (SELECT count(*) FROM sources WHERE kind = 'gitlab') > 1 THEN host ELSE 'GitLab' END
    WHERE kind = 'gitlab'`);
}

/**
 * The source for a configured host: inserted the first time, else its base URL refreshed from config (scheme, port
 * and relative root may change; the host is the identity). A host already stored for another kind is refused.
 */
export function ensureSource(db: Db, c: { kind: ProviderKind; host: string; baseUrl: string }): SourceRow {
  const host = c.host.toLowerCase();
  return db.tx(() => {
    const found = sourceByHost(db, host);
    if (found && found.kind !== c.kind) throw new Error(`${host} is already a ${found.kind} source here`);
    if (found) {
      if (found.baseUrl !== c.baseUrl) db.run('UPDATE sources SET base_url = ? WHERE id = ?', [c.baseUrl, found.id]);
    } else {
      db.run('INSERT INTO sources (kind, host, base_url, name, created_at) VALUES (?, ?, ?, ?, ?)', [
        c.kind, host, c.baseUrl, c.kind === 'github' ? 'GitHub' : 'GitLab', new Date().toISOString(),
      ]);
      nameGitLabSources(db);
    }
    return sourceByHost(db, host)!;
  });
}

/** The public key of the repo at provider path `path` on source `src`: the path on github.com, else `<host>/<path>`. */
export function sourceKey(src: SourceRef, path: string): string {
  return src.id === GITHUB_SOURCE_ID ? path : `${src.host}/${path}`;
}

/** How messages name a source: 'GitHub', 'GitLab (gitlab.example.com)'. */
export function sourceLabel(src: Pick<SourceRow, 'id' | 'host' | 'name'>): string {
  return src.id === GITHUB_SOURCE_ID || src.name === src.host ? src.name : `${src.name} (${src.host})`;
}

/**
 * Why the token's account mustn't sync into this source, or null if it may. A source's data belongs to the account
 * that first synced it: adopting another one (say after `gh auth switch`) would mark every repo removed, rename
 * same-named ones and mix both accounts' data. Compares ids when both are known, else logins (case-insensitively).
 */
export function viewerMismatch(src: Pick<SourceRow, 'id' | 'host' | 'name' | 'viewer'>, viewer: { id?: string | null; login: string }): string | null {
  const stored = src.viewer;
  if (!stored) return null;
  const same = stored.id && viewer.id ? stored.id === viewer.id : stored.login.toLowerCase() === viewer.login.toLowerCase();
  if (same) return null;
  const fix = src.id === GITHUB_SOURCE_ID ? 'use a different database' : 'remove the source and add it again (its data is deleted)';
  return `This database's ${sourceLabel(src)} account is @${stored.login}, but the token is for @${viewer.login}. Switch back to @${stored.login}, or ${fix}.`;
}

/**
 * Claims source `sourceId` for the account `v`, or finds it belongs to another one (returned: why not). The read,
 * check and write are one write transaction, so another process can't claim it in between. A claim refreshes the
 * login, name and avatar (they may have changed), keeps a stored id the provider didn't send, and replaces the emails
 * only when given.
 */
export function tryClaimViewer(db: Db, sourceId: number, v: ClaimedViewer): string | null {
  return db.tx(() => {
    const src = getSource(db, sourceId);
    if (!src) throw new Error(`No source ${sourceId}`);
    const mismatch = viewerMismatch(src, v);
    if (mismatch) return mismatch;
    db.run(
      `UPDATE sources SET viewer_id = coalesce(?, viewer_id), viewer_login = ?, viewer_name = ?, viewer_avatar = ?,
         viewer_emails = coalesce(?, viewer_emails) WHERE id = ?`,
      [v.id ?? null, v.login, v.name ?? null, v.avatarUrl ?? null, v.emails ? JSON.stringify(v.emails) : null, sourceId],
    );
    return null;
  });
}

/** Records the provider's rate limit as the source's client last saw it. */
export function setSourceRateLimit(db: Db, sourceId: number, rl: RateLimitMeta): void {
  db.run('UPDATE sources SET rate_limit = ? WHERE id = ?', [
    JSON.stringify({ limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt }),
    sourceId,
  ]);
}

/** Records the source's own part of the sync run that just ended (the manager, per source). */
export function setSourceLastSync(db: Db, sourceId: number, last: SourceSyncMeta): void {
  db.run('UPDATE sources SET last_sync = ? WHERE id = ?', [JSON.stringify(last), sourceId]);
}

/**
 * Removes a source and everything tracked on it, in one write transaction: its repos (which cascades to every child
 * table and the full-text indexes, as removing one repo does), then its row. github.com can't be removed. Refusing a
 * source still configured on this instance, and evicting the diff cache afterwards, are the caller's part.
 */
export function removeSource(db: Db, id: number): { repos: number } {
  if (id === GITHUB_SOURCE_ID) throw new Error(`${GITHUB_HOST} is built in and can't be removed`);
  return db.tx(() => {
    if (!getSource(db, id)) throw new Error(`No source ${id}`);
    const repos = db.run('DELETE FROM repos WHERE source_id = ?', [id]).changes;
    db.run('DELETE FROM sources WHERE id = ?', [id]);
    nameGitLabSources(db);
    return { repos };
  });
}
