import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Repo } from '../../../shared/api';
import { useRepoMap } from '../api/hooks';
import { Icon } from './Icon';

/**
 * The repo map, provided once by the app shell. Chips read it from context instead of each
 * subscribing its own react-query observer (a 1,000-row PR list would otherwise create 1,000).
 */
const RepoMapCtx = createContext<Map<string, Repo> | null>(null);

export function RepoMapProvider({ children }: { children: ReactNode }) {
  const repos = useRepoMap();
  return <RepoMapCtx.Provider value={repos}>{children}</RepoMapCtx.Provider>;
}

/** Repo name with a lock icon when private. */
export function RepoChip({ name, className = 'repo-chip' }: { name: string; className?: string }) {
  const repos = useContext(RepoMapCtx);
  const priv = repos?.get(name)?.visibility === 'private';
  return (
    <span className={className}>
      {priv && <Icon name="lock" title="Private" />}
      {name}
    </span>
  );
}
