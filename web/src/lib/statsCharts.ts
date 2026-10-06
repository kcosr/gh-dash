/** Map StatsResponse into chart component props (web/src/charts). */
import type { Bucket, Repo, StatsResponse, Tile, Who } from '../../../shared/api';
import type { PrWords } from '../../../shared/provider';
import { repoLabel, repoParts } from '../../../shared/repos';
import { ACTIVITY_SERIES, YOU_VS_OTHERS } from '../charts';
import type { ColumnDatum, HBarRow, LinePoint, SeriesDef, StatTileProps } from '../charts';
import { prevLabel } from './range';
import type { ResolvedRange } from './range';
import { addDays, fmtDate, fmtHours, fmtMonth, fmtMonthYear, fmtShortDay, parseDateOnly } from './time';
import { actorName } from './util';

export function bucketLabel(start: string, bucket: Bucket): { label: string; title: string } {
  const d = parseDateOnly(start);
  if (bucket === 'day') return { label: fmtDate(d), title: fmtShortDay(d) };
  if (bucket === 'week') return { label: fmtDate(d), title: `Week of ${fmtDate(d)}` };
  return { label: fmtMonth(d), title: fmtMonthYear(d) };
}

const BUCKET_COL = { day: 'Day', week: 'Week of', month: 'Month' } as const;

// ------------------------------------------------------------------ KPI tiles

/** Titles for the 12 equal slices of the range (from the URL's resolved range, local dates). */
function sparkTitles(range: ResolvedRange): string[] {
  const a = range.fromDate.getTime();
  const b = addDays(range.toDate, 1).getTime(); // exclusive end
  const span = (b - a) / 12;
  return Array.from({ length: 12 }, (_, i) => {
    const s = new Date(a + i * span), e = new Date(a + (i + 1) * span - 1);
    return fmtDate(s) === fmtDate(e) ? fmtDate(s) : `${fmtDate(s)} – ${fmtDate(e)}`;
  });
}

export function tileProps(
  st: StatsResponse,
  key: keyof StatsResponse['tiles'],
  label: string,
  unitWord: string,
  range: ResolvedRange,
  opts: { upGood?: boolean; hours?: boolean } = {},
): StatTileProps {
  const t: Tile = st.tiles[key];
  const upGood = opts.upGood ?? true;
  const fmt = (v: number): [string, string] => (opts.hours ? fmtHours(v) : [v.toLocaleString(), '']);
  const [value, unit] = t.value === null ? ['—', ''] : fmt(t.value);
  let delta: StatTileProps['delta'] = null;
  if (t.value !== null && t.previous !== null) {
    const diff = t.value - t.previous;
    const vs = prevLabel(range.id, range.days);
    // hours: anything under a minute counts as no change
    if (Math.abs(diff) < (opts.hours ? 1 / 60 : 1e-9)) delta = { text: 'no change', direction: 'flat', good: null, vs };
    else {
      const [dv, du] = fmt(Math.abs(diff));
      delta = { text: `${dv}${du ? ` ${du}` : ''}`, direction: diff > 0 ? 'up' : 'down', good: diff > 0 === upGood, vs };
    }
  }
  return {
    label,
    value,
    unit: unit || undefined,
    delta,
    spark: t.spark?.length ? { values: t.spark, titles: sparkTitles(range), unit: unitWord, formatValue: opts.hours ? fmtHoursText : undefined } : undefined,
  };
}

/** Hours as text for tooltips/ticks: "0", "15 min", "1.5 h", "3.2 d". Module-level so chart memoization holds. */
export function fmtHoursText(h: number): string {
  if (!Number.isFinite(h)) return '—';
  if (h === 0) return '0';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 36) return `${Math.round(h * 10) / 10} h`;
  return `${(h / 24).toFixed(1)} d`;
}

// ------------------------------------------------------------------ charts

/** "PRs merged" in the words of the page (`w`): "MRs merged", "PRs & MRs merged". */
export const mergedLabel = (w: PrWords) => `${w.shortMany} merged`;

