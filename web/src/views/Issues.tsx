import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, IssueState } from '../../../shared/api';
import { useIssueList } from '../api/hooks';
import { Avatar } from '../components/Avatar';
import { DateRangeButton } from '../components/DateRange';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { FilterInput } from '../components/FilterInput';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { Labels } from '../components/Label';
import { Markdown } from '../components/Markdown';
import { RepoChip } from '../components/RepoChip';
import { Seg, WHO_OPTIONS } from '../components/Seg';
import { useUI } from '../components/ui';
import { issueListParams } from '../lib/apiQuery';
import { plainPreview } from '../lib/markdown';
import { fmtDateTime, plural, rel } from '../lib/time';
import { useUrlState } from '../lib/urlState';
import { actorName } from '../lib/util';

export function IssuesView() {
  const { s, set, range } = useUrlState();
  const { openExport } = useUI();
  const params = issueListParams(s);
  const issues = useIssueList(params);
  const scroller = useRef<HTMLDivElement>(null);
  const filterKey = JSON.stringify(params);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [filterKey]);
  const data = issues.data;
  const items = useMemo(() => {
    // Syncs can move an issue across a page boundary; render each issue once.
    const seen = new Set<string>();
    return (data?.pages.flatMap((p) => p.items) ?? []).filter((issue) => {
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
  }, [data]);
  const total = data?.pages[0]?.total ?? 0;
  const state = params.state;
  const stateLabel = state === 'all' ? 'All issues' : state === 'open' ? 'Open' : 'Closed';
  const authorLabel = s.who === 'me' ? 'By you' : s.who === 'others' ? 'By others' : 'Everyone';

  return (
    <main className="main">
      <FilterToolbar summary={[stateLabel, authorLabel, range.text, s.q && `“${s.q}”`].filter(Boolean).join(' · ')}>
        <div className="row">
          <Seg<IssueState | 'all'> value={state} onChange={(state) => set({ state })} ariaLabel="Issue state" options={[
            { value: 'open', label: <><Icon name="issue" />Open</> },
            { value: 'closed', label: <><Icon name="issueClosed" />Closed</> },
            { value: 'all', label: 'All' },
          ]} />
          <Seg value={s.who} onChange={(who) => set({ who })} options={WHO_OPTIONS} ariaLabel="Author" />
          <DateRangeButton />
          <span className="summary">{data ? `${total.toLocaleString()} ${state === 'all' ? '' : `${state} `}${plural(total, 'issue')}` : issues.isError ? '' : 'Loading…'}</span>
          <span className="spacer" />
          <span className="btn-group">
            <button type="button" className="btn" onClick={() => openExport('md')}><Icon name="md" />Markdown</button>
            <button type="button" className="btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
          </span>
        </div>
        <div className="row">
          <FilterInput value={s.q} onChange={(q) => set({ q }, { replace: true })} placeholder="Filter issues by title or description…" />
          <span className="issue-date-hint">Dates use creation for open issues and closure for closed issues. Author filters use the creator.</span>
        </div>
      </FilterToolbar>
      <div className="scroll" id="scroll" ref={scroller}>
        <ProgressBar active={issues.isFetching && !issues.isFetchingNextPage && !!data} />
        <div className={`list issue-list${issues.isPlaceholderData ? ' stale' : ''}`} aria-busy={issues.isFetching}>
          {issues.isError && !data ? <ErrorNote error={issues.error} onRetry={() => issues.refetch()} />
            : !data ? <div className="empty" role="status">Loading issues…</div>
            : !issues.isPlaceholderData && s.repos?.length === 0 ? (
              <EmptyState icon="book" title="No repositories selected" action={<button type="button" className="btn" onClick={() => set({ repos: null })}>Select default repositories</button>} />
            ) : !items.length && issues.isPlaceholderData ? <div className="empty" role="status">Updating issues…</div>
            : !items.length ? (
              <EmptyState icon="issue" title="No issues match these filters" action={
                <div className="empty-actions">
                  {s.q && <button type="button" className="btn" onClick={() => set({ q: '' })}>Clear search</button>}
                  {s.range !== 'ytd' && s.range !== '90d' && <button type="button" className="btn" onClick={() => set({ range: '90d' })}>Show last 90 days</button>}
                  {s.who !== 'everyone' && <button type="button" className="btn" onClick={() => set({ who: 'everyone' })}>Show everyone's</button>}
                </div>
              }>Try another state, repository, author, or date range.</EmptyState>
            ) : <>
              {items.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
              {issues.isError && (
                <div className="issue-page-error" role="alert">
                  <p>Couldn't {issues.isFetchNextPageError ? 'load more' : 'refresh'} issues. The loaded issues are still shown.</p>
                  <button type="button" className="btn" disabled={issues.isFetching} onClick={() => issues.isFetchNextPageError ? issues.fetchNextPage() : issues.refetch()}>Retry</button>
                </div>
              )}
              <div className="issue-list-footer">
                <span>{items.length.toLocaleString()} of {total.toLocaleString()} {plural(total, 'issue')}</span>
                {issues.hasNextPage && !issues.isFetchNextPageError && <button type="button" className="btn" disabled={issues.isFetching || issues.isPlaceholderData} onClick={() => issues.fetchNextPage()}>
                  {issues.isFetchingNextPage ? 'Loading…' : 'Load more issues'}
                </button>}
              </div>
            </>}
        </div>
      </div>
    </main>
  );
}

const IssueRow = memo(function IssueRow({ issue }: { issue: Issue }) {
  const [expanded, setExpanded] = useState(false);
  const at = issue.state === 'closed' ? issue.closedAt ?? issue.createdAt : issue.createdAt;
  return (
    <article className="pr issue-row" aria-label={`${issue.repo}#${issue.number}: ${issue.title}`}>
      <span className={`pr-ic ${issue.state === 'open' ? 'open' : 'merged'}`}><Icon name={issue.state === 'open' ? 'issue' : 'issueClosed'} /></span>
      <div className="pr-main">
        <div className="pr-title">
          <a href={issue.url} target="_blank" rel="noopener noreferrer" title="Open issue on GitHub">{issue.title}<Icon name="ext" /></a>
          <Labels labels={issue.labels} />
        </div>
        <div className="pr-meta">
          <RepoChip name={issue.repo} /><span className="num">#{issue.number}</span><span className="sep">·</span>
          <span>{issue.state === 'open' ? 'Opened' : 'Closed'} <time dateTime={at} title={fmtDateTime(at)}>{rel(at)}</time></span>
          <span className="sep">·</span><span>created by</span>
          <span className="author"><Avatar actor={issue.author} /><b>{issue.author.isMe ? 'you' : actorName(issue.author)}</b></span>
        </div>
        {issue.body.trim() && <details className="issue-description" onToggle={(e) => setExpanded(e.currentTarget.open)}>
          <summary aria-label={`Description of ${issue.repo}#${issue.number}`}><span className="pr-desc">{plainPreview(issue.body)}</span><span className="issue-description-toggle">Description <Icon name="chevron" /></span></summary>
          {expanded && <Markdown source={issue.body} />}
        </details>}
      </div>
    </article>
  );
});
