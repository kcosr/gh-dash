// An app with agents and a fake code host, for the MCP tests: JSON-RPC over app.request, and tool calls.

import type { DiffFile, Principal } from '../../shared/api';
import { createApp, type AppDeps } from '../api/app';
import { CommentBus } from '../comments/bus';
import { type Config, loadConfig } from '../config';
import { createAgent } from '../db/agents';
import type { Db } from '../db/db';
import { DiffCache } from '../diff/cache';
import { DiffService, type DiffSources } from '../diff/service';
import { newestFirst } from '../provider/branches';
import { SourceError } from '../provider/errors';
import type { CommitDiff, DiffSource, PrRevision } from '../provider/types';
import { SyncManager } from '../sync/manager';
import { seedDb } from './seed';
import { testTokens } from './tokens';

export const sha = (c: string) => c.repeat(64).slice(0, 40);

/** A file of a diff whose patch shows `lines` (new side) added at the top, over `context` unchanged lines. */
export function addedFile(path: string, lines: string[], over: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: lines.length,
    deletions: 0,
    patch: `@@ -1,1 +1,${lines.length + 1} @@\n${lines.map((l) => `+${l}`).join('\n')}\n ctx`,
    ...over,
  };
}

/**
 * A branch of the fake code host: its head, and its comparison with the default branch (`baseOid` is the merge base,
 * `files` what a compare lists). The default branch is one too, when a test wants it listed; a comparison of a branch
 * is found by its head.
 */
export interface FakeBranch {
  headOid: string;
  baseOid: string;
  files: DiffFile[];
  /** The head commit's committer date (ISO, UTC); null for a host that doesn't say. Default: none. */
  committedAt?: string | null;
}

/**
 * What the fake code host serves, by repo key: PR revisions and files, commits, branches and file contents. `down` makes
 * every request fail as a missing token does.
 */
export interface FakeCode {
  prs: Map<string, { headOid: string; baseOid: string; files: DiffFile[] }>;
  commits: Map<string, CommitDiff>;
  /** By branchKey: what a branch's head is and what comparing it with the default branch gives. */
  branches: Map<string, FakeBranch>;
  blobs: Map<string, string>;
  down: string | null;
  /**
   * Requests made, as "pr alice/app#2", "commit …", "blob alice/app@<oid>:<path>", "branch alice/app~feature/x" (its
   * head), "compare alice/app~feature/x" and "branches alice/app" (with the filter, if any, after a space).
   */
  requests: string[];
}

export const prKey = (repo: string, n: number) => `${repo}#${n}`;
/** Repo keys have no '~' and git forbids it in a branch name: the same form the web app's diff ids use. */
export const branchKey = (repo: string, branch: string) => `${repo}~${branch}`;
export const blobKey = (repo: string, oid: string, path: string) => `${repo}@${oid}:${path}`;

export function fakeCode(): { code: FakeCode; sources: DiffSources } {
  const code: FakeCode = { prs: new Map(), commits: new Map(), branches: new Map(), blobs: new Map(), down: null, requests: [] };
  const missing = (what: string) => new SourceError('not-found', `${what} not found`, { status: 404 });
  const source: DiffSource = {
    kind: 'github',
    get requests() {
      return code.requests.length;
    },
    rateLimit: null,
    authHint: 'check the token',
    maxFiles: 3000,
    prHeadIs: async () => null,
    async branchHead(repo, branch): Promise<string> {
      code.requests.push(`branch ${branchKey(repo.key, branch)}`);
      const found = code.branches.get(branchKey(repo.key, branch));
      if (!found) throw missing(`branch ${branch}`);
      return found.headOid;
    },
    async compare(repo, _base, head) {
      const hit = [...code.branches].find(([key, b]) => key.startsWith(`${repo.key}~`) && b.headOid === head);
      code.requests.push(`compare ${hit ? hit[0] : `${repo.key}@${head}`}`);
      if (!hit) throw missing(`commit ${head}`);
      const { baseOid, files } = hit[1];
      return {
        baseOid, headOid: head, files, totalFiles: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
      };
    },
    async branches(repo, query, limit) {
      code.requests.push(`branches ${repo.key}${query ? ` ${query}` : ''}`);
      const all = [...code.branches]
        .filter(([key]) => key.startsWith(`${repo.key}~`))
        .map(([key, b]) => ({ name: key.slice(repo.key.length + 1), headOid: b.headOid, committedAt: b.committedAt ?? null }))
        .filter((b) => !query || b.name.toLowerCase().includes(query.toLowerCase()))
        .sort(newestFirst);
      return { items: all.slice(0, limit), more: all.length > limit };
    },
    async prRevision(repo, number): Promise<PrRevision> {
      code.requests.push(`pr ${repo.key}#${number}`);
      const pr = code.prs.get(prKey(repo.key, number));
      if (!pr) throw missing(`${repo.key}#${number}`);
      return {
        headOid: pr.headOid, baseRef: 'main', baseOid: pr.baseOid, title: `PR ${number}`, totalFiles: pr.files.length, additions: 1, deletions: 0,
        url: `https://github.com/${repo.path}/pull/${number}/files`,
      };
    },
    async prFiles(repo, number, rev) {
      return { rev, files: code.prs.get(prKey(repo.key, number))!.files };
    },
    async commit(repo, ref) {
      code.requests.push(`commit ${repo.key}@${ref}`);
      const hit = [...code.commits.entries()].find(([k]) => k.startsWith(`${repo.key}@${ref}`));
      if (!hit) throw missing(`commit ${ref}`);
      return hit[1];
    },
    async blob(repo, oid, path) {
      code.requests.push(`blob ${blobKey(repo.key, oid, path)}`);
      const text = code.blobs.get(blobKey(repo.key, oid, path));
      if (text === undefined) throw missing(path);
      return { kind: 'file', bytes: new TextEncoder().encode(text) };
    },
  };
  const sources: DiffSources = {
    get: async () => {
      if (code.down) throw new SourceError('auth', code.down);
      return source;
    },
    authFailed: () => {},
  };
  return { code, sources };
}

