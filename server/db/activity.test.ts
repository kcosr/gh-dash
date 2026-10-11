import { describe, expect, it } from 'vitest';
import { ACTIVE_DAYS } from '../../shared/repos';
import { DAY_MS } from '../lib/time';
import { addManualRepo, prRecord, SEED_NOW, seedDb } from '../test/seed';
import { type ActivityRow, repoActivity } from './activity';
import { createThread, getPrincipal, SELF_PRINCIPAL_ID, setThreadStatus } from './comments';
import type { Db } from './db';
import { loadQueryCtx, type Scope } from './filters';
import { listPrs } from './lists';
import { listRepos, setRepoPrefs } from './repos';
import { patchSettings } from './settings';
import { upsertPr } from './write';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

/** An automatic, quiet repo: nothing open, last active a year ago. */
const QUIET: ActivityRow = {
  status: 'auto', is_archived: 0, is_fork: 0, pinned: 0, open_prs: 0, open_issues: 0, open_threads: 0, last_activity_at: ago(365),
};
const rule = (over: Partial<ActivityRow>, includeForks = false) => repoActivity({ ...QUIET, ...over }, NOW, includeForks);

describe('the activity rule', () => {
  it('gives every reason', () => {
    expect(rule({ status: 'active' })).toEqual({ active: true, reason: 'set' });
    expect(rule({ status: 'inactive', open_prs: 3, last_activity_at: ago(1) })).toEqual({ active: false, reason: 'set' });
    expect(rule({ is_archived: 1, last_activity_at: ago(1) })).toEqual({ active: false, reason: 'archived' });
    expect(rule({ is_fork: 1, last_activity_at: ago(1) })).toEqual({ active: false, reason: 'fork' });
    expect(rule({ pinned: 1 })).toEqual({ active: true, reason: 'pinned' });
    expect(rule({ open_prs: 1 })).toEqual({ active: true, reason: 'open' });
    expect(rule({ open_issues: 1 })).toEqual({ active: true, reason: 'open' });
    expect(rule({ open_threads: 1 })).toEqual({ active: true, reason: 'open' });
    expect(rule({ last_activity_at: ago(30) })).toEqual({ active: true, reason: 'recent' });
    expect(rule({})).toEqual({ active: false, reason: 'quiet' });
    expect(rule({ last_activity_at: null })).toEqual({ active: false, reason: 'quiet' });
  });

  it('lets the status beat archived and fork, which beat pinned, which beats quiet', () => {
    expect(rule({ status: 'active', is_archived: 1 })).toEqual({ active: true, reason: 'set' });
    expect(rule({ status: 'active', is_fork: 1 })).toEqual({ active: true, reason: 'set' });
    expect(rule({ is_archived: 1, pinned: 1, open_prs: 1 })).toEqual({ active: false, reason: 'archived' });
    expect(rule({ is_fork: 1, pinned: 1, open_prs: 1 })).toEqual({ active: false, reason: 'fork' });
    expect(rule({ pinned: 1, open_prs: 1, last_activity_at: ago(1) })).toEqual({ active: true, reason: 'pinned' });
    expect(rule({ open_threads: 1, last_activity_at: ago(1) })).toEqual({ active: true, reason: 'open' });
  });

  it('takes a fork as any other repo while forks are on', () => {
    expect(rule({ is_fork: 1, last_activity_at: ago(1) }, true)).toEqual({ active: true, reason: 'recent' });
    expect(rule({ is_fork: 1 }, true)).toEqual({ active: false, reason: 'quiet' });
  });

  it(`counts activity within ${ACTIVE_DAYS} days, to the millisecond`, () => {
    expect(rule({ last_activity_at: ago(ACTIVE_DAYS) })).toEqual({ active: true, reason: 'recent' });
    expect(rule({ last_activity_at: new Date(NOW - ACTIVE_DAYS * DAY_MS - 1).toISOString() })).toEqual({ active: false, reason: 'quiet' });
  });

  it('reads an unknown status as automatic', () => {
    expect(rule({ status: 'hidden', last_activity_at: ago(1) })).toEqual({ active: true, reason: 'recent' });
  });
});

