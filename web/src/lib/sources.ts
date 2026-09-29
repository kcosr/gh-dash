/**
 * The sources the app can work with (add to, sync), and what stands in their way (design §7.5, §7.9). Everything here
 * is derived from what the server already reports: `SyncStatus.sources` (every source the database knows, with its
 * token and its problem) and the repo list (which sources have repos, and where they live). It is the one seam to swap
 * for `/sources` (`Source.configured`, its account) once the web reads that.
 */
import { GITHUB_HOST, type ProviderKind, type Repo, type SourceSyncStatus, type SyncStatus } from '../../../shared/api';
import { sourceRootUrl } from '../../../shared/provider';
import type { SourceInfo } from './contexts';

/** The kind of code host a host name is: github.com is GitHub, any other source is a GitLab (the only other kind so far). */
export const kindOfHost = (host: string): ProviderKind => (host === GITHUB_HOST ? 'github' : 'gitlab');

/** The sources' sync statuses, github.com first. A server that reports none (an older build) has github.com alone, from the run-level fields. */
export function sourceStatuses(st: SyncStatus | undefined): SourceSyncStatus[] {
  if (!st) return [];
  if (st.sources?.length) return st.sources;
  return [{
    source: GITHUB_HOST, running: st.running, progress: st.progress, lastSyncAt: st.lastSyncAt, lastResult: st.lastResult,
    rateLimit: st.rateLimit, tokenSource: st.tokenSource, viewer: st.viewer, problem: null,
  }];
}

/**
 * Whether this instance's config has the source. github.com always does. `SourceSyncStatus` says it in its problem
 * ("GitLab (gitlab.example.com) isn't configured on this server") and by having no token; until `/sources` says it
 * outright, that is where it is read from.
 */
export function isConfigured(s: SourceSyncStatus): boolean {
  return s.source === GITHUB_HOST || s.tokenSource !== 'none' || !/isn't configured on this server/.test(s.problem ?? '');
}

/** What stands in the way of a source syncing: it isn't in this instance's config, it has no token, or the token is another account's. */
export type Trouble = 'not-configured' | 'no-token' | 'mismatch';

export function troubleOf(s: SourceSyncStatus): Trouble | null {
  if (!s.problem) return s.tokenSource === 'none' && s.source === GITHUB_HOST ? 'no-token' : null;
  if (!isConfigured(s)) return 'not-configured';
  return s.tokenSource === 'none' ? 'no-token' : 'mismatch';
}

/** A source the app works with: how the switcher names it, where it lives, and what stands in its way. */
export interface WorkSource extends SourceInfo {
  /** Its web URL with any relative root ("https://gitlab.example.com/gitlab"), what pasted addresses are read against. */
  baseUrl: string;
  status: SourceSyncStatus;
  trouble: Trouble | null;
}

/**
 * The sources worth showing: those with live repos, with a token, or (other than github.com) configured here. A
 * GitLab-only user never sees an empty GitHub source, and a GitLab in the database that this instance doesn't have
 * shows only while it has repos. Never empty: github.com stands in when nothing else qualifies. github.com first,
 * then by host. `githubMismatch`: the GitHub account check says the token is another account's (its `/account`
 * answers this without waiting for a sync).
 */
export function workSources(
  statuses: readonly SourceSyncStatus[],
  repos: readonly Pick<Repo, 'source' | 'url' | 'nameWithOwner'>[],
  opts: { githubMismatch?: boolean } = {},
): WorkSource[] {
  const withRepos = new Set(repos.map((r) => r.source));
  const wanted = statuses.filter((s) => withRepos.has(s.source) || s.tokenSource !== 'none' || (s.source !== GITHUB_HOST && isConfigured(s)));
  const chosen = wanted.length ? wanted : statuses.filter((s) => s.source === GITHUB_HOST);
  const sorted = [...chosen].sort((a, b) => Number(b.source === GITHUB_HOST) - Number(a.source === GITHUB_HOST) || a.source.localeCompare(b.source));
  const gitlabs = sorted.filter((s) => kindOfHost(s.source) === 'gitlab').length;
  return sorted.map((status) => {
    const host = status.source;
    const kind = kindOfHost(host);
    const home = repos.find((r) => r.source === host);
    return {
      host, kind, name: kind === 'github' ? 'GitHub' : gitlabs > 1 ? host : 'GitLab',
      baseUrl: home ? sourceRootUrl(home) : `https://${host}`,
      status,
      trouble: host === GITHUB_HOST && opts.githubMismatch ? 'mismatch' : troubleOf(status),
    };
  });
}

/** The first source with something in its way: the one the top bar names in All. */
export const firstTrouble = (sources: readonly WorkSource[]): WorkSource | null => sources.find((s) => s.trouble) ?? null;

/** "GitHub", "GitLab", "GitHub and GitLab": the code hosts of these sources, each named once. */
export function hostNames(sources: readonly Pick<WorkSource, 'kind'>[]): string {
  const names = [...new Set(sources.map((s) => (s.kind === 'github' ? 'GitHub' : 'GitLab')))].sort();
  return names.join(' and ');
}

/** The top bar's words for a trouble: "No token" alone, "GitLab: no token" where several sources could be meant. */
export function troubleLabel(w: Pick<WorkSource, 'name' | 'trouble'>, named: boolean): string {
  const text = w.trouble === 'mismatch' ? 'account mismatch' : w.trouble === 'not-configured' ? 'not configured' : 'no token';
  return named ? `${w.name}: ${text}` : text[0]!.toUpperCase() + text.slice(1);
}

/** The source the Add dialog starts on: the context's; in All, the last one used, else GitHub; else the first. */
export function addDefault<S extends { host: string }>(sources: readonly S[], context: string | null, lastUsed: string | null): S | null {
  for (const host of [context, lastUsed, GITHUB_HOST]) {
    const found = host ? sources.find((s) => s.host === host) : undefined;
    if (found) return found;
  }
  return sources[0] ?? null;
}