export function activityColumns(st: StatsResponse, w: PrWords): { data: ColumnDatum[]; series: SeriesDef[]; table: { columns: string[]; rows: (string | number)[][] } } {
  const series = [ACTIVITY_SERIES.commits, { ...ACTIVITY_SERIES.prsMerged, label: mergedLabel(w) }, ACTIVITY_SERIES.issues];
  const data = st.series.map((b) => ({
    ...bucketLabel(b.start, st.range.bucket),
    values: { commits: b.commits, prsMerged: b.prsMerged, issues: b.issuesOpened + b.issuesClosed },
  }));
  return {
    data,
    series,
    table: {
      columns: [BUCKET_COL[st.range.bucket], 'Commits', mergedLabel(w), 'Issues opened', 'Issues closed'],
      rows: st.series.map((b) => [bucketLabel(b.start, st.range.bucket).title, b.commits, b.prsMerged, b.issuesOpened, b.issuesClosed]),
    },
  };
}

export function mergedColumns(st: StatsResponse, who: Who) {
  const single: SeriesDef = who === 'me'
    ? { key: 'mine', label: 'You', color: 'var(--wb-s1)' }
    : { key: 'others', label: 'Others', color: 'var(--wb-s1)' };
  const series = who === 'everyone' ? YOU_VS_OTHERS : [single];
  const data = st.series.map((b) => {
    const mine = who === 'others' ? 0 : who === 'me' ? b.prsMerged : b.prsMergedMine;
    const others = who === 'me' ? 0 : who === 'others' ? b.prsMerged : Math.max(0, b.prsMerged - b.prsMergedMine);
    const values: Record<string, number> = { mine, others };
    return { ...bucketLabel(b.start, st.range.bucket), values };
  });
  return {
    data,
    series,
    table: {
      columns: [BUCKET_COL[st.range.bucket], ...series.map((s) => s.label), ...(series.length > 1 ? ['Total'] : [])],
      rows: data.map((d) => [d.title, ...series.map((s) => d.values[s.key]), ...(series.length > 1 ? [d.values.mine + d.values.others] : [])]),
    },
  };
}

export function starsLine(st: StatsResponse): { points: LinePoint[]; table: { columns: string[]; rows: (string | number)[][] } } {
  const points = st.stars.map((d) => {
    const dt = parseDateOnly(d.date);
    return { label: fmtDate(dt), title: fmtShortDay(dt), value: d.total, extra: [{ label: 'new that day', value: `+${d.added}` }] };
  });
  return {
    points,
    table: { columns: ['Date', 'Total stars', 'New'], rows: st.stars.map((d) => [fmtShortDay(parseDateOnly(d.date)), d.total, d.added]) },
  };
}

export function ttmLine(st: StatsResponse, w: PrWords): { points: LinePoint[]; table: { columns: string[]; rows: (string | number)[][] } } {
  // Buckets without merges are NaN, which the LineChart draws as a gap.
  const points = st.series.map((b) => {
    const { label, title } = bucketLabel(b.start, st.range.bucket);
    const h = b.medianHoursToMerge;
    return {
      label,
      title,
      value: h === null ? NaN : Math.round(h * 100) / 100,
      extra: [{ label: mergedLabel(w), value: h === null ? '0' : String(b.prsMerged) }],
    };
  });
  const withData = st.series.filter((b) => b.medianHoursToMerge !== null);
  return {
    points,
    table: {
      columns: [BUCKET_COL[st.range.bucket], 'Median time to merge', mergedLabel(w)],
      rows: withData.map((b) => [bucketLabel(b.start, st.range.bucket).title, fmtHoursText(b.medianHoursToMerge!), b.prsMerged]),
    },
  };
}