describe('the default selection', () => {
  const OLD = '2025-01-02T00:00:00Z';
  const you = (db: Db) => getPrincipal(db, SELF_PRINCIPAL_ID)!;
  const general = { path: null, side: null, startLine: null, endLine: null, snippet: null };

  /** The seed plus repos added by hand, each pushed long ago with one old merged PR, so the PR list shows it if selected. */
  function setup() {
    const db = seedDb();
    const add = (key: string, over: Parameters<typeof addManualRepo>[2] = {}) => {
      const id = addManualRepo(db, key, { pushedAt: OLD, ...over });
      upsertPr(db, id, prRecord(1, { state: 'merged', createdAt: '2025-01-01T00:00:00Z', mergedAt: OLD }));
      return id;
    };
    return { db, add };
  }
  const scope: Scope = {
    repos: null, visibility: 'all', ownership: 'all', who: 'everyone', from: Date.parse('2024-01-01T00:00:00Z'), to: SEED_NOW, tz: 'UTC', q: null,
  };
  /** The repos the default selection's PR list covers, as of SEED_NOW. */
  const selected = (db: Db) => [...new Set(listPrs(db, loadQueryCtx(db, [], SEED_NOW), scope, { state: 'all', labels: null }, null).items.map((p) => p.repo))].sort();
  const why = (db: Db, key: string) => {
    const r = listRepos(db, 'UTC', SEED_NOW).find((x) => x.key === key)!;
    return { status: r.status, active: r.active, reason: r.activeReason };
  };

  it("is the seed's recent repos: not archived, forked or marked inactive", () => {
    const { db } = setup();
    expect(selected(db)).toEqual(['alice/app', 'alice/secret']);
    expect(why(db, 'alice/hidden')).toEqual({ status: 'inactive', active: false, reason: 'set' });
    expect(why(db, 'alice/old')).toEqual({ status: 'auto', active: false, reason: 'archived' });
    expect(why(db, 'alice/fork')).toEqual({ status: 'auto', active: false, reason: 'fork' });
  });

  it('leaves a quiet repo out, unless it is pinned or marked active', () => {
    const { db, add } = setup();
    add('bob/quiet');
    expect(why(db, 'bob/quiet')).toEqual({ status: 'auto', active: false, reason: 'quiet' });
    expect(selected(db)).not.toContain('bob/quiet');
    setRepoPrefs(db, 'bob/quiet', { pinned: true });
    expect(why(db, 'bob/quiet')).toEqual({ status: 'auto', active: true, reason: 'pinned' });
    expect(selected(db)).toContain('bob/quiet');
    // Unpinning returns it to the rule: pinning never wrote a status.
    setRepoPrefs(db, 'bob/quiet', { pinned: false });
    expect(selected(db)).not.toContain('bob/quiet');
    setRepoPrefs(db, 'bob/quiet', { status: 'active' });
    expect(why(db, 'bob/quiet')).toEqual({ status: 'active', active: true, reason: 'set' });
    expect(selected(db)).toContain('bob/quiet');
  });

  it('includes an archived repo marked active, and leaves out one marked inactive however busy', () => {
    const { db, add } = setup();
    add('bob/archived', { isArchived: true });
    const busy = add('bob/busy', { pushedAt: '2026-09-29T00:00:00Z' });
    db.run('UPDATE repos SET open_prs = 2, open_issues = 1 WHERE id = ?', [busy]);
    expect(selected(db)).toEqual(['alice/app', 'alice/secret', 'bob/busy']);
    setRepoPrefs(db, 'bob/archived', { status: 'active' });
    setRepoPrefs(db, 'bob/busy', { status: 'inactive' });
    expect(selected(db)).toEqual(['alice/app', 'alice/secret', 'bob/archived']);
    expect(why(db, 'bob/busy')).toEqual({ status: 'inactive', active: false, reason: 'set' });
  });

  it('keeps a quiet repo with an unresolved gh-dash thread active, until it is resolved', () => {
    const { db, add } = setup();
    const id = add('bob/reviewed');
    const t = createThread(db, { repoId: id, kind: 'pr', number: 1 }, { commitOid: 'a'.repeat(40), baseOid: null, anchor: general, body: 'Why?' }, you(db), '2025-02-01T00:00:00.000Z');
    expect(why(db, 'bob/reviewed')).toEqual({ status: 'auto', active: true, reason: 'open' });
    expect(selected(db)).toContain('bob/reviewed');
    setThreadStatus(db, t.id, 'resolved', you(db), '2025-02-02T00:00:00.000Z');
    expect(why(db, 'bob/reviewed')).toEqual({ status: 'auto', active: false, reason: 'quiet' });
    expect(selected(db)).not.toContain('bob/reviewed');
  });

  it('counts recent gh-dash comment activity as activity', () => {
    const { db, add } = setup();
    const id = add('bob/discussed');
    const t = createThread(db, { repoId: id, kind: 'pr', number: 1 }, { commitOid: 'a'.repeat(40), baseOid: null, anchor: general, body: 'Why?' }, you(db), '2026-09-28T09:00:00.000Z');
    setThreadStatus(db, t.id, 'resolved', you(db), '2026-09-28T10:00:00.000Z');
    const repo = listRepos(db, 'UTC', SEED_NOW).find((r) => r.key === 'bob/discussed')!;
    expect(repo).toMatchObject({ lastActivityAt: '2026-09-28T10:00:00.000Z', active: true, activeReason: 'recent' });
    expect(selected(db)).toContain('bob/discussed');
  });

  it('includes recent forks while settings.includeForks is on', () => {
    const { db } = setup();
    expect(selected(db)).not.toContain('alice/fork');
    patchSettings(db, { includeForks: true });
    expect(selected(db)).toContain('alice/fork');
    expect(why(db, 'alice/fork')).toEqual({ status: 'auto', active: true, reason: 'recent' });
  });

  it('is decided as of the request: the same repos age out', () => {
    const { db } = setup();
    const later = Date.parse('2027-06-01T00:00:00Z');
    expect(loadQueryCtx(db, [], later).activeRepoIds).toEqual([]);
    expect(listRepos(db, 'UTC', later).filter((r) => r.active)).toEqual([]);
  });
});
