import type { Repo, RepoQuery } from './api';

export function defaultRepoScope(repos: Repo[], includeForks = false): string[] {
  return repos.filter((r) => !r.isArchived && !r.hidden && (!r.isFork || includeForks)).map((r) => r.name);
}

/** Shared by the repository tab and its API export so scope, search and ordering agree. */
export function selectRepos(repos: Repo[], query: RepoQuery, includeForks = false): Repo[] {
  const selected = query.repos !== undefined
    ? new Set(query.repos.split(',').map((name) => name.trim()).filter(Boolean))
    : query.scope === 'default' ? new Set(defaultRepoScope(repos, includeForks)) : null;
  const text = query.q?.trim().toLowerCase() ?? '';
  const activity = (r: Repo) => r.lastActivityAt ?? r.pushedAt ?? r.createdAt;
  const compare = (a: Repo, b: Repo) => {
    switch (query.sort) {
      case 'stars': return b.stars - a.stars;
      case 'open': return b.stats.openPrs - a.stats.openPrs;
      case 'name': return a.name.localeCompare(b.name);
      default: return activity(b).localeCompare(activity(a));
    }
  };
  return repos.filter((r) => (!selected || selected.has(r.name))
    && (!query.visibility || query.visibility === 'all' || r.visibility === query.visibility)
    && (!text || `${r.name} ${r.description ?? ''} ${r.topics.join(' ')} ${r.language?.name ?? ''}`.toLowerCase().includes(text)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.hidden) - Number(b.hidden) || compare(a, b) || a.name.localeCompare(b.name));
}
