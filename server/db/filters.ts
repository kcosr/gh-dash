import type { Ownership, VisibilityFilter, Who } from '../../shared/api';
import { isoSec } from '../lib/time';
import type { Db, Param } from './db';
import { REPO_IDS_FOR_KEYS } from './repo-key';
import { getSettings } from './settings';
import { listSources } from './sources';

/** Parsed, validated scope shared by every list/stats query. Times are UTC ms; `to` is exclusive. */
export interface Scope {
  /** null = the default selection (non-archived, non-hidden, non-fork unless includeForks). */
  repos: string[] | null;
  /**
   * The sources to look at, by host (lower-case): the context switcher's `source=`. Absent or null = every source. It
   * intersects `repos` (and the default selection), and also applies where `repos` is ignored (facets.byRepo).
   */
  source?: string[] | null;
  visibility: VisibilityFilter;
  /** 'mine': repos tracked because the viewer owns them; 'others': repos added by hand. */
  ownership: Ownership;
  who: Who;
  from: number;
  to: number;
  tz: string;
  q: string | null;
}

/**
 * Per-request facts needed to evaluate "me" and the default selection. "Me" is per source: every source has its own
 * account, so a login means one person on GitHub and possibly another on a GitLab instance.
 */
export interface QueryCtx {
  /** Lower-cased login of each source's account, by source id. A source whose account isn't known yet has no entry. */
  viewers: Map<number, string>;
  /** Lower-cased commit emails that count as me on every source: settings.myEmails and GH_DASH_MY_EMAILS. */
  myEmails: string[];
  /** Lower-cased commit emails of each source's account, by source id: they count as me in that source's repos only. */
  viewerEmails: Map<number, string[]>;
  includeForks: boolean;
}

