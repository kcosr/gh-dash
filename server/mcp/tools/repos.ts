// whoami, list_repos, resolve_repo: who the agent is here, and which repositories gh-dash tracks.

import { z } from 'zod';
import { GITHUB_HOST } from '../../../shared/api';
import { inputHost, parseGitHubInput, parseGitLabInput } from '../../../shared/repos';
import { parseSources } from '../../api/scope';
import type { Db } from '../../db/db';
import { type RepoRef, resolveRepo as resolveKey, resolveRepoOn } from '../../db/repo-key';
import { type SourceRow, sourceKey } from '../../db/sources';
import { HttpError } from '../../lib/errors';
import { queryRepos } from '../../services/repos';
import { limitArg } from '../format';
import { reachableSources, reaches, reposInReach, requireSourcesInReach } from '../reach';
import { readTool } from '../tool';

/** What whoami says of an agent the user limited to some sources. */
const SCOPED_NOTE =
  'The user limited you to these sources: gh-dash answers for repositories and threads on any other as for ones it ' +
  "doesn't track or have. Only the user can change that (Settings → Agents).";

export const whoami = readTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'Your agent identity in gh-dash (comments you write are attributed to it), the gh-dash version, and the code hosts it ' +
    'tracks repositories on that you may reach (`scoped`: the user limited you to those). gh-dash is the user\'s review ' +
    'dashboard: its comments are local, never posted to GitHub or GitLab.',
  input: z.object({}).strict(),
  run: (_args, ctx) => ({
    agent: { id: ctx.principal.id, name: ctx.principal.name, ...(ctx.sources !== null ? { scoped: true } : {}) },
    server: { version: ctx.deps.config.version },
    sources: reachableSources(ctx).map((s) => ({ host: s.host, kind: s.kind })),
    ...(ctx.sources !== null ? { note: SCOPED_NOTE } : {}),
  }),
});

/** Open threads per repo id. */
function openThreads(db: Db): Map<number, number> {
  const rows = db.all<{ repo_id: number; n: number }>("SELECT repo_id, count(*) AS n FROM comment_threads WHERE status = 'open' GROUP BY repo_id");
  return new Map(rows.map((r) => [r.repo_id, r.n]));
}

export const listRepos = readTool({
  name: 'list_repos',
  title: 'List repositories',
  description:
    'Repositories gh-dash tracks that you may reach, most recently active first. `key` is how every other tool names a ' +
    'repository. To find the one a local clone is of, prefer resolve_repo with its remote URL.',
  input: z
    .object({
      query: z.string().max(200).optional().describe('Case-insensitive text in the key, description, topics or language'),
      source: z.string().max(253).optional().describe('Only repositories on this host (e.g. github.com)'),
      ownership: z.enum(['all', 'mine', 'others']).default('all').describe("mine: the user's own (tracked automatically); others: added by hand"),
      limit: limitArg(500, 50),
    })
    .strict(),
  run: ({ query, source, ownership, limit }, ctx) => {
    const { deps } = ctx;
    const { db } = deps;
    requireSourcesInReach(ctx, parseSources(source));
    const all = reposInReach(ctx, queryRepos(deps, { q: query, source, sort: 'activity' })).filter(
      (r) => ownership === 'all' || (ownership === 'mine') === (r.trackedBy === 'owned'),
    );
    const ids = new Map(db.all<{ id: number; key: string }>('SELECT id, key FROM repos WHERE removed_at IS NULL').map((r) => [r.key, r.id]));
    const open = openThreads(db);
    return {
      repos: all.slice(0, limit).map((r) => ({
        key: r.key,
        provider: r.provider,
        url: r.url,
        defaultBranch: r.defaultBranch,
        trackedBy: r.trackedBy,
        openPrs: r.stats.openPrs,
        openThreads: open.get(ids.get(r.key) ?? 0) ?? 0,
        ...(r.isArchived ? { archived: true } : {}),
        ...(r.hidden ? { hidden: true } : {}),
      })),
      total: all.length,
    };
  },
});

