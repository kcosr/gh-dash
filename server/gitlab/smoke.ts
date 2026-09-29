/**
 * A read-only smoke test of the GitLab provider against a real instance (tools/gitlab-smoke.ts runs it). It drives the
 * real sources, mappers and token helper step by step, checks what they produce and carries on past failures.
 *
 * Besides the mapping of what the sync reads, it checks the GitLab calls the integration wave adds (DESIGN §10.3), which
 * the fake instance can't prove: the viewer's emails, the token validation query, projects(ids:), the candidates
 * listing, the lookup query with its permission fields and counts, merge and squash commit SHAs, what glab does for a
 * host it isn't logged in to, and how the instance takes the sync's per-source pool of concurrent rounds.
 *
 * Output is anonymised unless --verbose: counts, field checks, error kinds and timings are safe to share, and titles,
 * bodies, paths, code, names and emails never appear (project paths become "project#1"; the one given with --project is
 * shown as given). The token is never printed, in any mode.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorRecord, CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import type { DiffFile } from '../../shared/api';
import type { DiffRepo, PrRevision, RoundRequest, RoundResult } from '../provider/types';
import { GitLabClient } from './client';
import { GitLabDiffSource } from './diff-source';
import { mapProbe, mapProject } from './map';
import { PROBE_FIELDS, PROJECT_FIELDS } from './queries';
import { encodeSegment, GitLabRestClient } from './rest';
import { GitLabSyncSource } from './sync-source';
import { personalAccessToken } from './token';
import { GitLabTransport, normalizeBaseUrl, type GitLabOptions } from './transport';
import type { GqlProbe, GqlProject } from './types';

export const USAGE = `usage: GITLAB_URL=https://gitlab.example.com GITLAB_TOKEN=<token> node gitlab-smoke.mjs [options]
  --project <group/sub/project>  the project to check (default: your most recently pushed one)
  --mr <number>                  the merge request to diff (default: the most recently updated one)
  --glab [path]                  also check the token glab has for GITLAB_URL's host (used if GITLAB_TOKEN is unset);
                                 glab from <path>, else GLAB_PATH, else PATH (GLAB_PATH alone also turns this on)
  --pool <n>                     rounds run at once in the concurrency check (default 3, the sync's pool; 1-10)
  --record <dir>                 save every raw response to <dir> (contains work data: review before sharing)
  --verbose                      show real values (titles, paths, names): for your eyes only, don't share
The token is read from GITLAB_TOKEN (or glab) only, never from the command line.`;

export interface SmokeConfig {
  baseUrl: string;
  token: string | null;
  project: string | null;
  mr: number | null;
  record: string | null;
  verbose: boolean;
  /** The glab executable to check (a path, or "glab" to look it up on PATH); null: no glab check. */
  glab: string | null;
  /** Repositories synced at once in the concurrency check. */
  pool: number;
}

/** The sync's repositories in flight per source (`concurrency ?? 3` in server/sync/sync.ts): keep in step with it. */
export const DEFAULT_POOL = 3;
const MAX_POOL = 10;

/** The run's settings from argv and the environment, or what's wrong with them. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): SmokeConfig | string {
  const cfg: SmokeConfig = { baseUrl: env.GITLAB_URL ?? '', token: env.GITLAB_TOKEN || null, project: null, mr: null, record: null, verbose: false, glab: env.GLAB_PATH || null, pool: DEFAULT_POOL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    try {
      if (arg === '--project') cfg.project = value();
      else if (arg === '--mr') cfg.mr = Number(value());
      else if (arg === '--pool') cfg.pool = Number(value());
      else if (arg === '--record') cfg.record = value();
      else if (arg === '--verbose') cfg.verbose = true;
      else if (arg === '--glab') cfg.glab = argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[++i]! : env.GLAB_PATH || 'glab';
      else if (/^--?(token|private-token)/.test(arg)) return 'The token is read from GITLAB_TOKEN only, never from the command line (it would end up in shell history).';
      else return `Unknown option: ${arg}`;
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (!cfg.baseUrl) return 'GITLAB_URL is not set.';
  if (!cfg.token && !cfg.glab) return 'GITLAB_TOKEN is not set (or pass --glab to use the token glab has).';
  if (cfg.mr !== null && !(Number.isInteger(cfg.mr) && cfg.mr > 0)) return '--mr needs a merge request number.';
  if (!(Number.isInteger(cfg.pool) && cfg.pool >= 1 && cfg.pool <= MAX_POOL)) return `--pool needs a number from 1 to ${MAX_POOL}.`;
  return cfg;
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/**
 * Makes text safe to print: tokens are always masked; unless verbose, the instance's address and every registered
 * private value (project paths, logins) are replaced by stand-ins, and API paths are reduced to their templates.
 */
