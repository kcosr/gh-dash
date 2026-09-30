/**
 * Code hosts: the words and URL shapes that differ between GitHub and GitLab (design §6.4, §7.3, §7.7).
 *
 * Items carry their own URLs (`pr.url`, `commit.url`, `issue.url`, `release.url`, `Diff.url`), built by their
 * source's mapper. Everything derived from them, and every word that names the host or its change requests, comes
 * from here: the web and the server exports never build a host URL or say "GitHub" / "PR" on their own. An item's
 * provider is its repo's (`repoProvider`); a page that lists several repos uses the words of the kinds present
 * (`mixedPrWords`, `wordsFor`).
 */
import type { ProviderKind, Repo } from './api';

/** How a host names its change requests. */
export interface PrWords {
  /** 'pull request' | 'merge request' */
  one: string;
  /** 'pull requests' | 'merge requests' */
  many: string;
  /** 'PR' | 'MR' */
  short: string;
  /** 'PRs' | 'MRs' */
  shortMany: string;
  /** The nav tab and the palette's "Go to": 'Pull requests' | 'Merge requests' ('PRs & MRs' for both kinds). */
  nav: string;
}

/** URLs derived from an item's or a repo's own URL. `repoUrl` is `Repo.url`, `prUrl` is `PullRequest.url`. */
export interface ProviderLinks {
  /** …/pull/n | …/-/merge_requests/n */
  pr(repoUrl: string, n: number): string;
  /** The PR's changed files: …/files | …/diffs */
  prFiles(prUrl: string): string;
  /** The PR's commits: …/commits on both. */
  prCommits(prUrl: string): string;
  /** …/commit/sha | …/-/commit/sha */
  commit(repoUrl: string, sha: string): string;
  /** A branch compared against `base` (three-dot): …/compare/base...head | …/-/compare/base...head */
  compare(repoUrl: string, base: string, head: string): string;
  /** The repo's PR list: …/pulls | …/-/merge_requests */
  prs(repoUrl: string): string;
  /** …/issues | …/-/issues */
  issues(repoUrl: string): string;
  /** …/releases | …/-/releases */
  releases(repoUrl: string): string;
  /**
   * The fragment that scrolls a diff page (`prFiles`, `commit`) to a file: '#diff-' + sha256(path) on GitHub,
   * '#' + sha1(path) on GitLab. Rejects where SubtleCrypto is unavailable (plain HTTP off localhost).
   */
  fileAnchor(path: string): Promise<string>;
}

export interface Provider {
  kind: ProviderKind;
  name: 'GitHub' | 'GitLab';
  /** The host's command-line tool. */
  cli: 'gh' | 'glab';
  pr: PrWords;
  /** How a PR/MR number is referenced: `app#12` | `app!12`. Issues are `#` on both. */
  prRef: '#' | '!';
  link: ProviderLinks;
}

