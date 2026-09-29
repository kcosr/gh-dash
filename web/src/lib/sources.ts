/**
 * Pure helpers for Settings → Sources (the GitLab sources' cards and the desktop app's Add GitLab form). Kept free of
 * React so they're unit-tested (shared/sources-view.test.ts).
 */
import type { ConfigSource, Source, SourceAccount, SourceSyncStatus } from '../../../shared/api';
import type { CredentialDraft, DesktopState, SourceDraft, SourceMethod } from '../../../shared/desktop';
import { fmtNum, plural, relLong } from './time';

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
  if (env === 'locks') return ['env'];
  return env === 'offered' ? ['app', 'glab', 'file', 'env'] : ['app', 'glab', 'file'];
}

/** What the form holds for a credential. */
export interface CredentialForm {
  method: SourceMethod;
  token: string;
  remember: boolean;
  /** The file main's picker returned (display only: main keeps its own copy). */
  file: string | null;
}

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
  const credential = credentialOf(f);
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
