import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { Repo, RepoSet } from '../../../shared/api';
import { repoPath, selectRepos } from '../../../shared/repos';
import { repoListParams } from '../lib/apiQuery';
import { usePatchRepo, useRepos, useSets, useSettings } from '../api/hooks';
import { Sparkline } from '../charts';
import { Ctl } from '../components/bits';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { FilterInput } from '../components/FilterInput';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Menu';
import { UnavailableNote, useConfirmRemoveRepo } from '../components/RepoTracking';
import { RepoName } from '../components/RepoName';
import { useRepoLabel } from '../components/repoMapContext';
import { Seg } from '../components/Seg';
import { useToast } from '../components/Toasts';
import { useSyncNow } from '../components/TopBar';
import { useUI } from '../components/ui';
import { addDays, fmtDate, rel, startOfWeek } from '../lib/time';
import { carrySearch, encodeParams, useUrlState } from '../lib/urlState';
import type { RepoLayout, RepoSort } from '../lib/urlState';
import { cx } from '../lib/util';

const last = (r: Repo) => r.lastActivityAt ?? r.pushedAt ?? r.createdAt;

/** Week-start titles for the 12-week sparkline (oldest first; last = this week). */
function weekTitles(): string[] {
  const w0 = startOfWeek(new Date());
  return Array.from({ length: 12 }, (_, i) => `Week of ${fmtDate(addDays(w0, -7 * (11 - i)))}`);
}

export function RepositoriesView() {
  const { s, set, location } = useUrlState();
  const search = carrySearch(location.search);
  const repos = useRepos();
  const settings = useSettings();
  const sets = useSets();
  const { openExport, openAddRepo } = useUI();
  const titles = useMemo(weekTitles, []);
  const setById = useMemo(() => new Map((sets.data ?? []).map((x) => [x.id, x])), [sets.data]);

  const list = selectRepos(repos.data ?? [], repoListParams(s), settings.data?.includeForks);
  const nPinned = list.filter((r) => r.pinned).length;

  return (
    <main className="main tint">
      <FilterToolbar summary={[`${list.length} repositories`, s.q && `“${s.q}”`].filter(Boolean).join(' · ')}>
        <div className="row">
          <FilterInput value={s.q} onChange={(v) => set({ q: v }, { replace: true })} placeholder="Search repositories" />
          <Ctl label="Sort">
            <Seg<RepoSort> className="sm" value={s.sort} onChange={(sort) => set({ sort })} ariaLabel="Sort" options={[
              { value: 'activity', label: 'Recent activity' }, { value: 'stars', label: 'Stars' }, { value: 'open', label: 'Open PRs' }, { value: 'name', label: 'Name' },
            ]} />
          </Ctl>
          <span className="summary">{list.length} {list.length === 1 ? 'repository' : 'repositories'} · {nPinned} pinned</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={openAddRepo}><Icon name="plus" />Add repository</button>
          <button type="button" className="btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
          <Seg<RepoLayout> className="sm" value={s.layout} onChange={(layout) => set({ layout })} ariaLabel="Layout" options={[
            { value: 'grid', label: <Icon name="grid" title="Cards" /> }, { value: 'list', label: <Icon name="list" title="Table" /> },
          ]} />
        </div>
      </FilterToolbar>
      <div className="scroll" id="scroll">
        <ProgressBar active={repos.isFetching && !!repos.data} />
        {repos.isError && !repos.data ? (
          <ErrorNote error={repos.error} onRetry={() => repos.refetch()} />
        ) : settings.isError && !settings.data ? (
          <ErrorNote error={settings.error} onRetry={() => settings.refetch()} />
        ) : !repos.data || !settings.data ? (
          <div className="repo-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="rcard skel-card" />)}</div>
        ) : list.length === 0 && s.own === 'others' && !repos.data.some((r) => r.trackedBy !== 'owned') ? (
          <EmptyState icon="book" title="No repositories from other owners" action={
            <button type="button" className="btn" onClick={openAddRepo}><Icon name="plus" />Add repository</button>
          }>Repositories you own are tracked automatically. Add others, such as an organization's or a project you contribute to.</EmptyState>
        ) : list.length === 0 ? (
          <EmptyState icon="book" title={s.repos?.length === 0 ? 'No repositories selected' : 'No repositories match'} action={
            <div className="empty-actions">
              {s.q && <button type="button" className="btn" onClick={() => set({ q: '' })}>Clear search</button>}
              {s.repos !== null && <button type="button" className="btn" onClick={() => set({ repos: null })}>Select default repositories</button>}
            </div>
          }>Choose repositories in the sidebar, or change the ownership or visibility filter.</EmptyState>
        ) : s.layout === 'grid' ? (
          <div className="repo-grid">
            {list.map((r) => <RepoCard key={r.key} repo={r} search={search} sets={r.setIds.map((id) => setById.get(id)).filter((x): x is RepoSet => !!x)} titles={titles} />)}
          </div>
        ) : (
          <RepoTable list={list} titles={titles} search={search} />
        )}
      </div>
    </main>
  );
}

