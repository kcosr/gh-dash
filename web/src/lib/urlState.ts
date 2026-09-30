/**
 * URL = source of truth for every filter. One parser (with per-view defaults) and one
 * writer. Setters replace history entries while typing and push them for clicks.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { EVENT_TYPES } from '../../../shared/api';
import { isBranchName } from '../../../shared/branch';
import { encodeQueryValue } from '../../../shared/query';
import type { CommentFilter, EventType, GroupBy, Ownership, PrStateFilter, Repo, ThreadKindFilter, ThreadStatusFilter, VisibilityFilter, Who } from '../../../shared/api';
import { RANGE_IDS, resolveRange } from './range';
import type { RangeId, ResolvedRange } from './range';
import { isValidDateOnly } from './time';

export type ViewName = 'prs' | 'comments' | 'issues' | 'activity' | 'repos' | 'repo' | 'insights' | 'settings';
export type Density = 'titles' | 'summary' | 'full';
export type RepoSort = 'activity' | 'stars' | 'open' | 'name';
export type RepoLayout = 'grid' | 'list';
/** The diff's file list narrowed to files with comment threads, or with unresolved ones. */
export type FileFilter = 'commented' | 'unresolved';
/** The Comments list: one group per PR, branch or commit, per repo, or none. */
export type ThreadGroup = 'target' | 'repo' | 'none';
/** The Comments list: by last activity (newest or oldest first), or each PR's, branch's or commit's threads in file order. */
export type ThreadOrder = 'recent' | 'oldest' | 'file';
/** Who opened a thread (GET /threads `author`): you, any agent, or one agent (its principal id). */
export type ThreadAuthor = 'self' | 'agents' | number;
/**
 * The PR list's state: a PR state, or `nopr`, the branches with no PR yet listed in the PRs' place (GET /branches). The
 * web's own value: the API's PrStateFilter has no such state.
 */
export type PrListState = PrStateFilter | 'nopr';

export interface UrlState {
  /** The context: a source's host (`source=gitlab.example.com`), lower-case; null = All (param absent). */
  source: string | null;
  /** null = the default selection (param absent); [] = explicitly nothing. */
  repos: string[] | null;
  vis: VisibilityFilter;
  /** Repos you own ('mine'), repos added by hand ('others'), or both. */
  own: Ownership;
  who: Who;
  range: RangeId;
  from: string | null;
  to: string | null;
  /** PR list: a PR state or `nopr` (PrListState); Issues: an issue state ('merged' is never one). */
  state: PrListState;
  /** PR list: only PRs with local comment threads (any, or unresolved); null = all. */
  comments: CommentFilter | null;
  group: GroupBy;
  density: Density;
  rel: boolean;
  types: EventType[];
  q: string;
  /** "<repo>#<n>" open in the drawer. */
  pr: string | null;
  /** Diff open over the list and drawer: "<repo>#<n>" (a PR), "<repo>~<branch>" (a branch) or "<repo>@<oid>" (a commit). */
  diff: string | null;
  /** Path of the file in view in the open diff (only with `diff`). */
  file: string | null;
  /** Comment thread in focus in the open diff (only with `diff`). */
  thread: number | null;
  /** The open diff's file list narrowed (only with `diff`); j/k follow it. */
  only: FileFilter | null;
  // /repos only
  sort: RepoSort;
  layout: RepoLayout;
  // /comments only
  /** Unresolved ('open'), resolved or all threads. */
  status: ThreadStatusFilter;
  /** Threads on PRs, on branches, on commits, or all of them. */
  kind: ThreadKindFilter;
  /** The `group` param on /comments (elsewhere it is `group`). */
  threadGroup: ThreadGroup;
  /** The `sort` param on /comments (elsewhere it is `sort`). */
  threadSort: ThreadOrder;
  /** Who opened the thread; null = anyone. */
  author: ThreadAuthor | null;
  /** Only open threads whose last comment isn't yours (`waiting=you`). */
  waiting: boolean;
}

export type UrlPatch = Partial<UrlState>;

export function viewFromPath(pathname: string): ViewName {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/comments') return 'comments';
  if (p === '/issues') return 'issues';
  if (p.startsWith('/activity')) return 'activity';
  if (p === '/repos') return 'repos';
  if (p.startsWith('/repos/')) return 'repo';
  if (p.startsWith('/insights')) return 'insights';
  if (p.startsWith('/settings')) return 'settings';
  return 'prs';
}

export { repoFromPath } from '../../../shared/repos';

