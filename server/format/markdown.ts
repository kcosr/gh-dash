import type { ActivityEvent, Actor, GroupBy, PrStateFilter, ProviderKind, PullRequest, ThreadListItem, ThreadStatusFilter, Who } from '../../shared/api';
import { threadsMarkdown } from '../../shared/comment-markdown';
import { PROVIDERS, mixedPrWords, refText } from '../../shared/provider';
import { DAY_MS, localDayNum, weekdayMon0 } from '../lib/time';

const utcFmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
const SHORT = utcFmt({ month: 'short', day: 'numeric' });
const SHORT_Y = utcFmt({ month: 'short', day: 'numeric', year: 'numeric' });
const MONTH = utcFmt({ month: 'long', year: 'numeric' });
const WEEKDAY = utcFmt({ weekday: 'long' });
const DAY_OF_MONTH = utcFmt({ day: 'numeric' });

const dayDate = (dayNum: number) => new Date(dayNum * DAY_MS);
const yearOf = (dayNum: number) => dayDate(dayNum).getUTCFullYear();
const monthOf = (dayNum: number) => dayDate(dayNum).getUTCMonth();

/** A repo's code host, by repo key: the exports' `#`/`!` and PR/MR words follow it. */
export type KindOf = (repo: string) => ProviderKind;
/** Every repo on github.com (the default, and all there is until repos carry a source). */
export const GITHUB_ONLY: KindOf = () => 'github';

export interface MdContext {
  tz: string;
  now: number;
  from: number;
  /** Exclusive. */
  to: number;
  /** The host of each repo in the export; GitHub when absent. */
  kindOf?: KindOf;
}

/** "Aug 29 – Sep 27, 2026" for the inclusive local days of [from, to). */
export function rangeLabel(ctx: MdContext): string {
  const a = localDayNum(ctx.tz, ctx.from);
  const b = localDayNum(ctx.tz, ctx.to - 1);
  if (a === b) return SHORT_Y.format(dayDate(a));
  if (yearOf(a) === yearOf(b)) return `${SHORT.format(dayDate(a))} – ${SHORT_Y.format(dayDate(b))}`;
  return `${SHORT_Y.format(dayDate(a))} – ${SHORT_Y.format(dayDate(b))}`;
}

function shortDate(dayNum: number, thisYear: number): string {
  return (yearOf(dayNum) === thisYear ? SHORT : SHORT_Y).format(dayDate(dayNum));
}

function dayHeading(dayNum: number, ctx: MdContext): string {
  const today = localDayNum(ctx.tz, ctx.now);
  const thisYear = yearOf(today);
  const name = dayNum === today ? 'Today' : dayNum === today - 1 ? 'Yesterday' : WEEKDAY.format(dayDate(dayNum));
  return `${name} · ${shortDate(dayNum, thisYear)}`;
}

function weekHeading(weekStart: number, ctx: MdContext): string {
  const today = localDayNum(ctx.tz, ctx.now);
  const thisWeek = today - weekdayMon0(today);
  const end = weekStart + 6;
  const endText = monthOf(end) === monthOf(weekStart) ? DAY_OF_MONTH.format(dayDate(end)) : SHORT.format(dayDate(end));
  const span = `${SHORT.format(dayDate(weekStart))} – ${endText}${yearOf(end) === yearOf(today) ? '' : `, ${yearOf(end)}`}`;
  if (weekStart === thisWeek) return `This week · ${span}`;
  if (weekStart === thisWeek - 7) return `Last week · ${span}`;
  return span;
}

function groupHeading(pr: PullRequest, group: GroupBy, ctx: MdContext): string {
  if (group === 'repo') return pr.repo;
  const day = localDayNum(ctx.tz, Date.parse(pr.activityAt));
  if (group === 'day') return dayHeading(day, ctx);
  if (group === 'week') return weekHeading(day - weekdayMon0(day), ctx);
  return MONTH.format(dayDate(day));
}

/** Escapes characters that would break `**bold**` or link syntax; backticks stay so `code` renders. */
const escapeInline = (s: string) => s.replace(/([\\*[\]])/g, '\\$1');

/** Markdown/HTML → a single line of plain text. */
function toPlain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First meaningful paragraph of a markdown body as plain text: skips HTML comments, headings, rules
 * and code fences; list items become sentences. Capped at `max` characters.
 */
