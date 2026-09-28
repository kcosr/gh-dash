import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import type { PullRequest } from '../../../shared/api';
import { usePatchRepo, usePrList, useReleases, useRepos, useStats, useSyncStatus } from '../api/hooks';
import { ChartCard, HBars, StackedColumns, StatTile } from '../charts';
import { prIconClass, prIconName } from '../components/bits';
import { DateRangeButton } from '../components/DateRange';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Labels } from '../components/Label';
import { Markdown } from '../components/Markdown';
import { Seg, WHO_OPTIONS } from '../components/Seg';
import { useUI } from '../components/ui';
import { ALL_TIME_FROM, scopeParams, statsParams } from '../lib/apiQuery';
import { activityColumns, contributorBars, tileProps } from '../lib/statsCharts';
import { fmtDate, fmtDateTime, isoDate, rel } from '../lib/time';
import { carrySearch, encodeParams, useUrlState } from '../lib/urlState';
import { actorName, cx } from '../lib/util';
import { InsightsSkeleton } from './Insights';

const LIST_MAX = 8;

function CompactPr({ pr, onOpen, active }: { pr: PullRequest; onOpen: () => void; active: boolean }) {
  return (
    <div className={cx('mini-pr', active && 'active')} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <span className={`pr-ic ${prIconClass(pr)}`}><Icon name={prIconName(pr)} /></span>
      <span className="mp-title">{pr.title}<Labels labels={pr.labels} /></span>
      <span className="num">#{pr.number}</span>
      <span className="mp-who">{pr.author.isMe ? 'you' : actorName(pr.author)}</span>
      <time dateTime={pr.activityAt} title={fmtDateTime(pr.activityAt)}>{pr.state === 'open' ? rel(pr.activityAt) : fmtDate(pr.activityAt)}</time>
    </div>
  );
}

