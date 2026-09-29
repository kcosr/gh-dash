import type { Actor, Bucket, StatsBucket, StatsResponse, Tile, Visibility } from '../../shared/api';
import { bucketIndex, DAY_MS, isoSec, localDateSql, makeBuckets, median, type OffsetSegment, offsetSegments } from '../lib/time';
import type { Db, Param } from './db';
import { addRepoScope, meSql, type QueryCtx, type Scope, Where } from './filters';
import { EVENT_SOURCES, type EventSource, sourceWhere } from './lists';
import { getMeta } from './meta';
import { repoKeySql } from './repo-key';

const SLICES = 12;
const TOP_CONTRIBUTORS = 20;

export function defaultBucket(from: number, to: number): Bucket {
  const days = (to - from) / DAY_MS;
  return days <= 45 ? 'day' : days <= 190 ? 'week' : 'month';
}

const src = (code: string) => EVENT_SOURCES.find((s) => s.code === code)!;
/** Stats count every default-branch commit, including ones that landed via a PR. */
const ALL_COMMITS: EventSource = { ...src('c'), extra: undefined };

/** Actor columns of the sources that feed `contributors`. */
interface PersonCols {
  login: string;
  email: string | null;
  name: string;
  avatar: string;
}
const COMMIT_PEOPLE: PersonCols = { login: 'c.author_login', email: 'c.author_email', name: 'c.author_name', avatar: 'c.author_avatar' };
const MERGE_PEOPLE: PersonCols = { login: 'p.author_login', email: null, name: 'p.author_name', avatar: 'p.author_avatar' };

/**
 * Events of one source over the current and the previous period, grouped in SQL so that large ranges
 * (tens of thousands of commits) never materialize one JS object per event. `day` and `slice` are null
 * for the previous period, which only needs counts and repos.
 */
interface Group {
  repo: string;
  visibility: Visibility;
  /** Local date in the request tz. */
  day: string | null;
  /** Spark slice 0..11. */
  slice: number | null;
  mine: number;
  n: number;
  /** `people`: identity columns, plus the latest event of the group (for display). */
  login?: string | null;
  email?: string | null;
  /** Name, only for identities with neither login nor email. */
  anon?: string | null;
  last?: string;
  eid?: number;
  /** `perEvent` (merged PRs): the event itself. */
  at?: string;
  created_at?: string;
  name?: string | null;
  avatar?: string | null;
}

interface SourceOpts {
  /** Compute the who flag (commits and merges feed commitsMine / prsMergedMine). */
  mine?: boolean;
  /** Also group by identity (commits). */
  people?: PersonCols;
  /** One row per event with created_at and actor (merged PRs: medians need each duration). */
  perEvent?: PersonCols;
}

function fetchGroups(db: Db, ctx: QueryCtx, scope: Scope, segments: OffsetSegment[], s: EventSource, opts: SourceOpts = {}): Group[] {
  const { from, to } = scope;
  const fromIso = isoSec(from);
  const wide: Scope = { ...scope, from: from - (to - from) };
  const cols: string[] = [];
  const params: Param[] = [];
  const col = (sql: string, ...p: Param[]) => {
    cols.push(sql);
    params.push(...p);
  };
  const day = localDateSql(s.at, segments);
  const me = opts.mine && s.who ? meSql(ctx, s.who.login, s.who.email) : { sql: '0', params: [] as Param[] };
  col(`${repoKeySql('r')} AS repo`);
  col('r.visibility AS visibility');
  col(`CASE WHEN ${s.at} >= ? THEN ${day.sql} END AS day`, fromIso, ...day.params);
  // Same arithmetic (IEEE doubles, then floor) as Math.floor((t - from) * SLICES / len) in JS.
  col(
    `CASE WHEN ${s.at} >= ? THEN min(${SLICES - 1}, CAST((unixepoch(${s.at}) * 1000 - ?) * ${SLICES} / ? AS INTEGER)) END AS slice`,
    fromIso,
    from,
    to - from,
  );
  col(`${me.sql} AS mine`, ...me.params);
  let group = 'r.id, day, slice, mine';
  if (opts.people) {
    const p = opts.people;
    const email = p.email ?? 'NULL';
    col(`${p.login} AS login`);
    col(`${email} AS email`);
    col(`CASE WHEN ${p.login} IS NULL AND ifnull(${email}, '') = '' THEN ${p.name} END AS anon`);
    // Bare columns next to max() come from the row holding the max: the group's latest event.
    col(`max(${s.at}) AS last`);
    col(`${s.alias}.id AS eid`);
    group += ', login, email, anon';
  }
  if (opts.perEvent) {
    const p = opts.perEvent;
    col(`${s.at} AS at`);
    col(`${s.alias}.created_at AS created_at`);
    col(`${p.login} AS login`);
    col(`${p.name} AS name`);
    col(`${p.avatar} AS avatar`);
    group = `${s.alias}.id`;
  }
  const w = sourceWhere(s, ctx, wide);
  return db.all<Group>(
    `SELECT ${cols.join(', ')}, count(*) AS n FROM ${s.table} ${s.alias} JOIN repos r ON r.id = ${s.alias}.repo_id
     WHERE ${w.toSql()} GROUP BY ${group}`,
    [...params, ...w.params],
  );
}

