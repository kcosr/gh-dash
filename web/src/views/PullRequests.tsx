import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PullRequest } from '../../../shared/api';
import { usePrList, useReleases, useRepoMap } from '../api/hooks';
import { Ctl, MOD_K } from '../components/bits';
import { DateRangeButton } from '../components/DateRange';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { FilterInput } from '../components/FilterInput';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { PrRow, ReleaseRow } from '../components/PrRow';
import { RepoChip } from '../components/RepoChip';
import { Seg, WHO_OPTIONS } from '../components/Seg';
import { useUI } from '../components/ui';
import { prFetchParams, releaseListParams } from '../lib/apiQuery';
import { groupListItems } from '../lib/grouping';
import type { ListItem } from '../lib/grouping';
import { hasBlockingLayer, isTypingTarget } from '../lib/layers';
import { plural } from '../lib/time';
import { useUrlState } from '../lib/urlState';
import type { Density } from '../lib/urlState';

const ST_WORD = { open: 'open', merged: 'merged', closed: 'closed', all: '' } as const;
const WHO_WORD = { me: 'by you', others: 'by others', everyone: '' } as const;

export function PullRequestsView() {
  const { s, set, range } = useUrlState();
  const { openExport } = useUI();
  const repoMap = useRepoMap();
  const prs = usePrList(prFetchParams(s));
  const relOn = s.rel && (s.state === 'merged' || s.state === 'all');
  const rels = useReleases(releaseListParams(s), relOn);

  const groups = useMemo(() => {
    const items: ListItem[] = (prs.data?.items ?? []).map((pr) => ({ kind: 'pr', at: new Date(pr.activityAt), pr }));
    if (relOn) for (const r of rels.data?.items ?? []) items.push({ kind: 'release', at: new Date(r.publishedAt), release: r });
    return groupListItems(items, s.group, (n) => repoMap.get(n)?.visibility === 'private');
  }, [prs.data, rels.data, relOn, s.group, repoMap]);

  // Flat PR order as rendered (group order), for j/k.
  const order = useMemo(() => groups.flatMap((g) => g.items.filter((i) => i.kind === 'pr').map((i) => (i as { pr: PullRequest }).pr)), [groups]);
  const [cursor, setCursor] = useState(-1);

  // Reset the cursor when the filters change.
  const filterKey = JSON.stringify(prFetchParams(s));
  useEffect(() => { setCursor(-1); }, [filterKey]);
  // Keep the cursor on the open PR.
  useEffect(() => {
    if (!s.pr) return;
    const i = order.findIndex((p) => p.id === s.pr);
    if (i >= 0) setCursor(i);
  }, [s.pr, order]);

  // Stable identity (reads the open PR through a ref) so memoized rows don't all re-render
  // whenever the drawer opens or moves.
  const openId = useRef(s.pr);
  useLayoutEffect(() => { openId.current = s.pr; });
  const openPr = useCallback((pr: PullRequest) => {
    set({ pr: openId.current === pr.id ? null : pr.id });
  }, [set]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasBlockingLayer() || isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey || !order.length) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const next = Math.max(0, Math.min(order.length - 1, cursor + (e.key === 'j' ? 1 : -1)));
        setCursor(next);
        const pr = order[next];
        document.querySelector(`article.pr[data-id="${CSS.escape(pr.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        if (s.pr) set({ pr: pr.id }, { replace: true });
      } else if (e.key === 'Enter' && cursor >= 0) {
        // Enter on a focused control (a toolbar button, a link) belongs to that control.
        if ((e.target as Element | null)?.closest?.('button, a[href], input, select, textarea, summary, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="separator"]')) return;
        e.preventDefault();
        set({ pr: order[cursor].id });
      } else if (e.key === 'o' && cursor >= 0) {
        e.preventDefault();
        window.open(order[cursor].url, '_blank', 'noopener');
      } else if (e.key === 'd' && cursor >= 0 && !s.pr) {
        // With details open, the drawer handles `d` (for its PR).
        e.preventDefault();
        set({ diff: order[cursor].id });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [order, cursor, s.pr, set]);

  const data = prs.data;
  const total = data?.total ?? 0;
  const nRepos = useMemo(() => new Set((data?.items ?? []).map((p) => p.repo)).size, [data]);
  const stWord = ST_WORD[s.state];
  const whoWord = WHO_WORD[s.who];
  const fetching = (prs.isFetching && !!data) || (relOn && rels.isFetching && !!rels.data);
  const cursorId = cursor >= 0 ? order[cursor]?.id : undefined;
  const summaryRest = `${[stWord, plural(total, 'PR'), whoWord].filter(Boolean).join(' ')} · ${nRepos} ${plural(nRepos, 'repo')}`;

  return (
    <main className="main">
      <FilterToolbar summary={[s.state === 'all' ? 'All PRs' : s.state[0].toUpperCase() + s.state.slice(1), s.who === 'me' ? 'By you' : s.who === 'others' ? 'By others' : 'Everyone', range.text, s.q && `“${s.q}”`].filter(Boolean).join(' · ')}>
        <div className="row">
          <Seg
            value={s.state}
            onChange={(state) => set({ state })}
            ariaLabel="PR state"
            options={[
              { value: 'open', label: <><Icon name="prOpen" className="st-open" />Open</> },
              { value: 'merged', label: <><Icon name="merge" className="st-merged" />Merged</> },
              { value: 'closed', label: <><Icon name="prClosed" className="st-closed" />Closed</> },
              { value: 'all', label: 'All' },
            ]}
          />
          <Seg value={s.who} onChange={(who) => set({ who })} options={WHO_OPTIONS} ariaLabel="Author" />
          <DateRangeButton />
          {/* Two parts in a one-line wrapping box: when space is short the date part wraps onto the
              clipped second line (drops first), then the rest ellipsizes. Full text in the title. */}
          <span className="summary grow pr-summary" title={data ? `${total.toLocaleString()} ${summaryRest} · ${range.text}` : undefined}>
            {data ? (
              <>
                <span className="sum-main"><b>{total.toLocaleString()}</b> {summaryRest}</span>
                <span className="sum-date"> · {range.text}</span>
              </>
            ) : prs.isError ? null : <span className="sum-main muted">Loading…</span>}
          </span>
          <span className="btn-group">
            <button type="button" className="btn" onClick={() => openExport('md')}><Icon name="md" />Markdown</button>
            <button type="button" className="btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
          </span>
        </div>
        <div className="row">
          <FilterInput value={s.q} onChange={(q) => set({ q }, { replace: true })} placeholder="Filter by title, description, label…" />
          <button
            type="button"
            className={`chip-toggle${s.rel ? ' on' : ''}`}
            style={{ marginLeft: 4 }}
            aria-pressed={s.rel}
            disabled={s.state === 'open' || s.state === 'closed'}
            title={s.state === 'open' || s.state === 'closed' ? 'Releases show with Merged or All' : 'Interleave releases'}
            onClick={() => set({ rel: !s.rel })}
          >
            <Icon name="tag" />Releases
          </button>
          {/* Local review comments, one chip stepping through: all PRs → with comments → with unresolved ones. */}
          <button
            type="button"
            className={`chip-toggle${s.comments ? ' on' : ''}`}
            aria-pressed={!!s.comments}
            title={s.comments === 'any' ? 'PRs with your comments · click for unresolved only' : s.comments === 'unresolved' ? 'PRs with unresolved comments · click for all PRs' : 'Only PRs with your comments'}
            onClick={() => set({ comments: s.comments === null ? 'any' : s.comments === 'any' ? 'unresolved' : null })}
          >
            <Icon name="comment" />{s.comments === 'any' ? 'Commented' : s.comments === 'unresolved' ? 'Unresolved' : 'Comments'}
          </button>
          <span className="spacer" />
          <Ctl label="Group">
            <Seg className="sm" value={s.group} onChange={(group) => set({ group })} ariaLabel="Group by" options={[
              { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'repo', label: 'Repo' },
            ]} />
          </Ctl>
          <Ctl label="Show">
            <Seg<Density> className="sm" value={s.density} onChange={(density) => set({ density })} ariaLabel="Density" options={[
              { value: 'titles', label: 'Titles' }, { value: 'summary', label: 'Summary' }, { value: 'full', label: 'Full' },
            ]} />
          </Ctl>
        </div>
      </FilterToolbar>

      <div className="scroll" id="scroll">
        <ProgressBar active={fetching} />
        <div className={`list${fetching ? ' stale' : ''}`}>
          {prs.isError && !data ? (
            <ErrorNote error={prs.error} onRetry={() => prs.refetch()} />
          ) : !data ? (
            <ListSkeleton density={s.density} />
          ) : s.repos?.length === 0 ? (
            <NoReposSelected onSelectAll={() => set({ repos: null })} />
          ) : groups.length === 0 ? (
            <EmptyState
              icon="merge"
              title={`No ${[stWord, 'PRs', whoWord].filter(Boolean).join(' ')} in ${range.phrase}${s.q ? ` matching “${s.q}”` : ''}`}
              action={
                <div className="empty-actions">
                  {s.range !== '90d' && s.range !== 'ytd' && <button type="button" className="btn" onClick={() => set({ range: '90d' })}>Show last 90 days</button>}
                  {s.who !== 'everyone' && <button type="button" className="btn" onClick={() => set({ who: 'everyone' })}>Show everyone's</button>}
                  {s.q && <button type="button" className="btn" onClick={() => set({ q: '' })}>Clear filter</button>}
                </div>
              }
            >
              Try a longer range or select more repositories.
            </EmptyState>
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.key}>
                  <div className="group-h">
                    <span className="gt">{s.group === 'repo' ? <RepoChip name={g.key} className="repo-ref" /> : g.title}</span>
                    {g.sub && s.group !== 'repo' && <span className="gs">{g.sub}</span>}
                    <span className="rule" />
                    <span className="gc">
                      {g.prs} {plural(g.prs, 'PR')}{g.releases ? ` · ${g.releases} ${plural(g.releases, 'release')}` : ''}
                    </span>
                  </div>
                  {g.items.map((it) =>
                    it.kind === 'pr' ? (
                      <PrRow
                        key={it.pr.id}
                        pr={it.pr}
                        density={s.density}
                        cursor={cursorId === it.pr.id}
                        active={s.pr === it.pr.id}
                        onOpen={openPr}
                      />
                    ) : (
                      <ReleaseRow key={it.release.id} release={it.release} density={s.density} />
                    ),
                  )}
                </section>
              ))}
              {data.nextCursor && (
                <div className="list-note">Showing the {data.items.length.toLocaleString()} most recent of {total.toLocaleString()} PRs. Narrow the range to see the rest.</div>
              )}
              <div className="list-foot">
                <span><kbd>j</kbd> <kbd>k</kbd> move</span>
                <span><kbd>↵</kbd> details</span>
                <span><kbd>d</kbd> diff</span>
                <span><kbd>o</kbd> open on GitHub</span>
                <span><kbd>/</kbd> filter</span>
                <span><kbd>{MOD_K}</kbd> jump anywhere</span>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export function NoReposSelected({ onSelectAll }: { onSelectAll: () => void }) {
  return (
    <EmptyState icon="book" title="No repositories selected" action={<button type="button" className="btn" onClick={onSelectAll}>Select all</button>}>
      Pick repositories in the sidebar, or choose a set.
    </EmptyState>
  );
}

export function ListSkeleton({ density, rows = 6 }: { density: Density; rows?: number }) {
  return (
    <div className="skel-list" aria-busy="true" aria-label="Loading">
      <div className="group-h"><span className="skel" style={{ width: 120 }} /><span className="rule" /></div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`skel-row${density === 'titles' ? ' t' : ''}`}>
          <i className="skel" style={{ width: 16, height: 16 }} />
          <div>
            <i className="skel" style={{ width: `${55 - (i % 3) * 8}%`, height: 14 }} />
            {density !== 'titles' && <i className="skel" style={{ width: '32%' }} />}
            {density !== 'titles' && <i className="skel" style={{ width: '85%' }} />}
          </div>
        </div>
      ))}
    </div>
  );
}