/**
 * A git remote as a host and a path: `https://[user[:password]@]host[:port]/path`, `ssh://[user@]host[:port]/path`,
 * `git://host/path`, `[user@]host:path` (scp-like). `web`: an http(s) URL, whose path may include a GitLab instance's
 * relative root. null for anything else (a key, `owner/name`).
 */
function remoteParts(input: string): { host: string; path: string; web: boolean } | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return { host: host === 'www.github.com' ? GITHUB_HOST : host, path: decodeURIComponent(url.pathname).replace(/^\/+/, ''), web: /^https?:$/i.test(url.protocol) };
  }
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(input);
  return scp ? { host: scp[1]!.toLowerCase(), path: scp[2]!, web: false } : null;
}

/**
 * A host that isn't a source (of those the agent may reach, when the user limited it: the others read the same, whether
 * or not gh-dash has them).
 */
const notASource = (host: string, scoped: boolean) =>
  scoped
    ? `${host} isn't a source of gh-dash's that you may reach (whoami lists yours). The user decides which ones an agent reaches.`
    : `${host} isn't a source in gh-dash. The user can add it in gh-dash (Settings → Sources), then track the repository.`;

/**
 * The source and provider path a remote URL (or key) names, among `sources` (those the agent may reach: `scoped` when
 * that isn't all of them); HttpError 404 when gh-dash can't place it.
 */
function locateRemote(input: string, sources: SourceRow[], scoped: boolean): { src: SourceRow; path: string } {
  const text = input.trim();
  const remote = remoteParts(text);
  const host = remote?.host ?? inputHost(text, sources.map((s) => s.host)) ?? inputHost(text, [], { guess: true }) ?? GITHUB_HOST;
  const src = sources.find((s) => s.host === host);
  if (!src) throw new HttpError(404, notASource(host, scoped));
  // Back into a form the shared parsers read, without credentials (a CI remote can carry a token).
  const canonical = remote ? (remote.web ? `https://${host}/${remote.path}` : `ssh://${host}/${remote.path}`) : text;
  let path: string | null;
  if (src.kind === 'gitlab') {
    path = parseGitLabInput(canonical, { host: src.host, baseUrl: src.baseUrl })?.path ?? null;
  } else {
    const p = parseGitHubInput(remote ? `${GITHUB_HOST}/${remote.path}` : text);
    path = p ? `${p.owner}/${p.name}` : null;
  }
  if (!path) throw new HttpError(404, `Can't read a ${src.kind === 'gitlab' ? 'GitLab project' : 'GitHub repository'} from "${text.slice(0, 200)}".`);
  return { src, path };
}

export const resolveRepo = readTool({
  name: 'resolve_repo',
  title: 'Resolve a git remote',
  description:
    'The gh-dash repository key for a git remote URL (the output of `git remote get-url origin`: https, ssh or ' +
    'git@host:path forms). Works offline. An error says when the host or the repository isn\'t tracked in gh-dash (or is ' +
    'out of your reach: see whoami).',
  input: z.object({ remote_url: z.string().min(1).max(2000).describe('A git remote URL, or a repository key') }).strict(),
  run: ({ remote_url }, ctx) => {
    const { db } = ctx.deps;
    const text = remote_url.trim();
    const answer = (ref: RepoRef) => {
      const row = db.get<{ url: string; kind: 'github' | 'gitlab' }>('SELECT r.url, s.kind FROM repos r JOIN sources s ON s.id = r.source_id WHERE r.id = ?', [ref.id])!;
      return { key: ref.key, provider: row.kind, url: row.url, tracked: true };
    };
    // A key (or an owned repo's short name) as it is. One out of reach is read as the others are: on a source that isn't one.
    const known = remoteParts(text) ? null : resolveKey(db, text);
    if (known && reaches(ctx.sources, known.sourceId)) return answer(known);
    const { src, path } = locateRemote(text, reachableSources(ctx), ctx.sources !== null);
    const ref = resolveRepoOn(db, path, src);
    if (!ref) {
      throw new HttpError(404, `${sourceKey(src, path)} isn't tracked in gh-dash. The user can add it in gh-dash (Repositories → Add).`);
    }
    return answer(ref);
  },
});
