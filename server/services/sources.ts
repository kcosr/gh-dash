// The sources API as plain functions (see services/lists.ts): what each source is, its credential and sync state, a
// fresh check of its credential, and removing an unconfigured one with its data. Sources are added, and their
// credentials changed, elsewhere (config.json / the environment, or the desktop app), never through here (design §1.6).

import { GITHUB_HOST, type Source, type SourceCheck, type TokenChoice } from '../../shared/api';
import type { SourceTestDraft } from '../../shared/desktop';
import { sourceUrl } from '../config-file';
import type { Db } from '../db/db';
import { GITHUB_SOURCE_ID, removeSource } from '../db/sources';
import type { DiffService } from '../diff/service';
import { GITLAB_TOKEN_ENV } from '../gitlab/credentials';
import { HttpError } from '../lib/errors';
import { reachedAt, type SourceRegistry, type SourceRuntime } from '../sources/registry';
import type { SyncManager } from '../sync/manager';
import { notASource } from '../sync/tracking';

export interface SourceDeps {
  db: Db;
  sources: Pick<SourceRegistry, 'list' | 'byHost' | 'apply'>;
  sync: Pick<SyncManager, 'status'>;
  diffs: Pick<DiffService, 'evict'>;
}

type RepoCounts = Source['repos'];

/** Live repositories per source: tracked automatically, added by hand, and hidden from the default selection. */
function repoCounts(db: Db): Map<number, RepoCounts> {
  const rows = db.all<{ source_id: number; total: number; added: number; hidden: number }>(
    `SELECT source_id, count(*) AS total, sum(tracked_by = 'manual') AS added, sum(hidden) AS hidden
     FROM repos WHERE removed_at IS NULL GROUP BY source_id`,
  );
  return new Map(rows.map((r) => [r.source_id, { owned: r.total - r.added, added: r.added, hidden: r.hidden }]));
}

/** Whether DELETE would remove the source now: not github.com, and not while this server has it configured. */
const removable = (runtime: SourceRuntime) => runtime.id !== GITHUB_SOURCE_ID && !runtime.configured;

async function describeSources(deps: SourceDeps, runtimes: SourceRuntime[]): Promise<Source[]> {
  // Never calls the provider: the token as last resolved and validated. Read first, so the sync status below sees the
  // token it resolved (the first read of a source waits for its resolution).
  const accounts = await Promise.all(runtimes.map((runtime) => (runtime.configured ? runtime.tokens.account() : null)));
  const counts = repoCounts(deps.db);
  const status = deps.sync.status().sources;
  return runtimes.map((runtime, i): Source => {
    const row = runtime.row;
    const sync = status.find((s) => s.source === runtime.host);
    if (!sync) throw new Error(`The sync status has no entry for ${runtime.host}`);
    return {
      host: runtime.host,
      kind: runtime.kind,
      name: row.name,
      // Where this server reaches it (the configured URL), which the web reads pasted URLs against.
      url: reachedAt(row, runtime.config),
      configured: runtime.configured,
      removable: removable(runtime),
      viewer: row.viewer ? { login: row.viewer.login, name: row.viewer.name, avatarUrl: row.viewer.avatarUrl } : null,
      account: accounts[i]!,
      sync,
      repos: counts.get(runtime.id) ?? { owned: 0, added: 0, hidden: 0 },
    };
  });
}

function runtimeOf(deps: SourceDeps, host: string): SourceRuntime {
  const runtime = deps.sources.byHost(host);
  if (!runtime) throw new HttpError(404, notASource(host.toLowerCase()));
  return runtime;
}

/** Every source this database knows, github.com first, including ones this server doesn't configure. Calls no provider. */
export function listSourceViews(deps: SourceDeps): Promise<Source[]> {
  return describeSources(deps, deps.sources.list());
}

/** One source by its host (case-insensitive); 404 when it isn't one. Calls no provider. */
export async function getSourceView(deps: SourceDeps, host: string): Promise<Source> {
  return (await describeSources(deps, [runtimeOf(deps, host)]))[0]!;
}

