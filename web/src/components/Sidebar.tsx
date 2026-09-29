import { useMemo, useState } from 'react';
import type { Ownership, Repo, VisibilityFilter } from '../../../shared/api';
import { repoProvider } from '../../../shared/provider';
import {
  defaultScope,
  useCreateSet,
  useCreateView,
  useDeleteSet,
  useDeleteView,
  useRepos,
  useSets,
  useSettings,
  useViews,
} from '../api/hooks';
import { DAY } from '../lib/time';
import { OVERLAY_KEYS, canonicalQuery, encodeParams, passesRepoFilters, useUrlState } from '../lib/urlState';
import { cx } from '../lib/util';
import { Icon } from './Icon';
import { MenuButton } from './Menu';
import { RepoName } from './RepoName';
import { useRepoLabel, useWords } from './repoMapContext';
import { Seg } from './Seg';
import { useToast } from './Toasts';
import { useUI } from './ui';

const ACTIVE_DAYS = 180;

const VIS_LABEL: Record<VisibilityFilter, string> = { all: 'Any', public: 'Public', private: 'Private', internal: 'Internal' };

const OWN_OPTIONS: { value: Ownership; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'All tracked repositories' },
  { value: 'mine', label: 'Mine', title: 'Repositories you own (tracked automatically)' },
  { value: 'others', label: 'Others', title: 'Repositories of other owners that you added' },
];

/** Visibility filter (`vis=`): a small menu next to the search box, with an accent dot while it narrows the list. */
function VisibilityMenu({ value, onChange, counts }: {
  value: VisibilityFilter;
  onChange: (v: VisibilityFilter) => void;
  /** Repos per visibility (after the ownership filter); Internal is offered only when some repo is internal. */
  counts: Record<VisibilityFilter, number>;
}) {
  const opts: VisibilityFilter[] = ['all', 'public', 'private', ...(counts.internal || value === 'internal' ? ['internal' as const] : [])];
  const what = `Visibility: ${VIS_LABEL[value]}`;
  return (
    <MenuButton className={cx('side-vis', value !== 'all' && 'on')} label={what} title={what} menuLabel="Visibility" menuClass="vis-menu" width={180}
      button={<><Icon name="filter" />{value !== 'all' && <i className="dot" aria-hidden="true" />}</>}>
      {(close) => opts.map((v) => (
        <button key={v} type="button" role="menuitemradio" aria-checked={v === value} className={cx('opt', v === value && 'on')}
          onClick={() => { close(); onChange(v); }}>
          <span className="ck">{v === value && <Icon name="check" />}</span>
          {VIS_LABEL[v]}
          <span className="spacer" />
          <span className="hint">{counts[v].toLocaleString()}</span>
        </button>
      ))}
    </MenuButton>
  );
}