/** `envEmails`: GH_DASH_MY_EMAILS, which always count as "me" in addition to settings.myEmails. */
export function loadQueryCtx(db: Db, envEmails: readonly string[] = []): QueryCtx {
  const settings = getSettings(db);
  const viewers = new Map<number, string>();
  const viewerEmails = new Map<number, string[]>();
  for (const src of listSources(db)) {
    if (!src.viewer) continue;
    viewers.set(src.id, src.viewer.login.toLowerCase());
    const emails = [...new Set(src.viewer.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length) viewerEmails.set(src.id, emails);
  }
  return {
    viewers,
    myEmails: [...new Set([...settings.myEmails, ...envEmails].map((e) => e.toLowerCase()))],
    viewerEmails,
    includeForks: settings.includeForks,
  };
}

/** Is this actor me, on the source the row belongs to? `email` is only meaningful for commits. */
export type IsMe = (login: string | null, email: string | null | undefined, sourceId: number) => boolean;

export function isMeFn(ctx: QueryCtx): IsMe {
  return (login, email, sourceId) => {
    const viewer = ctx.viewers.get(sourceId);
    if (viewer && login && login.toLowerCase() === viewer) return true;
    if (!email) return false;
    const e = email.toLowerCase();
    return ctx.myEmails.includes(e) || !!ctx.viewerEmails.get(sourceId)?.includes(e);
  };
}

export class Where {
  readonly parts: string[] = [];
  readonly params: Param[] = [];

  add(sql: string, ...params: Param[]): this {
    this.parts.push(sql);
    this.params.push(...params);
    return this;
  }

  toSql(): string {
    return this.parts.length ? this.parts.map((p) => `(${p})`).join(' AND ') : '1';
  }
}

/** Repo-level scope on alias `r`. `ignoreRepos` drops the repo selection (for facets.byRepo). */
export function addRepoScope(w: Where, scope: Scope, ctx: QueryCtx, ignoreRepos = false): void {
  w.add('r.removed_at IS NULL');
  if (!ignoreRepos) {
    if (scope.repos === null) w.add(`r.is_archived = 0 AND r.hidden = 0${ctx.includeForks ? '' : ' AND r.is_fork = 0'}`);
    else if (scope.repos.length === 0) w.add('0');
    else w.add(`r.id IN ${REPO_IDS_FOR_KEYS}`, JSON.stringify(scope.repos));
  }
  if (scope.source) w.add('r.source_id IN (SELECT id FROM sources WHERE host IN (SELECT value FROM json_each(?)))', JSON.stringify(scope.source));
  if (scope.visibility !== 'all') w.add('r.visibility = ?', scope.visibility);
  if (scope.ownership !== 'all') w.add(scope.ownership === 'mine' ? `r.tracked_by = 'owned'` : `r.tracked_by <> 'owned'`);
}

/**
 * SQL predicate that is true when the actor in `loginCol` / `emailCol` is the viewer of the source the row's repo (alias
 * `r`) is on. The login is compared with that source's account only; the emails are settings.myEmails and
 * GH_DASH_MY_EMAILS everywhere, plus each source's own in its repos. Never NULL, so `NOT` of it keeps the rows of a
 * source that has no account yet.
 */
export function meSql(ctx: QueryCtx, loginCol: string, emailCol?: string): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  if (ctx.viewers.size) {
    const whens = [...ctx.viewers].map(() => 'WHEN ? THEN ?').join(' ');
    parts.push(`ifnull(lower(ifnull(${loginCol}, '')) = CASE r.source_id ${whens} END, 0)`);
    for (const [id, login] of ctx.viewers) params.push(id, login);
  }
  if (emailCol) {
    if (ctx.myEmails.length) {
      parts.push(`lower(ifnull(${emailCol}, '')) IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ctx.myEmails));
    }
    for (const [id, emails] of ctx.viewerEmails) {
      parts.push(`(r.source_id = ? AND lower(ifnull(${emailCol}, '')) IN (SELECT value FROM json_each(?)))`);
      params.push(id, JSON.stringify(emails));
    }
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', params };
}

export function addWho(w: Where, who: Who, ctx: QueryCtx, loginCol: string, emailCol?: string): void {
  if (who === 'everyone') return;
  const me = meSql(ctx, loginCol, emailCol);
  w.add(who === 'me' ? me.sql : `NOT ${me.sql}`, ...me.params);
}

/**
 * `from` ≤ col < `to`. Timestamps compare as text, so the bounds are written as the column is: whole seconds (what code
 * hosts give), or with milliseconds (`ms`: gh-dash's own, like comment events), else an event in the bound's own second
 * would fall on the wrong side.
 */
export function addRange(w: Where, col: string, scope: Scope, ms = false): void {
  const iso = ms ? (t: number) => new Date(t).toISOString() : isoSec;
  w.add(`${col} >= ? AND ${col} < ?`, iso(scope.from), iso(scope.to));
}

/**
 * Builds a safe FTS5 MATCH expression: every term is quoted (so user input can't produce syntax
 * errors), "quoted phrases" are kept together, and the last bare term is prefix-matched.
 * Returns null when the input has no searchable characters (callers fall back to LIKE).
 */
export function ftsQuery(q: string): string | null {
  const terms: { text: string; quoted: boolean }[] = [];
  // Control characters are dropped: FTS5 reads the query as a C string, so a NUL ends it mid-quote.
  for (const m of q.replace(/[\u0000-\u001f\u007f]/g, ' ').matchAll(/"([^"]*)"?|(\S+)/g)) {
    const text = (m[1] ?? m[2] ?? '').replace(/"/g, '').trim();
    if (/[\p{L}\p{N}]/u.test(text)) terms.push({ text, quoted: m[1] !== undefined });
  }
  if (terms.length === 0) return null;
  return terms.map((t, i) => `"${t.text}"${i === terms.length - 1 && !t.quoted ? '*' : ''}`).join(' ');
}

/** A LIKE pattern for "contains `text`": `%`, `_` and the escape character in it match themselves. Use with ESCAPE '\'. */
export const likeContains = (text: string): string => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** A plain "contains" filter over `cols` (no FTS index): case-insensitive for ASCII only, as SQLite's LIKE is. */
export function addLike(w: Where, q: string | null, cols: string[]): void {
  if (!q) return;
  const like = likeContains(q);
  w.add(cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR '), ...cols.map(() => like));
}

export type FtsTable = 'pull_requests' | 'issues' | 'commits' | 'releases';

/** Full-text filter on `alias.id` via the table's FTS index; LIKE over `likeCols` when there is nothing to match. */
export function addText(w: Where, q: string | null, table: FtsTable, alias: string, likeCols: string[]): void {
  if (!q) return;
  const match = ftsQuery(q);
  if (match) w.add(`${alias}.id IN (SELECT rowid FROM ${table}_fts WHERE ${table}_fts MATCH ?)`, match);
  else addLike(w, q, likeCols);
}