export class Privacy {
  private readonly secrets: string[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  constructor(
    readonly verbose: boolean,
    private readonly base: string,
  ) {}

  secret(value: string | null): void {
    if (value) this.secrets.push(value);
  }

  /** Registers a private value (and its URL-encoded forms) as "<kind>#N", unless it's already known. */
  alias(kind: string, value: string, as?: string): string {
    const known = this.aliases.get(value);
    if (known) return known;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const stand = as ?? `${kind}#${n}`;
    for (const form of new Set([value, encodeURIComponent(value), safeSegment(value)])) this.aliases.set(form, stand);
    return stand;
  }

  /** `text` with every token masked (and nothing else changed): what --record writes. */
  maskTokens(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[token]');
    return out;
  }

  scrub(text: string): string {
    let out = this.maskTokens(text);
    if (this.verbose) return out;
    out = out.split(this.base).join('<gitlab>').split(new URL(this.base).host).join('<host>');
    out = out.replace(/\/api\/v4(\/[^\s?:;,)'"]*)?(\?\S*)?/g, (_, path?: string) => `/api/v4${path ? restTemplate(path) : ''}`);
    if (!this.aliases.size) return out;
    // One pass, longest first, so a kept value ("group/proj" given with --project) isn't rewritten by a shorter one.
    const values = [...this.aliases.keys()].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return out.replace(new RegExp(values.join('|'), 'g'), (v) => this.aliases.get(v)!);
  }
}

function safeSegment(value: string): string {
  try {
    return encodeSegment(value);
  } catch {
    return value;
  }
}

/** A REST path with its variable parts named ("/projects/:project/merge_requests/:iid/versions"). */
export function restTemplate(path: string): string {
  const after: Record<string, string> = { projects: ':project', merge_requests: ':iid', versions: ':version', commits: ':sha', files: ':path', users: ':user' };
  const parts = path.split('/');
  return parts.map((p, i) => (i > 0 && after[parts[i - 1]!] ? after[parts[i - 1]!] : p.length > 40 || p.includes('%') ? ':x' : p)).join('/');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Problems (fail the step) and notes (don't) found by a step, counted by message. */
export class Check {
  readonly problems = new Map<string, number>();
  readonly notes = new Map<string, number>();
  fail(msg: string): void {
    this.problems.set(msg, (this.problems.get(msg) ?? 0) + 1);
  }
  note(msg: string): void {
    this.notes.set(msg, (this.notes.get(msg) ?? 0) + 1);
  }
  expect(ok: boolean, msg: string): void {
    if (!ok) this.fail(msg);
  }
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEX6 = /^[0-9a-f]{6}$/;
const HTTP = /^https?:\/\//;

function time(c: Check, what: string, v: string | null, nullable = false): void {
  if (v === null) c.expect(nullable, `${what} is null`);
  else c.expect(UTC.test(v), `${what} is not UTC to the second`);
}

function actor(c: Check, what: string, a: ActorRecord | null, git = false): void {
  if (!a) return;
  if (git) c.expect(a.login === null || a.login.length > 0, `${what}.login is empty`);
  else c.expect(!!a.login, `${what}.login is missing`);
  c.expect(a.email === null || a.email === a.email.toLowerCase(), `${what}.email is not lower case`);
  c.expect(a.avatarUrl === null || HTTP.test(a.avatarUrl), `${what}.avatarUrl is not absolute`);
}

function labels(c: Check, what: string, ls: { name: string; color: string }[]): void {
  for (const l of ls) {
    c.expect(!!l.name, `${what} label without a name`);
    c.expect(HEX6.test(l.color), `${what} label color is not 6-digit lower-case hex without #`);
  }
}

/** `values` should be in descending order (ISO strings compare as times). */
function descending(c: Check, what: string, values: (string | null)[], strict = true): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== null && values[i] !== null && values[i]! > values[i - 1]!) {
      if (strict) c.fail(`${what} not newest first`);
      else c.note(`${what} not strictly newest first (git order)`);
      return;
    }
  }
}

function checkRepo(c: Check, r: RepoRecord): void {
  c.expect(/^gid:\/\/gitlab\/Project\/\d+$/.test(r.nodeId), 'nodeId is not a Project global id');
  c.expect(!!r.name && !!r.owner && r.nameWithOwner === `${r.owner}/${r.name}`, 'nameWithOwner is not owner/name');
  c.expect(HTTP.test(r.url), 'url is not absolute');
  c.expect(r.visibility === 'public' || r.visibility === 'private' || r.visibility === 'internal', 'visibility is not public/private/internal');
  c.expect(r.languageColor === null || /^#[0-9a-f]{6}$/i.test(r.languageColor), 'languageColor is not #hex');
  c.expect(r.stars >= 0 && r.forks >= 0, 'negative stars or forks');
  time(c, 'createdAt', r.createdAt);
  time(c, 'pushedAt', r.pushedAt, true);
  if (r.defaultBranch === null) c.note('a project without a default branch (empty repository)');
}

function checkProbe(c: Check, p: RepoProbe): void {
  c.expect(p.openPrs >= 0 && p.openIssues >= 0, 'negative open counts');
  time(c, 'latestPrUpdatedAt', p.latestPrUpdatedAt, true);
  time(c, 'latestIssueUpdatedAt', p.latestIssueUpdatedAt, true);
  c.expect(p.releaseTags.length <= 3 && p.releaseTags.every((t) => !!t), 'releaseTags: more than 3, or empty tags');
  c.expect(p.latestStarredAt === null, 'latestStarredAt is set (GitLab has none)');
}

function checkPr(c: Check, p: PrRecord): void {
  c.expect(Number.isInteger(p.number) && p.number > 0, 'number is not a positive integer');
  c.expect(['open', 'merged', 'closed'].includes(p.state), 'state is not open/merged/closed');
  time(c, 'createdAt', p.createdAt);
  time(c, 'updatedAt', p.updatedAt);
  time(c, 'activityAt', p.activityAt);
  time(c, 'mergedAt', p.mergedAt, p.state !== 'merged');
  time(c, 'closedAt', p.closedAt, p.state === 'open');
  c.expect(p.state === 'merged' || p.mergedAt === null, 'mergedAt set on an unmerged MR');
  c.expect(p.state !== 'open' || (p.closedAt === null && p.mergedBy === null), 'closedAt or mergedBy set on an open MR');
  if (p.state === 'merged' && !p.mergedBy) c.note('a merged MR without mergedBy');
  if (!p.headOid) c.note('an MR without a head SHA (no diff yet)');
  else c.expect(OID.test(p.headOid), 'headOid is not a SHA');
  c.expect(!!p.headRef && !!p.baseRef, 'headRef or baseRef is empty');
  c.expect(p.additions >= 0 && p.deletions >= 0 && p.changedFiles >= 0, 'negative diff stats');
  c.expect(p.commitCount >= p.commits.length, 'commitCount below the commits listed');
  c.expect(HTTP.test(p.url), 'url is not absolute');
  actor(c, 'author', p.author);
  labels(c, 'MR', p.labels);
  for (const i of p.closingIssues) c.expect(i.number > 0 && (i.state === 'open' || i.state === 'closed'), 'closing issue malformed');
  for (const x of p.commits) {
    c.expect(OID.test(x.oid), 'MR commit oid is not a SHA');
    time(c, 'MR commit committedAt', x.committedAt);
    actor(c, 'MR commit author', x.author, true);
  }
  descending(c, 'MR commits (expected oldest first after mapping)', p.commits.map((x) => x.committedAt).reverse(), false);
}

function checkIssue(c: Check, i: IssueRecord): void {
  c.expect(Number.isInteger(i.number) && i.number > 0, 'number is not a positive integer');
  c.expect(i.state === 'open' || i.state === 'closed', 'state is not open/closed');
  time(c, 'createdAt', i.createdAt);
  time(c, 'updatedAt', i.updatedAt);
  time(c, 'activityAt', i.activityAt);
  time(c, 'closedAt', i.closedAt, i.state === 'open');
  c.expect(i.state === 'closed' || i.closedBy === null, 'closedBy set on an open issue');
  if (i.state === 'closed' && !i.closedBy) c.note('a closed issue without closedBy');
  c.expect(HTTP.test(i.url), 'url is not absolute');
  actor(c, 'author', i.author);
  actor(c, 'closedBy', i.closedBy);
  labels(c, 'issue', i.labels);
}

function checkCommit(c: Check, x: CommitRecord): void {
  c.expect(OID.test(x.oid), 'oid is not a SHA');
  time(c, 'committedAt', x.committedAt);
  c.expect(x.author.login === null, 'author.login is set (GitLab gives none)');
  actor(c, 'author', x.author, true);
  c.expect(x.additions >= 0 && x.deletions >= 0, 'negative stats');
  c.expect(x.prNumber === null, 'prNumber is set');
  c.expect(!x.headline.includes('\n'), 'headline spans lines');
  c.expect(HTTP.test(x.url), 'url is not absolute');
}

function checkRelease(c: Check, r: ReleaseRecord): void {
  c.expect(!!r.tag, 'tag is empty');
  time(c, 'publishedAt', r.publishedAt);
  c.expect(r.isPrerelease === false, 'isPrerelease is set');
  if (!r.url) c.note('a release without a URL');
  actor(c, 'author', r.author);
}

function checkStar(c: Check, s: StarRecord): void {
  c.expect(!!s.login, 'login is empty');
  time(c, 'starredAt', s.starredAt);
  c.expect(s.avatarUrl === null || HTTP.test(s.avatarUrl), 'avatarUrl is not absolute');
}

/** Files of a diff; `totals` are the host's own, which the files' counts can only match when every file has a patch. */
function checkFiles(c: Check, files: DiffFile[], totals: { additions: number; deletions: number }): string {
  let withoutPatch = 0;
  for (const f of files) {
    c.expect(!!f.path, 'file without a path');
    c.expect(['added', 'removed', 'modified', 'renamed'].includes(f.status), `unexpected file status ${f.status}`);
    c.expect((f.status === 'renamed') === (f.previousPath !== null), 'previousPath set on a non-rename (or missing on a rename)');
    if (f.patch === null) withoutPatch++;
    else {
      c.expect(f.patch.startsWith('@@'), 'patch does not start with @@');
      c.expect(!/^(diff --git|--- |\+\+\+ |index )/m.test(f.patch.split(/^@@/m)[0] ?? ''), 'patch keeps header lines');
    }
  }
  const sum = files.reduce((s, f) => ({ additions: s.additions + f.additions, deletions: s.deletions + f.deletions }), { additions: 0, deletions: 0 });
  const counted = `files +${sum.additions}/-${sum.deletions} vs GitLab +${totals.additions}/-${totals.deletions}`;
  if (withoutPatch === 0) c.expect(sum.additions === totals.additions && sum.deletions === totals.deletions, `per-file +/- don't add up to GitLab's totals (${counted})`);
  else {
    c.note(`${withoutPatch} file(s) without a patch (binary, rename only, or over the diff limits): totals compared as a bound`);
    c.expect(sum.additions <= totals.additions && sum.deletions <= totals.deletions, `per-file +/- exceed GitLab's totals (${counted})`);
  }
  return counted;
}

// ---------------------------------------------------------------------------
// The integration wave's calls (DESIGN §3.4, §4.5, §4.7, §4.8, §10.3)
// ---------------------------------------------------------------------------

/**
 * These documents are what the wave's code will send, written out here because that code isn't built yet: a
 * field GitLab 19.3 doesn't have fails the request with GitLab's own message, which the step then shows.
 * §3.4: the token validation query. The account, its emails ("me" on commits, §4.7), the instance, the personal count.
 */
const VALIDATE = `query SmokeValidate {
  currentUser { id username name avatarUrl publicEmail commitEmail emails { nodes { email } } }
  metadata { version enterprise }
  projects(personal: true) { count }
}`;

/** §4.8: refreshing hand-added projects, in chunks of PROJECTS_CHUNK ids. */
const PROJECTS_BY_IDS = `query SmokeProjectsByIds($ids: [ID!], $first: Int!) {
  projects(ids: $ids, first: $first) { nodes { ...ProjectFields ...ProbeFields } }
}
${PROJECT_FIELDS}
${PROBE_FIELDS}`;
const PROJECTS_CHUNK = 25;
/** A project id that doesn't exist (gid syntax is valid): GitLab should leave it out, not fail. */
const MISSING_PROJECT_ID = 'gid://gitlab/Project/2147483000';

/** §4.8: the Add dialog's lookup of one project: its fields, what the token may read, and the sizes of the backfill. */
const LOOKUP = `query SmokeLookup($path: ID!, $since: Time!) {
  currentUser { id username }
  project(fullPath: $path) {
    ...ProjectFields
    ...ProbeFields
    userPermissions { downloadCode readMergeRequest }
    issuesEnabled
    mergeRequestsSince: mergeRequests(updatedAfter: $since) { count }
    issuesSince: issues(updatedAfter: $since, types: [ISSUE]) { count }
    releaseTotal: releases { count }
  }
}
${PROJECT_FIELDS}
${PROBE_FIELDS}`;
/** Not a project anyone has: the lookup must answer `project: null`, which the tracking API reports as not-found. */
const MISSING_PROJECT_PATH = 'smoke-check-no-such-group/no-such-project';

/** §4.8: the permission fields over the projects the token is a member of, to see the false values the lookup classifies. */
const PERMISSIONS = `query SmokePermissions($first: Int!) {
  projects(membership: true, first: $first, sort: "latest_activity_desc") {
    count
    nodes { id userPermissions { downloadCode readMergeRequest } issuesEnabled }
  }
}`;
const PERMISSION_PROJECTS = 50;

/** §4.5: merged MRs with the SHAs the commit-to-MR link-up uses, and the commits the sync lists for an MR. */
const MERGED_MRS = `query SmokeMergedMrs($path: ID!, $first: Int!) {
  project(fullPath: $path) {
    mergeRequests(state: merged, first: $first, sort: UPDATED_DESC) {
      nodes { iid state mergedAt targetBranch mergeCommitSha squashCommitSha diffHeadSha commits(first: 20) { nodes { sha } } }
    }
  }
}`;
const MERGED_MRS_SAMPLE = 25;

/** §4.8: the Add dialog's candidates, as the wave's REST listing asks for them. */
const CANDIDATES = { membership: true, archived: false, simple: true, order_by: 'last_activity_at', sort: 'desc', per_page: 100 } as const;
const CANDIDATES_LIMIT = 1000;

/** §3.3: a host glab has never seen; it must have no token for it. `.invalid` never resolves (RFC 2606). */
const UNKNOWN_HOST = 'unknown.invalid';
/** §3.4: the scopes that let a token change things on GitLab (Settings warns about them). */
const WRITE_SCOPES = ['api', 'write_repository'];
/** §3.4: the page that creates a token with the name and scope filled in, below the instance URL. */
const TOKEN_PAGE = '/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api';

/** The fields of ProjectFields and ProbeFields (queries.ts): every one must be in the response, null or not. */
const PROJECT_KEYS = ['id', 'path', 'fullPath', 'namespace', 'description', 'webUrl', 'visibility', 'archived', 'isForked', 'starCount', 'forksCount', 'createdAt', 'lastActivityAt', 'topics', 'languages', 'repository'];
const PROBE_KEYS = ['openMergeRequests', 'openIssues', 'latestMergeRequest', 'latestIssue', 'latestReleases'];

const ADDRESS = /^[^@\s]+@[^@\s]+$/;
const GLOBAL_ID = /^gid:\/\/gitlab\/(\w+)\/\d+$/;

interface ValidateData {
  currentUser: {
    id: string;
    username: string;
    publicEmail: string | null;
    commitEmail: string | null;
    emails: { nodes: { email: string }[] } | null;
  } | null;
  metadata: { version: string; enterprise: boolean } | null;
  projects: { count: number } | null;
}

type Count = { count: number } | null;

interface LookupProject extends GqlProject, GqlProbe {
  userPermissions: { downloadCode: boolean; readMergeRequest: boolean } | null;
  issuesEnabled: boolean | null;
  mergeRequestsSince: Count;
  issuesSince: Count;
  releaseTotal: Count;
}

interface LookupData {
  currentUser: { id: string; username: string } | null;
  project: LookupProject | null;
}

interface PermissionsData {
  projects: { count: number; nodes: { id: string; userPermissions: LookupProject['userPermissions']; issuesEnabled: boolean | null }[] } | null;
}

export interface MergedMr {
  iid: string;
  state: string;
  mergedAt: string | null;
  targetBranch: string;
  mergeCommitSha: string | null;
  squashCommitSha: string | null;
  diffHeadSha: string | null;
  commits: { nodes: { sha: string }[] } | null;
}

/** One project of the REST listing (`simple=true`): the fields the Add dialog reads. */
interface Candidate {
  id: number;
  path_with_namespace: string;
  web_url: string;
  last_activity_at: string;
  namespace: { kind: string; full_path: string } | null;
}

/** GitLab sends every field a query asks for, null or not: one that is `undefined` was left out of the response. */
function has(c: Check, obj: object | null | undefined, keys: string[], what: string): void {
  if (!obj) return;
  for (const k of keys) c.expect((obj as Record<string, unknown>)[k] !== undefined, `${what}.${k} is missing from the response`);
}

/** A project read with the project and probe fields: mapped by the real mappers, and no field left out of the response. */
function checkProjectNode(c: Check, p: GqlProject & GqlProbe, base: string): { record: RepoRecord; probe: RepoProbe } {
  has(c, p, [...PROJECT_KEYS, ...PROBE_KEYS], 'project');
  const record = mapProject(p, base);
  const probe = mapProbe(p);
  checkRepo(c, record);
  checkProbe(c, probe);
  return { record, probe };
}

/** `userPermissions` of a project: both fields present and true/false (returned, so a caller can count the false ones). */
function permissionFlags(c: Check, perm: LookupProject['userPermissions'] | undefined): { downloadCode: boolean | null; readMergeRequest: boolean | null } {
  if (perm === undefined) c.fail('userPermissions is missing from the response');
  else if (perm === null) c.fail('userPermissions is null');
  else return { downloadCode: flag(c, perm.downloadCode, 'userPermissions.downloadCode'), readMergeRequest: flag(c, perm.readMergeRequest, 'userPermissions.readMergeRequest') };
  return { downloadCode: null, readMergeRequest: null };
}

function flag(c: Check, v: unknown, what: string): boolean | null {
  if (v === undefined) c.fail(`${what} is missing from the response`);
  else if (typeof v !== 'boolean') c.fail(`${what} is not true/false (it is ${v === null ? 'null' : typeof v})`);
  else return v;
  return null;
}

/** The `count` of a connection asked for `{ count }`, or null (already reported) when it is absent or unusable. */
function total(c: Check, v: Count | undefined, what: string): number | null {
  if (v === undefined) c.fail(`${what} is missing from the response`);
  else if (v === null) c.fail(`${what} is null (the token can't read it)`);
  else if (!Number.isInteger(v.count) || v.count < 0) c.fail(`${what}.count is not a non-negative integer`);
  else return v.count;
  return null;
}

/** The token's scopes and expiry as gh-dash will show them (§3.4): the date, and whether Settings will warn about writing. */
export function checkTokenInfo(c: Check, info: { scopes: string[]; expiresAt: string | null }): string {
  c.expect(info.expiresAt === null || /^\d{4}-\d{2}-\d{2}$/.test(info.expiresAt), 'expires_at is not a plain date (YYYY-MM-DD)');
  const write = info.scopes.filter((s) => WRITE_SCOPES.includes(s));
  return write.length ? `Settings would warn: can change things (${write.join(', ')})` : 'no write scope (no warning)';
}

/**
 * §3.4 and §4.7: what the validation query gave. Returns the addresses that count as the viewer's ("me" on commits).
 */
export function checkValidate(c: Check, d: ValidateData, expect: { login: string | null; owned: number | null }): { addresses: Set<string>; detail: string } {
  const addresses = new Set<string>();
  const u = d.currentUser;
  if (!u) {
    c.fail('currentUser is null');
    return { addresses, detail: 'no user' };
  }
  c.expect(GLOBAL_ID.exec(u.id)?.[1] === 'User', 'currentUser.id is not a User global id');
  c.expect(!!u.username && (expect.login === null || u.username === expect.login), 'currentUser.username is empty, or another user than the viewer step found');
  has(c, u, ['publicEmail', 'commitEmail', 'emails'], 'currentUser');
  const listed = u.emails?.nodes;
  if (u.emails === null) c.note('currentUser.emails is null: the token may not list the account\'s addresses (publicEmail and commitEmail only)');
  else if (u.emails !== undefined) c.expect(Array.isArray(listed), 'currentUser.emails.nodes is not a list');
  const all = [u.publicEmail, u.commitEmail, ...(listed ?? []).map((e) => e?.email)];
  for (const a of all) {
    if (typeof a === 'string' && a) {
      c.expect(ADDRESS.test(a), 'an email is not an address');
      addresses.add(a.toLowerCase());
    } else c.expect(a === null || a === undefined || a === '', 'an email is not text');
  }
  c.expect(addresses.size > 0, 'no address from publicEmail, commitEmail or emails: "me" on GitLab commits would need myEmails');

  const meta = d.metadata;
  if (meta === undefined) c.fail('metadata is missing from the response');
  else c.expect(!!meta && /^\d+\.\d+\.\d+/.test(meta.version) && typeof meta.enterprise === 'boolean', 'metadata has no version like 19.3.3, or enterprise is not true/false');
  const personal = total(c, d.projects, 'projects(personal: true)');
  if (personal !== null && expect.owned !== null) {
    c.expect(personal === expect.owned, `projects(personal: true).count is ${personal}, but ${expect.owned} projects were listed`);
  }
  const detail =
    `${meta ? `GitLab ${meta.version}` : 'no version'} · publicEmail ${u.publicEmail ? 'set' : 'unset'} · commitEmail ${u.commitEmail ? 'set' : 'unset'}` +
    ` · emails ${listed ? `${listed.length} listed` : 'not listed'} · ${addresses.size} distinct address(es) · personal projects ${personal ?? '?'}`;
  return { addresses, detail };
}

/** How the commits page links to merged MRs by the SQL of §4.5: by merge SHA, squash SHA, a commit the MR lists, or not at all. */
export function linkCommits(oids: string[], mrs: MergedMr[]): { merge: number; squash: number; listed: number; none: number } {
  const merge = new Set(mrs.flatMap((m) => (m.mergeCommitSha ? [m.mergeCommitSha] : [])));
  const squash = new Set(mrs.flatMap((m) => (m.squashCommitSha ? [m.squashCommitSha] : [])));
  const listed = new Set(mrs.flatMap((m) => (m.commits?.nodes ?? []).map((n) => n.sha)));
  const out = { merge: 0, squash: 0, listed: 0, none: 0 };
  for (const oid of oids) {
    if (merge.has(oid)) out.merge++;
    else if (squash.has(oid)) out.squash++;
    else if (listed.has(oid)) out.listed++;
    else out.none++;
  }
  return out;
}

/** The lookup query's answer for a project the token can see: mapped by the real mappers, and every new field present. */
export function checkLookup(c: Check, p: LookupProject, base: string) {
  const { record, probe } = checkProjectNode(c, p, base);
  const perm = permissionFlags(c, p.userPermissions);
  const issuesEnabled = flag(c, p.issuesEnabled, 'issuesEnabled');
  const counts = {
    mrs: total(c, p.mergeRequestsSince, 'mergeRequests(updatedAfter:)'),
    issues: total(c, p.issuesSince, 'issues(updatedAfter:, types: [ISSUE])'),
    releases: total(c, p.releaseTotal, 'releases'),
  };
  return { record, probe, perm, issuesEnabled, counts };
}

const lower = (s: string) => s.toLowerCase();
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
/** The `p`th quantile of ascending `sorted`. */
const quantile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

// ---------------------------------------------------------------------------
// Requests: timing, rate limits, recording
// ---------------------------------------------------------------------------

interface Call {
  op: string;
  status: number | string;
  ms: number;
}

interface Traffic {
  calls: Call[];
  /** Requests started and not yet answered, and the most at once since `peak` was last reset. */
  inflight: number;
  peak: number;
  /** Names of response headers seen that tell something about the instance (rate limits, GitLab's own). */
  headers: Set<string>;
  rateLimited: number;
}

const NOTABLE_HEADER = /^(ratelimit-|retry-after|x-gitlab-|gitlab-|x-runtime|x-request-id|x-next-page|x-total)/;

/** Wraps fetch to time each call, note notable headers and (with --record) save raw responses. */
function instrument(inner: typeof fetch, traffic: Traffic, record: Recorder | null): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const op = graphqlOp(init?.body) ?? `${init?.method ?? 'GET'} ${restTemplate(url.pathname.replace(/^.*?\/api\/v4/, ''))}`;
    const started = performance.now();
    traffic.peak = Math.max(traffic.peak, ++traffic.inflight);
    try {
      const res = await inner(input, init);
      traffic.calls.push({ op, status: res.status, ms: Math.round(performance.now() - started) });
      res.headers.forEach((_, name) => NOTABLE_HEADER.test(name) && traffic.headers.add(name));
      if (res.headers.has('ratelimit-limit')) traffic.rateLimited++;
      if (record) await record.save(op, url, init, res.clone());
      return res;
    } catch (err) {
      traffic.calls.push({ op, status: 'network error', ms: Math.round(performance.now() - started) });
      throw err;
    } finally {
      traffic.inflight--;
    }
  };
}

function graphqlOp(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  try {
    const name = /^\s*query\s+(\w+)/.exec((JSON.parse(body) as { query?: string }).query ?? '')?.[1];
    return name ? `GraphQL ${name}` : null;
  } catch {
    return null;
  }
}

/** --record: raw responses, for re-recording fixtures. Work data, so a note says to review them; never the token. */
class Recorder {
  private n = 0;
  constructor(
    private readonly dir: string,
    private readonly scrubToken: (text: string) => string,
  ) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'README-REVIEW-BEFORE-SHARING.txt'),
      'These are raw responses from your GitLab instance, recorded by gitlab-smoke --record.\n' +
        'They contain work data: project and file names, titles, descriptions, code, usernames and emails.\n' +
        'The token is not in them (it is masked as [token]), but review every file before sharing any of it.\n',
    );
  }

  async save(op: string, url: URL, init: RequestInit | undefined, res: Response): Promise<void> {
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Raw file contents stay text.
    }
    const request = { method: init?.method ?? 'GET', url: url.href, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null };
    const headers = Object.fromEntries([...res.headers].filter(([k]) => !/^(set-cookie|authorization)$/i.test(k)));
    const file = `${String(++this.n).padStart(3, '0')}-${op.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}.json`;
    writeFileSync(join(this.dir, file), this.scrubToken(JSON.stringify({ request, status: res.status, headers, body }, null, 2)));
  }
}

