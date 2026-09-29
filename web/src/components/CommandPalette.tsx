import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PullRequest } from '../../../shared/api';
import { capitalize, refText } from '../../../shared/provider';
import { highlightParts } from '../../../shared/repo-display';
import { matchRepoRef, paletteRefKeys, repoParts } from '../../../shared/repos';
import { api } from '../api/client';
import { useApiBase, useRepos, useViews } from '../api/hooks';
import { API_OFF_HINT, apiLink } from '../lib/account';
import { ALL_TIME_FROM, exportTarget, exportUrl } from '../lib/apiQuery';
import { useFocusTrap, useLayer } from '../lib/layers';
import { browserTz, fmtDate } from '../lib/time';
import { ALL, useSwitchContext } from '../lib/contexts';
import { carrySearch, keepRepoInScope, patchSearch, repoFromPath, repoLinkSearch, useUrlState } from '../lib/urlState';
import { copyText, useDebounced } from '../lib/util';
import { prIconClass, prIconName } from './bits';
import { Icon, ProviderIcon } from './Icon';
import type { IconName } from './Icon';
import { useProviderOf, useRepoLabel, useRepoMapCtx, useSourceCtx, useWords } from './repoMapContext';
import { sourceTitle } from './SourceBadge';
import { useToast } from './Toasts';
import { useViewHref } from './TopBar';
import { useUI } from './ui';

/** `labelParts` draws a repo name: a muted owner, then the name (`label` is the same text, for matching). */
interface Item { key: string; icon: ReactNode; label: string; labelParts?: [string, string]; right?: ReactNode; run: () => void }
interface Section { title: string; items: Item[] }

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

/** A repo name with the owner muted; a search match is marked in either part, or across the slash. */
function RepoHighlight({ parts, q }: { parts: [string, string]; q: string }) {
  return <>{highlightParts(parts, q).map((segs, i) => (
    <span key={i} className={i === 0 && parts[0] ? 'pal-o' : undefined}>
      {segs.map((seg, j) => (seg.hit ? <mark key={j}>{seg.text}</mark> : seg.text))}
    </span>
  ))}</>;
}

const ic = (name: IconName) => <Icon name={name} />;

