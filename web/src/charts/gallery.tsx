/**
 * Dev-only chart gallery (web/gallery.html): every component with realistic sample data, the
 * degenerate cases, in a light and a dark section. Not part of the app bundle.
 */
import '../workbench/styles/index.css';
import '../styles/app.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ACTIVITY_SERIES, ActivityStrip, CalendarHeatmap, ChartCard, HBars, LineChart, Sparkline, StackedColumns, StatTile,
  YOU_VS_OTHERS, formatLongDate, formatNumber, formatShortDate, type ColumnDatum, type HBarRow, type LinePoint,
  type SeriesDef,
} from './index';

// ---------------------------------------------------------------------------
// Deterministic sample data (today = Sun, Sep 27 2026)
// ---------------------------------------------------------------------------
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260927);
const ri = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1));
const DAY = 864e5;
const TODAY = Date.UTC(2026, 8, 27) / DAY;
const iso = (num: number) => new Date(num * DAY).toISOString().slice(0, 10);
const wdOf = (num: number) => (new Date(num * DAY).getUTCDay() + 6) % 7;
const lastDays = (n: number) => Array.from({ length: n }, (_, i) => iso(TODAY - n + 1 + i));

// Weekly buckets over the last 90 days (Mon-start weeks).
const weekStarts = (() => {
  const first = TODAY - 89;
  const mon = first - wdOf(first);
  const out: string[] = [];
  for (let d = mon; d <= TODAY; d += 7) out.push(iso(d));
  return out;
})();
const activity: ColumnDatum[] = weekStarts.map((w, i) => ({
  label: formatShortDate(w),
  title: `Week of ${formatShortDate(w)}`,
  values: {
    commits: i === 7 ? 9 : ri(18, 64),
    prsMerged: i === 7 ? 1 : ri(3, 14),
    issues: i === 7 ? 0 : ri(1, 9),
  },
}));
const activitySeries: SeriesDef[] = [ACTIVITY_SERIES.commits, ACTIVITY_SERIES.prsMerged, ACTIVITY_SERIES.issues];
const youVsOthers: ColumnDatum[] = weekStarts.map((w) => ({
  label: formatShortDate(w),
  title: `Week of ${formatShortDate(w)}`,
  values: { mine: ri(1, 9), others: ri(0, 5) },
}));

const days90 = lastDays(90);
let starTotal = 1186;
const stars: LinePoint[] = days90.map((d, i) => {
  const added = i === 46 ? 37 : i === 47 ? 12 : rnd() < 0.45 ? ri(1, 4) : 0;
  starTotal += added;
  return {
    label: formatShortDate(d),
    title: formatLongDate(d),
    value: starTotal,
    extra: [{ label: 'new that day', value: `+${added}` }],
  };
});

const commitDays = days90.map((d) => {
  const wd = wdOf(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY);
  const busy = wd < 5 ? rnd() < 0.85 : rnd() < 0.3;
  return { date: d, count: busy ? ri(1, wd < 5 ? 14 : 4) : 0 };
});
commitDays[61].count = 31; // one big day

const repoNames = [
  'gh-dash', 'agent-runner', 'dotfiles', 'nvim-config', 'homelab-infra', 'sqlite-fts-experiments', 'example-site',
  'photo-sorter', 'tsgo-playground', 'advent-of-code-2025', 'resume', 'mdbook-theme-quiet',
];
const repoRows: HBarRow[] = repoNames
  .map((name, i) => {
    const commits = Math.max(0, 140 - i * 13 + ri(-6, 6));
    const prsMerged = Math.max(0, 22 - i * 2 + ri(-2, 2));
    const issues = Math.max(0, ri(0, 9) - (i > 8 ? 5 : 0));
    return {
      key: name,
      label: name,
      value: commits + prsMerged + issues,
      breakdown: [
        { label: 'commits', value: commits, color: 'var(--wb-s1)' },
        { label: 'PRs merged', value: prsMerged, color: 'var(--wb-s2)' },
        { label: 'issues', value: issues, color: 'var(--wb-s3)' },
      ],
      onClick: () => console.log('open repo', name),
    };
  })
  .sort((a, b) => b.value - a.value);