/**
 * Resolves the source's token again and validates it against the provider now (github.com: 1 GraphQL point; GitLab: 2
 * requests). 404 for an unknown source; 503 when there is no token to check (the reason is in the message, and the
 * source as it stands in `details`). A token the provider rejects is not an error here: `account.error` says so.
 */
export async function checkSource(deps: SourceDeps, host: string): Promise<Source> {
  const runtime = runtimeOf(deps, host);
  const account = await runtime.tokens.check();
  const source = await getSourceView(deps, runtime.host);
  if (account.source === 'none') throw new HttpError(503, runtime.tokens.noTokenMessage(), source);
  return source;
}

/**
 * Removes a source and everything tracked on it (its repos, and with them every pull request, commit, issue, release and
 * star), then its cached diffs. 404 for an unknown source; 409 for github.com, which is built in, and for a source this
 * server still has configured: take it out of the configuration first (the desktop app's Settings, config.json, or the
 * environment), so that it isn't synced again.
 */
export function deleteSource(deps: SourceDeps, host: string): { repos: number } {
  const runtime = runtimeOf(deps, host);
  if (runtime.id === GITHUB_SOURCE_ID) throw new HttpError(409, `${GITHUB_HOST} is built in and can't be removed.`);
  if (runtime.configured) {
    const how = runtime.config?.from === 'env' ? 'Unset GH_DASH_GITLAB_URL' : 'Remove it in Settings (desktop app) or from config.json';
    throw new HttpError(409, `${runtime.label} is still configured on this server. ${how} first.`);
  }
  const removed = removeSource(deps.db, runtime.id);
  // The registry keeps a runtime for every row in the database: drop this one.
  deps.sources.apply();
  deps.diffs.evict();
  return removed;
}

/** The credential settings each desktop method stands for (what the source's config.json entry will say). */
function draftCredential(draft: SourceTestDraft): { tokenChoice: TokenChoice | null; tokenFile: string | null; tokenEnv: string | null } {
  switch (draft.method) {
    case 'app':
      return { tokenChoice: 'app', tokenFile: null, tokenEnv: null };
    case 'glab':
      return { tokenChoice: 'glab', tokenFile: null, tokenEnv: null };
    case 'file':
      if (!draft.tokenFile) throw new HttpError(400, 'Choose the token file first.');
      return { tokenChoice: 'file', tokenFile: draft.tokenFile, tokenEnv: null };
    case 'env':
      return { tokenChoice: null, tokenFile: null, tokenEnv: draft.tokenEnv || GITLAB_TOKEN_ENV };
    default:
      throw new HttpError(400, `Unknown sign-in method: ${String((draft as { method?: unknown }).method)}`);
  }
}

/**
 * Tests a GitLab source that isn't configured yet, or a new credential for one that is (the desktop app's
 * test-source): resolves the token the draft describes with a throwaway provider and validates it (2 requests), then
 * compares the account with the one this database has for that host. Nothing is saved, and the running source (if
 * any) is left alone. `ok` when GitLab accepted the token and nothing conflicts; a rejected token, a missing scope or
 * no token at all is `account.error`. A URL that can't be a source is a 400.
 */
export async function testSourceDraft(deps: { sources: Pick<SourceRegistry, 'draft'> }, draft: SourceTestDraft): Promise<SourceCheck> {
  let target: { baseUrl: string; host: string };
  try {
    target = sourceUrl(draft.url);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (target.host === GITHUB_HOST) throw new HttpError(400, `${GITHUB_HOST} is built in: connect it under GitHub.`);
  const tokens = deps.sources.draft({ host: target.host, baseUrl: target.baseUrl, ...draftCredential(draft) });
  if (draft.method === 'app') tokens.setAppToken(draft.token ?? null);
  const account = await tokens.check();
  const conflict = account.mismatch
    ? `This dashboard's data from ${target.host} belongs to ${account.dbLogin ?? 'another account'}, but this token is for ${account.login ?? 'another account'}.`
    : null;
  return { ok: account.error === null && account.login !== null && conflict === null, host: target.host, url: target.baseUrl, account, conflict };
}
