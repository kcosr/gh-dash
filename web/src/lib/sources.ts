/**
 * Sources in the web app, kept free of React so they're unit-tested (shared/sources-view.test.ts,
 * shared/add-sources.test.ts):
 * - which sources the app works with (add to, sync) and what stands in their way (design §7.5, §7.9);
 * - Settings → Sources (the GitLab sources' blocks and the desktop app's Add GitLab form).
 */
import { GITHUB_HOST } from '../../../shared/api';
import type { ConfigSource, ProviderKind, Repo, Source, SourceAccount, SourceSyncStatus, SyncStatus } from '../../../shared/api';
import type { CredentialDraft, DesktopState, SourceDraft, SourceMethod } from '../../../shared/desktop';
import { PROVIDERS } from '../../../shared/provider';
import { presentSources } from './contexts';
import type { SourceInfo } from './contexts';
import { fmtNum, plural, relLong } from './time';

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

/** What stands in the way of a source syncing: it isn't in this instance's config, it has no token, or the token is another account's. */
export type Trouble = 'not-configured' | 'no-token' | 'mismatch';

/**
 * What stands in a source's way, from `/sources` (`configured`, its account) and its live sync status (polled, so
 * fresher than the account for a token that just appeared or went).
 */
export function troubleOf(src: Pick<Source, 'configured' | 'account'>, live: Pick<SourceSyncStatus, 'tokenSource' | 'problem'>): Trouble | null {
  if (!src.configured) return 'not-configured';
  if (live.tokenSource === 'none' && (src.account?.source ?? 'none') === 'none') return 'no-token';
  if (src.account?.mismatch) return 'mismatch';
  // A configured source with a token has one other problem the sync reports: its account isn't this database's.
  return live.problem && live.tokenSource !== 'none' ? 'mismatch' : null;
}

/** A source the app works with: how the switcher names it, where it lives, and what stands in its way. */
export interface WorkSource extends SourceInfo {
  /** `Source.url`: its web URL with any relative root ("https://gitlab.example.com/gitlab"), what pasted addresses are read against. */
  baseUrl: string;
  /** Its part of the sync, live (the polled sync status), else as `/sources` last said. */
  status: SourceSyncStatus;
  trouble: Trouble | null;
  /** Set up and able to sync, but nothing synced from it yet: no repos, no last sync. */
  awaitingFirstSync: boolean;
}

const githubStatus = (st: readonly SourceSyncStatus[]): SourceSyncStatus =>
  st.find((s) => s.source === GITHUB_HOST) ?? {
    source: GITHUB_HOST, running: false, progress: null, lastSyncAt: null, lastResult: null, rateLimit: null, tokenSource: 'none', viewer: null, problem: null,
  };

/**
 * The sources worth showing: the sources present (see `presentSources`: those with live repos, and those set up here),
 * each with its live status and what stands in its way. Never empty once anything is known: github.com stands in when
 * nothing else qualifies (a fresh install). `sources`: GET /sources, null while it loads; until then github.com alone
 * is known, from its sync status. `githubMismatch`: the GitHub account check says the token is another account's
 * (its `/account` answers this without waiting for a sync).
 */