export function CommandPalette({ onClose, onRun, onSync, onToggleTheme, onToggleSidebar, sidebarHidden }: {
  onClose: () => void; onRun: () => void; onSync: () => void; onToggleTheme: () => void;
  /** Desktop views with a sidebar. */
  onToggleSidebar?: () => void; sidebarHidden?: boolean;
}) {
  const { s, view, location, navigate, set } = useUrlState();
  const repoParam = repoFromPath(location.pathname);
  const toast = useToast();
  const { openAddRepo } = useUI();
  const repoLabel = useRepoLabel();
  const providerOf = useProviderOf();
  const w = useWords().pr;
  const { repos: repoMap } = useRepoMapCtx();
  const { sources, multi, current, byHost } = useSourceCtx();
  const ctx = current?.host ?? null;
  const switchTo = useSwitchContext();
  const hrefTo = useViewHref();
  const repos = useRepos();
  const views = useViews();
  const apiBase = useApiBase();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const dq = useDebounced(q.trim(), 160);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);
  useFocusTrap(box);
  useEffect(() => { input.current?.focus(); }, []);

  // "<repo>#<n>" (a PR) or "<repo>!<n>" (an MR): the repo part is a key, an alias, or (failing both) a short name shared
  // by tracked repos of that kind, the context's first (paletteRefKeys). A `!` naming no GitLab repo is text.
  const refKeys = useMemo(() => {
    const m = matchRepoRef(dq);
    return m && { m, keys: paletteRefKeys(m, repos.data ?? [], ctx) };
  }, [dq, repos.data, ctx]);
  const refMatch = refKeys && refKeys.keys !== null ? refKeys.m : null;
  // Unknown here: let the server decide. A reference looks across contexts (opening one takes you to its source).
  const refRepos = refMatch ? (refKeys!.keys!.length ? refKeys!.keys!.join(',') : refMatch.repo) : undefined;
  // Searches and recent PRs follow the context, like the lists.
  const source = refMatch ? undefined : ctx ?? undefined;
  const prSearch = useQuery({
    queryKey: ['palette-prs', dq, refRepos, source],
    queryFn: () =>
      dq
        ? api.prs({ q: refMatch ? undefined : dq, repos: refRepos, source, state: 'all', who: 'everyone', from: ALL_TIME_FROM, tz: browserTz(), limit: refMatch ? 200 : 8 })
        : api.prs({ source, state: 'all', who: 'me', from: '-90d', tz: browserTz(), limit: 5 }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  const openPr = (p: PullRequest) => {
    const stay = view === 'prs' || view === 'activity' || view === 'repo';
    const base = stay ? location.search : carrySearch(location.search);
    navigate({ pathname: stay ? location.pathname : '/prs', search: patchSearch(base, stay ? view : 'prs', { pr: p.id, diff: null }) });
  };

  const sections = useMemo<Section[]>(() => {
    const ql = q.trim().toLowerCase();
    const has = (t: string) => !ql || t.toLowerCase().includes(ql);
    const out: Section[] = [];
    const go = (path: string) => navigate(hrefTo(path));

    // A repo is found by what it shows: its name, and for someone else's repo the owner as well. Every source's repos
    // are found; the context's come first, and choosing another's takes you to its context.
    const shown = (repos.data ?? []).map((r) => {
      const { owner, name } = repoParts(r.key, repoMap);
      return { r, label: repoLabel(r.key), parts: [owner === null ? '' : `${owner}/`, name] as [string, string] };
    });
    const away = (r: { source: string }) => Number(!!ctx && r.source !== ctx);
    const rs = shown
      .filter(({ r, label }) => has(label) && (ql || !away(r)))
      .sort((a, b) => away(a.r) - away(b.r) || (ql ? Number(!a.label.toLowerCase().startsWith(ql)) - Number(!b.label.toLowerCase().startsWith(ql)) : 0) || (b.r.lastActivityAt ?? '').localeCompare(a.r.lastActivityAt ?? ''))
      .slice(0, ql ? 6 : 4);
    if (rs.length) {
      out.push({
        title: 'Repositories',
        items: rs.flatMap(({ r, label, parts }) => [
          {
            key: `repo:${r.key}`,
            // With several sources the mark says which one (the palette searches them all).
            icon: multi ? <span className="pal-src" title={sourceTitle(byHost.get(r.source) ?? { host: r.source, name: r.source })}><ProviderIcon kind={r.provider} /></span> : ic('book'),
            label,
            labelParts: parts,
            right: <>{r.visibility === 'private' && <Icon name="lock" title="Private" />}{r.visibility === 'internal' && <Icon name="lock" title="Internal" />}<span>{away(r) ? `Switch to ${byHost.get(r.source)?.name ?? r.source}` : 'Select only this repo'}</span></>,
            run: () => {
              if (view === 'prs' || view === 'issues' || view === 'repos' || view === 'activity' || view === 'insights') set({ repos: [r.key], ...keepRepoInScope(r, s) });
              else navigate(`/prs?${repoLinkSearch(r.key, ctx ? r.source : null)}`);
            },
          },
        ]),
      });
    }

    const prs = prSearch.data?.items ?? [];
    const prItems: Item[] = [];
    if (ql && !refMatch) {
      prItems.push({
        key: 'search-prs',
        icon: ic('search'),
        label: `Search ${w.many} for “${q.trim()}”`,
        right: <span>/prs?q=</span>,
        run: () => navigate({ pathname: '/prs', search: patchSearch(carrySearch(location.search), 'prs', { q: q.trim(), state: 'all' }) }),
      });
    }
    const matched = refMatch ? prs.filter((p) => String(p.number).startsWith(refMatch.number)).slice(0, 6) : prs.slice(0, 6);
    for (const p of matched) {
      prItems.push({
        key: `pr:${p.id}`,
        icon: <span className={`pr-ic ${prIconClass(p)}`}><Icon name={prIconName(p)} /></span>,
        label: p.title,
        right: <span>{refText(providerOf(p.repo).kind, repoLabel(p.repo), p.number, 'pr')} · {fmtDate(p.activityAt)}</span>,
        run: () => openPr(p),
      });
    }
    if (prItems.length) out.push({ title: ql ? capitalize(w.many) : `Recent ${w.many}`, items: prItems });

    if (ql && !refMatch) out.push({ title: 'Issues', items: [{
      key: 'search-issues', icon: ic('issue'), label: `Search issues for “${q.trim()}”`,
      run: () => navigate({ pathname: '/issues', search: patchSearch(carrySearch(location.search), 'issues', { q: q.trim(), state: 'all' }) }),
    }] });

    const vs = (views.data ?? []).filter((v) => has(v.name));
    if (vs.length) out.push({ title: 'Saved views', items: vs.map((v) => ({ key: `view:${v.id}`, icon: ic('bookmark'), label: v.name, run: () => navigate(`${v.path}${v.query ? `?${v.query}` : ''}`) })) });

    const nav: [string, string, IconName][] = [[w.nav, '/prs', 'merge'], ['Issues', '/issues', 'issue'], ['Activity', '/activity', 'pulse'], ['Repositories', '/repos', 'book'], ['Insights', '/insights', 'chart'], ['Settings', '/settings', 'sliders']];
    const navItems = nav.filter(([l]) => has(l)).map(([l, p, i]) => ({ key: `go:${p}`, icon: ic(i), label: l, run: () => go(p) }));
    if (navItems.length) out.push({ title: 'Go to', items: navItems });

    const t = exportTarget(view, s, repoParam);
    // Switching context: each option but the current one (no new shortcut; the top bar has the control).
    const switches: Item[] = multi
      ? [...sources.map((x) => ({ host: x.host, name: x.name, kind: x.kind as typeof x.kind | null })), { host: ALL, name: 'All', kind: null }]
        .filter((x) => x.host !== (ctx ?? ALL))
        .map((x) => ({
          key: `ctx:${x.host}`, icon: x.kind ? <span className="pal-src"><ProviderIcon kind={x.kind} /></span> : ic('layers'),
          label: `Switch to ${x.name}`, run: () => switchTo(x.host),
        }))
      : [];
    const acts: Item[] = [
      ...switches,
      { key: 'do:sync', icon: ic('sync'), label: 'Sync now', run: onSync },
      { key: 'do:addrepo', icon: ic('plus'), label: 'Add repository…', run: openAddRepo },
      { key: 'do:theme', icon: ic('moon'), label: 'Toggle dark mode', run: onToggleTheme },
      ...(onToggleSidebar ? [{ key: 'do:sidebar', icon: ic('list'), label: sidebarHidden ? 'Show sidebar' : 'Hide sidebar', run: onToggleSidebar }] : []),
      // Without a Local API there's no URL to copy or open: say how to get one instead.
      apiBase
        ? { key: 'do:copyapi', icon: ic('braces'), label: 'Copy API URL for this view', run: async () => toast((await copyText(apiLink(apiBase, exportUrl(t))!)) ? 'API URL copied' : 'Copy failed') }
        : { key: 'do:copyapi', icon: ic('braces'), label: 'Copy API URL for this view', right: <span>Local API is off</span>, run: () => toast(API_OFF_HINT) },
      apiBase
        ? { key: 'do:docs', icon: ic('doc'), label: 'Open API docs', run: () => { window.open(apiLink(apiBase, '/api/docs')!, '_blank', 'noopener'); } }
        : { key: 'do:docs', icon: ic('doc'), label: 'Open API docs', right: <span>Local API is off</span>, run: () => toast(API_OFF_HINT) },
    ].filter((a) => has(a.label));
    if (acts.length) out.push({ title: 'Actions', items: acts });
    return out;
  }, [q, repos.data, repoMap, repoLabel, providerOf, w, views.data, prSearch.data, view, s, location.search, location.pathname, repoParam, onToggleSidebar, sidebarHidden, apiBase, openAddRepo, sources, multi, ctx, byHost, switchTo, hrefTo]);

  const flat = sections.flatMap((sec) => sec.items);
  const cur = Math.min(idx, Math.max(0, flat.length - 1));

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => {
    results.current?.querySelector<HTMLElement>('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    onRun();
    onClose();
    it.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((cur + 1) % Math.max(1, flat.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((cur - 1 + flat.length) % Math.max(1, flat.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[cur]); }
  };

  let k = 0;
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={box} onKeyDown={onKeyDown}>
        <div className="pal-in">
          <Icon name="search" />
          <input
            ref={input}
            placeholder={`Search repos, ${w.many}, views, actions…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-res"
            aria-activedescendant={flat[cur] ? `pal-${cur}` : undefined}
          />
          {prSearch.isFetching && <span className="spin"><Icon name="sync" /></span>}
          <kbd>esc</kbd>
        </div>
        <div className="pal-res" id="pal-res" role="listbox" ref={results}>
          {sections.map((sec) => (
            <div key={sec.title} role="group" aria-label={sec.title}>
              <div className="pal-sec">{sec.title}</div>
              {sec.items.map((it) => {
                const i = k++;
                return (
                  <button
                    key={it.key}
                    id={`pal-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === cur}
                    tabIndex={-1}
                    className={`pal-item${i === cur ? ' on' : ''}`}
                    onMouseMove={() => { if (i !== cur) setIdx(i); }}
                    onClick={() => run(it)}
                  >
                    {it.icon}
                    <span className="pal-l">{it.labelParts ? <RepoHighlight parts={it.labelParts} q={q.trim()} /> : <Highlight text={it.label} q={q.trim()} />}</span>
                    {it.right && <span className="r">{it.right}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!flat.length && <div className="pal-none">No results</div>}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
