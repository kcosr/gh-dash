import { createContext, useCallback, useContext } from 'react';
import type { useNavigate } from 'react-router';
import type { Repo } from '../../../shared/api';
import { repoLabel } from '../../../shared/repos';

/**
 * The repo map, provided once by the app shell (RepoMapProvider). Chips and names read it from context instead of each
 * subscribing its own react-query observer (a 1,000-row PR list would otherwise create 1,000).
 */
export const RepoMapCtx = createContext<{
  repos: Map<string, Repo>;
  hrefFor: (key: string) => string;
  navigate: ReturnType<typeof useNavigate>;
} | null>(null);

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
