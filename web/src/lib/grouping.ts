/** Grouping for the PR list (day/week/month/repo) and the Activity feed (per day). */
import type { ActivityEvent, Actor, CommentActivity, CommentEventKind, Commit, GroupBy, PullRequest, Release } from '../../../shared/api';
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

/** A comment event (Activity's type `comment`). */
export type CommentEvent = Extract<ActivityEvent, { type: 'comment' }>;

export type FeedRow =
  | { kind: 'event'; key: string; at: Date; event: ActivityEvent }
  | { kind: 'commits'; key: string; at: Date; repo: string; actor: Actor; commits: Commit[] }
  | { kind: 'stars'; key: string; at: Date; repo: string; actors: Actor[] }
  /** One person's (or agent's) comment events on one PR, branch or commit that day, newest first. */
  | { kind: 'comments'; key: string; at: Date; repo: string; actor: Actor; target: CommentActivity['target']; events: CommentEvent[] };

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
    case 'comment': return `m:${e.comment.eventId}`;
  }
}

/** A comment event's PR, branch or commit, within its repo: "#17", "~<branch>" or "@<oid>". */
const targetKey = (t: CommentActivity['target']) => (t.kind === 'pr' ? `#${t.number}` : t.kind === 'branch' ? `~${t.branch}` : `@${t.oid}`);

/**
 * Group raw events per local day, applying the mock's rules:
 *  - commits by the same person to the same repo on the same day collapse;
 *  - stars on the same repo on the same day collapse;
 *  - comment events by the same person or agent on the same PR, branch or commit on the same day collapse;
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
      } else if (e.type === 'comment') {
        const by = e.comment.by;
        const k = `m|${e.repo}|${targetKey(e.comment.target)}|${by.kind}:${by.id}`;
        const g = agg.get(k);
        if (g && g.kind === 'comments') {
          g.events.push(e);
          continue;
        }
        const row: FeedRow = { kind: 'comments', key: `${dk}|${k}`, at, repo: e.repo, actor: e.actor, target: e.comment.target, events: [e] };
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

// ------------------------------------------------------------------ comment events

/** Kinds in a thread's life order: how a row lists what someone did. */
const KIND_ORDER: readonly CommentEventKind[] = ['thread_opened', 'replied', 'edited', 'comment_deleted', 'resolved', 'reopened', 'thread_deleted'];

/** "a thread", "one" (the noun said already), "3 threads", "3". */
const count = (n: number, noun: boolean, one: string) => (n === 1 ? (noun ? `a ${one}` : 'one') : `${n}${noun ? ` ${one}s` : ''}`);

/** Per kind: the words for one event at a place, one without one, and a count (of threads, or of comments). */
const KIND_WORDS: Record<CommentEventKind, { at: (place: string) => string; one: string; verb: string; noun: 'thread' | 'comment' }> = {
  thread_opened: { at: (p) => `commented on ${p}`, one: 'commented', verb: 'opened', noun: 'thread' },
  replied: { at: (p) => `replied on ${p}`, one: 'replied', verb: 'replied to', noun: 'thread' },
  edited: { at: (p) => `edited a comment on ${p}`, one: 'edited a comment', verb: 'edited', noun: 'comment' },
  comment_deleted: { at: (p) => `deleted a comment on ${p}`, one: 'deleted a comment', verb: 'deleted', noun: 'comment' },
  resolved: { at: (p) => `resolved ${p}`, one: 'resolved a thread', verb: 'resolved', noun: 'thread' },
  reopened: { at: (p) => `reopened ${p}`, one: 'reopened a thread', verb: 'reopened', noun: 'thread' },
  thread_deleted: { at: (p) => `deleted a thread on ${p}`, one: 'deleted a thread', verb: 'deleted', noun: 'thread' },
};

/**
 * "host.ts:42–44", "host.ts" (a file), or null for a thread on the whole PR, branch or commit: short, the path's last
 * part.
 */
export function commentPlace(c: Pick<CommentActivity, 'path' | 'startLine' | 'endLine'>): string | null {
  if (c.path === null) return null;
  const name = c.path.slice(c.path.lastIndexOf('/') + 1);
  if (c.startLine === null) return name;
  return `${name}:${c.startLine === c.endLine || c.endLine === null ? c.startLine : `${c.startLine}–${c.endLine}`}`;
}

/** A single event's words: "replied on host.ts:42–44", "resolved a thread". */
export function commentEventWords(e: Pick<CommentEvent, 'kind' | 'comment'>): string {
  const w = KIND_WORDS[e.kind];
  const place = commentPlace(e.comment);
  return place ? w.at(place) : w.one;
}

/** An event's verb alone, for a line in a row of several kinds: "opened", "replied", "resolved". */
export function commentVerb(kind: CommentEventKind): string {
  return { thread_opened: 'opened', replied: 'replied', edited: 'edited', comment_deleted: 'deleted a comment', resolved: 'resolved', reopened: 'reopened', thread_deleted: 'deleted' }[kind];
}

/**
 * What a comments row says someone did (after their name, before the PR, branch or commit): one event names its place
 * ("resolved host.ts:42–44"); several count threads (comments, for edits and deletions) per kind, in a thread's life
 * order ("opened 2 threads and replied to 3"; the noun once while it's the same).
 */
export function commentSummary(events: readonly Pick<CommentEvent, 'kind' | 'comment'>[]): string {
  if (events.length === 1) return commentEventWords(events[0]!);
  const per = new Map<CommentEventKind, Set<number>>();
  for (const e of events) {
    const set = per.get(e.kind) ?? new Set<number>();
    // Edits and deletions count comments (one edited twice is one), the rest threads (one replied to twice is one).
    set.add(KIND_WORDS[e.kind].noun === 'comment' ? e.comment.commentId ?? -e.comment.eventId : e.comment.threadId);
    per.set(e.kind, set);
  }
  const kinds = KIND_ORDER.filter((k) => per.has(k));
  // Several events on one thread, all of one kind (two replies): its place, once.
  if (kinds.length === 1 && per.get(kinds[0]!)!.size === 1) return commentEventWords(events[0]!);
  let prev: string | null = null;
  const parts = kinds.map((k) => {
    const w = KIND_WORDS[k];
    const text = `${w.verb} ${count(per.get(k)!.size, w.noun !== prev, w.noun)}`;
    prev = w.noun;
    return text;
  });
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
