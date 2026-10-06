import { ChipToggle, EmptyState, ErrorState, ProgressBar, Seg, hasBlockingLayer, isTypingTarget } from '../workbench';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Branch, PullRequest } from '../../../shared/api';
import type { PrWords } from '../../../shared/provider';
import { useBranchList, usePrList, useReleases, useRepoMap } from '../api/hooks';
import { Ctl, MOD_K } from '../components/bits';
import { DateRangeButton } from '../components/DateRange';
import { FilterInput } from '../components/FilterInput';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { BranchRow, PrRow, ReleaseRow } from '../components/PrRow';
import { RepoChip } from '../components/RepoChip';
import { useWords } from '../components/repoMapContext';
import { WHO_OPTIONS } from '../lib/filterOptions';
import { useUI } from '../components/ui';
import { branchListParams, prFetchParams, releaseListParams } from '../lib/apiQuery';
import { branchItem, groupListItems } from '../lib/grouping';
import type { ListItem } from '../lib/grouping';
import { plural } from '../lib/time';
import { useUrlState } from '../lib/urlState';
import type { Density } from '../lib/urlState';

const ST_WORD = { open: 'open', merged: 'merged', closed: 'closed', all: '' } as const;
const WHO_WORD = { me: 'by you', others: 'by others', everyone: '' } as const;

/** "a PR", "an MR", "a PR or MR": the article as the letters are read out. */
const aShort = (w: PrWords) => `${/^[MN]/.test(w.short) ? 'an' : 'a'} ${w.short}`;