// ---------------------------------------------------------------------------
// glab
// ---------------------------------------------------------------------------

export type Exec = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | string; stdout: string; stderr: string }>;

/** Runs a command without a shell or stdin; `code` is the exit code, or "ENOENT", "timeout", …. */
export const execCommand: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { env: opts.env, timeout: opts.timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      const code = !e ? 0 : e.killed ? 'timeout' : (e.code ?? 'error');
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    }).stdin?.end();
  });


/** What `glab auth status` says about one host (never its user, config path or token). */
export interface GlabHost {
  host: string;
  loggedIn: 'yes' | 'no' | 'unknown';
  /** Where glab keeps the token: "OS keyring", "config file", "none" or "unknown". */
  storage: string;
  apiProtocol: string | null;
  restEndpoint: string | null;
  graphqlEndpoint: string | null;
}

export interface GlabResult {
  version: string | null;
  /** What each way of asking glab for the token gave. */
  attempts: string[];
  method: string | null;
  token: string | null;
  hosts: GlabHost[];
}

const GLAB_TIMEOUT_MS = 15_000;
/** Variables glab would take a token from: gone from its environment, so it can't just hand GITLAB_TOKEN back. */
const TOKEN_VARS = ['GITLAB_TOKEN', 'GLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'];
/** What glab prints as a token: glpat-…, gloas-… or another long opaque string (not a row of asterisks). */
const TOKEN_LIKE = /^(?:gl[a-z]+-[\w.-]{10,}|[A-Za-z0-9_.-]{20,})$/;

