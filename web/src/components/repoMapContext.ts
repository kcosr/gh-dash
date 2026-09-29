import { createContext, useCallback, useContext, useMemo } from 'react';
import type { useNavigate } from 'react-router';
import type { Repo } from '../../../shared/api';
import { repoKind, repoProvider, wordsFor } from '../../../shared/provider';
import type { Provider, Words } from '../../../shared/provider';
import { repoLabel } from '../../../shared/repos';
import type { SourceInfo } from '../lib/contexts';

/**
 * The repo map, provided once by the app shell (RepoMapProvider). Chips and names read it from context instead of each
 * subscribing its own react-query observer (a 1,000-row PR list would otherwise create 1,000).
 */
export const RepoMapCtx = createContext<{
  repos: Map<string, Repo>;
  hrefFor: (key: string) => string;
  navigate: ReturnType<typeof useNavigate>;
} | null>(null);

/**
 * The repo map alone. It changes only when repo data does (RepoMapCtx also changes with the filters), so memoized
 * rows and Markdown that read a repo's host from it don't re-render on navigation. Empty outside RepoMapProvider.
 */
export const ReposCtx = createContext<ReadonlyMap<string, Repo>>(new Map());

export function useRepoMapCtx() {
  const context = useContext(RepoMapCtx);
  if (!context) throw new Error('Repo names outside RepoMapProvider');
  return context;
}

/** `(key) => text`: the plain-text name of a repo (see `repoLabel`) for titles, aria, toasts and copied text. */
export function useRepoLabel(): (key: string) => string {
  const { repos } = useRepoMapCtx();
  return useCallback((key: string) => repoLabel(key, repos), [repos]);
}

/** `(key) => Provider`: a repo's code host, for an item's own words and links (`#`/`!`, "Open on GitHub"). */
export function useProviderOf(): (key: string) => Provider {
  const repos = useContext(ReposCtx);
  return useCallback((key: string) => repoProvider(repos.get(key)), [repos]);
}

/** The sources and the context (design §7.1), provided with the repo map by RepoMapProvider. */
export interface SourceContext {
  /** The sources present (see `presentSources`), github.com first. */
  sources: SourceInfo[];
  byHost: ReadonlyMap<string, SourceInfo>;
  /** Two or more sources: the switcher shows, and All marks each repo with its source. */
  multi: boolean;
  /** The context's source; null = All (and while the URL names no source present). On Settings, the last context. */
  current: SourceInfo | null;
  /** Mark repos with their source: in All, with several sources. */
  badges: boolean;
}

const NO_SOURCES: SourceContext = { sources: [], byHost: new Map(), multi: false, current: null, badges: false };
export const SourceCtx = createContext<SourceContext>(NO_SOURCES);

export function useSourceCtx(): SourceContext {
  return useContext(SourceCtx);
}

/**
 * Words for text about what a page lists rather than one item ("Pull requests", "PRs merged"): the context's source's,
 * or in All those of the kinds present ("PRs & MRs" for both); GitHub's while none are loaded.
 */
export function useWords(): Words {
  const { sources, current } = useSourceCtx();
  const repos = useContext(ReposCtx);
  return useMemo(
    () => wordsFor(current ? [current.kind] : sources.length ? sources.map((s) => s.kind) : Array.from(repos.values(), repoKind)),
    [current, sources, repos],
  );
}