async function digestHex(algorithm: 'SHA-1' | 'SHA-256', text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A branch name in a URL path: each segment encoded, the slashes kept (both hosts' compare pages expect them so). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

const GITHUB: Provider = {
  kind: 'github',
  name: 'GitHub',
  cli: 'gh',
  pr: { one: 'pull request', many: 'pull requests', short: 'PR', shortMany: 'PRs', nav: 'Pull requests' },
  prRef: '#',
  link: {
    pr: (repoUrl, n) => `${repoUrl}/pull/${n}`,
    prFiles: (prUrl) => `${prUrl}/files`,
    prCommits: (prUrl) => `${prUrl}/commits`,
    commit: (repoUrl, sha) => `${repoUrl}/commit/${sha}`,
    compare: (repoUrl, base, head) => `${repoUrl}/compare/${refPath(base)}...${refPath(head)}`,
    prs: (repoUrl) => `${repoUrl}/pulls`,
    issues: (repoUrl) => `${repoUrl}/issues`,
    releases: (repoUrl) => `${repoUrl}/releases`,
    fileAnchor: async (path) => `#diff-${await digestHex('SHA-256', path)}`,
  },
};

const GITLAB: Provider = {
  kind: 'gitlab',
  name: 'GitLab',
  cli: 'glab',
  pr: { one: 'merge request', many: 'merge requests', short: 'MR', shortMany: 'MRs', nav: 'Merge requests' },
  prRef: '!',
  link: {
    pr: (repoUrl, n) => `${repoUrl}/-/merge_requests/${n}`,
    prFiles: (prUrl) => `${prUrl}/diffs`,
    prCommits: (prUrl) => `${prUrl}/commits`,
    commit: (repoUrl, sha) => `${repoUrl}/-/commit/${sha}`,
    compare: (repoUrl, base, head) => `${repoUrl}/-/compare/${refPath(base)}...${refPath(head)}`,
    prs: (repoUrl) => `${repoUrl}/-/merge_requests`,
    issues: (repoUrl) => `${repoUrl}/-/issues`,
    releases: (repoUrl) => `${repoUrl}/-/releases`,
    fileAnchor: async (path) => `#${await digestHex('SHA-1', path)}`,
  },
};

export const PROVIDERS: Record<ProviderKind, Provider> = { github: GITHUB, gitlab: GITLAB };

/** What this module reads of a repo. The lookups fall back to GitHub only for a repo that isn't known at all. */
export type ProviderRepo = Pick<Repo, 'provider' | 'url' | 'nameWithOwner'>;

/** The kind of a repo's host; GitHub for a repo that isn't known (not in the map, removed). */
export function repoKind(repo: ProviderRepo | null | undefined): ProviderKind {
  return repo?.provider ?? 'github';
}

/** A repo's host: its words and URL shapes. */
export function repoProvider(repo: ProviderRepo | null | undefined): Provider {
  return PROVIDERS[repoKind(repo)];
}

const MIXED_PR: PrWords = { one: 'pull or merge request', many: 'pull & merge requests', short: 'PR or MR', shortMany: 'PRs & MRs', nav: 'PRs & MRs' };

/** The change-request words for a page listing repos of these kinds: one kind's own, neutral ones for both. */
export function mixedPrWords(kinds: Iterable<ProviderKind>): PrWords {
  const set = new Set(kinds);
  if (set.size > 1) return MIXED_PR;
  return PROVIDERS[set.values().next().value ?? 'github'].pr;
}

/** Words for a page listing repos of these kinds. */
export interface Words {
  pr: PrWords;
  /** The host's name when one kind is present; null for both (say "Open", with the host in the tooltip). */
  host: Provider['name'] | null;
}

export function wordsFor(kinds: Iterable<ProviderKind>): Words {
  const set = new Set(kinds);
  return { pr: mixedPrWords(set), host: set.size > 1 ? null : PROVIDERS[set.values().next().value ?? 'github'].name };
}

/** 'Pull requests' from 'pull requests'. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A reference as the host writes it: `app#12` for a GitHub PR or any issue, `app!12` for a GitLab MR. */
export function refText(kind: ProviderKind, repoLabel: string, n: number, what: 'pr' | 'issue'): string {
  return `${repoLabel}${what === 'pr' ? PROVIDERS[kind].prRef : '#'}${n}`;
}

// ---------------------------------------------------------------------------
// Links in an item's Markdown (design §7.7)
// ---------------------------------------------------------------------------

/**
 * The web root of a repo's source: `https://github.com`, or a GitLab instance's URL including its relative root
 * (`https://gitlab.example.com/gitlab`). A repo's URL is `<root>/<path>` on both hosts, so the root is what's left
 * once the path is taken off; the URL's origin when it doesn't end with the path.
 */
export function sourceRootUrl(repo: Pick<Repo, 'url' | 'nameWithOwner'>): string {
  const url = repo.url.replace(/\/+$/, '');
  const tail = `/${repo.nameWithOwner}`;
  if (url.toLowerCase().endsWith(tail.toLowerCase())) return url.slice(0, -tail.length);
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** What root-relative links in an item's Markdown resolve against. */
export interface LinkBase {
  kind: ProviderKind;
  /** The item's repo (`Repo.url`). */
  repoUrl: string;
  /** The repo's source (`sourceRootUrl`). */
  rootUrl: string;
}

export function linkBase(repo: ProviderRepo): LinkBase {
  return { kind: repoKind(repo), repoUrl: repo.url.replace(/\/+$/, ''), rootUrl: sourceRootUrl(repo) };
}

/**
 * Where a URL in an item's Markdown points. The host renders root-relative URLs against itself, so they are resolved
 * against the item's source rather than left to land on gh-dash:
 *  - GitLab project uploads, `/uploads/…`, against the project: `${repoUrl}/uploads/…`;
 *  - any other `/…` against the source's root (a GitLab relative root included): `/alice/app/-/issues/3`, GitHub's
 *    `/owner/name/pull/3`.
 * Anything else is returned unchanged: absolute URLs, relative paths (`docs/a.md`, `../a`), fragments, queries, and
 * protocol-relative `//host/…`. Run it after react-markdown's `defaultUrlTransform`, so unsafe schemes are blanked
 * first (an empty URL stays empty).
 */
export function resolveItemUrl(url: string, base: LinkBase): string {
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return url;
  if (base.kind === 'gitlab' && url.startsWith('/uploads/')) return `${base.repoUrl}${url}`;
  return `${base.rootUrl}${url}`;
}