const ttm: LinePoint[] = weekStarts.map((w, i) => {
  const v = i === 4 || i === 5 ? NaN : Math.round((2 + rnd() * 20 + (i === 9 ? 30 : 0)) * 10) / 10;
  return { label: formatShortDate(w), title: `Week of ${formatShortDate(w)}`, value: v };
});
const fmtHours = (h: number) => (h < 36 ? `${formatNumber(Math.round(h * 10) / 10)}` : formatNumber(Math.round(h)));

const contributors: HBarRow[] = [
  ['alice', 612], ['dependabot[bot]', 188], ['renovate[bot]', 97], ['alice-nguyen', 41], ['bobby-tables', 23],
  ['octo-contributor-with-a-very-long-handle', 11], ['ci-bot', 4],
].map(([l, v]) => ({ key: String(l), label: String(l), value: Number(v) }));

const days30 = lastDays(30);
const strip = days30.map((d, i) => ({ date: d, count: i === 24 ? 27 : rnd() < 0.15 ? 0 : ri(2, 38) }));

const spark12 = (lo: number, hi: number) => Array.from({ length: 12 }, () => ri(lo, hi));
const tileSparks = [spark12(1, 9), spark12(40, 140)];
const repoSparks = [0, 1, 2, 3].map((k) => (k === 3 ? Array<number>(12).fill(0) : spark12(0, 18 - k * 4)));
const spark52 = Array.from({ length: 52 }, () => ri(0, 20));
const sparkTitles = Array.from({ length: 12 }, (_, i) => `${formatShortDate(iso(TODAY - 90 + i * 7.5))} – ${formatShortDate(iso(TODAY - 90 + (i + 1) * 7.5 - 1))}`);

// Edge-case data
const daily365: ColumnDatum[] = lastDays(365).map((d) => ({
  label: formatShortDate(d),
  title: formatLongDate(d, true),
  values: { commits: rnd() < 0.3 ? 0 : ri(1, 20), prsMerged: rnd() < 0.7 ? 0 : ri(1, 3) },
}));
const heat365 = lastDays(365).map((d) => ({ date: d, count: rnd() < 0.35 ? 0 : ri(1, 12) }));
const zeros: ColumnDatum[] = weekStarts.slice(0, 8).map((w) => ({ label: formatShortDate(w), title: `Week of ${formatShortDate(w)}`, values: { commits: 0 } }));
const longRows: HBarRow[] = [
  { key: 'a', label: 'an-extremely-long-repository-name-that-will-not-fit-in-the-label-column', value: 88 },
  { key: 'b', label: 'short', value: 61 },
  { key: 'c', label: 'medium-length-name', value: 40 },
  { key: 'd', label: 'zero-activity-repo', value: 0 },
  { key: 'e', label: 'folded-1', value: 9 },
  { key: 'f', label: 'folded-2', value: 7 },
  { key: 'g', label: 'folded-3', value: 3 },
];

const tableOf = (cols: string[], rows: (string | number)[][]) => ({ columns: cols, rows });