/**
 * The token `glab` (an executable path, or "glab" on PATH) has for `host`, as gh-dash would read it: `glab config get
 * token` (empty when glab keeps it in the OS keyring, as glab 1.119 does), then `glab auth status --show-token` when
 * this glab has that flag (glab 1.119 has no `auth token`). Anything that looks like a token goes to `secret` before
 * anything else happens; glab's output is only ever summarised, never shown.
 */
export async function glabToken(glab: string, host: string, env: NodeJS.ProcessEnv, exec: Exec, secret: (t: string) => void): Promise<GlabResult> {
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !TOKEN_VARS.includes(k)));
  clean.NO_PROMPT = '1';
  clean.NO_COLOR = '1';
  const run = (args: string[]) => exec(glab, args, { env: clean, timeoutMs: GLAB_TIMEOUT_MS });
  const out: GlabResult = { version: null, attempts: [], method: null, token: null, hosts: [] };
  const v = await run(['--version']);
  if (v.code !== 0) {
    out.attempts.push(v.code === 'ENOENT' ? 'glab not found (pass --glab <path> or set GLAB_PATH)' : `glab --version failed (${v.code})`);
    return out;
  }
  out.version = /\d+\.\d+\.\d+\S*/.exec(v.stdout)?.[0] ?? (v.stdout.trim().split('\n')[0] ?? '').slice(0, 60);
  const got = (what: string, token: string | null) => {
    out.attempts.push(`${what}: got a token`);
    out.method = what;
    out.token = token;
  };

  const config = await run(['config', 'get', 'token', '--host', host]);
  const stored = config.code === 0 ? config.stdout.trim() : '';
  if (stored) secret(stored);
  if (config.code !== 0) out.attempts.push(`glab config get token: failed (${config.code}): ${firstLine(config.stderr)}`);
  else if (!stored) out.attempts.push('glab config get token: empty (glab keeps the token in the OS keyring, or has none for this host)');
  else got('glab config get token', stored);

  if (!out.token) {
    const help = await run(['auth', 'status', '--help']);
    if (!/--show-token/.test(help.stdout + help.stderr)) out.attempts.push('glab auth status --show-token: this glab has no --show-token');
    else {
      const shown = await run(['auth', 'status', '--hostname', host, '--show-token']);
      const text = plain(shown.stdout + '\n' + shown.stderr);
      const candidates = text.split('\n').filter((l) => /token/i.test(l)).map((l) => l.trim().split(/\s+/).at(-1) ?? '');
      const token = candidates.find((t) => TOKEN_LIKE.test(t)) ?? null;
      if (token) {
        secret(token);
        got('glab auth status --show-token', token);
      } else out.attempts.push(`glab auth status --show-token: no token for this host (exit ${shown.code})`);
    }
  }

  // Without --show-token: whether glab is logged in, and where it keeps the token, per host.
  const status = await run(['auth', 'status']);
  out.hosts = parseAuthStatus(plain(status.stdout + '\n' + status.stderr));
  return out;
}

/** glab's output without colour codes. */
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** `glab auth status`, one entry per host section (a host name on its own line, its details indented below). */
export function parseAuthStatus(text: string): GlabHost[] {
  const hosts: GlabHost[] = [];
  let lines: string[] = [];
  const flush = (host: string | undefined) => {
    if (!host) return;
    const body = lines.join('\n');
    hosts.push({
      host,
      loggedIn: /Logged in to /i.test(body) ? 'yes' : /not logged in|not authenticated|no token|401|invalid/i.test(body) ? 'no' : 'unknown',
      storage: /No token found/i.test(body) ? 'none' : /Token found in .*keyring/i.test(body) ? 'OS keyring' : /Token:/i.test(body) ? 'config file' : 'unknown',
      apiProtocol: /API calls for \S+ are made over (\w+) protocol/i.exec(body)?.[1] ?? null,
      restEndpoint: /REST API Endpoint:\s*(\S+)/i.exec(body)?.[1] ?? null,
      graphqlEndpoint: /GraphQL API Endpoint:\s*(\S+)/i.exec(body)?.[1] ?? null,
    });
  };
  let host: string | undefined;
  for (const line of text.split('\n')) {
    if (/^[^\s].*/.test(line) && /^[\w.-]+(:\d+)?$/.test(line.trim())) {
      flush(host);
      host = line.trim();
      lines = [];
    } else lines.push(line);
  }
  flush(host);
  return hosts;
}

const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 200) || '(no message)';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface SmokeIo {
  out: (line: string) => void;
  fetchImpl?: typeof fetch;
  exec?: Exec;
  /** Waits between retries of the GitLab clients (tests skip the waits). */
  sleep?: (ms: number) => Promise<void>;
  /** Which build of the tool ran (a git SHA when bundled). */
  build?: string;
}

/** Thrown by a step that finds out only while running that there is nothing for it to check. */
class Skip extends Error {}

interface StepResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
}

/** What earlier steps found, for the later ones. */
interface State {
  viewer: boolean;
  /** The viewer's username, for checks that compare namespaces and emails to it. */
  login: string | null;
  owned: RepoRecord[];
  /** Whether `owned` is the listing itself (the step didn't fail), so counts can be compared with it. */
  ownedListed: boolean;
  /** A group project from the candidates listing, for the lookup of a project that isn't yours. */
  groupPath: string | null;
  repo: RepoRecord | null;
  probe: RepoProbe | null;
  rounds: RoundResult;
  rev: PrRevision | null;
  files: DiffFile[];
}

const META = 'query SmokeMeta { metadata { version enterprise } }';
const MEMBERSHIP = 'query SmokeMembership { projects(membership: true, first: 1, sort: "latest_activity_desc") { nodes { fullPath } } }';
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const DAY_MS = 86_400_000;