interface Source {
  /** Current-period groups, with the index of their day in the range. */
  cur: (Group & { d: number })[];
  /** Previous-period groups (merges: one per PR). */
  prev: Group[];
  prevCount: number;
  prevRepos: Set<string>;
}

const hoursToMerge = (g: { at?: string; created_at?: string }) => (Date.parse(g.at!) - Date.parse(g.created_at!)) / 3_600_000;
const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const sum = (groups: { n: number }[]) => groups.reduce((a, g) => a + g.n, 0);

export function computeStats(db: Db, ctx: QueryCtx, scope: Scope, bucketParam?: Bucket): StatsResponse {
  const { from, to, tz } = scope;
  const len = to - from;
  const prevFrom = from - len;
  const bucket = bucketParam ?? defaultBucket(from, to);

  const days = makeBuckets(tz, from, to, 'day');
  const buckets = makeBuckets(tz, from, to, bucket);
  const dayIndex = new Map(days.keys.map((k, i) => [k, i]));
  /** Bucket of each day (buckets are made of whole local days). */
  const dayBucket = days.starts.map((start) => Math.max(0, bucketIndex(buckets, start)));
  const segments = offsetSegments(tz, from, to);

  const fetch = (s: EventSource, opts?: SourceOpts): Source => {
    const out: Source = { cur: [], prev: [], prevCount: 0, prevRepos: new Set() };
    for (const g of fetchGroups(db, ctx, scope, segments, s, opts)) {
      if (g.day === null) {
        out.prev.push(g);
        out.prevCount += g.n;
        out.prevRepos.add(g.repo);
        continue;
      }
      const d = dayIndex.get(g.day);
      if (d !== undefined && g.slice !== null) out.cur.push({ ...g, d });
    }
    return out;
  };

  const commits = fetch(ALL_COMMITS, { mine: true, people: COMMIT_PEOPLE });
  const prsOpened = fetch(src('po'));
  const prsMerged = fetch(src('pm'), { mine: true, perEvent: MERGE_PEOPLE });
  const prsClosed = fetch(src('pc'));
  const issuesOpened = fetch(src('io'));
  const issuesClosed = fetch(src('ic'));
  const releases = fetch(src('r'));
  const stars = fetch(src('s'));

  const countSpark = (groups: { slice: number | null; n: number }[]) => {
    const out = new Array<number>(SLICES).fill(0);
    for (const g of groups) out[g.slice!]! += g.n;
    return out;
  };
  const countTile = (s: Source): Tile => ({ value: sum(s.cur), previous: s.prevCount, spark: countSpark(s.cur) });

  // Tiles
  const mergeSlices = Array.from({ length: SLICES }, () => [] as number[]);
  for (const g of prsMerged.cur) mergeSlices[g.slice!]!.push(hoursToMerge(g));
  const activity = [commits, prsOpened, prsMerged, prsClosed, issuesOpened, issuesClosed, releases];
  const repoSlices = Array.from({ length: SLICES }, () => new Set<string>());
  const activeCur = new Set<string>();
  const activePrev = new Set<string>();
  for (const s of activity) {
    for (const g of s.cur) {
      repoSlices[g.slice!]!.add(g.repo);
      activeCur.add(g.repo);
    }
    for (const repo of s.prevRepos) activePrev.add(repo);
  }

  const tiles: StatsResponse['tiles'] = {
    prsMerged: countTile(prsMerged),
    commits: countTile(commits),
    newStars: countTile(stars),
    medianHoursToMerge: {
      value: round2(median(prsMerged.cur.map(hoursToMerge))),
      previous: round2(median(prsMerged.prev.map(hoursToMerge))),
      spark: mergeSlices.map((h) => round2(median(h)) ?? 0),
    },
    issuesClosed: countTile(issuesClosed),
    activeRepos: { value: activeCur.size, previous: activePrev.size, spark: repoSlices.map((s) => s.size) },
  };

  // Series
  const series: StatsBucket[] = buckets.keys.map((start) => ({
    start,
    commits: 0,
    commitsMine: 0,
    prsOpened: 0,
    prsMerged: 0,
    prsMergedMine: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    releases: 0,
    stars: 0,
    medianHoursToMerge: null,
  }));
  type Counter = 'commits' | 'prsOpened' | 'prsMerged' | 'issuesOpened' | 'issuesClosed' | 'releases' | 'stars';
  const count = (s: Source, key: Counter, mineKey?: 'commitsMine' | 'prsMergedMine') => {
    for (const g of s.cur) {
      const b = series[dayBucket[g.d]!]!;
      b[key] += g.n;
      if (mineKey && g.mine) b[mineKey] += g.n;
    }
  };
  count(commits, 'commits', 'commitsMine');
  count(prsOpened, 'prsOpened');
  count(prsMerged, 'prsMerged', 'prsMergedMine');
  count(issuesOpened, 'issuesOpened');
  count(issuesClosed, 'issuesClosed');
  count(releases, 'releases');
  count(stars, 'stars');
  const mergeBuckets = series.map(() => [] as number[]);
  for (const g of prsMerged.cur) mergeBuckets[dayBucket[g.d]!]!.push(hoursToMerge(g));
  mergeBuckets.forEach((h, i) => (series[i]!.medianHoursToMerge = round2(median(h))));

  // Daily cumulative stars across in-scope public repos
  const starDays = days.keys.map((date) => ({ date, total: 0, added: 0 }));
  if (scope.who !== 'me' && !scope.q) {
    for (const g of stars.cur) if (g.visibility === 'public') starDays[g.d]!.added += g.n;
    const { current, after } = publicStarTotals(db, ctx, scope);
    let total = current - after;
    for (let i = starDays.length - 1; i >= 0; i--) {
      starDays[i]!.total = total;
      total -= starDays[i]!.added;
    }
  }

  const commitCalendar = days.keys.map((date) => ({ date, count: 0 }));
  for (const g of commits.cur) commitCalendar[g.d]!.count += g.n;

  // Per repo
  const byRepoMap = new Map<string, StatsResponse['byRepo'][number]>();
  const bump = (s: Source, key: 'commits' | 'prsMerged' | 'issues' | 'releases' | 'stars') => {
    for (const g of s.cur) {
      let e = byRepoMap.get(g.repo);
      if (!e) byRepoMap.set(g.repo, (e = { repo: g.repo, commits: 0, prsMerged: 0, issues: 0, releases: 0, stars: 0, total: 0 }));
      e[key] += g.n;
      e.total += g.n;
    }
  };
  bump(commits, 'commits');
  bump(prsMerged, 'prsMerged');
  bump(issuesOpened, 'issues');
  bump(issuesClosed, 'issues');
  bump(releases, 'releases');
  bump(stars, 'stars');
  const byRepo = [...byRepoMap.values()].sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));

  return {
    range: { from: isoSec(from), to: isoSec(to), prevFrom: isoSec(prevFrom), prevTo: isoSec(from), bucket, tz },
    tiles,
    series,
    stars: starDays,
    commitCalendar,
    byRepo,
    contributors: contributors(db, commits.cur, prsMerged.cur),
  };
}

