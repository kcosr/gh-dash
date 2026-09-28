import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PullRequest } from '../../../shared/api';
import { api } from '../api/client';
import { useRepos, useViews } from '../api/hooks';
import { ALL_TIME_FROM, exportTarget, exportUrl } from '../lib/apiQuery';
import { useFocusTrap, useLayer } from '../lib/layers';
import { browserTz, fmtDate } from '../lib/time';
import { carrySearch, patchSearch, repoFromPath, useUrlState } from '../lib/urlState';
import { copyText, useDebounced } from '../lib/util';
import { prIconClass, prIconName } from './bits';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useToast } from './Toasts';

interface Item { key: string; icon: ReactNode; label: string; right?: ReactNode; run: () => void }
interface Section { title: string; items: Item[] }

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

const ic = (name: IconName) => <Icon name={name} />;

export function CommandPalette({ onClose, onRun, onSync, onToggleTheme }: { onClose: () => void; onRun: () => void; onSync: () => void; onToggleTheme: () => void }) {
  const { s, view, location, navigate, set } = useUrlState();
  const repoParam = repoFromPath(location.pathname);
  const toast = useToast();
  const repos = useRepos();
  const views = useViews();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const dq = useDebounced(q.trim(), 160);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);
  useFocusTrap(box);
  useEffect(() => { input.current?.focus(); }, []);

  const refMatch = /^([\w.-]+)#(\d+)$/.exec(dq);
  const prSearch = useQuery({
    queryKey: ['palette-prs', dq],
    queryFn: () =>
      dq
        ? api.prs({ q: refMatch ? undefined : dq, repos: refMatch ? refMatch[1] : undefined, state: 'all', who: 'everyone', from: ALL_TIME_FROM, tz: browserTz(), limit: refMatch ? 200 : 8 })
        : api.prs({ state: 'all', who: 'me', from: '-90d', tz: browserTz(), limit: 5 }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  const openPr = (p: PullRequest) => {
    const stay = view === 'prs' || view === 'activity' || view === 'repo';
    const base = stay ? location.search : carrySearch(location.search);
    navigate({ pathname: stay ? location.pathname : '/prs', search: patchSearch(base, stay ? view : 'prs', { pr: p.id }) });
  };

  const sections = useMemo<Section[]>(() => {
    const ql = q.trim().toLowerCase();
    const has = (t: string) => !ql || t.toLowerCase().includes(ql);
    const out: Section[] = [];
    const go = (path: string) => navigate(`${path}${carrySearch(location.search)}`);

    const rs = (repos.data ?? [])
      .filter((r) => has(r.name))
      .sort((a, b) => (ql ? Number(!a.name.toLowerCase().startsWith(ql)) - Number(!b.name.toLowerCase().startsWith(ql)) : 0) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      .slice(0, ql ? 6 : 4);
    if (rs.length) {
      out.push({
        title: 'Repositories',
        items: rs.flatMap((r) => [
          {
            key: `repo:${r.name}`,
            icon: ic('book'),
            label: r.name,
            right: <>{r.visibility === 'private' && <Icon name="lock" />}<span>Select only this repo</span></>,
            run: () => {
              if (view === 'prs' || view === 'issues' || view === 'repos' || view === 'activity' || view === 'insights') set({ repos: [r.name] });
              else navigate(`/prs?repos=${encodeURIComponent(r.name)}`);
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
        label: `Search pull requests for “${q.trim()}”`,
        right: <span>/prs?q=</span>,
        run: () => navigate({ pathname: '/prs', search: patchSearch(carrySearch(location.search), 'prs', { q: q.trim(), state: 'all' }) }),
      });
    }
    const matched = refMatch ? prs.filter((p) => String(p.number).startsWith(refMatch[2])).slice(0, 6) : prs.slice(0, 6);
    for (const p of matched) {
      prItems.push({
        key: `pr:${p.id}`,
        icon: <span className={`pr-ic ${prIconClass(p)}`}><Icon name={prIconName(p)} /></span>,
        label: p.title,
        right: <span>{p.repo}#{p.number} · {fmtDate(p.activityAt)}</span>,
        run: () => openPr(p),
      });
    }
    if (prItems.length) out.push({ title: ql ? 'Pull requests' : 'Recent pull requests', items: prItems });

    if (ql && !refMatch) out.push({ title: 'Issues', items: [{
      key: 'search-issues', icon: ic('issue'), label: `Search issues for “${q.trim()}”`,
      run: () => navigate({ pathname: '/issues', search: patchSearch(carrySearch(location.search), 'issues', { q: q.trim(), state: 'all' }) }),
    }] });

    const vs = (views.data ?? []).filter((v) => has(v.name));
    if (vs.length) out.push({ title: 'Saved views', items: vs.map((v) => ({ key: `view:${v.id}`, icon: ic('bookmark'), label: v.name, run: () => navigate(`${v.path}${v.query ? `?${v.query}` : ''}`) })) });

    const nav: [string, string, IconName][] = [['Pull requests', '/prs', 'merge'], ['Issues', '/issues', 'issue'], ['Activity', '/activity', 'pulse'], ['Repositories', '/repos', 'book'], ['Insights', '/insights', 'chart'], ['Settings', '/settings', 'sliders']];
    const navItems = nav.filter(([l]) => has(l)).map(([l, p, i]) => ({ key: `go:${p}`, icon: ic(i), label: l, run: () => go(p) }));
    if (navItems.length) out.push({ title: 'Go to', items: navItems });

    const t = exportTarget(view, s, repoParam);
    const acts: Item[] = [
      { key: 'do:sync', icon: ic('sync'), label: 'Sync now', run: onSync },
      { key: 'do:theme', icon: ic('moon'), label: 'Toggle dark mode', run: onToggleTheme },
      { key: 'do:copyapi', icon: ic('braces'), label: 'Copy API URL for this view', run: async () => toast((await copyText(window.location.origin + exportUrl(t))) ? 'API URL copied' : 'Copy failed') },
      { key: 'do:docs', icon: ic('doc'), label: 'Open API docs', run: () => window.open('/api/docs', '_blank', 'noopener') },
    ].filter((a) => has(a.label));
    if (acts.length) out.push({ title: 'Actions', items: acts });
    return out;
  }, [q, repos.data, views.data, prSearch.data, view, s, location.search, location.pathname, repoParam]);

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
            placeholder="Search repos, pull requests, views, actions…"
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
                    <span className="pal-l"><Highlight text={it.label} q={q.trim()} /></span>
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
