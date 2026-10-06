import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { PullRequest } from '../../../shared/api';
import { capitalize, refText } from '../../../shared/provider';
import { highlightParts } from '../../../shared/repo-display';
import { matchRepoRef, paletteRefKeys, repoParts } from '../../../shared/repos';
import { api } from '../api/client';
import { useApiBase, useRepos, useViews } from '../api/hooks';
import { API_OFF_HINT, apiLink } from '../lib/account';
import { ALL_TIME_FROM, exportTarget, exportUrl } from '../lib/apiQuery';
import { CommandPalette as WorkbenchPalette, useToast } from '../workbench';
import type { PaletteSource } from '../workbench';
import { browserTz, fmtDate } from '../lib/time';
import { ALL, useSwitchContext } from '../lib/contexts';
import { branchDiffId, carrySearch, keepRepoInScope, parseDiffId, patchSearch, repoFromPath, repoLinkSearch, useUrlState } from '../lib/urlState';
import { copyText, useDebounced } from '../lib/util';
import { prIconClass, prIconName } from './bits';
import { BranchPrRef, branchListTrouble, useBranchSearch } from './Branches';
import { Icon, ProviderIcon } from './Icon';
import type { IconName } from './Icon';
import { useProviderOf, useRepoLabel, useRepoMapCtx, useSourceCtx, useWords } from './repoMapContext';
import { sourceTitle } from './SourceBadge';
import { useViewHref } from './TopBar';
import { useUI } from './ui';

/**
 * `labelParts` draws a repo name: a muted owner, then the name (`label` is the same text, for matching). `step`: the
 * item leads to another step of the palette, which stays open.
 */
interface Item { key: string; icon: ReactElement; label: string; labelParts?: [string, string]; right?: ReactNode; run: () => void; step?: boolean }
interface Section { title: string; items: Item[] }

/**
 * Reviewing a branch takes steps: a repository (skipped when one is in view), then its branches. `back`: where
 * Backspace in the empty input goes.
 */
type Step = { kind: 'repo' } | { kind: 'branch'; repo: string; back: Step | null };