/** Bars of the busiest repos. A repo you own is labelled by its bare name; any other has its muted owner as `labelPrefix`. */
export function repoBars(st: StatsResponse, repos: ReadonlyMap<string, Repo>, onClick: (repo: string) => void, w: PrWords): { rows: HBarRow[]; table: { columns: string[]; rows: (string | number)[][] } } {
  return {
    rows: st.byRepo.filter((r) => r.total > 0).map((r) => {
      const { owner, name } = repoParts(r.repo, repos);
      return {
        key: r.repo,
        label: name,
        ...(owner === null ? {} : { labelPrefix: `${owner}/` }),
        value: r.total,
        breakdown: [
          { label: 'commits', value: r.commits, color: ACTIVITY_SERIES.commits.color },
          { label: mergedLabel(w), value: r.prsMerged, color: ACTIVITY_SERIES.prsMerged.color },
          { label: 'issues', value: r.issues, color: ACTIVITY_SERIES.issues.color },
          { label: 'releases', value: r.releases },
          { label: 'stars', value: r.stars },
        ].filter((b) => b.value > 0),
        onClick: () => onClick(r.repo),
      };
    }),
    table: {
      columns: ['Repository', 'Commits', mergedLabel(w), 'Issues', 'Releases', 'Stars', 'Total'],
      rows: st.byRepo.map((r) => [repoLabel(r.repo, repos), r.commits, r.prsMerged, r.issues, r.releases, r.stars, r.total]),
    },
  };
}

type Contributor = StatsResponse['contributors'][number];

/**
 * One row per person, with every "me" identity in a single row labelled "alice (you)". The server
 * already merges the viewer's identities; merging again here keeps an older server (one row per
 * identity) from listing the user twice. Sums are safe: identities are disjoint.
 */
export function mergeContributors(list: Contributor[]): Contributor[] {
  const mine = list.filter((c) => c.actor.isMe);
  if (mine.length <= 1) return list;
  const me = mine.find((c) => c.actor.login) ?? mine[0];
  const merged: Contributor = {
    actor: me.actor,
    commits: mine.reduce((t, c) => t + c.commits, 0),
    prsMerged: mine.reduce((t, c) => t + c.prsMerged, 0),
    total: mine.reduce((t, c) => t + c.total, 0),
  };
  return [...list.filter((c) => !c.actor.isMe), merged].sort((a, b) => b.total - a.total);
}

/** "alice (you)" for the viewer (falls back to the sync status' viewer login), else login or name. */
export function contributorName(c: Contributor, viewer?: string | null): string {
  if (!c.actor.isMe) return actorName(c.actor);
  return `${c.actor.login ?? viewer ?? c.actor.name ?? 'you'} (you)`;
}

export function contributorBars(st: StatsResponse, viewer: string | null | undefined, w: PrWords): { rows: HBarRow[]; table: { columns: string[]; rows: (string | number)[][] } } {
  const list = mergeContributors(st.contributors);
  // Unique keys even when two unlinked authors share a display name.
  const seen = new Set<string>();
  const keyOf = (c: Contributor) => {
    const base = c.actor.isMe ? 'me' : c.actor.login ? `@${c.actor.login}` : `name:${c.actor.name ?? '?'}`;
    let k = base;
    for (let i = 2; seen.has(k); i++) k = `${base}#${i}`;
    seen.add(k);
    return k;
  };
  return {
    rows: list.filter((c) => c.total > 0).map((c) => ({
      key: keyOf(c),
      label: contributorName(c, viewer),
      value: c.total,
      breakdown: [
        { label: 'commits', value: c.commits, color: ACTIVITY_SERIES.commits.color },
        { label: mergedLabel(w), value: c.prsMerged, color: ACTIVITY_SERIES.prsMerged.color },
      ].filter((b) => b.value > 0),
    })),
    table: {
      columns: ['Person', 'Commits', mergedLabel(w), 'Total'],
      rows: list.map((c) => [contributorName(c, viewer), c.commits, c.prsMerged, c.total]),
    },
  };
}

export function calendarTable(st: StatsResponse) {
  return { columns: ['Date', 'Commits'], rows: [...st.commitCalendar].reverse().map((d) => [fmtShortDay(parseDateOnly(d.date)), d.count]) };
}
