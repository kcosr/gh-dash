import type { VisibilityFilter, Who } from '../../shared/api';
import { isoSec } from '../lib/time';
import type { Db, Param } from './db';
import { getMeta } from './meta';
import { getSettings } from './settings';

/** Parsed, validated scope shared by every list/stats query. Times are UTC ms; `to` is exclusive. */
export interface Scope {
  /** null = default scope (non-archived, non-hidden, non-fork unless includeForks). */
  repos: string[] | null;
  visibility: VisibilityFilter;
  who: Who;
  from: number;
  to: number;
  tz: string;
  q: string | null;
}

/** Per-request facts needed to evaluate "me" and the default scope. */
export interface QueryCtx {
  /** Lower-cased viewer login, or null before the first sync. */
  viewer: string | null;
  /** Lower-cased commit emails that count as me. */
  myEmails: string[];
  includeForks: boolean;
}

/** `envEmails`: GH_DASH_MY_EMAILS, which always count as "me" in addition to settings.myEmails. */
export function loadQueryCtx(db: Db, envEmails: readonly string[] = []): QueryCtx {
  const settings = getSettings(db);
  return {
    viewer: getMeta(db, 'viewer')?.login.toLowerCase() ?? null,
    myEmails: [...new Set([...settings.myEmails, ...envEmails].map((e) => e.toLowerCase()))],
    includeForks: settings.includeForks,
  };
}

export type IsMe = (login: string | null, email?: string | null) => boolean;

export function isMeFn(ctx: QueryCtx): IsMe {
  return (login, email) =>
    (!!ctx.viewer && !!login && login.toLowerCase() === ctx.viewer) ||
    (!!email && ctx.myEmails.includes(email.toLowerCase()));
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
    else w.add('r.name IN (SELECT value FROM json_each(?))', JSON.stringify(scope.repos));
  }
  if (scope.visibility !== 'all') w.add('r.visibility = ?', scope.visibility);
}

/** SQL predicate that is true when the actor in `loginCol` / `emailCol` is the viewer. */
export function meSql(ctx: QueryCtx, loginCol: string, emailCol?: string): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  if (ctx.viewer) {
    parts.push(`lower(ifnull(${loginCol}, '')) = ?`);
    params.push(ctx.viewer);
  }
  if (emailCol && ctx.myEmails.length) {
    parts.push(`lower(ifnull(${emailCol}, '')) IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(ctx.myEmails));
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', params };
}

export function addWho(w: Where, who: Who, ctx: QueryCtx, loginCol: string, emailCol?: string): void {
  if (who === 'everyone') return;
  const me = meSql(ctx, loginCol, emailCol);
  w.add(who === 'me' ? me.sql : `NOT ${me.sql}`, ...me.params);
}

export function addRange(w: Where, col: string, scope: Scope): void {
  w.add(`${col} >= ? AND ${col} < ?`, isoSec(scope.from), isoSec(scope.to));
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

export type FtsTable = 'pull_requests' | 'issues' | 'commits' | 'releases';

/** Full-text filter on `alias.id` via the table's FTS index; LIKE over `likeCols` when there is nothing to match. */
export function addText(w: Where, q: string | null, table: FtsTable, alias: string, likeCols: string[]): void {
  if (!q) return;
  const match = ftsQuery(q);
  if (match) {
    w.add(`${alias}.id IN (SELECT rowid FROM ${table}_fts WHERE ${table}_fts MATCH ?)`, match);
  } else {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    w.add(likeCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR '), ...likeCols.map(() => like));
  }
}
