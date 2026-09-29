import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EVENT_TYPES } from '../../../shared/api';
import type { Actor, EventType, StatsBucket } from '../../../shared/api';
import type { PrWords } from '../../../shared/provider';
import { useActivityFeed, useRepoMap, useStats } from '../api/hooks';
import { ActivityStrip } from '../charts';
import { Avatar, AvatarStack } from '../components/Avatar';
import { prIconName } from '../components/bits';
import { DateRangeButton } from '../components/DateRange';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { CommentBadge } from '../components/PrRow';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { RepoChip } from '../components/RepoChip';
import { useProviderOf, useWords } from '../components/repoMapContext';
import { Seg, WHO_OPTIONS } from '../components/Seg';
import { useUI } from '../components/ui';
import { NoReposSelected } from './PullRequests';
import { activityParams, statsParams } from '../lib/apiQuery';
import { groupFeed } from '../lib/grouping';
import type { FeedDay, FeedRow } from '../lib/grouping';
import { plainPreview } from '../lib/markdown';
import { LAST_VISIT } from '../lib/storage';
import type { ResolvedRange } from '../lib/range';
import { addDays, dayDiff, fmtDateSmart, fmtDateTime, fmtShortDay, fmtTime, isoDate, parseDateOnly } from '../lib/time';
import { commitDiffId, useUrlState } from '../lib/urlState';
import { actorName, actorSubject, isPlainClick } from '../lib/util';

const TYPES: { type: EventType; label: string; icon: IconName; color: string }[] = [
  { type: 'commit', label: 'Commits', icon: 'commit', color: 'var(--text-2)' },
  { type: 'pr', label: 'Pull requests', icon: 'merge', color: 'var(--merged)' },
  { type: 'issue', label: 'Issues', icon: 'issue', color: 'var(--open)' },
  { type: 'release', label: 'Releases', icon: 'tag', color: 'var(--release)' },
  { type: 'star', label: 'Stars', icon: 'starFill', color: 'var(--star)' },
];

const COMMITS_SHOWN = 3;

function lastVisitLabel(d: Date): string {
  const diff = dayDiff(d, new Date());
  const day = diff === 0 ? 'today' : diff === 1 ? 'yesterday' : `on ${fmtDateSmart(d)}`;
  return `Since your last visit · ${fmtTime(d)} ${day}`;
}

type StripDay = { date: string; count: number; title?: string };

/**
 * Per-day strip counts from the feed's own `facets.byDay` (same filters as the list, so the bars
 * match the day headers). Zero-filled over the whole range; the server omits empty days.
 */
function stripFromByDay(byDay: Record<string, number>, range: ResolvedRange): StripDay[] {
  const out: StripDay[] = [];
  for (let d = range.fromDate; d <= range.toDate; d = addDays(d, 1)) {
    const date = isoDate(d);
    out.push({ date, count: byDay[date] ?? 0 });
  }
  return out;
}

/**
 * Fallback for servers without `facets.byDay`: /stats day buckets, limited to the selected types.
 * Approximate: stats commits include PR merge commits, which the feed shows as PR events instead.
 */
function stripDays(series: StatsBucket[] | undefined, types: EventType[], w: PrWords) {
  if (!series) return [];
  const on = new Set(types);
  return series.map((b) => {
    const parts: [number, string, string][] = [];
    if (on.has('commit')) parts.push([b.commits, 'commit', 'commits']);
    if (on.has('pr')) parts.push([b.prsOpened + b.prsMerged, `${w.short} event`, `${w.shortMany} events`]);
    if (on.has('issue')) parts.push([b.issuesOpened + b.issuesClosed, 'issue event', 'issue events']);
    if (on.has('release')) parts.push([b.releases, 'release', 'releases']);
    if (on.has('star')) parts.push([b.stars, 'star', 'stars']);
    const count = parts.reduce((t, [n]) => t + n, 0);
    const detail = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(', ');
    return { date: b.start, count, title: `${fmtShortDay(parseDateOnly(b.start))}${detail ? ` · ${detail}` : ''}` };
  });
}

