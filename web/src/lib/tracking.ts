/** Pure helpers for adding and removing repositories (the Add dialog, the Remove confirmation). */
import type { RepoCandidate, RepoPreview } from '../../../shared/api';
import { PROVIDERS, type Provider } from '../../../shared/provider';
import { parseGitLabInput, parseRepoInput } from '../../../shared/repos';
import type { InputSource } from '../../../shared/repos';
import { fmtDateSmart, plural } from './time';

/** The repo key (`owner/name`) that dialog input names: owner/name, a github.com URL or a git@ address; else null. */
export function inputKey(text: string): string | null {
  const p = parseRepoInput(text);
  return p ? `${p.owner}/${p.name}` : null;
}

/**
 * The repo key that dialog input names on `source`: for GitHub `owner/name` (see `inputKey`); for a GitLab source
 * `<host>/<group>/…/<project>` from a path, a key, a web URL or an ssh address of that host; else null.
 */
export function inputKeyOn(source: InputSource & { kind: 'github' | 'gitlab' }, text: string): string | null {
  if (source.kind === 'github') return inputKey(text);
  const p = parseGitLabInput(text, source);
  return p ? `${source.host.toLowerCase()}/${p.path}` : null;
}

/**
 * Up to `limit` candidates whose key contains `text` (case-insensitive), best first: a name or `owner/name` prefix,
 * then an owner prefix, then a match anywhere. Within a rank the input order (most recently pushed first) is kept.
 * `hostPrefix`: a GitLab source's host, which its candidates' keys start with and the search must not see.
 */
export function matchCandidates<C extends Pick<RepoCandidate, 'key' | 'owner' | 'name'>>(items: readonly C[], text: string, limit = 20, hostPrefix?: string): C[] {
  const lead = hostPrefix ? `${hostPrefix.toLowerCase()}/` : null;
  const bare = (key: string) => (lead && key.toLowerCase().startsWith(lead) ? key.slice(lead.length) : key);
  // Typed as a key (host and all) or as a path: both search the path.
  const q = bare(text.trim()).toLowerCase();
  if (!q) return [];
  const rank = (c: C) => {
    const key = bare(c.key).toLowerCase();
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
 * GitHub requests", or "size unknown" when the host didn't say. `p` is the repo's host. GitLab doesn't count commits
 * ("… · 350 MRs · 90 issues · commits: size unknown"). `unavailable`: parts the project has turned off, which aren't
 * counted (and aren't synced).
 */
export function backfillLine(b: RepoPreview['backfill'], p: Provider = PROVIDERS.github, unavailable: readonly ('prs' | 'issues')[] = []): string {
  const since = `Since ${fmtDateSmart(b.since)}`;
  const unknown = `${since}: size unknown`;
  const prsOn = !unavailable.includes('prs');
  const issuesOn = !unavailable.includes('issues');
  if ((prsOn && b.prs === null) || (issuesOn && b.issues === null)) return unknown;
  const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString()} ${plural(v, one, many)}`;
  const parts: string[] = [];
  if (b.commits !== null) parts.push(`~${n(b.commits, 'commit')}`);
  if (prsOn) parts.push(n(b.prs!, p.pr.short, p.pr.shortMany));
  if (issuesOn) parts.push(n(b.issues!, 'issue'));
  if (b.commits === null) {
    if (!parts.length) return unknown;
    parts.push('commits: size unknown');
  } else if (b.requests === null) {
    return unknown;
  }
  if (b.requests !== null) parts.push(`about ${n(b.requests, `${p.name} request`)}`);
  return `${since}: ${parts.join(' · ')}`;
}

/**
 * The Remove confirmation's text. `commentCount` is where the diff-comments track plugs in (its branch isn't merged
 * here): once `Repo.commentCount` exists, pass it, and the text names the user's own comments that go with the repo.
 * `p` is the repo's host.
 */
export function removeRepoBody(commentCount?: number, p: Provider = PROVIDERS.github): string {
  const comments = commentCount ? `, and your ${commentCount.toLocaleString()} ${plural(commentCount, 'comment')}` : '';
  return `gh-dash stops syncing it and deletes its ${p.pr.many}, issues, commits and releases from this dashboard${comments}. `
    + `It also leaves your sets. Nothing changes on ${p.name}. Adding it again re-syncs from scratch.`;
}