/** A commit's diff as the fake host serves it. */
export function commitDiff(oid: string, parent: string | null, files: DiffFile[]): CommitDiff {
  return { title: `Commit ${oid.slice(0, 7)}`, baseOid: parent, headOid: oid, files, totalFiles: files.length, additions: 1, deletions: 0, url: `https://github.com/x/commit/${oid}` };
}

/** An agent with a token, as the `agents` command makes one. */
export function addAgent(db: Db, name: string): { principal: Principal; token: string } {
  const { agent, token } = createAgent(db, name);
  return { principal: { id: agent.id, kind: 'agent', name: agent.name }, token };
}

export interface McpHarnessOptions {
  db?: Db;
  config?: Partial<Config>;
  transport?: AppDeps['transport'];
}

export function mcpHarness(opts: McpHarnessOptions = {}) {
  const db = opts.db ?? seedDb();
  const config: Config = { ...loadConfig({}), webDir: '/nonexistent', ...opts.config };
  const tokens = testTokens();
  const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
  const { code, sources } = fakeCode();
  const logs: string[] = [];
  const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources, log: (l) => logs.push(l) });
  const { principal: agent, token } = addAgent(db, 'Claude');
  const { principal: other, token: otherToken } = addAgent(db, 'Codex');
  const bus = new CommentBus();
  const app = createApp({ db, config, sync, diffs, tokens, transport: opts.transport, bus });

  let nextId = 1;
  /** `headers`: added to the defaults (Claude's token); null leaves one out altogether. */
  const post = (body: unknown, headers: Record<string, string | null> = {}) =>
    app.request('http://localhost/mcp', {
      method: 'POST',
      headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }).filter((e): e is [string, string] => e[1] !== null)),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  /** A JSON-RPC request's response body. */
  const rpc = async (method: string, params?: unknown, headers: Record<string, string | null> = {}) => {
    const res = await post({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, headers);
    return (await res.json()) as { id: number; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
  };
  /** A tool's result: its structuredContent, or its error text. */
  const call = async <T = Record<string, any>>(name: string, args: Record<string, unknown> = {}, headers: Record<string, string | null> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args }, headers);
    if (res.error) throw new Error(`JSON-RPC error ${res.error.code}: ${res.error.message}`);
    const result = res.result as { content: { type: string; text: string }[]; structuredContent?: T; isError?: boolean };
    return result.isError ? { error: result.content[0]!.text, data: undefined as T | undefined } : { error: undefined, data: result.structuredContent as T };
  };
  /** A tool's structuredContent; throws with the tool's error. */
  const ok = async <T = Record<string, any>>(name: string, args: Record<string, unknown> = {}) => {
    const r = await call<T>(name, args);
    if (r.error !== undefined) throw new Error(`${name} failed: ${r.error}`);
    return r.data!;
  };
  /** A tool's error text; throws if it succeeded. */
  const fails = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.error === undefined) throw new Error(`${name} succeeded: ${JSON.stringify(r.data)}`);
    return r.error;
  };
  return { db, config, app, diffs, bus, code, logs, agent, token, other, otherToken, post, rpc, call, ok, fails };
}

/** The PR diff a harness's fake host serves for `alice/app#n`. */
export function servePr(code: FakeCode, repo: string, n: number, headOid: string, baseOid: string, files: DiffFile[]): void {
  code.prs.set(prKey(repo, n), { headOid, baseOid, files });
}

/**
 * A branch the harness's fake host has, at `headOid`, that compares with the default branch as `baseOid` (the merge base)
 * and `files`. Calling it again is a push (or a moved merge base).
 */
export function serveBranch(code: FakeCode, repo: string, branch: string, headOid: string, baseOid: string, files: DiffFile[], committedAt: string | null = null): void {
  code.branches.set(branchKey(repo, branch), { headOid, baseOid, files, committedAt });
}