function PinButton({ repo }: { repo: Repo }) {
  const patch = usePatchRepo();
  const label = useRepoLabel()(repo.key);
  return (
    <button
      type="button"
      className={cx('pin-btn', repo.pinned && 'on')}
      title={repo.pinned ? 'Unpin' : 'Pin to the top of the sidebar'}
      aria-pressed={repo.pinned}
      aria-label={repo.pinned ? `Unpin ${label}` : `Pin ${label}`}
      onClick={() => patch.mutate({ key: repo.key, patch: { pinned: !repo.pinned } })}
    >
      <Icon name="pin" />
    </button>
  );
}

function RepoMenu({ repo }: { repo: Repo }) {
  const patch = usePatchRepo();
  const toast = useToast();
  const sync = useSyncNow();
  const confirmRemove = useConfirmRemoveRepo();
  const label = useRepoLabel()(repo.key);
  const toggleHidden = () => {
    // Hiding a default-scope card unmounts this component before the mutation completes.
    void patch.mutateAsync({ key: repo.key, patch: { hidden: !repo.hidden } }).then(() => {
      toast(repo.hidden ? `${label} is back in the default scope`
        : `${label} hidden. To unhide, find it with the sidebar search, select it, then open its menu.`, { ms: 6000 });
    }).catch((error: Error) => toast(`Couldn't update ${label}: ${error.message}`, { error: true }));
  };
  return (
    <MenuButton className="pin-btn" label={`More actions for ${label}`} title="More" button={<Icon name="dots" />} menuLabel={`Actions for ${label}`}>
      {(close) => {
        const act = (fn: () => void) => () => { close(); fn(); };
        return (
          <>
            <button type="button" role="menuitem" className="opt" onClick={act(() => patch.mutate({ key: repo.key, patch: { pinned: !repo.pinned } }))}>
              <span className="ck"><Icon name="pin" /></span>{repo.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button type="button" role="menuitem" className="opt" onClick={act(toggleHidden)}>
              <span className="ck"><Icon name={repo.hidden ? 'eye' : 'eyeOff'} /></span>{repo.hidden ? 'Unhide' : 'Hide from default scope'}
            </button>
            {/* For a repo added by hand this also checks again whether the token can read it. */}
            <button type="button" role="menuitem" className="opt" onClick={act(() => sync.run({ repo: repo.key }))}>
              <span className="ck"><Icon name="sync" /></span>Sync now
            </button>
            <Link role="menuitem" className="opt" to={`/activity?${encodeParams([['repos', repo.key]])}`} onClick={close}>
              <span className="ck"><Icon name="pulse" /></span>Activity in this repo
            </Link>
            <a role="menuitem" className="opt" href={repo.url} target="_blank" rel="noopener noreferrer" onClick={close}>
              <span className="ck"><Icon name="ext" /></span>Open on GitHub
            </a>
            {repo.trackedBy === 'manual' && (
              <>
                <div className="menu-sep" role="separator" />
                <button type="button" role="menuitem" className="opt" onClick={act(() => confirmRemove(repo))}>
                  <span className="ck"><Icon name="trash" /></span>Remove…
                </button>
              </>
            )}
          </>
        );
      }}
    </MenuButton>
  );
}

function VisBadge({ repo }: { repo: Repo }) {
  // No "Unavailable" badge: the card says so in its note (UnavailableNote), where the reason and the actions are.
  return (
    <>
      <span className="vis-badge">{repo.visibility === 'private' ? <><Icon name="lock" />Private</> : repo.visibility === 'internal' ? <><Icon name="lock" title="Internal" />Internal</> : 'Public'}</span>
      {!repo.unavailable && repo.syncedAt === null && <span className="vis-badge">Syncing…</span>}
      {repo.isArchived && <span className="vis-badge">Archived</span>}
      {repo.isFork && <span className="vis-badge"><Icon name="fork" />Fork</span>}
      {repo.hidden && <span className="vis-badge">Hidden</span>}
    </>
  );
}

function RepoCard({ repo: r, sets, titles, search }: { repo: Repo; sets: RepoSet[]; titles: string[]; search: string }) {
  const st = r.stats;
  const label = useRepoLabel()(r.key);
  return (
    <div className={cx('rcard', (r.isArchived || r.hidden) && 'archived')}>
      <div className="rc-h">
        <Link className="rc-name" to={`${repoPath(r.key)}${search}`} title={label}><RepoName repo={r.key} /></Link>
        <VisBadge repo={r} />
        <span className="spacer" />
        <PinButton repo={r} />
        <RepoMenu repo={r} />
      </div>
      {r.unavailable ? <UnavailableNote repo={r} compact /> : <p className="rc-desc">{r.description ?? <span className="muted">No description</span>}</p>}
      <div className="rc-stats">
        {r.language && <span><i className="lang" style={{ '--lc': r.language.color ?? 'var(--muted)' } as CSSProperties} />{r.language.name}</span>}
        {r.visibility === 'public' && (
          <span title="Stars (new in the last 30 days)"><Icon name="star" />{r.stars.toLocaleString()}{st.newStars30d > 0 && r.trackedBy === 'owned' && <em>+{st.newStars30d}</em>}</span>
        )}
        <span title="Open pull requests"><Icon name="prOpen" />{st.openPrs} open</span>
        <span title="Merged in the last 30 days"><Icon name="merge" />{st.mergedPrs30d} merged</span>
      </div>
      <div className="rc-spark">
        <Sparkline values={st.weeklyCommits} titles={titles} unit="commits" width={168} height={28} focusable={false} ariaLabel={`${label}: commits per week, last 12 weeks`} />
        <span className="l">commits · 12 wk</span>
      </div>
      <div className="rc-foot">
        <span title={last(r)}>Updated {rel(last(r))}</span>
        <span className="spacer" />
        {sets.map((x) => <span key={x.id} className="set-chip">{x.name}</span>)}
      </div>
    </div>
  );
}

function RepoTable({ list, titles, search }: { list: Repo[]; titles: string[]; search: string }) {
  const label = useRepoLabel();
  return (
    <div className="rtable-wrap">
      <table className="rtable">
        <thead>
          <tr>
            <th>Repository</th><th>Visibility</th><th>Language</th><th className="r">Stars</th><th className="r">Open PRs</th>
            <th className="r">Merged · 30d</th><th className="r">Commits · 30d</th><th>Updated</th><th>Commits · 12 wk</th><th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.key} className={cx((r.isArchived || r.hidden) && 'dim')}>
              <td><Link to={`${repoPath(r.key)}${search}`} title={label(r.key)}><RepoName repo={r.key} /></Link>{r.pinned && <span className="pin-mark" title="Pinned"><Icon name="pin" /></span>}</td>
              <td title={r.unavailable?.reason}>{r.visibility === 'private' ? 'Private' : r.visibility === 'internal' ? 'Internal' : 'Public'}{r.unavailable ? ' · unavailable' : r.syncedAt === null ? ' · syncing…' : ''}{r.isArchived ? ' · archived' : ''}{r.isFork ? ' · fork' : ''}{r.hidden ? ' · hidden' : ''}</td>
              <td>{r.language ? <><i className="lang" style={{ '--lc': r.language.color ?? 'var(--muted)' } as CSSProperties} /> {r.language.name}</> : '—'}</td>
              <td className="r">{r.visibility === 'public' ? <>{r.stars.toLocaleString()}{r.stats.newStars30d > 0 && r.trackedBy === 'owned' && <em className="plus"> +{r.stats.newStars30d}</em>}</> : '—'}</td>
              <td className="r">{r.stats.openPrs}</td>
              <td className="r">{r.stats.mergedPrs30d}</td>
              <td className="r">{r.stats.commits30d}</td>
              <td title={last(r)}>{rel(last(r))}</td>
              <td><Sparkline values={r.stats.weeklyCommits} titles={titles} unit="commits" width={120} height={18} focusable={false} ariaLabel={`${label(r.key)}: commits per week, last 12 weeks`} /></td>
              <td className="acts"><PinButton repo={r} /><RepoMenu repo={r} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