/** Current stargazer total of in-scope public repos, and how many of their stars came after the range. */
function publicStarTotals(db: Db, ctx: QueryCtx, scope: Scope): { current: number; after: number } {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  w.add(`r.visibility = 'public'`);
  const current = db.get<{ n: number | null }>(`SELECT sum(r.stars) AS n FROM repos r WHERE ${w.toSql()}`, w.params)!.n ?? 0;
  const after = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM stars s JOIN repos r ON r.id = s.repo_id WHERE ${w.toSql()} AND s.starred_at >= ?`,
    [...w.params, isoSec(scope.to)],
  )!.n;
  return { current, after };
}

/** Identity of a person: all "me" identities are one person; others by login, else commit email, else name. */
function personKey(g: Group): string {
  if (g.mine) return 'me';
  if (g.login) return `l:${g.login.toLowerCase()}`;
  if (g.email) return `e:${g.email.toLowerCase()}`;
  return `n:${g.anon ?? g.name ?? ''}`;
}

interface Person {
  commits: number;
  prsMerged: number;
  total: number;
  /** Latest event; its actor is the one displayed. */
  last: string;
  display: { commitId: number } | { actor: Actor };
}

/**
 * People by commits + merged PRs (who filter applies). Every identity that is "me" (the viewer's login, or
 * a commit email in settings.myEmails / GH_DASH_MY_EMAILS) merges into one entry shown as the viewer.
 * Others merge by login, else (commits without a linked account) by email, and show the actor (name,
 * avatar) of their latest event.
 */
function contributors(db: Db, commits: Group[], merges: Group[]): StatsResponse['contributors'] {
  const people = new Map<string, Person>();
  const add = (g: Group, key: 'commits' | 'prsMerged', last: string, display: Person['display']) => {
    const id = personKey(g);
    let p = people.get(id);
    if (!p) people.set(id, (p = { commits: 0, prsMerged: 0, total: 0, last, display }));
    else if (last > p.last) Object.assign(p, { last, display });
    p[key] += g.n;
    p.total += g.n;
  };
  for (const g of commits) add(g, 'commits', g.last!, { commitId: g.eid! });
  for (const g of merges) {
    add(g, 'prsMerged', g.at!, { actor: { login: g.login ?? null, name: g.name ?? null, avatarUrl: g.avatar ?? null, isMe: false } });
  }

  // Everyone who can make the top N (ties included), then their display actors in one lookup.
  const ranked = [...people.entries()].sort(([, a], [, b]) => b.total - a.total);
  const cutoff = ranked[TOP_CONTRIBUTORS - 1]?.[1].total ?? 0;
  const top = ranked.filter(([, p]) => p.total >= cutoff);
  const ids = top.flatMap(([, p]) => ('commitId' in p.display ? [p.display.commitId] : []));
  const commitActors = new Map(
    db
      .all<{ id: number; login: string | null; name: string | null; avatar: string | null }>(
        'SELECT id, author_login AS login, author_name AS name, author_avatar AS avatar FROM commits WHERE id IN (SELECT value FROM json_each(?))',
        [JSON.stringify(ids)],
      )
      .map((r): [number, Actor] => [r.id, { login: r.login, name: r.name, avatarUrl: r.avatar, isMe: false }]),
  );
  const viewer = getMeta(db, 'viewer');
  const label = (a: Actor) => a.login ?? a.name ?? '';
  return top
    .map(([id, p]) => {
      let actor = 'commitId' in p.display ? commitActors.get(p.display.commitId)! : p.display.actor;
      if (id === 'me') {
        actor = viewer ? { login: viewer.login, name: viewer.name, avatarUrl: viewer.avatarUrl, isMe: true } : { ...actor, isMe: true };
      }
      return { actor, commits: p.commits, prsMerged: p.prsMerged, total: p.total };
    })
    .sort((a, b) => b.total - a.total || label(a.actor).localeCompare(label(b.actor)))
    .slice(0, TOP_CONTRIBUTORS);
}