/** Runs every step and prints the report; resolves to the process exit code (1 when a step failed, 2 for usage). */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: SmokeIo): Promise<number> {
  const cfg = parseArgs(argv, env);
  if (typeof cfg === 'string') {
    // Nothing from the environment is echoed: only our own message.
    io.out(cfg);
    io.out(USAGE);
    return 2;
  }
  let base: string;
  try {
    base = normalizeBaseUrl(cfg.baseUrl);
  } catch (err) {
    io.out(`GITLAB_URL: ${(err as Error).message}`);
    return 2;
  }
  const privacy = new Privacy(cfg.verbose, base);
  privacy.secret(cfg.token);
  // The user named it: shown as given.
  if (cfg.project) privacy.alias('project', cfg.project, cfg.project);
  const print = (line: string) => io.out(privacy.scrub(line));
  const results: StepResult[] = [];

  /** One step: PASS unless it threw or found problems. Everything it prints is scrubbed on the way out. */
  const step = async (name: string, fn: (c: Check) => Promise<string>, skip?: string | false | null) => {
    const label = `${String(results.length + 1).padStart(2)} ${name.padEnd(16)}`;
    if (skip) {
      print(`${label} SKIP  ${skip}`);
      results.push({ name, status: 'SKIP' });
      return;
    }
    const c = new Check();
    const started = performance.now();
    let detail: string;
    try {
      detail = await fn(c);
    } catch (err) {
      if (err instanceof Skip) {
        print(`${label} SKIP  ${err.message}`);
        results.push({ name, status: 'SKIP' });
        return;
      }
      const e = err as Error & { kind?: string; status?: number | null };
      c.fail(`${e.name ?? 'Error'} (kind ${e.kind ?? '-'}, status ${e.status ?? '-'}): ${e.message}`);
      detail = 'threw';
    }
    const status = c.problems.size ? 'FAIL' : 'PASS';
    print(`${label} ${status}  ${detail}  (${Math.round(performance.now() - started)} ms)`);
    for (const [msg, count] of c.problems) print(`      ! ${msg}${count > 1 ? ` (x${count})` : ''}`);
    for (const [msg, count] of c.notes) print(`      ~ ${msg}${count > 1 ? ` (x${count})` : ''}`);
    results.push({ name, status });
  };
  /** --verbose only: a few real records, for the user's own eyes. */
  const show = (what: string, data: unknown) => {
    if (cfg.verbose) for (const line of JSON.stringify(data, null, 1).split('\n').slice(0, 40)) print(`      | ${what}: ${line}`);
  };

  print(`gitlab-smoke (build ${io.build ?? 'dev'}): read-only checks of gh-dash's GitLab code. Node ${process.version}.`);
  print(
    cfg.verbose
      ? 'VERBOSE: the output below contains real data from your instance (titles, paths, names). For your eyes only; do not share it.'
      : 'Output is anonymised (project#1, …): counts, checks, errors and timings only. It is safe to share.',
  );
  if ((env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY !== '1') {
    print('Note: HTTPS_PROXY is set, but Node only sends fetch through it with NODE_USE_ENV_PROXY=1 (or --use-env-proxy).');
  }
  if (cfg.record) print(`RECORDING raw responses to ${cfg.record}: they contain work data (titles, code, names). Review before sharing.`);

  const record = cfg.record ? new Recorder(cfg.record, (t) => privacy.maskTokens(t)) : null;
  const traffic: Traffic = { calls: [], inflight: 0, peak: 0, headers: new Set(), rateLimited: 0 };
  const fetchImpl = instrument(io.fetchImpl ?? fetch, traffic, record);

  // The token: GITLAB_TOKEN, else what glab has.
  let token = cfg.token;
  if (cfg.glab) {
    const glab = cfg.glab;
    let glabRuns = false;
    await step('glab', async (c) => {
      const found = await glabToken(glab, new URL(base).host, env, io.exec ?? execCommand, (t) => privacy.secret(t));
      for (const a of found.attempts) c.note(a);
      for (const h of found.hosts) {
        const endpoint = (url: string | null, api: string) => (!url ? 'none' : url.replace(/\/$/, '') === `${base}${api}` ? 'matches GITLAB_URL' : 'differs from GITLAB_URL');
        const name = h.host === new URL(base).host ? h.host : privacy.alias('host', h.host);
        c.note(
          `glab auth status: ${name} · logged in: ${h.loggedIn} · token in: ${h.storage} · API over ${h.apiProtocol ?? '?'} · ` +
            `REST endpoint ${endpoint(h.restEndpoint, '/api/v4')} · GraphQL endpoint ${endpoint(h.graphqlEndpoint, '/api/graphql')}`,
        );
      }
      if (!found.version) {
        c.fail('glab did not run');
        return 'no glab';
      }
      glabRuns = true;
      if (!found.token) {
        c.fail("glab gave no token for GITLAB_URL's host");
        return `glab ${found.version} · no way worked`;
      }
      // What gh-dash would get from glab: a PAT (scopes, expiry) or an OAuth token from glab's browser login.
      const info = await personalAccessToken({ baseUrl: base, token: found.token, fetchImpl, maxAttempts: 2 });
      const kind = info
        ? `scopes: ${info.scopes.join(', ') || 'none'} · expires: ${info.expiresAt ?? 'never'} · active: ${info.active}`
        : 'not a PAT (GitLab answers 400 for OAuth tokens): scopes and expiry unknown';
      if (info && !info.canRead) c.fail("glab's token has neither read_api nor api");
      if (info && !info.scopes.includes('api')) c.note("glab's token lacks the api scope a glab login usually has");
      if (info) c.note(`glab's token: ${checkTokenInfo(c, info)}`);
      let use: string;
      if (!cfg.token) {
        token = found.token;
        use = 'the run uses this token';
      } else use = sha256(found.token) === sha256(cfg.token) ? 'same token as GITLAB_TOKEN' : 'a different token from GITLAB_TOKEN (the run uses GITLAB_TOKEN)';
      return `glab ${found.version} · via ${found.method} · ${kind} · ${use}`;
    });
    // §3.3: the resolver asks glab for the token of a host the user names, so glab must not answer for one it doesn't know.
    await step(
      'glab other host',
      async (c) => {
        const found = await glabToken(glab, UNKNOWN_HOST, env, io.exec ?? execCommand, (t) => privacy.secret(t));
        for (const a of found.attempts) c.note(a);
        c.expect(!found.token, `glab gave a token for ${UNKNOWN_HOST}, a host it isn't logged in to (a global token?): the resolver must check the host against glab's configured hosts first`);
        return found.token ? `${UNKNOWN_HOST}: glab handed out a token (${found.method})` : `${UNKNOWN_HOST}: glab has no token for it, as wanted`;
      },
      !glabRuns && 'glab did not run',
    );
  }
  if (!token) {
    print('No token to run with: GITLAB_TOKEN is unset and glab gave none.');
    return 1;
  }

  const opts: GitLabOptions = { baseUrl: base, token, fetchImpl, maxAttempts: 2, sleep: io.sleep };
  const sync = new GitLabSyncSource(opts);
  const diff = new GitLabDiffSource(opts);
  const graphql = new GitLabClient(new GitLabTransport(opts, { maxAttempts: 2, maxRetryWaitMs: 10_000 }));
  const st: State = { viewer: false, login: null, owned: [], ownedListed: false, groupPath: null, repo: null, probe: null, rounds: {}, rev: null, files: [] };

  await step('instance', async (c) => {
    const root = new URL(base).pathname;
    const meta = await graphql.query<{ metadata: { version: string; enterprise: boolean } | null }>(META).catch((err: Error) => {
      c.note(`version unknown: ${err.message}`);
      return null;
    });
    const version = meta?.metadata ? `GitLab ${meta.metadata.version}${meta.metadata.enterprise ? ' (EE)' : ''}` : 'GitLab version unknown';
    return `${new URL(base).protocol}//<host> · relative root: ${root === '/' ? 'none' : root} · ${version}`;
  });

  await step('token', async (c) => {
    const info = await personalAccessToken(opts);
    if (!info) {
      c.note("not a personal/group/project access token (GitLab answers 400 for OAuth tokens, e.g. glab's browser login): scopes and expiry unknown");
      return 'kind: not a PAT';
    }
    c.expect(info.canRead, 'the token has neither read_api nor api');
    c.expect(info.active, 'the token is not active (revoked or expired)');
    if (info.expiresAt && Date.parse(info.expiresAt) - Date.now() < 14 * DAY_MS) c.note(`expires soon: ${info.expiresAt}`);
    if (!token!.startsWith('glpat-')) c.note('the token does not start with glpat-: gh-dash would call it "unknown" rather than "personal" (a custom token prefix?)');
    return `scopes: ${info.scopes.join(', ') || 'none'} · expires: ${info.expiresAt ?? 'never'} · active: ${info.active} · ${checkTokenInfo(c, info)}`;
  });

  await step('viewer', async (c) => {
    const v = await sync.viewer();
    privacy.alias('user', v.login, 'you');
    c.expect(v.id !== null && /^gid:\/\/gitlab\/User\/\d+$/.test(v.id), 'id is not a User global id');
    c.expect(!!v.login, 'login is empty');
    c.expect(v.avatarUrl === null || HTTP.test(v.avatarUrl), 'avatarUrl is not absolute');
    st.viewer = true;
    st.login = v.login;
    show('viewer', v);
    return `id ok · name ${v.name ? 'set' : 'unset'} · avatar ${v.avatarUrl ? 'absolute URL' : 'none'}`;
  });

  await step('owned projects', async (c) => {
    st.owned = (await sync.ownedRepos()).repos;
    st.ownedListed = true;
    for (const r of st.owned) {
      privacy.alias('project', r.nameWithOwner);
      checkRepo(c, r);
    }
    const count = (f: (r: RepoRecord) => boolean) => st.owned.filter(f).length;
    show('owned', st.owned.slice(0, 3));
    return `${st.owned.length} in your namespace · private ${count((r) => r.visibility === 'private')} · archived ${count((r) => r.isArchived)} · forks ${count((r) => r.isFork)} · with language ${count((r) => !!r.languageName)} · empty ${count((r) => !r.defaultBranch)}`;
  }, !st.viewer && 'no viewer');

  await step('project', async (c) => {
    let path = cfg.project;
    let how = '--project';
    if (!path) {
      const pick = st.owned.filter((r) => !r.isArchived && r.defaultBranch).sort((a, b) => ((a.pushedAt ?? '') < (b.pushedAt ?? '') ? 1 : -1))[0];
      if (pick) {
        path = pick.nameWithOwner;
        how = 'your most recently pushed project';
      } else {
        const data = await graphql.query<{ projects: { nodes: { fullPath: string }[] } }>(MEMBERSHIP);
        path = data.projects.nodes[0]?.fullPath ?? null;
        how = 'the most recently active project you are a member of';
        if (path) privacy.alias('project', path);
      }
    }
    if (!path) {
      c.fail('no project to check: pass --project group/project');
      return 'none';
    }
    const { found } = await sync.repo(path);
    if (!found) {
      c.fail('repo(path) returned null: the project does not exist or the token cannot see it');
      return privacy.alias('project', path);
    }
    st.repo = found.record;
    st.probe = found.probe;
    checkRepo(c, found.record);
    checkProbe(c, found.probe);
    c.expect(found.record.nameWithOwner === path, 'nameWithOwner differs from the path asked for');
    show('project', found);
    const p = found.probe;
    return `${privacy.alias('project', path)} (${how}) · default branch ${found.record.defaultBranch ? 'set' : 'none'} · stars ${found.record.stars} · open MRs ${p.openPrs} · open issues ${p.openIssues} · release tags ${p.releaseTags.length}`;
  }, !st.viewer && 'no viewer');

  const repo = st.repo as RepoRecord | null;
  await step('probes', async (c) => {
    const { probes, errors } = await sync.probes([repo!]);
    for (const e of errors) c.fail(`probe chunk failed: ${e}`);
    const p = probes.get(repo!.nodeId);
    if (!p) {
      c.fail('no probe for the project');
      return '0 probes';
    }
    checkProbe(c, p);
    if (JSON.stringify(p) !== JSON.stringify(st.probe)) c.note('differs from the probe read with the project (something changed in between?)');
    return `1 probe · open MRs ${p.openPrs} · open issues ${p.openIssues}`;
  }, !repo && 'no project');

  const since = new Date(Date.now() - 365 * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');
  /** One round() of one section, checked by `check`. */
  const section = <K extends keyof RoundResult>(key: K, check: (c: Check, page: NonNullable<RoundResult[K]>) => string, skip?: string | false | null) =>
    step(`round ${key}`, async (c) => {
      const req = key === 'commits' ? { commits: { after: null, since } } : { [key]: { after: null } };
      const page = (await sync.round(repo!, req))[key];
      if (!page) {
        c.fail('section missing from the result');
        return '-';
      }
      st.rounds[key] = page;
      show(key, page.items.slice(0, 3));
      return `${page.items.length} item(s) · more: ${page.hasMore} · ${check(c, page)}`;
    }, !repo ? 'no project' : skip);

  await section('commits', (c, p) => {
    p.items.forEach((x) => checkCommit(c, x));
    descending(c, 'commits', p.items.map((x) => x.committedAt), false);
    return `with stats ${p.items.filter((x) => x.additions + x.deletions > 0).length}`;
  }, repo && !repo.defaultBranch && 'empty repository');
  await section('prs', (c, p) => {
    p.items.forEach((x) => checkPr(c, x));
    descending(c, 'prs by updatedAt', p.items.map((x) => x.updatedAt));
    const states = (s: string) => p.items.filter((x) => x.state === s).length;
    return `open ${states('open')} · merged ${states('merged')} · closed ${states('closed')} · drafts ${p.items.filter((x) => x.isDraft).length} · with closing issues ${p.items.filter((x) => x.closingIssues.length).length} · with labels ${p.items.filter((x) => x.labels.length).length}`;
  });
  await section('openPrs', (c, p) => {
    p.items.forEach((x) => checkPr(c, x));
    c.expect(p.items.every((x) => x.state === 'open'), 'a non-open MR in openPrs');
    descending(c, 'openPrs by createdAt', p.items.map((x) => x.createdAt));
    return `drafts ${p.items.filter((x) => x.isDraft).length}`;
  });
  await section('issues', (c, p) => {
    p.items.forEach((x) => checkIssue(c, x));
    descending(c, 'issues by updatedAt', p.items.map((x) => x.updatedAt));
    return `open ${p.items.filter((x) => x.state === 'open').length} · closed ${p.items.filter((x) => x.state === 'closed').length} · with closedBy ${p.items.filter((x) => x.closedBy).length} · with labels ${p.items.filter((x) => x.labels.length).length}`;
  });
  await section('openIssues', (c, p) => {
    p.items.forEach((x) => checkIssue(c, x));
    c.expect(p.items.every((x) => x.state === 'open'), 'a closed issue in openIssues');
    descending(c, 'openIssues by createdAt', p.items.map((x) => x.createdAt));
    return 'all open';
  });
  await section('releases', (c, p) => {
    p.items.forEach((x) => checkRelease(c, x));
    time(c, 'oldestCreatedAt', p.oldestCreatedAt, p.items.length === 0);
    return `oldestCreatedAt ${p.oldestCreatedAt ? 'set' : 'null'}`;
  });
  await section('stars', (c, p) => {
    p.items.forEach((x) => checkStar(c, x));
    descending(c, 'stars', p.items.map((x) => x.starredAt));
    const hidden = repo!.stars - p.totalCount;
    c.expect(hidden >= 0, `GitLab lists more starrers (${p.totalCount}) than the project's star count (${repo!.stars})`);
    if (hidden > 0) c.note(`${hidden} star(s) not listed (private profiles or blocked users)`);
    return `listed total ${p.totalCount} · starCount ${repo!.stars}`;
  });

  await step('recheck', async (c) => {
    const prs = (st.rounds.prs?.items ?? []).slice(0, 2).map((p) => p.number);
    const issues = (st.rounds.issues?.items ?? []).slice(0, 2).map((i) => i.number);
    const missingPr = Math.max(0, ...prs) + 1_000_000;
    const missingIssue = Math.max(0, ...issues) + 1_000_000;
    const result = await sync.recheck(repo!, [...prs, missingPr], [...issues, missingIssue]);
    for (const n of prs) c.expect(result.prs.get(n)?.number === n, 'an existing MR came back missing');
    for (const n of issues) c.expect(result.issues.get(n)?.number === n, 'an existing issue came back missing');
    c.expect(result.prs.get(missingPr) === null && result.issues.get(missingIssue) === null, 'a number that does not exist came back');
    result.prs.forEach((p) => p && checkPr(c, p));
    result.issues.forEach((i) => i && checkIssue(c, i));
    return `${prs.length} MR(s) + ${issues.length} issue(s) found · 1 + 1 missing number(s) null`;
  }, !repo && 'no project');

  const diffRepo: DiffRepo | null = repo ? { key: repo.name, owner: repo.owner, name: repo.name, path: repo.nameWithOwner } : null;
  const mr = cfg.mr ?? st.rounds.prs?.items.find((p) => p.headOid)?.number ?? null;
  await step('prRevision', async (c) => {
    const rev = await diff.prRevision(diffRepo!, mr!, AbortSignal.timeout(60_000));
    st.rev = rev;
    c.expect(OID.test(rev.headOid) && OID.test(rev.baseOid), 'headOid or baseOid is not a SHA');
    c.expect(!!rev.baseRef && HTTP.test(rev.url) && rev.url.endsWith('/diffs'), 'baseRef empty, or url not the MR changes page');
    c.expect(rev.totalFiles >= 0 && rev.additions >= 0 && rev.deletions >= 0, 'negative totals');
    show('revision', { ...rev, handle: undefined });
    return `!${mr}${cfg.mr ? '' : ' (most recently updated)'} · ${rev.totalFiles} file(s) · +${rev.additions}/-${rev.deletions}`;
  }, (!diffRepo && 'no project') || (!mr && 'no merge request (pass --mr)'));

  const rev = st.rev as PrRevision | null;
  await step('prFiles', async (c) => {
    const out = await diff.prFiles(diffRepo!, mr!, rev!, AbortSignal.timeout(120_000));
    st.files = out.files;
    if (out.rev !== rev) c.note('the MR moved: files are for its newer revision');
    c.expect(out.files.length <= diff.maxFiles && out.files.length <= out.rev.totalFiles, 'more files than GitLab counts');
    if (out.files.length < out.rev.totalFiles) c.note(`${out.rev.totalFiles - out.files.length} file(s) beyond what GitLab lists (diff limits)`);
    const counted = checkFiles(c, out.files, out.rev);
    const status = (s: string) => out.files.filter((f) => f.status === s).length;
    show('files', out.files.slice(0, 3).map((f) => ({ ...f, patch: f.patch?.slice(0, 200) })));
    return `${out.files.length} file(s): added ${status('added')} · modified ${status('modified')} · removed ${status('removed')} · renamed ${status('renamed')} · ${counted}`;
  }, !rev && 'no revision');

  const target = st.files.find((f) => f.status !== 'removed' && f.patch !== null);
  await step('blob', async (c) => {
    const blob = await diff.blob(diffRepo!, rev!.headOid, target!.path, MAX_BLOB_BYTES, AbortSignal.timeout(60_000));
    if (blob.kind === 'file') c.expect(blob.bytes.byteLength > 0 || target!.additions === 0, 'an empty file that the diff adds lines to');
    return blob.kind === 'file' ? `a changed file at the MR head · ${blob.bytes.byteLength} bytes` : blob.kind;
  }, !target && 'no text file in the diff');

  const newest = st.rounds.commits?.items[0]?.oid ?? null;
  await step('commit diff', async (c) => {
    const d = await diff.commit(diffRepo!, newest!, AbortSignal.timeout(120_000));
    c.expect(d.headOid === newest, 'headOid differs from the commit asked for');
    c.expect(d.baseOid === null || OID.test(d.baseOid), 'baseOid is not a SHA');
    c.expect(d.totalFiles >= d.files.length && HTTP.test(d.url), 'totalFiles below the files listed, or url not absolute');
    const counted = checkFiles(c, d.files, d);
    return `newest default-branch commit · ${d.files.length} file(s) · ${counted}`;
  }, (!diffRepo && 'no project') || (!newest && 'no commits'));

  // -------------------------------------------------------------------------
  // The integration wave's calls (DESIGN §10.3)
  // -------------------------------------------------------------------------

  const rest = new GitLabRestClient(new GitLabTransport(opts, { maxAttempts: 2, maxRetryWaitMs: 10_000 }));
  const login = st.login ?? '';
  let addresses = new Set<string>();

  await step('validation query', async (c) => {
    const d = await graphql.query<ValidateData>(VALIDATE);
    const checked = checkValidate(c, d, { login: st.login, owned: st.ownedListed ? st.owned.length : null });
    addresses = checked.addresses;
    show('viewer emails', d.currentUser && { publicEmail: d.currentUser.publicEmail, commitEmail: d.currentUser.commitEmail, emails: d.currentUser.emails });
    // What "me" on commits will do: the project's commits (mapped, lower-case addresses) against these.
    const commits = st.rounds.commits?.items ?? [];
    const yours = commits.filter((x) => x.author.email !== null && addresses.has(x.author.email)).length;
    if (commits.length && addresses.size && !yours) c.note(`none of the project's ${commits.length} commits carries one of these addresses: "me" on commits would need myEmails`);
    return `${checked.detail}${commits.length ? ` · your address on ${yours} of the project's ${commits.length} commits` : ''}`;
  });

  await step(
    'projects by ids',
    async (c) => {
      const ids = [...new Set([repo!.nodeId, ...st.owned.map((r) => r.nodeId)])].slice(0, PROJECTS_CHUNK);
      const d = await graphql.query<{ projects: { nodes: (GqlProject & GqlProbe)[] } | null }>(PROJECTS_BY_IDS, { ids, first: ids.length });
      const nodes = d.projects?.nodes;
      if (!nodes) {
        c.fail('projects(ids:) is null');
        return 'null';
      }
      const got = new Set(nodes.map((n) => n.id));
      c.expect(got.size === nodes.length, 'a project came back twice');
      c.expect(nodes.every((n) => ids.includes(n.id)), 'a project that was not asked for came back');
      const left = ids.filter((id) => !got.has(id)).length;
      c.expect(left === 0, `${left} of ${ids.length} requested project(s) not returned`);
      const visibility: Record<string, number> = { public: 0, internal: 0, private: 0 };
      for (const n of nodes) {
        checkProjectNode(c, n, base);
        if (n.visibility && n.visibility in visibility) visibility[n.visibility]!++;
        else c.fail(`visibility is ${n.visibility === null ? 'null' : 'not exactly public, internal or private'}`);
      }
      const again = nodes.find((n) => n.id === repo!.nodeId);
      if (again && JSON.stringify([mapProject(again, base), mapProbe(again)]) !== JSON.stringify([repo, st.probe])) c.note("differs from the project read by path (something changed in between?)");
      // A project that doesn't exist must be left out, not fail the request: the refresh sends chunks of ids.
      const mixed = await graphql.query<{ projects: { nodes: { id: string }[] } | null }>(PROJECTS_BY_IDS, { ids: [repo!.nodeId, MISSING_PROJECT_ID], first: 2 }).catch((err: Error) => {
        c.fail(`a project id that does not exist made projects(ids:) fail, which would lose its whole chunk: ${err.message}`);
        return null;
      });
      if (mixed) c.expect(mixed.projects?.nodes.length === 1 && mixed.projects.nodes[0]!.id === repo!.nodeId, 'projects(ids:) with one missing id did not return exactly the project that exists');
      return `${nodes.length} of ${ids.length} ids in one request (${PROJECTS_CHUNK} per request in the design) · raw visibility: public ${visibility.public}, internal ${visibility.internal}, private ${visibility.private} · a missing id is left out`;
    },
    (!repo && 'no project') || (!st.ownedListed && 'no owned projects'),
  );

  let candidates = 0;
  await step('candidates', async (c) => {
    const { items, total: count } = await rest.all<Candidate>('/projects', CANDIDATES_LIMIT, { query: CANDIDATES });
    candidates = items.length;
    const truncated = items.length >= CANDIDATES_LIMIT && (count === null || count > CANDIDATES_LIMIT);
    if (truncated) c.note(`the listing stops at ${CANDIDATES_LIMIT} projects (the Add dialog would say "truncated")`);
    if (count === null) c.note('GitLab sent no X-Total (it stops counting at 10,000 projects)');
    else c.expect(items.length === Math.min(count, CANDIDATES_LIMIT), `${items.length} projects listed, but X-Total says ${count}`);
    for (const x of items) {
      c.expect(Number.isInteger(x.id) && x.id > 0, 'a project id is not a number');
      c.expect(typeof x.path_with_namespace === 'string' && x.path_with_namespace.includes('/'), 'path_with_namespace is missing, or has no namespace');
      c.expect(!!x.namespace && ['user', 'group'].includes(x.namespace.kind) && !!x.namespace.full_path, 'namespace.kind (user or group) or namespace.full_path is missing');
      c.expect(!x.namespace || (x.path_with_namespace ?? '').startsWith(`${x.namespace.full_path}/`), 'path_with_namespace does not start with the namespace path');
      c.expect(HTTP.test(x.web_url ?? ''), 'web_url is not absolute');
      c.expect(!Number.isNaN(Date.parse(x.last_activity_at)), 'last_activity_at is not a time');
    }
    descending(c, 'candidates by last_activity_at', items.map((x) => x.last_activity_at));
    // The Add dialog leaves out what sync tracks by itself: the personal namespace, which must be the same set as projects(personal: true).
    const personal = items.filter((x) => x.namespace?.kind === 'user' && !!login && lower(x.namespace.full_path) === lower(login));
    if (st.ownedListed && login) {
      const live = st.owned.filter((r) => !r.isArchived);
      const listed = new Set(personal.map((x) => `gid://gitlab/Project/${x.id}`));
      const missing = live.filter((r) => !listed.has(r.nodeId)).length;
      const extra = personal.filter((x) => !live.some((r) => r.nodeId === `gid://gitlab/Project/${x.id}`)).length;
      c.expect(extra === 0 && (truncated || missing === 0), `your ${live.length} non-archived personal projects and the ${personal.length} in your namespace in this listing differ: ${missing} missing here, ${extra} not personal (a project pending deletion can do this)`);
    }
    const group = items.find((x) => x.namespace?.kind === 'group');
    if (group) {
      st.groupPath = group.path_with_namespace;
      privacy.alias('project', st.groupPath);
    }
    show('candidates', items.slice(0, 3));
    const groups = items.filter((x) => x.namespace?.kind === 'group').length;
    return `${items.length} listed in ${Math.max(1, Math.ceil(items.length / 100))} request(s)${count !== null ? ` (X-Total ${count})` : ''} · in your namespace ${personal.length} · in groups ${groups} · in other users' namespaces ${items.length - personal.length - groups}`;
  });

  /** One lookup of `path`, with the shape checks; the caller compares it with what it knows. */
  const lookup = async (c: Check, path: string) => {
    const d = await graphql.query<LookupData>(LOOKUP, { path, since });
    if (!d.currentUser) c.fail('currentUser is null');
    else {
      c.expect(GLOBAL_ID.exec(d.currentUser.id)?.[1] === 'User' && d.currentUser.username === st.login, 'currentUser is not the user the viewer step found');
    }
    if (!d.project) {
      c.fail('project is null for a project that exists and that the token can see');
      return null;
    }
    return checkLookup(c, d.project, base);
  };
  /** "n > 0" style bound between a count from the lookup and the listing the sync reads (equal when the listing is complete). */
  const against = (c: Check, what: string, count: number | null, listed: number, complete: boolean) => {
    if (count === null) return;
    if (complete) c.expect(count === listed, `${what} counts ${count}, but the complete listing has ${listed}`);
    else c.expect(count >= listed, `${what} counts ${count}, fewer than the ${listed} already listed`);
  };

  await step(
    'lookup',
    async (c) => {
      const got = await lookup(c, repo!.nameWithOwner);
      if (got) {
        c.expect(got.record.nodeId === repo!.nodeId, 'another project came back');
        // A project in your own namespace: the token can read it.
        c.expect(got.perm.downloadCode !== false && got.perm.readMergeRequest !== false, 'userPermissions says the token cannot read the code or merge requests of a project it just listed');
        const { prs, issues, releases } = st.rounds;
        if (prs) against(c, 'mergeRequests(updatedAfter:)', got.counts.mrs, prs.items.filter((x) => x.updatedAt >= since).length, !prs.hasMore);
        if (issues) against(c, 'issues(updatedAfter:)', got.counts.issues, issues.items.filter((x) => x.updatedAt >= since).length, !issues.hasMore);
        if (releases) against(c, 'releases', got.counts.releases, releases.items.length, false);
        show('lookup', got);
      }
      // "Owned" is "the namespace is the viewer's own" (§4.8): it must hold for every project of projects(personal: true).
      if (st.ownedListed && login) {
        const off = st.owned.filter((r) => lower(r.owner) !== lower(login)).length;
        c.expect(off === 0, `${off} of your ${st.owned.length} personal projects are not in a namespace named like your username, so "owned = your namespace" would misjudge them`);
      }
      // A path that names nothing: null (the tracking API's not-found), not an error.
      const none = await graphql.query<LookupData>(LOOKUP, { path: MISSING_PROJECT_PATH, since }).catch((err: Error) => {
        c.fail(`a project that does not exist made the lookup fail instead of answering null: ${err.message}`);
        return null;
      });
      if (none) c.expect(none.project === null, 'a project that does not exist came back');
      if (!got) return 'null';
      const n = (v: number | null) => v ?? '?';
      return `${privacy.alias('project', repo!.nameWithOwner)} · downloadCode ${got.perm.downloadCode} · readMergeRequest ${got.perm.readMergeRequest} · issuesEnabled ${got.issuesEnabled} · since ${since.slice(0, 10)}: MRs ${n(got.counts.mrs)}, issues ${n(got.counts.issues)} · releases ${n(got.counts.releases)} · a missing project answers null`;
    },
    !repo && 'no project',
  );

  await step(
    'lookup group',
    async (c) => {
      const got = await lookup(c, st.groupPath!);
      if (!got) return 'null';
      c.expect(lower(got.record.owner) !== lower(login), 'a group project is in the namespace named like your username');
      c.expect(got.record.nameWithOwner === st.groupPath, 'nameWithOwner differs from the path asked for');
      return `${privacy.alias('project', st.groupPath!)} (first group project in the candidates) · owned: no (namespace is not yours) · downloadCode ${got.perm.downloadCode} · readMergeRequest ${got.perm.readMergeRequest} · issuesEnabled ${got.issuesEnabled}`;
    },
    !st.groupPath && (candidates ? 'no group project among the candidates' : 'no candidates'),
  );

  await step('permissions', async (c) => {
    const d = await graphql.query<PermissionsData>(PERMISSIONS, { first: PERMISSION_PROJECTS });
    const conn = d.projects;
    if (!conn) {
      c.fail('projects(membership: true) is null');
      return 'null';
    }
    let noCode = 0;
    let noMr = 0;
    let noIssues = 0;
    for (const p of conn.nodes) {
      const perm = permissionFlags(c, p.userPermissions);
      if (perm.downloadCode === false) noCode++;
      if (perm.readMergeRequest === false) noMr++;
      if (flag(c, p.issuesEnabled, 'issuesEnabled') === false) noIssues++;
    }
    c.expect(Number.isInteger(conn.count) && conn.count >= conn.nodes.length, 'count is not a number, or is below the projects listed');
    if (conn.nodes.length && !noCode && !noMr && !noIssues) c.note('every project grants everything: a false permission, which the lookup classifies as "permission", was not seen');
    return `${conn.nodes.length} of ${conn.count} member projects · downloadCode false ${noCode} · readMergeRequest false ${noMr} · issues disabled ${noIssues}`;
  });

  await step(
    'merge shas',
    async (c) => {
      const d = await graphql.query<{ project: { mergeRequests: { nodes: MergedMr[] } | null } | null }>(MERGED_MRS, { path: repo!.nameWithOwner, first: MERGED_MRS_SAMPLE });
      const mrs = d.project?.mergeRequests?.nodes;
      if (!mrs) {
        c.fail('project.mergeRequests is null');
        return 'null';
      }
      if (!mrs.length) throw new Skip('no merged merge requests in this project (pass --project with one that has some)');
      for (const m of mrs) {
        has(c, m, ['mergeCommitSha', 'squashCommitSha'], 'merge request');
        c.expect(m.state === 'merged', 'a merge request that is not merged came back for state: merged');
        for (const sha of [m.mergeCommitSha, m.squashCommitSha]) c.expect(!sha || OID.test(sha), 'a merge or squash commit SHA is not a SHA');
      }
      const withMerge = mrs.filter((m) => m.mergeCommitSha).length;
      const withSquash = mrs.filter((m) => m.squashCommitSha).length;
      const neither = mrs.filter((m) => !m.mergeCommitSha && !m.squashCommitSha).length;
      if (neither === mrs.length) c.note('no merged MR has a mergeCommitSha or squashCommitSha (fast-forward merges only?): links would come from the MR commits alone');
      show('merged MRs', mrs.slice(0, 3).map((m) => ({ ...m, commits: m.commits?.nodes.length })));
      // What the link-up of §4.5 does with the commits page the sync reads.
      const commits = st.rounds.commits;
      if (!commits) return `${mrs.length} merged MRs · merge SHA on ${withMerge} · squash SHA on ${withSquash} · neither ${neither} · (no commits round to link)`;
      const oids = commits.items.map((x) => x.oid);
      const linked = linkCommits(oids, mrs);
      const known = new Set(oids);
      const windowStart = commits.hasMore ? (commits.items.at(-1)?.committedAt ?? since) : since;
      const recent = mrs.filter((m) => m.targetBranch === repo!.defaultBranch && m.mergedAt !== null && Date.parse(m.mergedAt) > Date.parse(windowStart) + DAY_MS);
      const linkable = recent.filter((m) => [m.mergeCommitSha, m.squashCommitSha, ...(m.commits?.nodes ?? []).map((n) => n.sha)].some((sha) => !!sha && known.has(sha))).length;
      if (recent.length && !linkable) c.fail(`none of the ${recent.length} MRs merged into the default branch within the commits page can be linked to a commit on it: Activity would show their commits as direct pushes`);
      else if (linkable < recent.length) c.note(`${recent.length - linkable} of ${recent.length} recent default-branch MRs have no commit on the page to link to (rebased, or merged after the page?)`);
      return (
        `${mrs.length} merged MRs · merge SHA on ${withMerge} · squash SHA on ${withSquash} · neither ${neither} · commits page ${oids.length}: ` +
        `linked by merge SHA ${linked.merge}, by squash SHA ${linked.squash}, by listed MR commits ${linked.listed}, not linked ${linked.none} · recent default-branch MRs linkable ${linkable} of ${recent.length}`
      );
    },
    (!repo && 'no project') || (repo && !repo.defaultBranch && 'empty repository'),
  );

  await step(
    'concurrency',
    async (c) => {
      // The sync runs `pool` repositories at once per source; each round asks for every section at once (7 requests).
      const usable = st.owned.filter((r) => !r.isArchived && r.defaultBranch).sort((a, b) => ((a.pushedAt ?? '') < (b.pushedAt ?? '') ? 1 : -1));
      if (!usable.length) throw new Skip('no non-archived project with commits among your own');
      const targets = Array.from({ length: cfg.pool }, (_, i) => usable[i % usable.length]!);
      const distinct = new Set(targets.map((t) => t.nodeId)).size;
      if (distinct < cfg.pool) c.note(`only ${distinct} project(s) of your own to use, so some rounds ran on the same project`);
      const req: RoundRequest = {
        commits: { after: null, since },
        prs: { after: null },
        openPrs: { after: null },
        issues: { after: null },
        openIssues: { after: null },
        releases: { after: null },
        stars: { after: null },
      };
      const failed = (what: string, r: PromiseSettledResult<RoundResult>) => {
        if (r.status === 'fulfilled') return;
        const e = r.reason as Error & { kind?: string; status?: number | null };
        const load = e.kind === 'rate-limit' || e.kind === 'transient' || (e.status ?? 0) === 429 || (e.status ?? 0) >= 500;
        // Throttling and server errors are the pool's doing; a project that refuses one section (issues turned off) is not.
        const msg = `${what} failed (kind ${e.kind ?? '-'}, status ${e.status ?? '-'}): ${e.message}`;
        if (load) c.fail(msg);
        else c.note(msg);
      };
      const alone0 = performance.now();
      failed('the round on its own', (await Promise.allSettled([sync.round(targets[0]!, req)]))[0]!);
      const aloneMs = Math.max(1, performance.now() - alone0);

      const before = traffic.calls.length;
      traffic.peak = traffic.inflight;
      const pool0 = performance.now();
      const settled = await Promise.allSettled(targets.map((t) => sync.round(t, req)));
      const wallMs = Math.max(1, performance.now() - pool0);
      settled.forEach((r, i) => failed(`round ${i + 1} of ${cfg.pool}`, r));

      const calls = traffic.calls.slice(before);
      const times = calls.map((x) => x.ms).sort((a, b) => a - b);
      const byStatus = (list: Call[]) => [...new Set(list.map((x) => x.status))].map((s) => `${s} x${list.filter((x) => x.status === s).length}`).join(', ');
      const trouble = calls.filter((x) => x.status === 429 || x.status === 'network error' || (typeof x.status === 'number' && x.status >= 500));
      if (trouble.length) c.fail(`${trouble.length} of ${calls.length} request(s) were throttled or failed with ${cfg.pool} rounds at once (${byStatus(trouble)}): the pool for GitLab should be smaller`);
      const others = calls.filter((x) => x.status !== 200 && !trouble.includes(x));
      if (others.length) c.note(`${others.length} request(s) answered ${byStatus(others)}`);
      if ((times.at(-1) ?? 0) > 20_000) c.note(`the slowest request took ${seconds(times.at(-1)!)} (GitLab gives up on a GraphQL query after 30 s)`);
      return (
        `${cfg.pool} rounds at once (${distinct} project(s), ${Object.keys(req).length} sections each) · ${calls.length} requests · peak in flight ${traffic.peak} · ` +
        `wall ${seconds(wallMs)} vs ${seconds(aloneMs)} for one round alone (x${(wallMs / aloneMs).toFixed(1)}) · ` +
        `request ms: median ${quantile(times, 0.5)}, p95 ${quantile(times, 0.95)}, max ${times.at(-1) ?? 0} · throttled or failed ${trouble.length}`
      );
    },
    !st.ownedListed && 'no owned projects',
  );

  print('');
  const rl = sync.rateLimit ?? diff.rateLimit;
  print(`Requests: ${traffic.calls.length} · most at once: ${traffic.peak} · rate limit: ${rl ? `${rl.remaining}/${rl.limit} left, resets ${rl.resetAt ?? '?'}` : 'none reported (throttling off)'} · responses with RateLimit headers: ${traffic.rateLimited}`);
  print(`Notable response headers: ${[...traffic.headers].sort().join(', ') || 'none'}`);
  // One line per request kind; a kind seen more than once shows its median and slowest time.
  const kinds = new Map<string, Call[]>();
  for (const call of traffic.calls) kinds.set(`${call.status} ${call.op}`, [...(kinds.get(`${call.status} ${call.op}`) ?? []), call]);
  for (const list of kinds.values()) {
    const ms = list.map((x) => x.ms).sort((a, b) => a - b);
    const first = list[0]!;
    const many = list.length > 1 ? `  (x${list.length}, slowest ${ms.at(-1)} ms)` : '';
    print(`  ${String(list.length > 1 ? quantile(ms, 0.5) : first.ms).padStart(6)} ms  ${String(first.status).padEnd(3)}  ${first.op}${many}`);
  }

  print('');
  print('By hand (the tool cannot check this): open the page below in a browser signed in to GitLab. It should show the new personal access');
  print('token form with the name "gh-dash" filled in and only the read_api scope ticked. Say if it is blank, has other scopes, or is a 404.');
  print(`  ${base}${TOKEN_PAGE}`);

  const tally = (s: StepResult['status']) => results.filter((r) => r.status === s);
  const failed = tally('FAIL');
  print('');
  print(`Summary: ${tally('PASS').length} passed, ${failed.length} failed, ${tally('SKIP').length} skipped${failed.length ? ` (failed: ${failed.map((r) => r.name).join(', ')})` : ''}`);
  if (cfg.record) print(`Recorded ${traffic.calls.length} response(s) to ${cfg.record}: review them before sharing (see README-REVIEW-BEFORE-SHARING.txt).`);
  return failed.length ? 1 : 0;
}
