/** Grouping for the PR list (day/week/month/repo) and the Activity feed (per day). */
import type { ActivityEvent, Actor, Commit, GroupBy, PullRequest, Release } from '../../../shared/api';
import { addDays, dayDiff, dayName, fmtDate, fmtDateSmart, fmtMonthYear, fmtWeekday, startOfDay, startOfMonth, startOfWeek } from './time';
import { actorKey } from './util';

// ------------------------------------------------------------------ PR list

export type ListItem =
  | { kind: 'pr'; at: Date; pr: PullRequest }
  | { kind: 'release'; at: Date; release: Release };

export interface ListGroup {
  key: string;
  title: string;
  sub: string;
  items: ListItem[];
  prs: number;
  releases: number;
}

function groupStart(d: Date, by: Exclude<GroupBy, 'repo'>): Date {
  if (by === 'day') return startOfDay(d);
  if (by === 'week') return startOfWeek(d);
  return startOfMonth(d);
}

export function periodLabel(start: Date, by: Exclude<GroupBy, 'repo'>, now = new Date()): [string, string] {
  if (by === 'day') return [dayName(start, now), fmtDateSmart(start, now)];
  if (by === 'week') {
    const end = addDays(start, 6);
    const endTxt = start.getMonth() === end.getMonth() ? String(end.getDate()) : fmtDate(end);
    const yr = start.getFullYear() !== now.getFullYear() ? `, ${start.getFullYear()}` : '';
    const span = `${fmtDate(start)} – ${endTxt}${yr}`;
    const thisWeek = startOfWeek(now);
    const diff = dayDiff(start, thisWeek);
    if (diff === 0) return ['This week', span];
    if (diff === 7) return ['Last week', span];
    return [span, ''];
  }
  return [fmtMonthYear(start), ''];
}

export function groupListItems(items: ListItem[], by: GroupBy, isPrivate: (repo: string) => boolean, now = new Date()): ListGroup[] {
  const sorted = [...items].sort((a, b) => b.at.getTime() - a.at.getTime());
  const map = new Map<string, ListGroup>();
  for (const it of sorted) {
    const repo = it.kind === 'pr' ? it.pr.repo : it.release.repo;
    let key: string, title: string, sub: string;
    if (by === 'repo') {
      key = repo; title = repo; sub = isPrivate(repo) ? 'private' : '';
    } else {
      const start = groupStart(it.at, by);
      key = String(start.getTime());
      [title, sub] = periodLabel(start, by, now);
    }
    let g = map.get(key);
    if (!g) { g = { key, title, sub, items: [], prs: 0, releases: 0 }; map.set(key, g); }
    g.items.push(it);
    if (it.kind === 'pr') g.prs++; else g.releases++;
  }
  const groups = [...map.values()];
  if (by === 'repo') groups.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
  return groups;
}

/** Date a PR sorts/filters on. */
export const prDate = (p: PullRequest) => new Date(p.activityAt);

// ------------------------------------------------------------------ Activity feed

export type FeedRow =
  | { kind: 'event'; key: string; at: Date; event: ActivityEvent }
  | { kind: 'commits'; key: string; at: Date; repo: string; actor: Actor; commits: Commit[] }
  | { kind: 'stars'; key: string; at: Date; repo: string; actors: Actor[] };

export interface FeedDay {
  key: string; // YYYY-MM-DD local
  date: Date;
  title: string;
  sub: string;
  rows: FeedRow[];
  count: number;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function eventKey(e: ActivityEvent): string {
  switch (e.type) {
    case 'commit': return `c:${e.repo}:${e.commit.oid}`;
    case 'pr': return `p:${e.pr.id}:${e.kind}`;
    case 'issue': return `i:${e.issue.id}:${e.kind}`;
    case 'release': return `r:${e.release.id}`;
    case 'star': return `s:${e.repo}:${actorKey(e.actor)}:${e.at}`;
  }
}

/**
 * Group raw events per local day, applying the mock's rules:
 *  - commits by the same person to the same repo on the same day collapse;
 *  - stars on the same repo on the same day collapse;
 *  - a PR "opened" event is hidden when the same PR also merged/closed that day.
 */
export function groupFeed(events: ActivityEvent[], now = new Date()): FeedDay[] {
  const days = new Map<string, { date: Date; events: ActivityEvent[] }>();
  const seen = new Set<string>();
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) continue; // pages can overlap if data changed between fetches
    seen.add(k);
    const d = new Date(e.at);
    const dk = dayKey(d);
    let day = days.get(dk);
    if (!day) { day = { date: startOfDay(d), events: [] }; days.set(dk, day); }
    day.events.push(e);
  }

  const out: FeedDay[] = [];
  for (const [dk, day] of days) {
    const finished = new Set(day.events.filter((e) => e.type === 'pr' && e.kind !== 'opened').map((e) => (e.type === 'pr' ? e.pr.id : '')));
    const rows: FeedRow[] = [];
    const agg = new Map<string, FeedRow>();
    let count = 0;
    for (const e of day.events) {
      if (e.type === 'pr' && e.kind === 'opened' && finished.has(e.pr.id)) continue;
      count++;
      const at = new Date(e.at);
      if (e.type === 'commit') {
        const k = `c|${e.repo}|${actorKey(e.actor)}`;
        const g = agg.get(k);
        if (g && g.kind === 'commits') {
          g.commits.push(e.commit);
          // A "me" group shows the viewer: prefer the identity with a GitHub login.
          if (e.actor.isMe && !g.actor.login && e.actor.login) g.actor = e.actor;
          continue;
        }
        const row: FeedRow = { kind: 'commits', key: `${dk}|${k}`, at, repo: e.repo, actor: e.actor, commits: [e.commit] };
        agg.set(k, row); rows.push(row);
      } else if (e.type === 'star') {
        const k = `s|${e.repo}`;
        const g = agg.get(k);
        if (g && g.kind === 'stars') {
          if (!g.actors.some((a) => actorKey(a) === actorKey(e.actor))) g.actors.push(e.actor);
          continue;
        }
        const row: FeedRow = { kind: 'stars', key: `${dk}|${k}`, at, repo: e.repo, actors: [e.actor] };
        agg.set(k, row); rows.push(row);
      } else {
        rows.push({ kind: 'event', key: `${dk}|${eventKey(e)}`, at, event: e });
      }
    }
    if (!rows.length) continue;
    const diff = dayDiff(day.date, now);
    const title = dayName(day.date, now);
    const sub = diff <= 1
      ? `${fmtWeekday(day.date)}, ${fmtDateSmart(day.date, now)}`
      : fmtDateSmart(day.date, now);
    out.push({ key: dk, date: day.date, title, sub, rows, count });
  }
  return out;
}

export { dayKey };