export function firstParagraph(body: string, max = 600): string {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  for (const para of cleaned.split(/\n[ \t]*\n/)) {
    if (/^\s*(```|~~~)/.test(para)) continue;
    const sentences = para
      .split('\n')
      .filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
      .map((l) => toPlain(l.replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')))
      .filter(Boolean)
      .map((l) => (/[.!?:;]$/.test(l) ? l : `${l}.`));
    if (sentences.length === 0) continue;
    const text = sentences.join(' ');
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return '';
}

const STATE_WORD: Record<PrStateFilter, string> = { open: 'Open', merged: 'Merged', closed: 'Closed', all: 'All' };
const WHO_WORD: Record<Who, string> = { me: ' by me', others: ' by others', everyone: '' };

export function prsMarkdown(prs: PullRequest[], opts: { state: PrStateFilter; who: Who; group: GroupBy }, ctx: MdContext): string {
  const kindOf = ctx.kindOf ?? GITHUB_ONLY;
  const w = mixedPrWords(prs.map((pr) => kindOf(pr.repo)));
  const lines = [`## ${STATE_WORD[opts.state]} ${w.shortMany}${WHO_WORD[opts.who]} · ${rangeLabel(ctx)}`];
  if (prs.length === 0) return `${lines[0]}\n\n_No ${w.many}._\n`;

  const groups = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const key = groupHeading(pr, opts.group, ctx);
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(pr);
  }
  for (const [heading, items] of groups) {
    lines.push('', `### ${heading}`, '');
    for (const pr of items) {
      const summary = firstParagraph(pr.body);
      lines.push(`- **${escapeInline(pr.title)}** ([${refText(kindOf(pr.repo), pr.repo, pr.number, 'pr')}](${pr.url}))${summary ? ` — ${summary}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const TIME = new Map<string, Intl.DateTimeFormat>();
function timeOf(iso: string, tz: string): string {
  let f = TIME.get(tz);
  if (!f) TIME.set(tz, (f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
  return f.format(Date.parse(iso));
}

const who = (a: Actor | null) => `**${escapeInline(a?.login ?? a?.name ?? 'someone')}**`;

function eventLine(e: ActivityEvent, kindOf: KindOf): string {
  switch (e.type) {
    case 'commit':
      return `${who(e.actor)} pushed [\`${e.commit.shortOid}\`](${e.commit.url}) to ${e.repo}: ${escapeInline(e.commit.headline)}`;
    case 'pr':
      return `${who(e.actor)} ${e.kind} ${PROVIDERS[kindOf(e.repo)].pr.short} [${refText(kindOf(e.repo), e.repo, e.pr.number, 'pr')}](${e.pr.url}): ${escapeInline(e.pr.title)}`;
    case 'issue':
      return `${who(e.actor)} ${e.kind} issue [${refText(kindOf(e.repo), e.repo, e.issue.number, 'issue')}](${e.issue.url}): ${escapeInline(e.issue.title)}`;
    case 'release': {
      const name = e.release.name && e.release.name !== e.release.tag ? ` — ${escapeInline(e.release.name)}` : '';
      return `${who(e.actor)} released [${e.repo} ${e.release.tag}](${e.release.url})${name}`;
    }
    case 'star':
      return `${who(e.actor)} starred ${e.repo}`;
  }
}

/**
 * One bullet per event, grouped under a heading per local day (events must be sorted newest first).
 * Like the UI feed, a PR's "opened" event is left out when the same PR also merged or closed that day.
 */
export function eventsMarkdown(title: string, events: ActivityEvent[], ctx: MdContext): string {
  const lines = [`## ${title} · ${rangeLabel(ctx)}`];
  if (events.length === 0) return `${lines[0]}\n\n_Nothing in this range._\n`;
  const days = events.map((e) => localDayNum(ctx.tz, Date.parse(e.at)));
  const finished = new Set<string>();
  events.forEach((e, i) => {
    if (e.type === 'pr' && e.kind !== 'opened') finished.add(`${days[i]}|${e.pr.id}`);
  });
  let lastDay: number | null = null;
  for (const [i, e] of events.entries()) {
    const day = days[i]!;
    if (e.type === 'pr' && e.kind === 'opened' && finished.has(`${day}|${e.pr.id}`)) continue;
    if (day !== lastDay) {
      lines.push('', `### ${dayHeading(day, ctx)}`, '');
      lastDay = day;
    }
    lines.push(`- ${timeOf(e.at, ctx.tz)} · ${eventLine(e, ctx.kindOf ?? GITHUB_ONLY)}`);
  }
  return `${lines.join('\n')}\n`;
}

const THREAD_STATUS_WORD: Record<ThreadStatusFilter, string> = { open: 'unresolved', resolved: 'resolved', all: 'all' };

/**
 * GET /threads as text: a section per PR or commit, in the order the list first reaches it, holding that target's threads
 * as the per-target export renders them (`threadsMarkdown`, under the section's heading). A commit is `repo@abc1234`.
 */
export function threadListMarkdown(items: readonly ThreadListItem[], status: ThreadStatusFilter, kindOf: KindOf = GITHUB_ONLY): string {
  const heading = `# Comments · ${THREAD_STATUS_WORD[status]}`;
  if (items.length === 0) return `${heading}\n\n_No ${status === 'all' ? '' : `${THREAD_STATUS_WORD[status]} `}comments._\n`;
  const targets = new Map<string, { ref: string; title: string | null; kind: ProviderKind; threads: ThreadListItem[] }>();
  for (const t of items) {
    const key = `${t.kind}\0${t.repo}\0${t.number ?? t.commitOid}`;
    let target = targets.get(key);
    if (!target) {
      const kind = kindOf(t.repo);
      const ref = t.number === null ? `${t.repo}@${t.commitOid.slice(0, 7)}` : refText(kind, t.repo, t.number, 'pr');
      targets.set(key, (target = { ref, title: t.targetTitle?.trim() || null, kind, threads: [] }));
    }
    target.threads.push(t);
  }
  const parts = [heading];
  for (const { ref, title, kind, threads } of targets.values()) {
    parts.push(`## ${ref}${title ? ` · ${escapeInline(title)}` : ''}`, threadsMarkdown(threads, { provider: PROVIDERS[kind] }).trimEnd());
  }
  return `${parts.join('\n\n')}\n`;
}