export function RepoDetailView() {
  const { name = '' } = useParams();
  const { s, set, range, location } = useUrlState();
  const { openExport } = useUI();
  const repos = useRepos();
  const patch = usePatchRepo();
  const repo = repos.data?.find((r) => r.name === name);
  const scoped = { ...s, repos: [name], vis: 'all' as const };
  const stats = useStats(statsParams(scoped), !!repo);
  const merged = usePrList({ ...scopeParams(scoped, { q: false }), state: 'merged', limit: 50 }, !!repo);
  const open = usePrList({ ...scopeParams({ ...scoped, who: 'everyone' }, { q: false }), from: ALL_TIME_FROM, state: 'open', limit: 50 }, !!repo);
  const releases = useReleases({ ...scopeParams({ ...scoped, who: 'everyone' }, { q: false }), from: ALL_TIME_FROM }, !!repo);
  const st = stats.data;
  const viewer = useSyncStatus().data?.viewer;
  const byWho = s.who === 'me' ? ' by you' : s.who === 'others' ? ' by others' : '';
  const tiles = useMemo(() => st && [
    tileProps(st, 'commits', `Commits${byWho}`, 'commits', range),
    tileProps(st, 'prsMerged', `PRs merged${byWho}`, 'PRs', range),
    tileProps(st, 'issuesClosed', 'Issues closed', 'issues', range),
    tileProps(st, 'newStars', 'New stars', 'stars', range),
  ], [st, byWho, range]);
  const activity = useMemo(() => st && activityColumns(st), [st]);
  const people = useMemo(() => st && contributorBars(st, viewer), [st, viewer]);

  if (repos.isSuccess && !repo) {
    return (
      <main className="main tint">
        <div className="scroll">
          <EmptyState icon="book" title={`No repository named “${name}”`} action={<Link className="btn" to={`/repos${carrySearch(location.search)}`}>All repositories</Link>}>
            It may have been renamed, deleted, or not synced yet.
          </EmptyState>
        </div>
      </main>
    );
  }

  const seeAll = (extra: [string, string][], allTime = false) => {
    const pairs: [string, string][] = [['repos', name], ...extra];
    if (allTime) pairs.push(['range', 'custom'], ['from', ALL_TIME_FROM], ['to', isoDate(new Date())]);
    else if (s.range === 'custom' && s.from && s.to) pairs.push(['range', 'custom'], ['from', s.from], ['to', s.to]);
    else if (s.range !== '30d') pairs.push(['range', s.range]);
    return `/prs?${encodeParams(pairs)}`;
  };
  const openPr = (id: string) => set({ pr: s.pr === id ? null : id });
  const whoSuffix = byWho ? `,${byWho}` : '';

  return (
    <main className="main tint">
      <div className="toolbar">
        <div className="row">
          <Link to={`/repos${carrySearch(location.search)}`} className="btn ghost crumb"><Icon name="chevronLeft" />Repositories</Link>
          <DateRangeButton />
          <Seg value={s.who} onChange={(who) => set({ who })} options={WHO_OPTIONS} ariaLabel="Author" />
          <span className="summary">{range.text}</span>
          <span className="spacer" />
          <Link className="btn" to={`/activity?repos=${encodeURIComponent(name)}`}><Icon name="pulse" />Activity</Link>
          <button type="button" className="btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
        </div>
      </div>
      <div className="scroll" id="scroll">
        <ProgressBar active={stats.isFetching && !!st} />
        {repo && (
          <div className="repo-head">
            <div className="rh-top">
              <h1>{repo.name}</h1>
              <span className="vis-badge">{repo.visibility === 'private' ? <><Icon name="lock" />Private</> : 'Public'}</span>
              {repo.isArchived && <span className="vis-badge">Archived</span>}
              {repo.isFork && <span className="vis-badge"><Icon name="fork" />Fork</span>}
              {repo.hidden && <span className="vis-badge">Hidden</span>}
              <span className="spacer" />
              <button
                type="button"
                className={cx('btn', repo.pinned && 'on-accent')}
                onClick={() => patch.mutate({ name: repo.name, patch: { pinned: !repo.pinned } })}
                aria-pressed={repo.pinned}
              >
                <Icon name="pin" />{repo.pinned ? 'Pinned' : 'Pin'}
              </button>
              <a className="btn primary" href={repo.url} target="_blank" rel="noopener noreferrer"><Icon name="ext" />Open on GitHub</a>
            </div>
            {repo.description && <p className="rh-desc">{repo.description}</p>}
            <div className="rc-stats rh-stats">
              {repo.language && <span><i className="lang" style={{ '--lc': repo.language.color ?? 'var(--muted)' } as CSSProperties} />{repo.language.name}</span>}
              {repo.visibility === 'public' && <span><Icon name="star" />{repo.stars.toLocaleString()} stars{repo.stats.newStars30d > 0 && <em>+{repo.stats.newStars30d}</em>}</span>}
              <span><Icon name="fork" />{repo.forks.toLocaleString()} forks</span>
              <span><Icon name="prOpen" />{repo.stats.openPrs} open PRs</span>
              <span><Icon name="issue" />{repo.stats.openIssues} open issues</span>
              {repo.defaultBranch && <span><code>{repo.defaultBranch}</code></span>}
              <span className="muted">Updated {rel(repo.lastActivityAt ?? repo.pushedAt ?? repo.createdAt)}</span>
              <a className="rh-link" href={`${repo.url}/pulls`} target="_blank" rel="noopener noreferrer">Pull requests ↗</a>
              <a className="rh-link" href={`${repo.url}/issues`} target="_blank" rel="noopener noreferrer">Issues ↗</a>
              <a className="rh-link" href={`${repo.url}/releases`} target="_blank" rel="noopener noreferrer">Releases ↗</a>
            </div>
            {repo.topics.length > 0 && <div className="rh-topics">{repo.topics.map((t) => <span key={t} className="set-chip">{t}</span>)}</div>}
          </div>
        )}

        {(repos.isError && !repos.data) || (stats.isError && !st) ? (
          <ErrorNote error={repos.error ?? stats.error} onRetry={() => { void repos.refetch(); void stats.refetch(); }} />
        ) : !st || !tiles || !activity || !people ? <InsightsSkeleton /> : (
          <>
            <div className="kpis">
              {tiles.map((t) => <StatTile key={t.label} {...t} />)}
            </div>
            <div className="charts">
              <ChartCard id="repo-activity" title="Activity over time" subtitle={`per ${st.range.bucket}, ${range.phrase}${whoSuffix}`} legend={activity.series} table={activity.table} wide loading={stats.isFetching && stats.isPlaceholderData}>
                <StackedColumns data={activity.data} series={activity.series} ariaLabel={`Activity in ${name}`} height={220} />
              </ChartCard>

              <section className="card list-card">
                <div className="card-h">
                  <div><h3>Recently merged</h3><div className="sub">{range.phrase}{byWho}</div></div>
                  <span className="spacer" />
                  <Link className="tbl-btn" to={seeAll(s.who !== 'me' ? [['who', s.who]] : [])}>See all</Link>
                </div>
                {merged.data?.items.length
                  ? merged.data.items.slice(0, LIST_MAX).map((p) => <CompactPr key={p.id} pr={p} onOpen={() => openPr(p.id)} active={s.pr === p.id} />)
                  : <div className="chart-empty">{merged.data ? 'No merged PRs in this range' : 'Loading…'}</div>}
                {(merged.data?.total ?? 0) > LIST_MAX && <div className="card-more">+{merged.data!.total - LIST_MAX} more</div>}
              </section>

              <section className="card list-card">
                <div className="card-h">
                  <div><h3>Open pull requests</h3><div className="sub">all authors, any age</div></div>
                  <span className="spacer" />
                  <Link className="tbl-btn" to={seeAll([['who', 'everyone'], ['state', 'open']], true)}>See all</Link>
                </div>
                {open.data?.items.length
                  ? open.data.items.slice(0, LIST_MAX).map((p) => <CompactPr key={p.id} pr={p} onOpen={() => openPr(p.id)} active={s.pr === p.id} />)
                  : <div className="chart-empty">{open.data ? 'No open pull requests' : 'Loading…'}</div>}
                {(open.data?.total ?? 0) > LIST_MAX && <div className="card-more">+{open.data!.total - LIST_MAX} more</div>}
              </section>

              <section className="card list-card">
                <div className="card-h">
                  <div><h3>Releases</h3><div className="sub">latest first</div></div>
                  <span className="spacer" />
                  {repo && <a className="tbl-btn" href={`${repo.url}/releases`} target="_blank" rel="noopener noreferrer">GitHub ↗</a>}
                </div>
                {releases.data?.items.length ? (
                  <div className="rel-list">
                    {releases.data.items.slice(0, 5).map((r) => (
                      <details key={r.id} className="rel-item" open={false}>
                        <summary>
                          <span className="pr-ic release"><Icon name="tag" /></span>
                          <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><b>{r.tag}</b>{r.name && r.name !== r.tag ? ` · ${r.name}` : ''}</a>
                          {r.isPrerelease && <span className="draft-tag">Pre-release</span>}
                          <span className="spacer" />
                          <time dateTime={r.publishedAt} title={fmtDateTime(r.publishedAt)}>{fmtDate(r.publishedAt)}</time>
                        </summary>
                        <Markdown source={r.body} />
                      </details>
                    ))}
                  </div>
                ) : <div className="chart-empty">{releases.data ? 'No releases' : 'Loading…'}</div>}
              </section>

              <ChartCard id="repo-people" title="Top contributors" subtitle={`commits + PRs merged, ${range.phrase}`} table={people.table}>
                <HBars rows={people.rows} unit="contributions" ariaLabel={`Top contributors to ${name}`} emptyText="No contributors in this range" />
              </ChartCard>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