export function workSources(
  sources: readonly Source[] | null,
  statuses: readonly SourceSyncStatus[],
  repos: readonly Pick<Repo, 'source' | 'provider'>[],
  opts: { githubMismatch?: boolean } = {},
): WorkSource[] {
  if (!sources) {
    if (!statuses.length) return [];
    const status = githubStatus(statuses);
    return [{
      host: GITHUB_HOST, kind: 'github', name: 'GitHub', baseUrl: 'https://github.com', status, awaitingFirstSync: false,
      trouble: opts.githubMismatch ? 'mismatch' : status.tokenSource === 'none' ? 'no-token' : null,
    }];
  }
  const present = presentSources(repos, sources);
  const chosen = present.length ? present : presentSources([{ source: GITHUB_HOST, provider: 'github' }]);
  const withRepos = new Set(repos.map((r) => r.source));
  return chosen.map((info) => {
    const src = sources.find((s) => s.host === info.host);
    const status = statuses.find((s) => s.source === info.host) ?? src?.sync ?? githubStatus(statuses);
    const trouble = info.host === GITHUB_HOST && opts.githubMismatch ? 'mismatch'
      : src ? troubleOf(src, status) : status.tokenSource === 'none' ? 'no-token' : null;
    return {
      ...info,
      baseUrl: src?.url ?? `https://${info.host}`,
      status,
      trouble,
      awaitingFirstSync: !trouble && !withRepos.has(info.host) && !status.lastSyncAt && !(src && src.repos.owned + src.repos.added),
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

/** Where Settings → Sources shows a source: GitHub's block, or the GitLab source's own. */
export const sourceSettingsLink = (host: string) => (host === GITHUB_HOST ? '/settings#account' : `/settings#source-${host}`);

/** "GitHub", "GitLab (gitlab.example.com)": a source named with its host where the kind alone could be several. */
export const sourceLabel = (w: Pick<WorkSource, 'host' | 'kind'>) => (w.kind === 'github' ? PROVIDERS.github.name : `${PROVIDERS[w.kind].name} (${w.host})`);

/** What the notice says about a source, or null when there is nothing to say. */
export function noticeText(w: Pick<WorkSource, 'host' | 'kind' | 'trouble' | 'awaitingFirstSync' | 'status'>): { text: string; setUp: boolean } | null {
  const who = sourceLabel(w);
  switch (w.trouble) {
    case 'no-token': return { text: `${who} has no token`, setUp: true };
    case 'not-configured': return { text: `${who} isn't configured here, so it isn't synced`, setUp: false };
    case 'mismatch': return { text: `${who}'s token is for another account, so it isn't synced`, setUp: false };
  }
  if (!w.awaitingFirstSync) return null;
  return { text: w.status.running ? `${who}: first sync in progress` : `${who} hasn't synced yet`, setUp: false };
}

/** The source the Add dialog starts on: the context's; in All, the last one used, else GitHub; else the first. */
export function addDefault<S extends { host: string }>(sources: readonly S[], context: string | null, lastUsed: string | null): S | null {
  for (const host of [context, lastUsed, GITHUB_HOST]) {
    const found = host ? sources.find((s) => s.host === host) : undefined;
    if (found) return found;
  }
  return sources[0] ?? null;
}

/**
 * What the URL field holds, as the source would be saved: https:// when no scheme is typed, the relative root kept,
 * no trailing slash (the server's rules, server/gitlab/transport.ts normalizeBaseUrl). null while it's empty.
 */
export function gitlabUrlInput(text: string): { baseUrl: string; host: string } | { error: string } | null {
  const raw = text.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: 'Enter the address of your GitLab, like https://gitlab.example.com.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'The address starts with https:// (or http://).' };
  if (url.username || url.password || url.search || url.hash) return { error: 'Leave out any user name, password, ? or #.' };
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return { error: 'That is not a host name.' };
  if (host === 'github.com') return { error: 'github.com is built in: it is the GitHub source above.' };
  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, host };
}

/** Where a GitLab source's token comes from, in words (its SourceAccount; the desktop app's keychain for a pasted one). */
export function sourceMethodLabel(a: Pick<SourceAccount, 'source' | 'choice' | 'env'>, opts: { desktop?: boolean; remembered?: boolean } = {}): string {
  switch (a.source) {
    case 'env': return opts.desktop ? `${a.env ?? 'GITLAB_TOKEN'} environment variable` : `${a.env ?? 'GITLAB_TOKEN'} (environment)`;
    case 'file': return 'Token file';
    case 'glab': return 'GitLab CLI (glab config get token)';
    case 'app': return opts.remembered ? 'Pasted token, saved in the OS keychain' : 'Pasted token, kept until gh-dash quits';
    case 'gh-cli': return 'GitHub CLI';
    case 'none': return a.choice === null ? 'Not connected' : 'No token found';
  }
}

/** "56 personal · 3 added · 1 hidden": what the token sees in its namespace (else what is tracked), and the rest. */
export function projectsLine(s: Pick<Source, 'repos'> & { account: Pick<SourceAccount, 'repos'> | null }): string {
  const personal = s.account?.repos?.total ?? s.repos.owned;
  const parts = [`${fmtNum(personal)} personal`];
  if (s.repos.added) parts.push(`${fmtNum(s.repos.added)} added`);
  if (s.repos.hidden) parts.push(`${fmtNum(s.repos.hidden)} hidden`);
  return parts.join(' · ');
}

/** "5 min ago · 12 new items · 1 error", "Syncing 3/10", or "Never synced". */
export function syncLine(sync: Pick<SourceSyncStatus, 'running' | 'progress' | 'lastSyncAt' | 'lastResult'>, now = Date.now()): string {
  if (sync.running) return sync.progress ? `Syncing ${sync.progress.done}/${sync.progress.total}` : 'Syncing';
  if (!sync.lastSyncAt) return 'Never synced';
  const parts = [relLong(sync.lastSyncAt, now)];
  if (sync.lastResult) {
    parts.push(`${fmtNum(sync.lastResult.newItems)} new ${plural(sync.lastResult.newItems, 'item')}`);
    if (sync.lastResult.errors.length) parts.push(`${sync.lastResult.errors.length} ${plural(sync.lastResult.errors.length, 'error')}`);
  }
  return parts.join(' · ');
}

/**
 * How a source can be removed from here:
 * - `app`: the desktop app added it (its config.json): Remove… takes it out and deletes its data;
 * - `delete`: no longer configured on this server: Remove… deletes its data (DELETE /sources/:host);
 * - `file` / `env`: configured by this server's config.json or GH_DASH_GITLAB_URL: only there;
 * - `desktop`: a desktop app's server seen in a browser: only in the app;
 * - null: github.com, which is built in.
 */
export type RemoveMode = 'app' | 'delete' | 'file' | 'env' | 'desktop' | null;
export function removeMode(
  s: Pick<Source, 'host' | 'kind' | 'configured' | 'removable'>,
  ctx: { desktopHosts: string[] | null; desktopServer: boolean; from: ConfigSource | null },
): RemoveMode {
  if (s.kind === 'github') return null;
  if (ctx.desktopHosts?.includes(s.host)) return 'app';
  if (s.removable || !s.configured) return 'delete';
  if (ctx.desktopServer) return 'desktop';
  return ctx.from === 'env' ? 'env' : 'file';
}

/** The ways to sign in that the Add / Change forms offer, given GITLAB_TOKEN (DesktopState.gitlabEnv). */
export function methodsFor(env: DesktopState['gitlabEnv'] | undefined): SourceMethod[] {
  return env === 'offered' ? ['app', 'glab', 'file', 'env'] : ['app', 'glab', 'file'];
}

/** What the form holds for a credential. */
export interface CredentialForm {
  method: SourceMethod;
  token: string;
  remember: boolean;
  /** The file main's picker returned (display only: main keeps its own copy), and the host it was picked for. */
  file: string | null;
  fileHost?: string | null;
}

/** The picked file, if it was picked for `host` (main uses a file only for the host it was picked for). */
export const fileFor = (f: Pick<CredentialForm, 'file' | 'fileHost'>, host: string | null) => (f.file && (f.fileHost ?? null) === host ? f.file : null);

/** The credential to send, or why it can't be sent yet. */
export function credentialOf(f: CredentialForm): CredentialDraft | { missing: string } {
  switch (f.method) {
    case 'app': return f.token.trim() ? { method: 'app', token: f.token.trim(), remember: f.remember } : { missing: 'Paste a token.' };
    case 'file': return f.file ? { method: 'file' } : { missing: 'Choose the token file.' };
    case 'glab': return { method: 'glab' };
    case 'env': return { method: 'env' };
  }
}

/** The draft to test or add, or why it can't be yet. */
export function draftOf(url: string, f: CredentialForm): SourceDraft | { missing: string } {
  const target = gitlabUrlInput(url);
  if (!target) return { missing: "Enter your GitLab's address." };
  if ('error' in target) return { missing: target.error };
  const credential = credentialOf({ ...f, file: f.fileHost === undefined ? f.file : fileFor(f, target.host) });
  if ('missing' in credential) return credential;
  return { kind: 'gitlab', url: target.baseUrl, ...credential };
}

/**
 * The inputs a test was made with: Add GitLab is enabled only while they are unchanged. The token is part of it (it
 * stays in this tab's memory, as it is in the input), never sent anywhere but to the app.
 */
export function draftKey(d: SourceDraft, file: string | null): string {
  return JSON.stringify([d.url, d.method, d.method === 'app' ? d.token : null, d.method === 'file' ? file : null]);
}