export function defaultsFor(view: ViewName): UrlState {
  return {
    source: null,
    repos: null,
    vis: 'all',
    own: 'all',
    who: view === 'prs' ? 'me' : 'everyone',
    range: view === 'insights' ? '90d' : '30d',
    from: null,
    to: null,
    state: view === 'issues' ? 'open' : 'merged',
    comments: null,
    group: 'week',
    density: 'summary',
    rel: true,
    types: [...EVENT_TYPES],
    q: '',
    pr: null,
    diff: null,
    file: null,
    thread: null,
    only: null,
    sort: 'activity',
    layout: 'grid',
    status: 'open',
    kind: 'all',
    threadGroup: 'target',
    threadSort: 'recent',
    author: null,
    waiting: false,
  };
}

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], dflt: T): T =>
  v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

const list = (v: string) => [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];

/** `author=self|agents|<principal id>`; anything else is anyone (null). */
export function parseAuthor(v: string | null): ThreadAuthor | null {
  if (v === 'self' || v === 'agents') return v;
  return v !== null && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : null;
}

export function parseUrlState(search: string, view: ViewName): UrlState {
  const p = new URLSearchParams(search);
  const d = defaultsFor(view);
  const reposRaw = p.get('repos');
  let range = oneOf(p.get('range'), RANGE_IDS, d.range);
  const from = p.get('from'), to = p.get('to');
  const customOk = isValidDateOnly(from) && isValidDateOnly(to);
  if (range === 'custom' && !customOk) range = d.range;
  const typesRaw = p.get('types');
  const typesValid = typesRaw === null ? [] : list(typesRaw).filter((t): t is EventType => (EVENT_TYPES as string[]).includes(t));
  // `types=` (empty) is an explicit "none"; a value naming no known type (typo, old link) is ignored.
  const typesDefault = typesRaw === null || (typesValid.length === 0 && typesRaw.trim() !== '');
  const pr = p.get('pr');
  const diff = p.get('diff');
  const diffOk = parseDiffId(diff) !== null;
  const thread = Number(p.get('thread'));
  const comments = p.get('comments');
  const only = p.get('only');
  // `group` and `sort` are per view: the Comments list's values are its own, and it leaves the others at their defaults.
  const threads = view === 'comments';
  return {
    // Any non-empty value: one that names no source is dropped once the repos are known (useCanonicalRepoUrl).
    source: p.get('source')?.trim().toLowerCase() || null,
    repos: reposRaw === null ? null : list(reposRaw),
    vis: oneOf(p.get('vis'), ['all', 'public', 'private', 'internal'] as const, d.vis),
    own: oneOf(p.get('own'), ['all', 'mine', 'others'] as const, d.own),
    who: oneOf(p.get('who'), ['me', 'others', 'everyone'] as const, d.who),
    range,
    from: range === 'custom' ? from : null,
    to: range === 'custom' ? to : null,
    // `nopr` is the PR list's alone.
    state: oneOf(p.get('state'), view === 'issues' ? ['open', 'closed', 'all'] as const : ['open', 'merged', 'closed', 'all', ...(view === 'prs' ? ['nopr'] as const : [])] as const, d.state),
    comments: view === 'prs' && (comments === 'any' || comments === 'unresolved') ? comments : null,
    group: threads ? d.group : oneOf(p.get('group'), ['day', 'week', 'month', 'repo'] as const, d.group),
    density: oneOf(p.get('density'), ['titles', 'summary', 'full'] as const, d.density),
    rel: p.get('rel') !== '0',
    // keep canonical EVENT_TYPES order
    types: typesDefault ? d.types : EVENT_TYPES.filter((t) => typesValid.includes(t)),
    q: p.get('q') ?? '',
    pr: pr && /^[^#\s]+#\d+$/.test(pr) ? pr : null,
    diff: diffOk ? diff : null,
    file: diffOk ? p.get('file') || null : null,
    thread: diffOk && Number.isInteger(thread) && thread > 0 ? thread : null,
    only: diffOk && (only === 'commented' || only === 'unresolved') ? only : null,
    sort: threads ? d.sort : oneOf(p.get('sort'), ['activity', 'stars', 'open', 'name'] as const, d.sort),
    layout: oneOf(p.get('layout'), ['grid', 'list'] as const, d.layout),
    status: threads ? oneOf(p.get('status'), ['open', 'resolved', 'all'] as const, d.status) : d.status,
    kind: threads ? oneOf(p.get('kind'), ['all', 'pr', 'branch', 'commit'] as const, d.kind) : d.kind,
    threadGroup: threads ? oneOf(p.get('group'), ['target', 'repo', 'none'] as const, d.threadGroup) : d.threadGroup,
    threadSort: threads ? oneOf(p.get('sort'), ['recent', 'oldest', 'file'] as const, d.threadSort) : d.threadSort,
    author: threads ? parseAuthor(p.get('author')) : d.author,
    waiting: threads && p.get('waiting') === 'you',
  };
}

/** Param order in written URLs (unknown params are kept at the end). */
const ORDER = ['source', 'repos', 'vis', 'own', 'who', 'range', 'from', 'to', 'state', 'status', 'kind', 'author', 'waiting', 'comments', 'group', 'density', 'rel', 'types', 'q', 'sort', 'layout', 'pr', 'diff', 'file', 'thread', 'only'];

/** Serialize a full state to params, omitting defaults for the view. */
function toParams(s: UrlState, view: ViewName): [string, string][] {
  const d = defaultsFor(view);
  const out: [string, string][] = [];
  if (s.source) out.push(['source', s.source]);
  if (s.repos !== null) out.push(['repos', s.repos.join(',')]);
  if (s.vis !== d.vis) out.push(['vis', s.vis]);
  if (s.own !== d.own) out.push(['own', s.own]);
  if (s.who !== d.who) out.push(['who', s.who]);
  if (s.range === 'custom' && s.from && s.to) out.push(['range', 'custom'], ['from', s.from], ['to', s.to]);
  else if (s.range !== d.range && s.range !== 'custom') out.push(['range', s.range]);
  if (s.state !== d.state) out.push(['state', s.state]);
  if (s.status !== d.status) out.push(['status', s.status]);
  if (s.kind !== d.kind) out.push(['kind', s.kind]);
  const threads = view === 'comments';
  if (threads && s.author !== null) out.push(['author', String(s.author)]);
  if (threads && s.waiting) out.push(['waiting', 'you']);
  if (s.comments) out.push(['comments', s.comments]);
  if (threads ? s.threadGroup !== d.threadGroup : s.group !== d.group) out.push(['group', threads ? s.threadGroup : s.group]);
  if (s.density !== d.density) out.push(['density', s.density]);
  if (!s.rel) out.push(['rel', '0']);
  if (s.types.length !== d.types.length) out.push(['types', s.types.join(',')]);
  if (s.q) out.push(['q', s.q]);
  if (threads ? s.threadSort !== d.threadSort : s.sort !== d.sort) out.push(['sort', threads ? s.threadSort : s.sort]);
  if (s.layout !== d.layout) out.push(['layout', s.layout]);
  if (s.pr) out.push(['pr', s.pr]);
  if (s.diff) {
    out.push(['diff', s.diff]);
    if (s.file) out.push(['file', s.file]);
    if (s.thread) out.push(['thread', String(s.thread)]);
    if (s.only) out.push(['only', s.only]);
  }
  return out;
}

/** Encode keeping ',', '/' and '@' readable (lists, file paths, commit diffs); '#', '&', spaces etc. are escaped. */
export function encodeParams(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeQueryValue(v)}`).join('&');
}

/** Apply a patch to a search string for a view; returns "?..." or "". */
export function patchSearch(search: string, view: ViewName, patch: UrlPatch): string {
  const cur = parseUrlState(search, view);
  const next = { ...cur, ...patch };
  if (patch.range && patch.range !== 'custom') { next.from = null; next.to = null; }
  const pairs = toParams(next, view);
  // keep params we don't know about
  const known = new Set(ORDER);
  // Retired repository toggles: selection is now controlled entirely by the sidebar.
  known.add('archived');
  known.add('forks');
  for (const [k, v] of new URLSearchParams(search)) if (!known.has(k)) pairs.push([k, v]);
  const qs = encodeParams(pairs);
  return qs ? `?${qs}` : '';
}

/** The filters on repos; `source` absent is All. */
type RepoFilters = Pick<UrlState, 'vis' | 'own'> & { source?: string | null };

/** Whether a repo is in the context: on its source, or any repo in All. */
export function inContext(r: Partial<Pick<Repo, 'source'>>, source: string | null | undefined): boolean {
  return !source || r.source === source;
}

/** Whether a repo passes the context and the visibility and ownership filters (sidebar list, selection counts). */
export function passesRepoFilters(r: Pick<Repo, 'visibility' | 'trackedBy'> & Partial<Pick<Repo, 'source'>>, s: RepoFilters): boolean {
  return inContext(r, s.source) && (s.vis === 'all' || r.visibility === s.vis) && (s.own === 'all' || (s.own === 'mine') === (r.trackedBy === 'owned'));
}

/**
 * Filtering to one repo: reset the visibility and ownership filters it doesn't pass (`vis=private` and a public repo,
 * `own=mine` and a repo added by hand), or the list would come back empty. A repo on another source than the context's
 * takes the context with it (in All, nothing changes). Unknown repos change nothing.
 */
export function keepRepoInScope(repo: (Pick<Repo, 'visibility' | 'trackedBy'> & Partial<Pick<Repo, 'source'>>) | undefined, s: RepoFilters): UrlPatch {
  const patch: UrlPatch = {};
  if (!repo) return patch;
  if (s.source && repo.source && s.source !== repo.source) patch.source = repo.source;
  if (s.vis !== 'all' && s.vis !== repo.visibility) patch.vis = 'all';
  if (s.own !== 'all' && (s.own === 'mine') !== (repo.trackedBy === 'owned')) patch.own = 'all';
  return patch;
}

/** Scope params carried across top-level navigation (the context first). */
export const SCOPE_KEYS = ['source', 'repos', 'vis', 'own', 'who', 'range', 'from', 'to'];

export function carrySearch(search: string, keys = SCOPE_KEYS): string {
  const p = new URLSearchParams(search);
  const pairs: [string, string][] = [];
  for (const k of keys) { const v = p.get(k); if (v !== null) pairs.push([k, v]); }
  const qs = encodeParams(pairs);
  return qs ? `?${qs}` : '';
}

/** The context param alone, for links that leave the rest of the scope behind ("?source=…" or ""). */
export function contextSearch(search: string): string {
  return carrySearch(search, ['source']);
}

/** "source=…&repos=<key>" (or just the repos): a link about one repo that stays in the context. */
export function repoLinkSearch(key: string, source: string | null): string {
  return encodeParams([...(source ? [['source', source] as [string, string]] : []), ['repos', key]]);
}

/** Params for what's open on top of a view (details, diff): never part of a saved view. */
export const OVERLAY_KEYS = ['pr', 'diff', 'file', 'thread', 'only'];

/** The params of a query string, less those named in `drop`. */
export function paramsExcept(search: string, drop: readonly string[]): [string, string][] {
  return [...new URLSearchParams(search)].filter(([k]) => !drop.includes(k));
}

/** Params as a query string in the written order (ORDER; params we don't know keep theirs, at the end): "?..." or "". */
export function orderedSearch(pairs: [string, string][]): string {
  const rank = (k: string) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
  const qs = encodeParams([...pairs].sort(([a], [b]) => rank(a) - rank(b)));
  return qs ? `?${qs}` : '';
}

/** Canonical query string (sorted, without the overlay params) for comparing saved views. */
export function canonicalQuery(query: string): string {
  const p = new URLSearchParams(query.replace(/^\?/, ''));
  for (const k of OVERLAY_KEYS) p.delete(k);
  const pairs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b));
  return encodeParams(pairs);
}

export type DiffTarget =
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'branch'; repo: string; branch: string }
  | { kind: 'commit'; repo: string; oid: string };

/** A PR's diff param is its id ("<repo>#<n>", like `pr`); a commit's is "<repo>@<oid>". */
export const commitDiffId = (repo: string, oid: string) => `${repo}@${oid}`;

/**
 * A branch's is "<repo>~<branch>": git forbids '~' in a branch's name, and repo keys never have one, so the first '~'
 * ends the repo.
 */
export const branchDiffId = (repo: string, branch: string) => `${repo}~${branch}`;

/**
 * Parse a `diff` param; null when malformed. Commit oids may be abbreviated (7–64 hex chars: a SHA-1 is 40, a SHA-256
 * is 64). The branch form is read first: a branch's name may hold '#' or '@', which mustn't make it a PR or a commit.
 */
export function parseDiffId(id: string | null): DiffTarget | null {
  if (!id) return null;
  const tilde = id.indexOf('~');
  if (tilde >= 0) {
    const repo = id.slice(0, tilde), branch = id.slice(tilde + 1);
    return repo && !/\s/.test(repo) && isBranchName(branch) ? { kind: 'branch', repo, branch } : null;
  }
  const m = /^([^#@\s]+)(?:#([1-9]\d{0,9})|@([0-9a-f]{7,64}))$/i.exec(id);
  if (!m) return null;
  return m[2] ? { kind: 'pr', repo: m[1], number: Number(m[2]) } : { kind: 'commit', repo: m[1], oid: m[3] };
}

export function useUrlState() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const s = useMemo(() => parseUrlState(location.search, view), [location.search, view]);
  const range: ResolvedRange = useMemo(() => resolveRange(s.range, s.from, s.to), [s.range, s.from, s.to]);

  // Successive set() calls in one tick must build on each other.
  const latest = useRef(location.search);
  latest.current = location.search;

  const set = useCallback(
    (patch: UrlPatch, opts: { replace?: boolean } = {}) => {
      const search = patchSearch(latest.current, view, patch);
      if (search === latest.current) return;
      latest.current = search;
      navigate({ pathname: location.pathname, search }, { replace: !!opts.replace });
    },
    [navigate, location.pathname, view],
  );

  return { s, set, view, range, location, navigate };
}