// ---------------------------------------------------------------------------
function Main({ theme }: { theme: 'light' | 'dark' }) {
  const [sel, setSel] = useState<string | null>(days30[24]);
  const [hl, setHl] = useState<number | null>(null);
  return (
    <div className="gal-sec" data-theme={theme}>
      <h2 className="gal-h">{theme} · Insights</h2>
      <div className="kpis">
        <StatTile label="PRs merged" value="64" delta={{ text: '12', direction: 'up', good: true, vs: 'prior 90 days' }} spark={{ values: tileSparks[0], titles: sparkTitles, unit: 'PRs' }} />
        <StatTile label="Commits to main" value="1,284" delta={{ text: '96', direction: 'down', good: false, vs: 'prior 90 days' }} spark={{ values: tileSparks[1], titles: sparkTitles, unit: 'commits' }} />
        <StatTile label="New stars" value="212" delta={{ text: 'no change', direction: 'flat', good: null, vs: 'prior 90 days' }} spark={{ values: [2, 0, 1, 3, 0, 0, 49, 4, 2, 1, 0, 3], titles: sparkTitles, unit: 'stars' }} />
        <StatTile label="Median time to merge" value="5.2" unit="h" delta={{ text: '1.3 h', direction: 'down', good: true, vs: 'prior 90 days' }} />
      </div>
      <div className="charts">
        <ChartCard
          id={`${theme}-activity`}
          className="g-activity"
          wide
          title="Activity over time"
          subtitle="last 90 days, per week"
          legend={activitySeries}
          table={tableOf(['Week of', 'Commits', 'PRs merged', 'Issues'], activity.map((d) => [d.label, d.values.commits, d.values.prsMerged, d.values.issues]))}
        >
          <StackedColumns data={activity} series={activitySeries} ariaLabel="Commits, PRs merged and issues per week" onColumnClick={(i) => setHl(hl === i ? null : i)} highlightIndex={hl} />
        </ChartCard>
        <ChartCard
          id={`${theme}-yvo`}
          className="g-yvo"
          title="Merged PRs — you vs others"
          subtitle="last 90 days, per week"
          legend={YOU_VS_OTHERS}
          table={tableOf(['Week of', 'You', 'Others'], youVsOthers.map((d) => [d.label, d.values.mine, d.values.others]))}
        >
          <StackedColumns data={youVsOthers} series={YOU_VS_OTHERS} ariaLabel="Merged PRs per week, you vs others" />
        </ChartCard>
        <ChartCard
          id={`${theme}-stars`}
          className="g-stars"
          title="Stars over time"
          subtitle="public repos in scope, cumulative"
          table={tableOf(['Date', 'Total stars'], stars.map((p) => [p.label, p.value]))}
        >
          <LineChart points={stars} valueLabel="stars" ariaLabel="Total stars over the last 90 days" />
        </ChartCard>
        <ChartCard
          id={`${theme}-heat`}
          className="g-heat"
          title="Commit calendar"
          subtitle="commits to default branches per day"
          table={tableOf(['Date', 'Commits'], [...commitDays].reverse().map((d) => [formatLongDate(d.date), d.count]))}
        >
          <CalendarHeatmap days={commitDays} unit="commits" ariaLabel="Commits per day" onDayClick={(d) => console.log('day', d)} />
        </ChartCard>
        <ChartCard
          id={`${theme}-repos`}
          className="g-repos"
          title="Most active repositories"
          subtitle="events in range"
          table={tableOf(['Repository', 'Events'], repoRows.map((r) => [r.label, r.value]))}
        >
          <HBars rows={repoRows} unit="events" ariaLabel="Events per repository" />
        </ChartCard>
        <ChartCard
          id={`${theme}-ttm`}
          className="g-ttm"
          title="Time to merge"
          subtitle="median hours from open to merge, per week"
          table={tableOf(['Week of', 'Median hours'], ttm.map((p) => [p.label, Number.isFinite(p.value) ? p.value : '—']))}
        >
          <LineChart points={ttm} valueLabel="hours" zeroBased formatValue={fmtHours} ariaLabel="Median hours to merge per week" />
        </ChartCard>
        <ChartCard
          id={`${theme}-people`}
          className="g-people"
          title="Top contributors"
          subtitle="commits + merged PRs"
          table={tableOf(['Person', 'Events'], contributors.map((r) => [r.label, r.value]))}
        >
          <HBars rows={contributors} unit="events" ariaLabel="Top contributors" />
        </ChartCard>
      </div>

      <h2 className="gal-h">{theme} · Activity strip + repo sparklines</h2>
      <div className="gal-box g-strip">
        <div className="cap">Events per day · selected {sel ? formatLongDate(sel) : 'none'} (click a day)</div>
        <ActivityStrip days={strip} ariaLabel="Events per day" selected={sel} onSelect={(d) => setSel(sel === d ? null : d)} />
      </div>
      <div className="gal-repos">
        {['gh-dash', 'agent-runner', 'dotfiles', 'resume'].map((name, k) => (
          <div className="rcard" key={name}>
            <div className="rc-h"><span className="rc-name">{name}</span></div>
            <div className="rc-spark">
              <Sparkline values={repoSparks[k]} titles={sparkTitles.map((t) => `Week of ${t.split(' – ')[0]}`)} unit="commits" width={168} height={28} />
              <span className="l">commits · 12 wk</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Edges({ theme }: { theme: 'light' | 'dark' }) {
  const t = (id: string) => `${theme}-edge-${id}`;
  const empty = tableOf(['—'], []);
  return (
    <div className="gal-sec" data-theme={theme}>
      <h2 className="gal-h">{theme} · Edge cases</h2>
      <div className="charts">
        <ChartCard id={t('365')} className="g-365" wide title="365 daily columns" subtitle="bars get thin; labels thin out" legend={[ACTIVITY_SERIES.commits, ACTIVITY_SERIES.prsMerged]} table={tableOf(['Day', 'Commits'], daily365.map((d) => [d.label, d.values.commits]))}>
          <StackedColumns data={daily365} series={[ACTIVITY_SERIES.commits, ACTIVITY_SERIES.prsMerged]} ariaLabel="Daily commits for a year" />
        </ChartCard>
        <ChartCard id={t('heat365')} className="g-heat365" wide title="Commit calendar · 365 days" table={tableOf(['Date', 'Commits'], heat365.map((d) => [d.date, d.count]))}>
          <CalendarHeatmap days={heat365} unit="commits" ariaLabel="Commits per day for a year" />
        </ChartCard>
      </div>
      <div className="charts three">
        <ChartCard id={t('empty')} title="StackedColumns · empty" table={empty}>
          <StackedColumns data={[]} series={[ACTIVITY_SERIES.commits]} ariaLabel="empty" height={180} />
        </ChartCard>
        <ChartCard id={t('zeros')} title="StackedColumns · all zeros" table={empty}>
          <StackedColumns data={zeros} series={[ACTIVITY_SERIES.commits]} ariaLabel="zeros" height={180} />
        </ChartCard>
        <ChartCard id={t('one')} title="StackedColumns · single column" legend={activitySeries} table={empty}>
          <StackedColumns data={activity.slice(-1)} series={activitySeries} ariaLabel="one" height={180} />
        </ChartCard>
        <ChartCard id={t('line1')} title="LineChart · single point" table={empty}>
          <LineChart points={stars.slice(-1)} valueLabel="stars" ariaLabel="one point" height={180} />
        </ChartCard>
        <ChartCard id={t('flat')} title="LineChart · flat, zero-based" table={empty}>
          <LineChart points={stars.slice(0, 20).map((p) => ({ ...p, value: 42 }))} valueLabel="stars" zeroBased ariaLabel="flat" height={180} />
        </ChartCard>
        <ChartCard id={t('lineempty')} title="LineChart · empty" table={empty}>
          <LineChart points={[]} valueLabel="stars" ariaLabel="empty line" height={180} />
        </ChartCard>
        <ChartCard id={t('long')} className="g-long" title="HBars · long labels, zero, fold (maxRows 4)" table={empty}>
          <HBars rows={longRows} unit="events" maxRows={4} ariaLabel="long labels" />
        </ChartCard>
        <ChartCard id={t('hempty')} title="HBars · empty" table={empty}>
          <HBars rows={[]} unit="events" ariaLabel="empty bars" />
        </ChartCard>
        <ChartCard id={t('heat1')} title="Heatmap · single day / empty" table={empty}>
          <CalendarHeatmap days={[{ date: iso(TODAY), count: 3 }]} unit="commits" ariaLabel="one day" />
          <CalendarHeatmap days={[]} unit="commits" ariaLabel="no days" />
        </ChartCard>
      </div>
      <div className="charts narrow">
        <ChartCard id={t('narrow')} title="A long card title that has to wrap in a narrow column" subtitle="legend wraps under the title" legend={activitySeries} table={empty}>
          <StackedColumns data={activity} series={activitySeries} ariaLabel="narrow" height={200} />
        </ChartCard>
        <ChartCard id={t('loading')} title="Loading (holds previous render)" subtitle="loading = true" loading legend={activitySeries} table={empty}>
          <StackedColumns data={activity} series={activitySeries} ariaLabel="loading" height={200} />
        </ChartCard>
      </div>
      <div className="gal-box">
        <div className="cap">ActivityStrip · 365 days, no selection</div>
        <ActivityStrip days={heat365} ariaLabel="year strip" />
        <div className="cap" style={{ marginTop: 10 }}>ActivityStrip · all zero</div>
        <ActivityStrip days={days30.map((d) => ({ date: d, count: 0 }))} ariaLabel="zero strip" />
        <div className="cap" style={{ marginTop: 10 }}>Sparklines · all zero · single · empty · 52 values</div>
        <div className="gal-row">
          <Sparkline values={Array(12).fill(0)} unit="commits" />
          <Sparkline values={[7]} unit="commits" />
          <Sparkline values={[]} unit="commits" />
          <Sparkline values={spark52} unit="commits" width={220} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Main theme="light" />
    <Main theme="dark" />
    <Edges theme="light" />
    <Edges theme="dark" />
  </StrictMode>,
);