/** Branches a step lists at most (newest first; typing narrows them). */
const BRANCHES_SHOWN = 12;

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
  const [step, setStep] = useState<Step | null>(null);
  const dq = useDebounced(q.trim(), 160);
  const go = (next: Step | null) => { setStep(next); setQ(''); };
  // The repo in view, if any: its page, the list narrowed to it, or its diff.
  const inView = [repoParam, s.repos?.length === 1 ? s.repos[0] : undefined, parseDiffId(s.diff)?.repo].find((k) => k && repoMap.has(k)) ?? null;
  // Branches to list: the step's repo's; on a repo's page, its own as you type.
  const branchRepo = step?.kind === 'branch' ? step.repo : !step && view === 'repo' && repoParam && repoMap.has(repoParam) ? repoParam : null;
  const branches = useBranchSearch(branchRepo, q);
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
    // A step lists repositories or branches alone.
    enabled: !step,
  });

  const openPr = (p: PullRequest) => {
    const stay = view === 'prs' || view === 'comments' || view === 'activity' || view === 'repo';
    const base = stay ? location.search : carrySearch(location.search);
    navigate({ pathname: stay ? location.pathname : '/prs', search: patchSearch(base, stay ? view : 'prs', { pr: p.id, diff: null }) });
  };

  const sections = useMemo<Section[]>(() => {
    const ql = q.trim().toLowerCase();
    const has = (t: string) => !ql || t.toLowerCase().includes(ql);
    const out: Section[] = [];

    /** A repo's branches, as items that open their diff over the view you're on (as a commit's opens). */
    const branchSection = (repo: string, title: string): Section => {
      const p = providerOf(repo);
      return {
        title,
        items: branches.items.slice(0, BRANCHES_SHOWN).map((b) => ({
          key: `branch:${b.name}`,
          icon: ic('branch'),
          label: b.name,
          right: <>{b.pr && <BranchPrRef pr={b.pr} p={p} />}{b.committedAt && <span>{fmtDate(b.committedAt)}</span>}</>,
          run: () => set({ diff: branchDiffId(repo, b.name), file: null, thread: null, only: null }),
        })),
      };
    };
    // Reviewing a branch: its repository first, then its branches; nothing else.
    if (step?.kind === 'repo') {
      const found = (repos.data ?? [])
        .map((r) => ({ r, label: repoLabel(r.key) }))
        .filter(({ label }) => has(label))
        .sort((a, b) => Number(b.r.key === inView) - Number(a.r.key === inView)
          || (ql ? Number(!a.label.toLowerCase().startsWith(ql)) - Number(!b.label.toLowerCase().startsWith(ql)) : 0)
          || (b.r.lastActivityAt ?? '').localeCompare(a.r.lastActivityAt ?? ''))
        .slice(0, 8);
      return found.length ? [{
        title: 'Review a branch of',
        items: found.map(({ r, label }) => {
          const { owner, name } = repoParts(r.key, repoMap);
          return {
            key: `pick:${r.key}`, icon: ic('book'), label, labelParts: [owner === null ? '' : `${owner}/`, name] as [string, string], step: true,
            right: <span>Branches</span>, run: () => go({ kind: 'branch', repo: r.key, back: step }),
          };
        }),
      }] : [];
    }
    if (step?.kind === 'branch') return branches.items.length ? [branchSection(step.repo, `Branches of ${repoLabel(step.repo)}`)] : [];
    const goTo = (path: string) => navigate(hrefTo(path));

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
              if (view === 'prs' || view === 'comments' || view === 'issues' || view === 'repos' || view === 'activity' || view === 'insights') set({ repos: [r.key], ...keepRepoInScope(r, s) });
              else navigate(`/prs?${repoLinkSearch(r.key, ctx ? r.source : null)}`);
            },
          },
        ]),
      });
    }

    // Reviewing a branch: the step (the repo in view's branches at once, else a repository first), found as you type;
    // with an empty query it waits among the actions. On a repo's page, its branches as you type too.
    const review: Item = {
      key: 'do:branch', icon: ic('branch'), label: 'Review a branch…', step: true,
      right: inView ? <span>{repoLabel(inView)}</span> : undefined,
      run: () => go(inView ? { kind: 'branch', repo: inView, back: null } : { kind: 'repo' }),
    };
    const branchItems = [...(ql && has(review.label) ? [review] : []), ...(branchRepo && ql ? branchSection(branchRepo, '').items : [])];
    if (branchItems.length) out.push({ title: 'Branches', items: branchItems });

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

    const nav: [string, string, IconName][] = [[w.nav, '/prs', 'merge'], ['Issues', '/issues', 'issue'], ['Comments', '/comments', 'comment'], ['Repositories', '/repos', 'book'], ['Activity', '/activity', 'pulse'], ['Insights', '/insights', 'chart'], ['Settings', '/settings', 'sliders']];
    const navItems = nav.filter(([l]) => has(l)).map(([l, p, i]) => ({ key: `go:${p}`, icon: ic(i), label: l, run: () => goTo(p) }));
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
      ...(ql ? [] : [review]),
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
  }, [q, repos.data, repoMap, repoLabel, providerOf, w, views.data, prSearch.data, view, s, location.search, location.pathname, repoParam, onToggleSidebar, sidebarHidden, apiBase, openAddRepo, sources, multi, ctx, byHost, switchTo, hrefTo, step, inView, branchRepo, branches.items]);

  const stepRepo = step?.kind === 'branch' ? step.repo : null;
  const trouble = stepRepo && branches.all.isError && !branches.all.data ? branchListTrouble(branches.all.error, providerOf(stepRepo)).text : undefined;
  const none = !stepRepo ? 'No results'
    : q.trim() ? `No branches matching “${q.trim()}”` : 'No branches besides the default one';

  // Product hooks own provider-aware lookup and ordering. The shared palette owns
  // navigation, overlays, highlighting and step focus; avoid filtering these
  // curated results again (a direct PR reference need not match the PR title).
  const paletteSources: PaletteSource[] = sections.map((section, index) => ({
    id: `gh-section-${index}`,
    title: section.title,
    limit: section.items.length,
    items: () => section.items.map((item) => ({
      id: item.key,
      label: item.label,
      icon: item.icon,
      hint: item.right,
      renderLabel: item.labelParts ? (query) => <RepoHighlight parts={item.labelParts!} q={query} /> : undefined,
      keepOpen: item.step,
      onSelect: () => {
        if (!item.step) onRun();
        item.run();
      },
    })),
  }));
  // Loading/errors remain visible even when a lookup has no result section yet.
  if (stepRepo) {
    paletteSources.push({
      id: 'gh-branch-status', title: `Branches of ${repoLabel(stepRepo)}`,
      loading: branches.all.isFetching || branches.searching,
      error: trouble,
      onRetry: () => { void branches.all.refetch(); },
    });
  } else if (step?.kind === 'repo') {
    paletteSources.push({
      id: 'gh-repo-status', title: 'Repositories', loading: repos.isFetching,
      error: repos.isError ? 'Could not load repositories' : undefined,
      onRetry: () => { void repos.refetch(); },
    });
  } else {
    paletteSources.push({
      id: 'gh-pr-status', title: capitalize(w.many), loading: prSearch.isFetching,
      error: prSearch.isError ? `Could not load ${w.many}` : undefined,
      onRetry: () => { void prSearch.refetch(); },
    });
  }

  return (
    <WorkbenchPalette
      open
      onClose={onClose}
      sources={paletteSources}
      query={q}
      onQueryChange={setQ}
      placeholder={step?.kind === 'repo' ? 'Pick a repository…' : step ? 'Filter branches…' : `Search repos, ${w.many}, views, actions…`}
      emptyText={none}
      step={step ? {
        id: stepRepo ? `branch:${stepRepo}` : 'repo',
        title: stepRepo ? repoLabel(stepRepo) : 'Review a branch',
        onBack: () => go(step.kind === 'branch' ? step.back : null),
        backLabel: 'Back',
      } : undefined}
    />
  );
}