const byActivity = (a: Repo, b: Repo) =>
  (b.lastActivityAt ?? b.pushedAt ?? '').localeCompare(a.lastActivityAt ?? a.pushedAt ?? '') || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { s, set, location, navigate } = useUrlState();
  const repos = useRepos();
  const settings = useSettings();
  const sets = useSets();
  const views = useViews();
  const { openPrompt, openAddRepo } = useUI();
  const toast = useToast();
  const label = useRepoLabel();
  const w = useWords().pr;
  const createSet = useCreateSet();
  const deleteSet = useDeleteSet();
  const createView = useCreateView();
  const deleteView = useDeleteView();

  const [filter, setFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const all = repos.data ?? [];
  const scope = useMemo(() => defaultScope(all, settings.data), [all, settings.data]);
  const selected = useMemo(() => new Set(s.repos ?? scope), [s.repos, scope]);
  const includeForks = !!settings.data?.includeForks;

  const fq = filter.trim().toLowerCase();
  const visCounts = useMemo(() => {
    const counts: Record<VisibilityFilter, number> = { all: 0, public: 0, private: 0, internal: 0 };
    for (const r of all) if (passesRepoFilters(r, { vis: 'all', own: s.own })) { counts.all++; counts[r.visibility]++; }
    return counts;
  }, [all, s.own]);
  const shown = all.filter((r) => passesRepoFilters(r, s) && (!fq || r.key.toLowerCase().includes(fq)));
  const pinned = shown.filter((r) => r.pinned).sort(byActivity);
  const rest = shown.filter((r) => !r.pinned).sort(byActivity);
  const cutoff = Date.now() - ACTIVE_DAYS * DAY;
  // Keep repositories with an open backlog visible; stars never promote an inactive repo.
  const isMain = (r: Repo) =>
    !r.isArchived && !r.hidden && (!r.isFork || includeForks) &&
    ((!!r.lastActivityAt && Date.parse(r.lastActivityAt) >= cutoff) || r.stats.openPrs > 0 || r.stats.openIssues > 0);
  const main = fq ? rest : rest.filter(isMain);
  const inactive = fq ? [] : rest.filter((r) => !isMain(r));
  const nSel = shown.filter((r) => selected.has(r.key)).length;
  /** The selection as the lists see it: the visibility and ownership filters apply on top of `repos=`. */
  const inScope = all.filter((r) => selected.has(r.key) && passesRepoFilters(r, s)).map((r) => r.key);
  const noOthers = s.own === 'others' && !all.some((r) => r.trackedBy !== 'owned');

  /** Write an explicit selection of repo keys; collapse back to the default selection when it matches it. */
  const select = (keys: Iterable<string>) => {
    const list = [...new Set(keys)].filter((k) => all.some((r) => r.key === k)).sort();
    const isDefault = list.length === scope.length && scope.every((k) => list.includes(k));
    set({ repos: isDefault ? null : list });
  };
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    select(next);
  };

  const sameSel = (keys: string[]) => {
    const valid = keys.filter((k) => all.some((r) => r.key === k));
    return valid.length === selected.size && valid.every((k) => selected.has(k));
  };
  const curQuery = canonicalQuery(location.search);

  const newSet = () => {
    if (!inScope.length) { toast('Select some repositories first'); return; }
    openPrompt({
      title: 'New set',
      label: 'Name',
      placeholder: 'e.g. Side projects',
      hint: `${inScope.length} selected ${inScope.length === 1 ? 'repository' : 'repositories'}`,
      submitLabel: 'Create set',
      onSubmit: (name) => createSet.mutateAsync({ name, repos: [...inScope].sort() }).then(() => toast(`Set “${name}” created`)),
    });
  };
  const saveView = () => {
    const query = encodeParams([...new URLSearchParams(location.search)].filter(([k]) => !OVERLAY_KEYS.includes(k)));
    openPrompt({
      title: 'Save view',
      label: 'Name',
      placeholder: 'e.g. What I shipped · 30 days',
      hint: <code>{location.pathname}{query ? `?${query}` : ''}</code>,
      submitLabel: 'Save view',
      onSubmit: (name) => createView.mutateAsync({ name, path: location.pathname, query }).then(() => toast(`View “${name}” saved`)),
    });
  };

  const item = (r: Repo) => {
    const on = selected.has(r.key);
    const name = label(r.key);
    const syncing = r.syncedAt === null && !r.unavailable;
    const openPrs = `${r.stats.openPrs} open ${repoProvider(r).pr.many}`;
    const description = [
      r.visibility === 'private' ? 'Private' : r.visibility === 'internal' ? 'Internal' : '',
      r.unavailable ? `Unavailable: ${r.unavailable.reason}` : '', syncing ? 'Syncing' : '',
      r.isArchived ? 'Archived' : '', r.hidden ? 'Hidden' : '', r.isFork ? 'Fork' : '',
      r.stats.openPrs > 0 ? openPrs : '',
      r.stats.openIssues > 0 ? `${r.stats.openIssues} open issues` : '',
    ].filter(Boolean).join('. ');
    const describedBy = description ? `repo-info-${r.key}` : undefined;
    return (
      <div key={r.key} className={cx('repo-item', on && 'on')}>
        <label className="repo-check-hit" title={`Include ${name} in selection`}>
          <input
            type="checkbox"
            className="repo-check"
            checked={on}
            aria-label={`Include ${name}`}
            aria-describedby={describedBy}
            onChange={() => toggle(r.key)}
          />
        </label>
        <button
          type="button"
          className="repo-select"
          aria-label={`Filter to ${name}`}
          aria-describedby={describedBy}
          title={`Filter to ${name}${r.description ? ` · ${r.description}` : ''}`}
          onClick={() => { set({ repos: [r.key], ...(onNavigate ? { pr: null, diff: null } : {}) }); onNavigate?.(); }}
        >
          <span className="repo-name">
            <RepoName repo={r.key} className="rname" />
            {r.visibility === 'private' && <span className="lk" title="Private"><Icon name="lock" /></span>}
            {r.visibility === 'internal' && <span className="lk" title="Internal"><Icon name="lock" /></span>}
          </span>
          {r.unavailable && <span className="arch" title={r.unavailable.reason}><Icon name="alert" />unavailable</span>}
          {syncing && <span className="arch">syncing…</span>}
          {!r.unavailable && !syncing && r.isArchived && <span className="arch">archived</span>}
          {!r.unavailable && !syncing && !r.isArchived && r.hidden && <span className="arch">hidden</span>}
          {!r.unavailable && !syncing && !r.isArchived && !r.hidden && r.isFork && <span className="arch">fork</span>}
          {(r.stats.openPrs > 0 || r.stats.openIssues > 0) && <span className="repo-counts" aria-hidden="true">
            {r.stats.openPrs > 0 && <span title={openPrs}>
              <Icon name="prOpen" />{r.stats.openPrs.toLocaleString()}
            </span>}
            {r.stats.openIssues > 0 && <span title={`${r.stats.openIssues} open issues`}>
              <Icon name="issue" />{r.stats.openIssues.toLocaleString()}
            </span>}
          </span>}
        </button>
        {description && <span className="sr-only" id={describedBy}>{description}</span>}
      </div>
    );
  };

  return (
    <aside className="sidebar" id="repository-sidebar" aria-label="Repository scope">
      <div className="side-top">
        <div className="side-search">
          <label className="field">
            <Icon name="search" />
            <input id="repoQ" placeholder="Filter repositories" value={filter} autoComplete="off" onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
          </label>
          <VisibilityMenu value={s.vis} onChange={(vis) => set({ vis })} counts={visCounts} />
        </div>
        <Seg className="full" value={s.own} onChange={(own) => set({ own })} ariaLabel="Ownership" options={OWN_OPTIONS} />
        <div className="side-quick">
          <button type="button" onClick={() => set({ repos: null })} title="Default selection: everything except archived, hidden and forks">All</button>
          <button type="button" onClick={() => set({ repos: [] })}>None</button>
          <button type="button" onClick={() => select(all.filter((r) => r.pinned).map((r) => r.key))}>Pinned</button>
          <span className="spacer" />
          <span className="muted">{nSel} of {shown.length} selected</span>
        </div>
      </div>

      {repos.isPending && <div className="side-skel">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div>}

      {pinned.length > 0 && (
        <>
          <div className="side-h"><span>Pinned</span><span className="note">Open {w.shortMany} / issues</span></div>
          {pinned.map(item)}
        </>
      )}
      {!repos.isPending && (
        <>
          <div className="side-h">
            <span>Repositories</span>
            {!pinned.length && <span className="note">Open {w.shortMany} / issues</span>}
            <button type="button" className="mini" title="Add a repository" aria-label="Add repository" onClick={openAddRepo}>+</button>
          </div>
          {main.map(item)}
          {noOthers ? (
            <div className="side-empty">
              No repositories from other owners.{' '}
              <button type="button" className="side-link" onClick={openAddRepo}>Add repository</button>
            </div>
          ) : !main.length && !inactive.length && <div className="side-empty">No matching repositories</div>}
          {inactive.length > 0 && (
            <>
              <button type="button" className="side-more" onClick={() => setShowInactive((v) => !v)} aria-expanded={showInactive}>
                <Icon name={showInactive ? 'chevron' : 'chevronRight'} />
                {showInactive ? 'Hide' : 'Show'} {inactive.length} inactive
              </button>
              {showInactive && inactive.map(item)}
            </>
          )}
        </>
      )}

      <div className="side-h">
        <span>Sets</span>
        <button type="button" className="mini" title="New set from selection" aria-label="New set from selection" onClick={newSet}>+</button>
      </div>
      {(sets.data ?? []).map((st) => (
        <div
          key={st.id}
          className={cx('set-item', sameSel(st.repos) && 'on')}
          role="button"
          tabIndex={0}
          onClick={() => select(st.repos)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(st.repos); } }}
          title={st.repos.map(label).join(', ')}
        >
          <Icon name="layers" />
          <span>{st.name}</span>
          <span className="count">{st.repos.length}</span>
          <button
            type="button"
            className="del"
            title={`Delete set “${st.name}”`}
            aria-label={`Delete set ${st.name}`}
            onClick={(e) => { e.stopPropagation(); deleteSet.mutate(st.id, { onSuccess: () => toast(`Deleted set “${st.name}”`) }); }}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
      {sets.data && !sets.data.length && <div className="side-empty">Select repos, then + to save a set</div>}

      <div className="side-h">
        <span>Saved views</span>
        <button type="button" className="mini" title="Save current filters as a view" aria-label="Save current view" onClick={saveView}>+</button>
      </div>
      {(views.data ?? []).map((v) => {
        const on = v.path === location.pathname && canonicalQuery(v.query) === curQuery;
        const go = () => { navigate(`${v.path}${v.query ? `?${v.query}` : ''}`); onNavigate?.(); };
        return (
          <div
            key={v.id}
            className={cx('set-item', on && 'on')}
            role="link"
            tabIndex={0}
            onClick={go}
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
            title={`${v.path}${v.query ? `?${v.query}` : ''}`}
          >
            <Icon name="bookmark" />
            <span>{v.name}</span>
            <button
              type="button"
              className="del"
              title={`Delete view “${v.name}”`}
              aria-label={`Delete view ${v.name}`}
              onClick={(e) => { e.stopPropagation(); deleteView.mutate(v.id, { onSuccess: () => toast(`Deleted view “${v.name}”`) }); }}
            >
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      {views.data && !views.data.length && <div className="side-empty">+ saves the current filters</div>}
    </aside>
  );
}