export function PullRequestsView() {
  const { s, set, range } = useUrlState();
  const { openExport } = useUI();
  const repoMap = useRepoMap();
  const words = useWords();
  const w = words.pr;
  // "No PR yet": the branches with no PR yet take the PRs' place, grouped, moved through and opened as they are.
  const noPr = s.state === 'nopr';
  const prs = usePrList(prFetchParams(s), !noPr);
  const branches = useBranchList(branchListParams(s), noPr);
  const list = noPr ? branches : prs;
  // Releases have no comments: a comments filter shows PRs alone.
  const relOn = s.rel && (s.state === 'merged' || s.state === 'all') && !s.comments;
  const rels = useReleases(releaseListParams(s), relOn);

  const groups = useMemo(() => {
    const items: ListItem[] = noPr
      ? (branches.data?.items ?? []).map(branchItem)
      : (prs.data?.items ?? []).map((pr) => ({ kind: 'pr', at: new Date(pr.activityAt), pr }));
    if (relOn) for (const r of rels.data?.items ?? []) items.push({ kind: 'release', at: new Date(r.publishedAt), release: r });
    return groupListItems(items, s.group, (n) => repoMap.get(n)?.visibility === 'private');
  }, [noPr, prs.data, branches.data, rels.data, relOn, s.group, repoMap]);

  // Flat row order as rendered (group order), for j/k: the PRs, or the branches.
  const order = useMemo(
    () => groups.flatMap((g) => g.items.flatMap((i): (PullRequest | Branch)[] => (i.kind === 'pr' ? [i.pr] : i.kind === 'branch' ? [i.branch] : []))),
    [groups],
  );
  const [cursor, setCursor] = useState(-1);

  // Reset the cursor when the filters change.
  const filterKey = JSON.stringify(noPr ? branchListParams(s) : prFetchParams(s));
  useEffect(() => { setCursor(-1); }, [filterKey]);
  // Keep the cursor on the open PR, or on the branch whose diff is open.
  const openRow = noPr ? s.diff : s.pr;
  useEffect(() => {
    if (!openRow) return;
    const i = order.findIndex((r) => r.id === openRow);
    if (i >= 0) setCursor(i);
  }, [openRow, order]);

  // Stable identity (reads the open PR through a ref) so memoized rows don't all re-render
  // whenever the drawer opens or moves.
  const openId = useRef(s.pr);
  useLayoutEffect(() => { openId.current = s.pr; });
  const openPr = useCallback((pr: PullRequest) => {
    set({ pr: openId.current === pr.id ? null : pr.id });
  }, [set]);
  // A branch has no details: it opens its diff (its id is the diff's), as the repo page's Branches card does.
  const openBranch = useCallback((b: Pick<Branch, 'id'>) => set({ diff: b.id, file: null, thread: null, only: null }), [set]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasBlockingLayer() || isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey || !order.length) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const next = Math.max(0, Math.min(order.length - 1, cursor + (e.key === 'j' ? 1 : -1)));
        setCursor(next);
        const row = order[next];
        document.querySelector(`article.pr[data-id="${CSS.escape(row.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        if (s.pr && !noPr) set({ pr: row.id }, { replace: true });
      } else if (e.key === 'Enter' && cursor >= 0) {
        // Enter on a focused control (a toolbar button, a link) belongs to that control.
        if ((e.target as Element | null)?.closest?.('button, a[href], input, select, textarea, summary, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="separator"]')) return;
        e.preventDefault();
        if (noPr) openBranch(order[cursor]);
        else set({ pr: order[cursor].id });
      } else if (e.key === 'o' && cursor >= 0) {
        e.preventDefault();
        window.open(order[cursor].url, '_blank', 'noopener');
      } else if (e.key === 'd' && cursor >= 0 && !s.pr) {
        // With details open, the drawer handles `d` (for its PR).
        e.preventDefault();
        if (noPr) openBranch(order[cursor]);
        else set({ diff: order[cursor].id });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [order, cursor, s.pr, noPr, openBranch, set]);

  const data = list.data;
  const total = data?.total ?? 0;
  const nRepos = useMemo(() => new Set((data?.items ?? []).map((i: { repo: string }) => i.repo)).size, [data]);
  const stWord = s.state === 'nopr' ? '' : ST_WORD[s.state];
  const whoWord = WHO_WORD[s.who];
  const fetching = (list.isFetching && !!data) || (relOn && rels.isFetching && !!rels.data);
  const cursorId = cursor >= 0 ? order[cursor]?.id : undefined;
  const what = noPr ? `${plural(total, 'branch', 'branches')} without ${aShort(w)}` : [stWord, plural(total, w.short, w.shortMany)].filter(Boolean).join(' ');
  const summaryRest = `${[what, whoWord].filter(Boolean).join(' ')} · ${nRepos} ${plural(nRepos, 'repo')}`;
  const stateLabel = noPr ? `No ${w.short} yet` : s.state === 'all' ? `All ${w.shortMany}` : s.state[0].toUpperCase() + s.state.slice(1);

  return (
    <main className="main">
      <FilterToolbar summary={[stateLabel, s.who === 'me' ? 'By you' : s.who === 'others' ? 'By others' : 'Everyone', range.text, s.q && `“${s.q}”`].filter(Boolean).join(' · ')}>
        <div className="row">
          <Seg
            value={s.state}
            // The drawer holds a PR's details: no row of the branch list is one.
            onChange={(state) => set(state === 'nopr' ? { state, pr: null } : { state })}
            label={`${w.short} state`}
            options={[
              { value: 'open', label: <><Icon name="prOpen" className="st-open" />Open</> },
              { value: 'merged', label: <><Icon name="merge" className="st-merged" />Merged</> },
              { value: 'closed', label: <><Icon name="prClosed" className="st-closed" />Closed</> },
              { value: 'all', label: 'All' },
              { value: 'nopr', label: <><Icon name="branch" />No {w.short} yet</>, title: `Pushed branches with no ${w.short} yet, or with commits since their last one` },
            ]}
          />
          <Seg value={s.who} onChange={(who) => set({ who })} options={WHO_OPTIONS} label="Author" />
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
          <span className="wb-btn-group">
            {/* Branches are JSON only: the API tab says so. */}
            {!noPr && <button type="button" className="wb-btn" onClick={() => openExport('md')}><Icon name="md" />Markdown</button>}
            <button type="button" className="wb-btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
          </span>
        </div>
        <div className="row">
          <FilterInput value={s.q} onChange={(q) => set({ q }, { replace: true })} placeholder={noPr ? 'Filter by branch name…' : 'Filter by title, description, label…'} />
          <ChipToggle
            type="button"
            style={{ marginLeft: 4 }}
            pressed={s.rel}
            disabled={s.state === 'open' || s.state === 'closed' || noPr}
            title={s.state === 'open' || s.state === 'closed' || noPr ? 'Releases show with Merged or All' : 'Interleave releases'}
            onPressedChange={() => set({ rel: !s.rel })}
          >
            <Icon name="tag" />Releases
          </ChipToggle>
          {/* Local review comments, one chip stepping through: all PRs → with comments → with unresolved ones. */}
          <ChipToggle
            type="button"
            pressed={!!s.comments}
            disabled={noPr}
            title={noPr ? `Comment filters are for ${w.shortMany}` : s.comments === 'any' ? 'PRs with your comments · click for unresolved only' : s.comments === 'unresolved' ? 'PRs with unresolved comments · click for all PRs' : 'Only PRs with your comments'}
            onPressedChange={() => set({ comments: s.comments === null ? 'any' : s.comments === 'any' ? 'unresolved' : null })}
          >
            <Icon name="comment" />{s.comments === 'any' ? 'Commented' : s.comments === 'unresolved' ? 'Unresolved' : 'Comments'}
          </ChipToggle>
          <span className="spacer" />
          <Ctl label="Group">
            <Seg size="sm" value={s.group} onChange={(group) => set({ group })} label="Group by" options={[
              { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'repo', label: 'Repo' },
            ]} />
          </Ctl>
          <Ctl label="Show">
            <Seg<Density> size="sm" value={s.density} onChange={(density) => set({ density })} label="Density" options={[
              { value: 'titles', label: 'Titles' }, { value: 'summary', label: 'Summary' }, { value: 'full', label: 'Full' },
            ]} />
          </Ctl>
        </div>
      </FilterToolbar>

      <div className="scroll" id="scroll">
        <ProgressBar active={fetching} />
        <div className={`list${fetching ? ' stale' : ''}`}>
          {list.isError && !data ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : !data ? (
            <ListSkeleton density={s.density} />
          ) : s.repos?.length === 0 ? (
            <NoReposSelected onSelectAll={() => set({ repos: null })} />
          ) : groups.length === 0 ? (
            <EmptyState
              icon={noPr ? 'fork' : 'merge'}
              title={`No ${noPr ? `branches without ${aShort(w)}` : [stWord, w.shortMany].filter(Boolean).join(' ')}${whoWord ? ` ${whoWord}` : ''} in ${range.phrase}${s.q ? ` matching “${s.q}”` : ''}`}
              actions={
                <div className="wb-empty-actions">
                  {s.range !== '90d' && s.range !== 'ytd' && <button type="button" className="wb-btn" onClick={() => set({ range: '90d' })}>Show last 90 days</button>}
                  {s.who !== 'everyone' && <button type="button" className="wb-btn" onClick={() => set({ who: 'everyone' })}>Show everyone's</button>}
                  {s.q && <button type="button" className="wb-btn" onClick={() => set({ q: '' })}>Clear filter</button>}
                </div>
              }
            >
              {noPr && `Branches come from the sync: a pushed branch shows here until ${aShort(w)} is opened from it. `}
              Try a longer range or select more repositories.
            </EmptyState>
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.key}>
                  <div className="group-h">
                    <span className="gt">{s.group === 'repo' ? <RepoChip repo={g.key} className="repo-ref" /> : g.title}</span>
                    {g.sub && s.group !== 'repo' && <span className="gs">{g.sub}</span>}
                    <span className="rule" />
                    <span className="gc">
                      {noPr
                        ? `${g.branches} ${plural(g.branches, 'branch', 'branches')}`
                        : `${g.prs} ${plural(g.prs, w.short, w.shortMany)}${g.releases ? ` · ${g.releases} ${plural(g.releases, 'release')}` : ''}`}
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
                    ) : it.kind === 'branch' ? (
                      <BranchRow
                        key={it.branch.id}
                        branch={it.branch}
                        density={s.density}
                        cursor={cursorId === it.branch.id}
                        active={s.diff === it.branch.id}
                        onOpen={openBranch}
                      />
                    ) : (
                      <ReleaseRow key={it.release.id} release={it.release} density={s.density} />
                    ),
                  )}
                </section>
              ))}
              {data.nextCursor && (
                <div className="list-note">
                  Showing the {data.items.length.toLocaleString()} most recent of {total.toLocaleString()} {noPr ? 'branches' : w.shortMany}. Narrow the range to see the rest.
                </div>
              )}
              <div className="list-foot">
                <span><kbd>j</kbd> <kbd>k</kbd> move</span>
                {noPr ? <span><kbd>↵</kbd> <kbd>d</kbd> diff</span> : <><span><kbd>↵</kbd> details</span><span><kbd>d</kbd> diff</span></>}
                <span><kbd>o</kbd> {words.host ? `open on ${words.host}` : 'open'}</span>
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
    <EmptyState icon="book" title="No repositories selected" actions={<button type="button" className="wb-btn" onClick={onSelectAll}>Select all</button>}>
      Pick repositories in the sidebar, or choose a set.
    </EmptyState>
  );
}

export function ListSkeleton({ density, rows = 6 }: { density: Density; rows?: number }) {
  return (
    <div className="skel-list" aria-busy="true" aria-label="Loading">
      <div className="group-h"><span className="wb-skel" style={{ width: 120 }} /><span className="rule" /></div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`skel-row${density === 'titles' ? ' t' : ''}`}>
          <i className="wb-skel" style={{ width: 16, height: 16 }} />
          <div>
            <i className="wb-skel" style={{ width: `${55 - (i % 3) * 8}%`, height: 14 }} />
            {density !== 'titles' && <i className="wb-skel" style={{ width: '32%' }} />}
            {density !== 'titles' && <i className="wb-skel" style={{ width: '85%' }} />}
          </div>
        </div>
      ))}
    </div>
  );
}