export function ActivityView() {
  const { s, set, range } = useUrlState();
  const { openExport } = useUI();
  const repoMap = useRepoMap();
  const w = useWords().pr;
  const noTypes = s.types.length === 0;
  const feed = useActivityFeed(activityParams(s));
  const pages = feed.data?.pages;
  const facets = pages?.[0]?.facets;
  const byDay = facets?.byDay;
  // Only needed (and only fetched) when the server doesn't send facets.byDay.
  const stats = useStats({ ...statsParams(s), bucket: 'day' }, !!pages && !byDay);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const events = useMemo(() => (noTypes ? [] : (pages ?? []).flatMap((p) => p.items)), [pages, noTypes]);
  const days = useMemo(() => groupFeed(events), [events]);
  const total = noTypes ? 0 : pages?.[0]?.total ?? 0;
  const strip = useMemo(() => {
    if (!pages) return [];
    // Keep the strip empty immediately, including while previous query data is displayed.
    if (byDay) return stripFromByDay(noTypes ? {} : byDay, range);
    return stripDays(stats.data?.series, s.types, w);
  }, [pages, byDay, noTypes, range, stats.data, s.types, w]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !feed.hasNextPage) return;
    const io = new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting) && !feed.isFetchingNextPage) void feed.fetchNextPage();
    }, { root: scroller.current, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage, days.length]);

  // Strip click -> scroll to that day, loading more pages if needed.
  useEffect(() => {
    if (!pending) return;
    const el = document.getElementById(`day-${pending}`);
    // If the target is the oldest loaded day, load one more page first so it can scroll to the top.
    const isLast = days[days.length - 1]?.key === pending;
    if (el && isLast && feed.hasNextPage) {
      if (!feed.isFetchingNextPage) void feed.fetchNextPage();
      return;
    }
    if (el) {
      el.scrollIntoView({ block: 'start' });
      setPending(null);
      return;
    }
    const oldest = days[days.length - 1];
    if (oldest && oldest.key < pending) { setPending(null); return; } // no events that day
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
    else if (!feed.hasNextPage && !feed.isFetching) setPending(null);
  }, [pending, days, feed.hasNextPage, feed.isFetchingNextPage, feed.isFetching, feed.fetchNextPage]);

  const onStripSelect = useCallback((d: string) => { setSelectedDay(d); setPending(d); }, []);
  // Stable callbacks so memoized day sections / rows only re-render when their own data changes.
  const onExpand = useCallback((k: string) => setExpanded((e) => new Set(e).add(k)), []);
  const onOpenPr = useCallback((id: string) => set({ pr: id }), [set]);
  const onOpenDiff = useCallback((id: string) => set({ diff: id }), [set]);
  const defaultBranch = useCallback((repo: string) => repoMap.get(repo)?.defaultBranch ?? 'main', [repoMap]);

  const toggleType = (t: EventType) => {
    const next = s.types.includes(t) ? s.types.filter((x) => x !== t) : EVENT_TYPES.filter((x) => x === t || s.types.includes(x));
    set({ types: next });
  };

  // Where the "since your last visit" divider goes: before the first row older than LAST_VISIT.
  const dividerBefore = useMemo(() => {
    if (!LAST_VISIT) return null;
    let sawNew = false;
    for (const d of days) for (const r of d.rows) {
      if (r.at > LAST_VISIT) sawNew = true;
      else return sawNew ? r.key : null;
    }
    return null;
  }, [days]);

  const fetching = feed.isFetching && !feed.isFetchingNextPage && !!pages;

  return (
    <main className="main">
      <FilterToolbar summary={[range.text, s.who === 'me' ? 'By you' : s.who === 'others' ? 'By others' : 'Everyone', s.types.length === TYPES.length ? 'All events' : `${s.types.length} event types`].join(' · ')}>
        <div className="row">
          <DateRangeButton />
          <Seg value={s.who} onChange={(who) => set({ who })} options={WHO_OPTIONS} ariaLabel="Author" />
          <span style={{ width: 6 }} />
          {TYPES.map((t) => {
            const on = s.types.includes(t.type);
            return (
              <button key={t.type} type="button" className={`chip-toggle${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleType(t.type)}>
                <span style={{ color: t.color }}><Icon name={t.icon} /></span>
                {t.type === 'pr' ? w.nav : t.label}
                <span className="n">{facets ? (facets.byType?.[t.type] ?? 0).toLocaleString() : '–'}</span>
              </button>
            );
          })}
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => openExport('api')} title="Export as Markdown or get the API URL"><Icon name="braces" />API</button>
        </div>
      </FilterToolbar>

      <div className="scroll" id="scroll" ref={scroller}>
        <ProgressBar active={fetching} />
        <div className="list feed-list">
          <div className="strip-wrap">
            {strip.length > 0 ? (
              <ActivityStrip
                days={strip}
                ariaLabel={`Events per day, ${range.phrase}`}
                selected={selectedDay}
                onSelect={onStripSelect}
                unit="events"
                height={56}
              />
            ) : <div className="strip-skel" />}
            <div className="strip-cap">
              <span>{range.text}</span>
              <span className="spacer" />
              {pages && <span>{total.toLocaleString()} {total === 1 ? 'event' : 'events'}{s.who !== 'everyone' ? (s.who === 'me' ? ' by you' : ' by others') : ''} · click a day to jump</span>}
            </div>
          </div>

          {feed.isError && !pages ? (
            <ErrorNote error={feed.error} onRetry={() => feed.refetch()} />
          ) : !pages ? (
            <FeedSkeleton />
          ) : s.repos?.length === 0 ? (
            <NoReposSelected onSelectAll={() => set({ repos: null })} />
          ) : noTypes ? (
            <EmptyState icon="pulse" title="No event types selected">Turn on at least one of the chips above.</EmptyState>
          ) : days.length === 0 ? (
            <EmptyState
              icon="pulse"
              title="Nothing here for these filters"
              action={s.range !== '90d' ? <button type="button" className="btn" onClick={() => set({ range: '90d' })}>Show last 90 days</button> : undefined}
            >
              Try a longer range or turn on more event types.
            </EmptyState>
          ) : (
            <>
              {days.map((d) => (
                <DaySection
                  key={d.key}
                  day={d}
                  count={byDay?.[d.key] ?? d.count}
                  dividerBefore={dividerBefore}
                  expanded={expanded}
                  onExpand={onExpand}
                  onOpenPr={onOpenPr}
                  onOpenDiff={onOpenDiff}
                  activePr={s.pr}
                  defaultBranch={defaultBranch}
                />
              ))}
              <div ref={sentinel} className="feed-end">
                {feed.hasNextPage
                  ? feed.isFetchingNextPage ? 'Loading more…' : <button type="button" className="btn ghost" onClick={() => feed.fetchNextPage()}>Load more</button>
                  : `That's everything from ${range.text}.`}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

const DaySection = memo(function DaySection({ day, count, dividerBefore, expanded, onExpand, onOpenPr, onOpenDiff, activePr, defaultBranch }: {
  day: FeedDay;
  /** Events that day: facets.byDay when available (complete even while later pages are unloaded). */
  count: number;
  dividerBefore: string | null;
  expanded: Set<string>;
  onExpand: (key: string) => void;
  onOpenPr: (id: string) => void;
  onOpenDiff: (id: string) => void;
  activePr: string | null;
  defaultBranch: (repo: string) => string;
}) {
  return (
    <section id={`day-${day.key}`} className="day-sec">
      <div className="group-h">
        <span className="gt">{day.title}</span>
        <span className="gs">{day.sub}</span>
        <span className="rule" />
        <span className="gc">{count.toLocaleString()} {count === 1 ? 'event' : 'events'}</span>
      </div>
      <div className="day">
        {day.rows.map((r) => (
          <Fragment key={r.key}>
            {r.key === dividerBefore && LAST_VISIT && <div className="new-divider">{lastVisitLabel(LAST_VISIT)}</div>}
            <FeedItem
              row={r}
              expanded={expanded.has(r.key)}
              onExpand={onExpand}
              onOpenPr={onOpenPr}
              onOpenDiff={onOpenDiff}
              active={!!activePr && r.kind === 'event' && r.event.type === 'pr' && r.event.pr.id === activePr}
              defaultBranch={defaultBranch}
            />
          </Fragment>
        ))}
      </div>
    </section>
  );
});

const Who = ({ actor }: { actor: Actor | null }) => <><Avatar actor={actor} size={18} /><b>{actorSubject(actor)}</b></>;

const FeedItem = memo(function FeedItem({ row, expanded, onExpand, onOpenPr, onOpenDiff, active, defaultBranch }: {
  row: FeedRow;
  expanded: boolean;
  onExpand: (key: string) => void;
  onOpenPr: (id: string) => void;
  onOpenDiff: (id: string) => void;
  /** This row's PR is open in the drawer. */
  active: boolean;
  defaultBranch: (repo: string) => string;
}) {
  let cls = '', icon: IconName = 'commit', text: ReactNode = null, sub: ReactNode = null;
  const providerOf = useProviderOf();
  const repo = (key: string) => <RepoChip repo={key} className="ev-repo" />;
  // Commit links open the diff in-app; modifier and middle clicks still go to GitHub.
  const diffLink = (key: string, c: { oid: string; url: string }, className: string, children: ReactNode) => (
    <a className={className} href={c.url} target="_blank" rel="noopener noreferrer" data-diff={commitDiffId(key, c.oid)} title="View the commit's diff"
      onClick={(ev) => { if (isPlainClick(ev)) { ev.preventDefault(); onOpenDiff(commitDiffId(key, c.oid)); } }}>{children}</a>
  );

  if (row.kind === 'commits') {
    const n = row.commits.length;
    const open = n <= COMMITS_SHOWN || expanded;
    cls = 'commit'; icon = 'commit';
    text = <><Who actor={row.actor} /> pushed {n} {n === 1 ? 'commit' : 'commits'} to <code className="br">{defaultBranch(row.repo)}</code> in {repo(row.repo)}</>;
    sub = (
      <div className="c-box">
        {row.commits.slice(0, open ? n : COMMITS_SHOWN).map((c) => (
          <div key={c.oid} className="c-li">
            {diffLink(row.repo, c, 'sha', c.shortOid || c.oid.slice(0, 7))}
            <span title={c.body ? `${c.headline}\n\n${c.body}` : c.headline}>{c.headline}</span>
            <CommentBadge c={c.comments} />
            <time dateTime={c.committedAt} title={fmtDateTime(c.committedAt)}>{fmtTime(c.committedAt)}</time>
          </div>
        ))}
        {!open && <button type="button" className="more" onClick={() => onExpand(row.key)}>Show {n - COMMITS_SHOWN} more</button>}
      </div>
    );
  } else if (row.kind === 'stars') {
    const names = row.actors;
    const n = names.length;
    const b = (a: Actor) => <b key={actorName(a)}>{actorName(a)}</b>;
    cls = 'star'; icon = 'starFill';
    text = (
      <>
        {n > 1 ? <AvatarStack actors={names} /> : <Avatar actor={names[0]} size={18} />}
        {n === 1 ? b(names[0]) : n === 2 ? <>{b(names[0])} and {b(names[1])}</> : <>{b(names[0])}, {b(names[1])} and {n - 2} {n - 2 === 1 ? 'other' : 'others'}</>}
        {' '}starred {repo(row.repo)}
      </>
    );
  } else {
    const e = row.event;
    if (e.type === 'pr') {
      const p = e.pr;
      cls = e.kind === 'opened' ? 'open' : e.kind;
      icon = e.kind === 'opened' ? prIconName({ state: 'open', isDraft: p.isDraft }) : prIconName({ state: e.kind, isDraft: false });
      text = (
        <>
          <Who actor={e.actor} /> {e.kind}{' '}
          <a className={`t${active ? ' on' : ''}`} href={p.url} onClick={(ev) => { ev.preventDefault(); onOpenPr(p.id); }}>{p.title}</a>
          <span className="num"><RepoChip repo={p.repo} className="repo-ref" />{providerOf(p.repo).prRef}{p.number}</span>
          <CommentBadge c={p.comments} />
        </>
      );
      if (e.kind === 'merged' && p.body.trim()) sub = <p className="ev-desc">{plainPreview(p.body)}</p>;
    } else if (e.type === 'issue') {
      const i = e.issue;
      cls = e.kind === 'opened' ? 'open' : 'merged';
      icon = e.kind === 'opened' ? 'issue' : 'issueClosed';
      text = (
        <>
          <Who actor={e.actor} /> {e.kind} issue{' '}
          <a className="t" href={i.url} target="_blank" rel="noopener noreferrer">{i.title}</a>
          <span className="num"><RepoChip repo={i.repo} className="repo-ref" />#{i.number}</span>
        </>
      );
    } else if (e.type === 'release') {
      const r = e.release;
      cls = 'release'; icon = 'tag';
      text = (
        <>
          <Who actor={e.actor} /> released{' '}
          <a className="t" href={r.url} target="_blank" rel="noopener noreferrer">{r.name && r.name !== r.tag ? `${r.tag} · ${r.name}` : r.tag}</a> in {repo(r.repo)}
        </>
      );
      if (r.body.trim()) sub = <p className="ev-desc">{plainPreview(r.body)}</p>;
    } else if (e.type === 'commit') {
      // (normally aggregated; kept for completeness)
      cls = 'commit'; icon = 'commit';
      text = <><Who actor={e.actor} /> pushed {diffLink(e.repo, e.commit, 't', e.commit.headline)} to {repo(e.repo)}<CommentBadge c={e.commit.comments} /></>;
    } else {
      cls = 'star'; icon = 'starFill';
      text = <><Avatar actor={e.actor} size={18} /><b>{actorName(e.actor)}</b> starred {repo(e.repo)}</>;
    }
  }

  return (
    <div className={`ev ${cls}`}>
      <span className="ev-ic"><Icon name={icon} /></span>
      <div className="ev-main">
        <div className="ev-text">{text}</div>
        {sub}
      </div>
      <time className="ev-time" dateTime={row.at.toISOString()} title={fmtDateTime(row.at)}>{fmtTime(row.at)}</time>
    </div>
  );
});

function FeedSkeleton() {
  return (
    <div className="skel-list" aria-busy="true" aria-label="Loading">
      <div className="group-h"><span className="skel" style={{ width: 160 }} /><span className="rule" /></div>
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="skel-row ev-skel">
          <i className="skel" style={{ width: 28, height: 28, borderRadius: 14 }} />
          <div><i className="skel" style={{ width: `${62 - (i % 3) * 12}%`, height: 14 }} /></div>
        </div>
      ))}
    </div>
  );
}
