import { useCallback, useMemo } from 'react';
import { defaultScope, useRepoMap, useRepos, useSettings, useStats, useSyncStatus } from '../api/hooks';
import { CalendarHeatmap, ChartCard, HBars, LineChart, StackedColumns, StatTile } from '../charts';
import { DateRangeButton } from '../components/DateRange';
import { ErrorNote, ProgressBar } from '../components/EmptyState';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { useWords } from '../components/repoMapContext';
import { Seg, WHO_OPTIONS } from '../components/Seg';
import { useUI } from '../components/ui';
import { statsParams } from '../lib/apiQuery';
import {
  activityColumns,
  calendarTable,
  contributorBars,
  fmtHoursText,
  mergedColumns,
  mergedLabel,
  repoBars,
  starsLine,
  tileProps,
  ttmLine,
} from '../lib/statsCharts';
import { repoPath } from '../../../shared/repos';
import { passesRepoFilters, patchSearch, useUrlState } from '../lib/urlState';

export function InsightsView() {
  const { s, set, range, navigate, location } = useUrlState();
  const { openExport } = useUI();
  const repos = useRepos();
  const repoMap = useRepoMap();
  const settings = useSettings();
  const stats = useStats(statsParams(s));
  const st = stats.data;
  const viewer = useSyncStatus().data?.viewer;
  const loading = stats.isFetching && stats.isPlaceholderData;
  const w = useWords().pr;

  const nRepos = useMemo(() => {
    const all = repos.data ?? [];
    const keys = new Set(s.repos ?? defaultScope(all, settings.data));
    return all.filter((r) => keys.has(r.key) && passesRepoFilters(r, s)).length;
  }, [repos.data, settings.data, s.repos, s.vis, s.own]);

  const byWho = s.who === 'me' ? ' by you' : s.who === 'others' ? ' by others' : '';
  const whoSuffix = byWho ? `,${byWho}` : '';

  const search = location.search;
  const openDay = useCallback(
    (date: string) => navigate({ pathname: '/activity', search: patchSearch(search, 'activity', { range: 'custom', from: date, to: date }) }),
    [navigate, search],
  );
  const openRepo = useCallback((key: string) => navigate(repoPath(key)), [navigate]);

  // Chart inputs are memoized on the response: the charts cache geometry by identity.
  const tiles = useMemo(() => st && [
    tileProps(st, 'prsMerged', `${mergedLabel(w)}${byWho}`, w.shortMany, range),
    tileProps(st, 'commits', `Commits${byWho}`, 'commits', range),
    tileProps(st, 'newStars', 'New stars', 'stars', range),
    tileProps(st, 'medianHoursToMerge', 'Median time to merge', 'hours', range, { upGood: false, hours: true }),
  ], [st, byWho, range, w]);
  const activity = useMemo(() => st && activityColumns(st, w), [st, w]);
  const merged = useMemo(() => st && mergedColumns(st, s.who), [st, s.who]);
  const stars = useMemo(() => st && starsLine(st), [st]);
  const calTable = useMemo(() => st && calendarTable(st), [st]);
  const byRepo = useMemo(() => st && repoBars(st, repoMap, openRepo, w), [st, repoMap, openRepo, w]);
  const ttm = useMemo(() => st && ttmLine(st, w), [st, w]);
  const people = useMemo(() => st && contributorBars(st, viewer, w), [st, viewer, w]);

  return (
    <main className="main tint">
      <FilterToolbar summary={[range.text, s.who === 'me' ? 'By you' : s.who === 'others' ? 'By others' : 'Everyone'].join(' · ')}>
        <div className="row">
          <DateRangeButton />
          <Seg value={s.who} onChange={(who) => set({ who })} options={WHO_OPTIONS} ariaLabel="Author" />
          <span className="summary">{nRepos} {nRepos === 1 ? 'repo' : 'repos'} · {range.text}</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
        </div>
      </FilterToolbar>
      <div className="scroll" id="scroll">
        <ProgressBar active={stats.isFetching && !!st} />
        {stats.isError && !st ? (
          <ErrorNote error={stats.error} onRetry={() => stats.refetch()} />
        ) : !st || !tiles || !activity || !merged || !stars || !calTable || !byRepo || !ttm || !people ? (
          <InsightsSkeleton />
        ) : (
          <>
            <div className="kpis">
              {tiles.map((t) => <StatTile key={t.label} {...t} />)}
            </div>
            <div className="charts">
              <ChartCard id="insights-activity" title="Activity over time" subtitle={`commits, ${mergedLabel(w)} and issues per ${st.range.bucket}${whoSuffix}`} legend={activity.series} table={activity.table} wide loading={loading}>
                <StackedColumns data={activity.data} series={activity.series} ariaLabel="Activity over time" height={240} />
              </ChartCard>
              <ChartCard
                id="insights-merged"
                title={s.who === 'everyone' ? `Merged ${w.shortMany} — you vs others` : `Merged ${w.shortMany}`}
                subtitle={`per ${st.range.bucket}, ${range.phrase}${whoSuffix}`}
                legend={merged.series}
                table={merged.table}
                loading={loading}
              >
                <StackedColumns data={merged.data} series={merged.series} ariaLabel={`Merged ${w.many}`} height={220} />
              </ChartCard>
              <ChartCard id="insights-stars" title="Stars over time" subtitle={`total across public repos in scope, ${range.phrase}`} table={stars.table} loading={loading}>
                <LineChart points={stars.points} valueLabel="stars" ariaLabel="Total stars over time" height={220} />
              </ChartCard>
              <ChartCard id="insights-calendar" title="Commit calendar" subtitle={`commits per day${whoSuffix} · click a day for its activity`} table={calTable} loading={loading}>
                <CalendarHeatmap days={st.commitCalendar} unit="commits" ariaLabel="Commits per day" onDayClick={openDay} />
              </ChartCard>
              <ChartCard id="insights-repos" title="Most active repositories" subtitle={`events per repository, ${range.phrase}`} table={byRepo.table} loading={loading}>
                <HBars rows={byRepo.rows} unit="events" ariaLabel="Most active repositories" emptyText="No activity in this range" />
              </ChartCard>
              <ChartCard id="insights-ttm" title="Time to merge" subtitle={`median time from open to merge, per ${st.range.bucket}`} table={ttm.table} loading={loading} wide={s.who === 'me'}>
                <LineChart points={ttm.points} valueLabel="median" ariaLabel="Median time to merge" zeroBased height={220} formatValue={fmtHoursText} emptyText={`No merged ${w.shortMany} in this range`} />
              </ChartCard>
              {s.who !== 'me' && (
                <ChartCard id="insights-people" title="Top contributors" subtitle={`commits + ${mergedLabel(w)}, ${range.phrase}`} table={people.table} loading={loading}>
                  <HBars rows={people.rows} unit="contributions" ariaLabel="Top contributors" emptyText="No contributors in this range" />
                </ChartCard>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export function InsightsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="kpis">{Array.from({ length: 4 }, (_, i) => <div key={i} className="tile skel-tile" />)}</div>
      <div className="charts">
        <div className="card skel-chart wide" />
        <div className="card skel-chart" />
        <div className="card skel-chart" />
      </div>
    </div>
  );
}
