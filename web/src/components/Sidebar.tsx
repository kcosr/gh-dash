import { useMemo, useState } from 'react';
import type { Repo } from '../../../shared/api';
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
import { canonicalQuery, encodeParams, useUrlState } from '../lib/urlState';
import { cx } from '../lib/util';
import { Icon } from './Icon';
import { Seg } from './Seg';
import { useToast } from './Toasts';
import { useUI } from './ui';

const ACTIVE_DAYS = 180;

const byActivity = (a: Repo, b: Repo) =>
  (b.lastActivityAt ?? b.pushedAt ?? '').localeCompare(a.lastActivityAt ?? a.pushedAt ?? '') || a.name.localeCompare(b.name);

export function Sidebar() {
  const { s, set, location, navigate } = useUrlState();
  const repos = useRepos();
  const settings = useSettings();
  const sets = useSets();
  const views = useViews();
  const { openPrompt } = useUI();
  const toast = useToast();
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
  const visOk = (r: Repo) => s.vis === 'all' || r.visibility === s.vis;
  const shown = all.filter((r) => visOk(r) && (!fq || r.name.toLowerCase().includes(fq)));
  const pinned = shown.filter((r) => r.pinned).sort(byActivity);
  const rest = shown.filter((r) => !r.pinned).sort(byActivity);
  const cutoff = Date.now() - ACTIVE_DAYS * DAY;
  // Keep repositories with an open backlog visible; stars never promote an inactive repo.
  const isMain = (r: Repo) =>
    !r.isArchived && !r.hidden && (!r.isFork || includeForks) &&
    ((!!r.lastActivityAt && Date.parse(r.lastActivityAt) >= cutoff) || r.stats.openPrs > 0 || r.stats.openIssues > 0);
  const main = fq ? rest : rest.filter(isMain);
  const inactive = fq ? [] : rest.filter((r) => !isMain(r));
  const nSel = shown.filter((r) => selected.has(r.name)).length;

  /** Write an explicit selection; collapse back to "default scope" when it matches it. */
  const select = (names: Iterable<string>) => {
    const list = [...new Set(names)].filter((n) => all.some((r) => r.name === n)).sort();
    const isDefault = list.length === scope.length && scope.every((n) => list.includes(n));
    set({ repos: isDefault ? null : list });
  };
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    select(next);
  };

  const sameSel = (names: string[]) => {
    const valid = names.filter((n) => all.some((r) => r.name === n));
    return valid.length === selected.size && valid.every((n) => selected.has(n));
  };
  const curQuery = canonicalQuery(location.search);

  const newSet = () => {
    if (!selected.size) { toast('Select some repositories first'); return; }
    openPrompt({
      title: 'New set',
      label: 'Name',
      placeholder: 'e.g. Side projects',
      hint: `${selected.size} selected ${selected.size === 1 ? 'repository' : 'repositories'}`,
      submitLabel: 'Create set',
      onSubmit: (name) => createSet.mutateAsync({ name, repos: [...selected].sort() }).then(() => toast(`Set “${name}” created`)),
    });
  };
  const saveView = () => {
    const query = encodeParams([...new URLSearchParams(location.search)].filter(([k]) => k !== 'pr'));
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
    const on = selected.has(r.name);
    return (
      <div key={r.name} className={cx('repo-item', on && 'on')}>
        <label className="repo-check-hit" title={`Include ${r.name} in selection`}>
          <input
            type="checkbox"
            className="repo-check"
            checked={on}
            aria-label={`Include ${r.name}`}
            aria-describedby={`repo-info-${r.name}`}
            onChange={() => toggle(r.name)}
          />
        </label>
        <button
          type="button"
          className="repo-select"
          aria-label={`Filter to ${r.name}`}
          aria-describedby={`repo-info-${r.name}`}
          title={`Filter to ${r.name}${r.description ? ` · ${r.description}` : ''}`}
          onClick={() => set({ repos: [r.name] })}
        >
          <span className="rname">{r.name}</span>
          {r.visibility === 'private' && <span className="lk" title="Private"><Icon name="lock" /></span>}
          {r.isArchived && <span className="arch">archived</span>}
          {!r.isArchived && r.hidden && <span className="arch">hidden</span>}
          {!r.isArchived && !r.hidden && r.isFork && <span className="arch">fork</span>}
          <span className="repo-counts" aria-hidden="true">
            <span title={`${r.stats.openPrs} open pull requests`}>
              <Icon name="prOpen" />{r.stats.openPrs.toLocaleString()}
            </span>
            <span title={`${r.stats.openIssues} open issues`}>
              <Icon name="issue" />{r.stats.openIssues.toLocaleString()}
            </span>
          </span>
        </button>
        <span className="sr-only" id={`repo-info-${r.name}`}>
          {r.visibility === 'private' ? 'Private. ' : ''}{r.isArchived ? 'Archived. ' : ''}
          {r.hidden ? 'Hidden. ' : ''}{r.isFork ? 'Fork. ' : ''}
          {r.stats.openPrs} open pull requests, {r.stats.openIssues} open issues.
        </span>
      </div>
    );
  };

  return (
    <aside className="sidebar" id="repository-sidebar" aria-label="Repository scope">
      <div className="side-top">
        <label className="field">
          <Icon name="search" />
          <input id="repoQ" placeholder="Filter repositories" value={filter} autoComplete="off" onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
        </label>
        <Seg
          className="full"
          value={s.vis}
          onChange={(vis) => set({ vis })}
          ariaLabel="Visibility"
          options={[
            { value: 'all', label: 'All' },
            { value: 'public', label: 'Public' },
            { value: 'private', label: <><Icon name="lock" />Private</> },
          ]}
        />
        <div className="side-quick">
          <button type="button" onClick={() => set({ repos: null })} title="Default scope: everything except archived, hidden and forks">All</button>
          <button type="button" onClick={() => set({ repos: [] })}>None</button>
          <button type="button" onClick={() => select(all.filter((r) => r.pinned).map((r) => r.name))}>Pinned</button>
          <span className="spacer" />
          <span className="muted">{nSel} of {shown.length} selected</span>
        </div>
      </div>

      {repos.isPending && <div className="side-skel">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div>}

      {pinned.length > 0 && (
        <>
          <div className="side-h"><span>Pinned</span><span className="note">Open PRs / issues</span></div>
          {pinned.map(item)}
        </>
      )}
      {!repos.isPending && (
        <>
          <div className="side-h"><span>Repositories</span>{!pinned.length && <span className="note">Open PRs / issues</span>}</div>
          {main.map(item)}
          {!main.length && !inactive.length && <div className="side-empty">No matching repositories</div>}
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
          title={st.repos.join(', ')}
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
        const go = () => navigate(`${v.path}${v.query ? `?${v.query}` : ''}`);
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
