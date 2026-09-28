import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { Repo, RepoSet } from '../../../shared/api';
import { usePatchRepo, useRepos, useSets } from '../api/hooks';
import { Sparkline } from '../charts';
import { Ctl } from '../components/bits';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { FilterInput } from '../components/FilterInput';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { Seg } from '../components/Seg';
import { useToast } from '../components/Toasts';
import { useUI } from '../components/ui';
import { useLayer } from '../lib/layers';
import { addDays, fmtDate, rel, startOfWeek } from '../lib/time';
import { useUrlState } from '../lib/urlState';
import type { RepoLayout, RepoSort } from '../lib/urlState';
import { cx } from '../lib/util';

const last = (r: Repo) => r.lastActivityAt ?? r.pushedAt ?? r.createdAt;

const SORTERS: Record<RepoSort, (a: Repo, b: Repo) => number> = {
  activity: (a, b) => last(b).localeCompare(last(a)),
  stars: (a, b) => b.stars - a.stars,
  open: (a, b) => b.stats.openPrs - a.stats.openPrs,
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Week-start titles for the 12-week sparkline (oldest first; last = this week). */
function weekTitles(): string[] {
  const w0 = startOfWeek(new Date());
  return Array.from({ length: 12 }, (_, i) => `Week of ${fmtDate(addDays(w0, -7 * (11 - i)))}`);
}

export function RepositoriesView() {
  const { s, set } = useUrlState();
  const repos = useRepos();
  const sets = useSets();
  const { openExport } = useUI();
  const titles = useMemo(weekTitles, []);
  const setById = useMemo(() => new Map((sets.data ?? []).map((x) => [x.id, x])), [sets.data]);

  const q = s.q.trim().toLowerCase();
  const all = repos.data ?? [];
  const list = all
    .filter((r) => (s.vis === 'all' || r.visibility === s.vis)
      && (s.archived || !r.isArchived)
      && (s.forks || !r.isFork)
      && (!q || `${r.name} ${r.description ?? ''} ${r.topics.join(' ')} ${r.language?.name ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.hidden) - Number(b.hidden) || SORTERS[s.sort](a, b) || a.name.localeCompare(b.name));
  const nPinned = list.filter((r) => r.pinned).length;
  const nArchived = all.filter((r) => r.isArchived).length;
  const nForks = all.filter((r) => r.isFork).length;

  return (
    <main className="main tint">
      <FilterToolbar summary={[`${list.length} repositories`, s.q && `“${s.q}”`, s.archived && 'Including archived', s.forks && 'Including forks'].filter(Boolean).join(' · ')}>
        <div className="row">
          <FilterInput value={s.q} onChange={(v) => set({ q: v }, { replace: true })} placeholder="Search repositories" />
          <Seg value={s.vis} onChange={(vis) => set({ vis })} ariaLabel="Visibility" options={[
            { value: 'all', label: 'All' }, { value: 'public', label: 'Public' }, { value: 'private', label: <><Icon name="lock" />Private</> },
          ]} />
          <Ctl label="Sort">
            <Seg<RepoSort> className="sm" value={s.sort} onChange={(sort) => set({ sort })} ariaLabel="Sort" options={[
              { value: 'activity', label: 'Recent activity' }, { value: 'stars', label: 'Stars' }, { value: 'open', label: 'Open PRs' }, { value: 'name', label: 'Name' },
            ]} />
          </Ctl>
          <button type="button" className={`chip-toggle${s.archived ? ' on' : ''}`} aria-pressed={s.archived} onClick={() => set({ archived: !s.archived })}>
            Show archived{nArchived ? <span className="n">{nArchived}</span> : null}
          </button>
          <button type="button" className={`chip-toggle${s.forks ? ' on' : ''}`} aria-pressed={s.forks} onClick={() => set({ forks: !s.forks })}>
            Show forks{nForks ? <span className="n">{nForks}</span> : null}
          </button>
          <span className="summary">{list.length} {list.length === 1 ? 'repository' : 'repositories'} · {nPinned} pinned</span>
          <span className="spacer" />
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
        ) : !repos.data ? (
          <div className="repo-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="rcard skel-card" />)}</div>
        ) : list.length === 0 ? (
          <EmptyState icon="book" title="No repositories match">Try clearing the search or showing archived and forked repositories.</EmptyState>
        ) : s.layout === 'grid' ? (
          <div className="repo-grid">
            {list.map((r) => <RepoCard key={r.name} repo={r} sets={r.setIds.map((id) => setById.get(id)).filter((x): x is RepoSet => !!x)} titles={titles} />)}
          </div>
        ) : (
          <RepoTable list={list} titles={titles} />
        )}
      </div>
    </main>
  );
}

function PinButton({ repo }: { repo: Repo }) {
  const patch = usePatchRepo();
  return (
    <button
      type="button"
      className={cx('pin-btn', repo.pinned && 'on')}
      title={repo.pinned ? 'Unpin' : 'Pin to the top of the sidebar'}
      aria-pressed={repo.pinned}
      aria-label={repo.pinned ? `Unpin ${repo.name}` : `Pin ${repo.name}`}
      onClick={() => patch.mutate({ name: repo.name, patch: { pinned: !repo.pinned } })}
    >
      <Icon name="pin" />
    </button>
  );
}

function RepoMenu({ repo }: { repo: Repo }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const patch = usePatchRepo();
  const toast = useToast();
  // The menu is portaled to the end of <body>: move focus into it on open (arrow keys move between
  // items) and back to the trigger on close, or keyboard users could never reach its items.
  const close = () => { setOpen(false); btn.current?.focus({ preventScroll: true }); };
  useLayer(open, close);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('.opt')?.focus(); }, [open]);
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Continue normal tab order from the trigger when leaving the portaled menu.
    if (e.key === 'Tab') { close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('.opt') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const r = btn.current?.getBoundingClientRect();
  const act = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <button ref={btn} type="button" className="pin-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`More actions for ${repo.name}`} title="More" onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" />
      </button>
      {open && r && createPortal(
        <>
          <div className="pop-scrim" onClick={close} />
          <div ref={menu} className="pop menu" role="menu" aria-label={`Actions for ${repo.name}`} style={{ top: r.bottom + 4, left: Math.max(8, r.right - 220) }} onKeyDown={onMenuKey}>
            <button type="button" role="menuitem" className="opt" onClick={act(() => patch.mutate({ name: repo.name, patch: { pinned: !repo.pinned } }))}>
              <span className="ck"><Icon name="pin" /></span>{repo.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button type="button" role="menuitem" className="opt" onClick={act(() => patch.mutate({ name: repo.name, patch: { hidden: !repo.hidden } }, { onSuccess: () => toast(repo.hidden ? `${repo.name} is back in the default scope` : `${repo.name} hidden from the default scope`) }))}>
              <span className="ck"><Icon name={repo.hidden ? 'eye' : 'eyeOff'} /></span>{repo.hidden ? 'Unhide' : 'Hide from default scope'}
            </button>
            <Link role="menuitem" className="opt" to={`/activity?repos=${encodeURIComponent(repo.name)}`} onClick={() => setOpen(false)}>
              <span className="ck"><Icon name="pulse" /></span>Activity in this repo
            </Link>
            <a role="menuitem" className="opt" href={repo.url} target="_blank" rel="noopener noreferrer" onClick={close}>
              <span className="ck"><Icon name="ext" /></span>Open on GitHub
            </a>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

function VisBadge({ repo }: { repo: Repo }) {
  return (
    <>
      <span className="vis-badge">{repo.visibility === 'private' ? <><Icon name="lock" />Private</> : 'Public'}</span>
      {repo.isArchived && <span className="vis-badge">Archived</span>}
      {repo.isFork && <span className="vis-badge"><Icon name="fork" />Fork</span>}
      {repo.hidden && <span className="vis-badge">Hidden</span>}
    </>
  );
}

function RepoCard({ repo: r, sets, titles }: { repo: Repo; sets: RepoSet[]; titles: string[] }) {
  const st = r.stats;
  return (
    <div className={cx('rcard', (r.isArchived || r.hidden) && 'archived')}>
      <div className="rc-h">
        <Link className="rc-name" to={`/repos/${encodeURIComponent(r.name)}`}>{r.name}</Link>
        <VisBadge repo={r} />
        <span className="spacer" />
        <PinButton repo={r} />
        <RepoMenu repo={r} />
      </div>
      <p className="rc-desc">{r.description ?? <span className="muted">No description</span>}</p>
      <div className="rc-stats">
        {r.language && <span><i className="lang" style={{ '--lc': r.language.color ?? 'var(--muted)' } as CSSProperties} />{r.language.name}</span>}
        {r.visibility === 'public' && (
          <span title="Stars (new in the last 30 days)"><Icon name="star" />{r.stars.toLocaleString()}{st.newStars30d > 0 && <em>+{st.newStars30d}</em>}</span>
        )}
        <span title="Open pull requests"><Icon name="prOpen" />{st.openPrs} open</span>
        <span title="Merged in the last 30 days"><Icon name="merge" />{st.mergedPrs30d} merged</span>
      </div>
      <div className="rc-spark">
        <Sparkline values={st.weeklyCommits} titles={titles} unit="commits" width={168} height={28} focusable={false} ariaLabel={`${r.name}: commits per week, last 12 weeks`} />
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

function RepoTable({ list, titles }: { list: Repo[]; titles: string[] }) {
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
            <tr key={r.name} className={cx((r.isArchived || r.hidden) && 'dim')}>
              <td><Link to={`/repos/${encodeURIComponent(r.name)}`}>{r.name}</Link>{r.pinned && <span className="pin-mark" title="Pinned"><Icon name="pin" /></span>}</td>
              <td>{r.visibility === 'private' ? 'Private' : 'Public'}{r.isArchived ? ' · archived' : ''}{r.isFork ? ' · fork' : ''}{r.hidden ? ' · hidden' : ''}</td>
              <td>{r.language ? <><i className="lang" style={{ '--lc': r.language.color ?? 'var(--muted)' } as CSSProperties} /> {r.language.name}</> : '—'}</td>
              <td className="r">{r.visibility === 'public' ? <>{r.stars.toLocaleString()}{r.stats.newStars30d > 0 && <em className="plus"> +{r.stats.newStars30d}</em>}</> : '—'}</td>
              <td className="r">{r.stats.openPrs}</td>
              <td className="r">{r.stats.mergedPrs30d}</td>
              <td className="r">{r.stats.commits30d}</td>
              <td title={last(r)}>{rel(last(r))}</td>
              <td><Sparkline values={r.stats.weeklyCommits} titles={titles} unit="commits" width={120} height={18} focusable={false} ariaLabel={`${r.name}: commits per week, last 12 weeks`} /></td>
              <td className="acts"><PinButton repo={r} /><RepoMenu repo={r} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
