/** Pure helpers for adding and removing repositories (the Add dialog, the Remove confirmation). */
import type { RepoCandidate, RepoPreview } from '../../../shared/api';
import { parseRepoInput } from '../../../shared/repos';
import { fmtDateSmart, plural } from './time';

/** The repo key (`owner/name`) that dialog input names: owner/name, a github.com URL or a git@ address; else null. */
export function inputKey(text: string): string | null {
  const p = parseRepoInput(text);
  return p ? `${p.owner}/${p.name}` : null;
}

/**
 * Up to `limit` candidates whose key contains `text` (case-insensitive), best first: a name or `owner/name` prefix,
 * then an owner prefix, then a match anywhere. Within a rank the input order (most recently pushed first) is kept.
 */
export function matchCandidates<C extends Pick<RepoCandidate, 'key' | 'owner' | 'name'>>(items: readonly C[], text: string, limit = 20): C[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const rank = (c: C) => {
    const key = c.key.toLowerCase();
    if (c.name.toLowerCase().startsWith(q) || key.startsWith(q) && q.includes('/')) return 0;
    if (c.owner.toLowerCase().startsWith(q)) return 1;
    return key.includes(q) ? 2 : -1;
  };
  return items
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * What the first sync of a previewed repo fetches: "Since Sep 29, 2025: ~1,240 commits · 350 PRs · 90 issues · about 30
 * GitHub requests", or "size unknown" when GitHub didn't say.
 */
export function backfillLine(b: RepoPreview['backfill']): string {
  const since = `Since ${fmtDateSmart(b.since)}`;
  if (b.commits === null || b.prs === null || b.issues === null || b.requests === null) return `${since}: size unknown`;
  const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString()} ${plural(v, one, many)}`;
  return `${since}: ~${n(b.commits, 'commit')} · ${n(b.prs, 'PR')} · ${n(b.issues, 'issue')} · about ${n(b.requests, 'GitHub request')}`;
}

/**
 * The Remove confirmation's text. `commentCount` is where the diff-comments track plugs in (its branch isn't merged
 * here): once `Repo.commentCount` exists, pass it, and the text names the user's own comments that go with the repo.
 */
export function removeRepoBody(commentCount?: number): string {
  const comments = commentCount ? `, and your ${commentCount.toLocaleString()} ${plural(commentCount, 'comment')}` : '';
  return `gh-dash stops syncing it and deletes its pull requests, issues, commits and releases from this dashboard${comments}. `
    + 'It also leaves your sets. Nothing changes on GitHub. Adding it again re-syncs from scratch.';
}
