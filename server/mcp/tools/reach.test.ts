// Agents limited to some sources (reach.ts): every tool, for an agent that reaches github.com only and one that
// reaches the GitLab source only. Out of reach, a repository reads as one gh-dash doesn't track, a thread or comment as
// one that doesn't exist and a source as a host that isn't one, in the same words; nothing out of reach is listed,
// returned by wait_for_reply or wakes it; and nothing out of reach is changed.

import { describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../../../shared/api';
import { setAgentSources } from '../../db/agents';
import { ensureSource, removeSource } from '../../db/sources';
import * as comments from '../../services/comments';
import { selfPrincipal } from '../../services/comments';
import { addAgent, mcpHarness, sha } from '../../test/mcp';
import { addManualRepo, GITLAB_HOST, seedDb, seedGitLab } from '../../test/seed';

const HEAD = sha('a');
/** The GitLab source's repository. */
const GL = `${GITLAB_HOST}/platform/app`;
const GH = 'alice/app';
const OTHER_HOST = 'gitlab.other.example';

type Who = 'gh' | 'gl' | 'all';

/**
 * github.com and gitlab.example.com, a thread of the user's on a PR of each, and three agents: Claude reaches github.com
 * only, Codex the GitLab source only, and Third every source.
 */
function setup() {
  const db = seedDb();
  const gitlab = seedGitLab(db).src.id;
  const h = mcpHarness({ db });
  const deps = { db: h.db, bus: h.bus };
  const self = selfPrincipal(h.db);
  const gh = comments.createPrThread(deps, self, GH, 2, { commitOid: HEAD, body: 'On GitHub' });
  const gl = comments.createPrThread(deps, self, GL, 2, { commitOid: HEAD, body: 'On GitLab' });
  const third = addAgent(h.db, 'Third');
  setAgentSources(h.db, h.agent.id, ['github.com']);
  setAgentSources(h.db, h.other.id, [GITLAB_HOST]);
  const tokens: Record<Who, string> = { gh: h.token, gl: h.otherToken, all: third.token };
  const principals = { gh: h.agent, gl: h.other, all: third.principal };
  /** A tool's result, as one of the agents. */
  const as = (who: Who, name: string, args: Record<string, unknown> = {}) => h.call(name, args, { authorization: `Bearer ${tokens[who]}` });
  const okAs = async (who: Who, name: string, args: Record<string, unknown> = {}) => {
    const r = await as(who, name, args);
    if (r.error !== undefined) throw new Error(`${name} failed for ${who}: ${r.error}`);
    return r.data!;
  };
  const failsAs = async (who: Who, name: string, args: Record<string, unknown> = {}) => {
    const r = await as(who, name, args);
    if (r.error === undefined) throw new Error(`${name} succeeded for ${who}: ${JSON.stringify(r.data)}`);
    return r.error;
  };
  /** The user replies through the HTTP API, as the web app does (the REST API reaches every source). */
  const userReplies = (threadId: number, body: string) =>
    h.app.request(`http://localhost/api/v1/threads/${threadId}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
    });
  /** What a thread holds now: its comments and status, and the event log's length. */
  const snapshot = (threadId: number) => ({
    comments: h.db.all('SELECT id, author_id, body FROM comments WHERE thread_id = ? ORDER BY id', [threadId]),
    status: h.db.get('SELECT status, resolved_by FROM comment_threads WHERE id = ?', [threadId]),
    events: h.db.get<{ n: number }>('SELECT count(*) AS n FROM comment_events')!.n,
  });
  return { ...h, deps, self, gitlab, gh, gl, principals, as, okAs, failsAs, userReplies, snapshot };
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keys = (items: { key?: string; repo?: string }[]) => [...new Set(items.map((i) => i.key ?? i.repo))];

describe('whoami', () => {
  it('lists only the sources within reach, and says the agent is limited; one reaching all is unchanged', async () => {
    const h = setup();
    const note = expect.stringContaining('The user limited you to these sources');
    expect(await h.okAs('gh', 'whoami')).toEqual({
      agent: { id: h.agent.id, name: 'Claude', scoped: true }, server: { version: h.config.version }, sources: [{ host: 'github.com', kind: 'github' }], note,
    });
    expect(await h.okAs('gl', 'whoami')).toMatchObject({ agent: { name: 'Codex', scoped: true }, sources: [{ host: GITLAB_HOST, kind: 'gitlab' }], note });
    expect(await h.okAs('all', 'whoami')).toEqual({
      agent: { id: h.principals.all.id, name: 'Third' }, server: { version: h.config.version },
      sources: [{ host: 'github.com', kind: 'github' }, { host: GITLAB_HOST, kind: 'gitlab' }],
    });
  });

  it('follows a change from the next request', async () => {
    const h = setup();
    setAgentSources(h.db, h.agent.id, null);
    expect(await h.okAs('gh', 'whoami')).not.toHaveProperty('note');
    expect((await h.okAs('gh', 'whoami')).sources).toHaveLength(2);
    setAgentSources(h.db, h.agent.id, [GITLAB_HOST]);
    expect((await h.okAs('gh', 'whoami')).sources).toEqual([{ host: GITLAB_HOST, kind: 'gitlab' }]);
  });
});

describe('list_repos', () => {
  it('lists the repositories within reach only', async () => {
    const h = setup();
    const gh = await h.okAs('gh', 'list_repos');
    expect(gh.total).toBe(5);
    expect(gh.repos.every((r: { provider: string }) => r.provider === 'github')).toBe(true);
    expect(await h.okAs('gl', 'list_repos')).toMatchObject({ repos: [{ key: GL, provider: 'gitlab', openThreads: 1 }], total: 1 });
    expect((await h.okAs('all', 'list_repos')).total).toBe(6);
    expect(keys((await h.okAs('gh', 'list_repos', { source: 'github.com' })).repos)).not.toContain(GL);
    expect(keys((await h.okAs('gl', 'list_repos', { query: 'app' })).repos)).toEqual([GL]);
  });

  it('reads a source out of reach as a host that is no source', async () => {
    const h = setup();
    const out = await h.failsAs('gh', 'list_repos', { source: GITLAB_HOST });
    expect(out).toBe(`${GITLAB_HOST} isn't a source here.`);
    expect(out.replace(GITLAB_HOST, 'HOST')).toBe((await h.failsAs('gh', 'list_repos', { source: OTHER_HOST })).replace(OTHER_HOST, 'HOST'));
    expect(await h.failsAs('gl', 'list_repos', { source: `${GITLAB_HOST},github.com` })).toBe("github.com isn't a source here.");
    expect(await h.failsAs('all', 'list_repos', { source: OTHER_HOST })).toBe(`${OTHER_HOST} isn't a source here.`);
  });
});

describe('resolve_repo', () => {
  it('resolves what is within reach, and reads the rest as hosts that are no source, alike for tracked and untracked', async () => {
    const h = setup();
    expect(await h.okAs('gh', 'resolve_repo', { remote_url: 'git@github.com:alice/app.git' })).toMatchObject({ key: GH });
    expect(await h.okAs('gl', 'resolve_repo', { remote_url: `git@${GITLAB_HOST}:platform/app.git` })).toMatchObject({ key: GL });
    const outOfReach = (host: string) => `${host} isn't a source of gh-dash's that you may reach (whoami lists yours). The user decides which ones an agent reaches.`;
    // github.com only: the GitLab project, by remote or key, tracked or not, and another host alike.
    for (const remote_url of [`https://${GITLAB_HOST}/platform/app.git`, `git@${GITLAB_HOST}:platform/app.git`, GL, `${GITLAB_HOST}/platform/nope`]) {
      expect(await h.failsAs('gh', 'resolve_repo', { remote_url }), remote_url).toBe(outOfReach(GITLAB_HOST));
    }
    expect(await h.failsAs('gh', 'resolve_repo', { remote_url: `https://${OTHER_HOST}/x/y.git` })).toBe(outOfReach(OTHER_HOST));
    // The GitLab source only: github.com's repos, by remote, key or an owned repo's short name.
    for (const remote_url of ['https://github.com/alice/app', 'git@github.com:alice/app.git', GH, 'alice/nope', 'app', 'nope']) {
      expect(await h.failsAs('gl', 'resolve_repo', { remote_url }), remote_url).toBe(outOfReach('github.com'));
    }
    // One that reaches every source is told what it always was.
    expect(await h.failsAs('all', 'resolve_repo', { remote_url: `https://${OTHER_HOST}/x/y.git` })).toContain(`${OTHER_HOST} isn't a source in gh-dash. The user can add it`);
    expect(await h.okAs('all', 'resolve_repo', { remote_url: GL })).toMatchObject({ key: GL });
  });

  it('still says a repository within reach is untracked', async () => {
    const h = setup();
    expect(await h.failsAs('gl', 'resolve_repo', { remote_url: `https://${GITLAB_HOST}/platform/nope.git` })).toBe(`${GITLAB_HOST}/platform/nope isn't tracked in gh-dash. The user can add it in gh-dash (Repositories → Add).`);
  });
});

/** Every tool that takes a repository key, with arguments that work for alice/app#2 and the GitLab project's !2. */
const BY_REPO: [string, (repo: string) => Record<string, unknown>][] = [
  ['list_prs', (repo) => ({ repo })],
  ['find_pr', (repo) => ({ repo, branch: 'feature' })],
  ['get_pr', (repo) => ({ repo, number: 2 })],
  ['list_branches', (repo) => ({ repo })],
  ['get_branch', (repo) => ({ repo, branch: 'topic/x' })],
  ['list_threads', (repo) => ({ repo })],
  ['list_threads', (repo) => ({ repo, pr: 2 })],
  ['wait_for_reply', (repo) => ({ repo, after: 0 })],
  ['wait_for_reply', (repo) => ({ repo, pr: 2, after: 0 })],
  ['show', (repo) => ({ repo, pr: 2 })],
  ['add_comment', (repo) => ({ repo, pr: 2, body: 'Here' })],
];

describe('tools that take a repository', () => {
  const untracked = (key: string) => `Repository ${key} isn't tracked in gh-dash (list_repos lists the ones that are)`;

  it('answer for a repository out of reach exactly as for one gh-dash does not track', async () => {
    const h = setup();
    const before = h.snapshot(h.gl.id);
    for (const [name, args] of BY_REPO) {
      for (const [who, key, missing] of [['gh', GL, `${GITLAB_HOST}/platform/nope`], ['gl', GH, 'alice/nope'], ['gl', 'app', 'nope']] as const) {
        const out = await h.failsAs(who, name, args(key));
        expect(out, `${name} ${who} ${key}`).toBe(untracked(key));
        expect(out.replace(key, 'KEY'), `${name} ${who}`).toBe((await h.failsAs(who, name, args(missing))).replace(missing, 'KEY'));
      }
    }
    // Nothing was written, fetched or shown.
    expect(h.snapshot(h.gl.id)).toEqual(before);
    expect(h.db.get<{ n: number }>('SELECT count(*) AS n FROM comment_threads')!.n).toBe(2);
    expect(h.code.requests).toEqual([]);
  });

  it('work on the repositories within reach', async () => {
    const h = setup();
    for (const [name, args] of BY_REPO) {
      for (const [who, key] of [['gh', GH], ['gl', GL], ['all', GH], ['all', GL]] as const) {
        const r = await h.as(who, name, args(key));
        expect(r.error, `${name} ${who} ${key}`).toBeUndefined();
      }
    }
    // Two new threads each on alice/app#2 (Claude, Third) and the GitLab !2 (Codex, Third).
    expect(h.db.all(`SELECT r.key, count(*) AS n FROM comment_threads t JOIN repos r ON r.id = t.repo_id GROUP BY r.key ORDER BY r.key`)).toEqual([
      { key: GH, n: 3 },
      { key: GL, n: 3 },
    ]);
  });
});

/** Every tool that takes a thread or comment id: `thread` and `comment` are ids in the other source's repository. */
const BY_ID: [string, (thread: number, comment: number) => Record<string, unknown>, 'Thread' | 'Comment'][] = [
  ['get_thread', (thread) => ({ id: thread }), 'Thread'],
  ['reply', (thread) => ({ thread_id: thread, body: 'Hello' }), 'Thread'],
  ['resolve_thread', (thread) => ({ thread_id: thread }), 'Thread'],
  ['resolve_thread', (thread) => ({ thread_id: thread, comment: 'Done' }), 'Thread'],
  ['reopen_thread', (thread) => ({ thread_id: thread, comment: 'Again' }), 'Thread'],
  ['show', (thread) => ({ thread_id: thread }), 'Thread'],
  ['edit_comment', (_thread, comment) => ({ comment_id: comment, body: 'Changed' }), 'Comment'],
  ['delete_comment', (_thread, comment) => ({ comment_id: comment }), 'Comment'],
];

describe('tools that take a thread or comment', () => {
  /**
   * Each agent's own thread and reply on the other source's repository, as when it was limited after writing them: its
   * own, so nothing but its reach would refuse them.
   */
  function withOwnWork() {
    const h = setup();
    const own = {
      gh: comments.createPrThread(h.deps, h.agent, GL, 2, { commitOid: HEAD, body: 'Mine, on GitLab' }),
      gl: comments.createPrThread(h.deps, h.other, GH, 2, { commitOid: HEAD, body: 'Mine, on GitHub' }),
    };
    const reply = {
      gh: comments.reply(h.deps, h.agent, own.gh.id, 'My reply').comments.at(-1)!.id,
      gl: comments.reply(h.deps, h.other, own.gl.id, 'My reply').comments.at(-1)!.id,
    };
    return { ...h, own, reply };
  }

  it('answer for a thread or comment out of reach exactly as for one that does not exist, and change nothing', async () => {
    const h = withOwnWork();
    const before = { gh: h.snapshot(h.own.gh.id), gl: h.snapshot(h.own.gl.id), userGl: h.snapshot(h.gl.id), userGh: h.snapshot(h.gh.id) };
    for (const [name, args, what] of BY_ID) {
      for (const who of ['gh', 'gl'] as const) {
        // Its own thread and reply, and the user's thread (whose first comment isn't its own).
        const cases = [[h.own[who].id, h.reply[who]], [who === 'gh' ? h.gl.id : h.gh.id, (who === 'gh' ? h.gl : h.gh).comments[0]!.id]] as const;
        for (const [thread, comment] of cases) {
          const out = await h.failsAs(who, name, args(thread, comment));
          expect(out, `${name} ${who} ${thread}`).toBe(`${what} not found`);
          expect(await h.failsAs(who, name, args(9999, 9999)), `${name} missing`).toBe(`${what} not found`);
        }
      }
    }
    expect({ gh: h.snapshot(h.own.gh.id), gl: h.snapshot(h.own.gl.id), userGl: h.snapshot(h.gl.id), userGh: h.snapshot(h.gh.id) }).toEqual(before);
  });

  it('wait_for_reply refuses thread ids out of reach as unknown ones, deleted threads too', async () => {
    const h = withOwnWork();
    expect(await h.failsAs('gh', 'wait_for_reply', { thread_ids: [h.gl.id] })).toBe(`Thread ${h.gl.id} not found`);
    expect(await h.failsAs('gh', 'wait_for_reply', { thread_ids: [h.gh.id, h.own.gh.id] })).toBe(`Thread ${h.own.gh.id} not found`);
    expect(await h.failsAs('gl', 'wait_for_reply', { thread_ids: [h.gh.id] })).toBe(`Thread ${h.gh.id} not found`);
    // A deleted thread lives on in its events: out of reach, it is as unknown as before.
    comments.deleteThread(h.deps, h.self, h.gl.id);
    expect(await h.failsAs('gh', 'wait_for_reply', { thread_ids: [h.gl.id] })).toBe(`Thread ${h.gl.id} not found`);
    expect((await h.okAs('gl', 'wait_for_reply', { thread_ids: [h.gl.id], after: 0 })).events.map((e: { kind: string }) => e.kind)).toEqual(['thread_opened', 'thread_deleted']);
    expect((await h.okAs('all', 'wait_for_reply', { thread_ids: [h.gl.id, h.gh.id], after: 0 })).events.length).toBeGreaterThan(0);
  });

  it('work on the threads and comments within reach', async () => {
    const h = withOwnWork();
    for (const [who, user] of [['gh', h.gh], ['gl', h.gl]] as const) {
      const other = who === 'gh' ? h.gl : h.gh;
      expect(await h.okAs(who, 'get_thread', { id: user.id })).toMatchObject({ id: user.id, status: 'open' });
      const replied = await h.okAs(who, 'reply', { thread_id: user.id, body: 'Within reach' });
      const mine = replied.lastComment.id as number;
      expect(await h.okAs(who, 'edit_comment', { comment_id: mine, body: 'Within reach, edited' })).toMatchObject({ lastComment: { excerpt: 'Within reach, edited' } });
      expect(await h.okAs(who, 'resolve_thread', { thread_id: user.id })).toMatchObject({ status: 'resolved' });
      expect(await h.okAs(who, 'reopen_thread', { thread_id: user.id })).toMatchObject({ status: 'open' });
      expect(await h.okAs(who, 'show', { thread_id: user.id })).toMatchObject({ windows: 0 });
      expect(await h.okAs(who, 'delete_comment', { comment_id: mine })).toMatchObject({ deleted: 'comment' });
      // The agent reaching every source reaches both.
      expect(await h.okAs('all', 'get_thread', { id: other.id })).toMatchObject({ id: other.id });
    }
  });
});

describe('lists without a repository', () => {
  it('list_prs lists the pull requests within reach only', async () => {
    const h = setup();
    const ghPrs = (await h.okAs('gh', 'list_prs', { state: 'all', limit: 200 })).items as { repo: string; ref: string }[];
    expect(ghPrs.length).toBeGreaterThan(0);
    expect(ghPrs.some((p) => p.repo === GL)).toBe(false);
    const glPrs = (await h.okAs('gl', 'list_prs', { state: 'all' })) as { items: { repo: string; ref: string }[]; total: number };
    expect(glPrs.items.map((p) => p.ref)).toEqual([`${GL}!3`, `${GL}!2`, `${GL}!1`]);
    expect(glPrs.total).toBe(3);
    const all = (await h.okAs('all', 'list_prs', { state: 'all', limit: 200 })).items as { repo: string }[];
    expect(all.length).toBe(ghPrs.length + 3);
    // Filters and pages within reach.
    expect((await h.okAs('gl', 'list_prs', { state: 'open' })).items.map((p: { ref: string }) => p.ref)).toEqual([`${GL}!2`]);
    expect((await h.okAs('gl', 'list_prs', { state: 'all', comments: 'any' })).items.map((p: { ref: string }) => p.ref)).toEqual([`${GL}!2`]);
    const first = await h.okAs('gl', 'list_prs', { state: 'all', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect((await h.okAs('gl', 'list_prs', { state: 'all', limit: 2, cursor: first.nextCursor })).items.map((p: { ref: string }) => p.ref)).toEqual([`${GL}!1`]);
  });

  it('list_threads lists, counts and totals the threads within reach only', async () => {
    const h = setup();
    comments.setThreadStatus(h.deps, h.self, h.gl.id, 'resolved');
    const ghThreads = await h.okAs('gh', 'list_threads', { status: 'all' });
    expect(ghThreads).toMatchObject({ items: [{ id: h.gh.id }], total: 1, counts: { open: 1, resolved: 0 } });
    const glThreads = await h.okAs('gl', 'list_threads', { status: 'all' });
    expect(glThreads).toMatchObject({ items: [{ id: h.gl.id }], total: 1, counts: { open: 0, resolved: 1 } });
    expect(await h.okAs('gl', 'list_threads')).toMatchObject({ items: [], total: 0 });
    expect(await h.okAs('all', 'list_threads', { status: 'all' })).toMatchObject({ total: 2, counts: { open: 1, resolved: 1 } });
    for (const args of [{ author: 'you' }, { waiting_on: 'me' }, { q: 'On' }, { since: '2020-01-01' }]) {
      expect((await h.okAs('gh', 'list_threads', { status: 'all', ...args })).items.map((t: { id: number }) => t.id), JSON.stringify(args)).toEqual([h.gh.id]);
    }
  });

  it('wait_for_reply returns the events within reach only', async () => {
    const h = setup();
    const refs = async (who: Who) => (await h.okAs(who, 'wait_for_reply', { after: 0 })).events.map((e: { ref: string }) => e.ref);
    expect(await refs('gh')).toEqual([`${GH}#2`]);
    expect(await refs('gl')).toEqual([`${GL}!2`]);
    expect(await refs('all')).toEqual([`${GH}#2`, `${GL}!2`]);
  });
});

describe('wait_for_reply, waiting', () => {
  it('never wakes for what happens out of reach, and wakes for what happens within', async () => {
    const h = setup();
    const waitFor = vi.spyOn(h.bus, 'waitFor');
    const waiting = h.okAs('gh', 'wait_for_reply', { timeout_s: 20 });
    await later(30);
    expect(waitFor).toHaveBeenCalledTimes(1);
    const matches = waitFor.mock.calls[0]![0];
    const message = (repo: string, threadId: number): StreamMessage => ({
      type: 'comments', repo, kind: 'pr', number: 2, branch: null, commitOid: HEAD, threadId, event: 'replied', by: h.self,
    });
    expect(matches(message(GL, h.gl.id))).toBe(false);
    expect(matches(message(GH, h.gh.id))).toBe(true);
    // Out of reach: the user's reply and a thread they open wake nothing, and nothing comes back.
    await h.userReplies(h.gl.id, 'Out of reach');
    comments.createPrThread(h.deps, h.self, GL, 3, { commitOid: HEAD, body: 'Also out of reach' });
    await later(30);
    expect(waitFor).toHaveBeenCalledTimes(1);
    await h.userReplies(h.gh.id, 'Within reach');
    const got = await waiting;
    expect(got.events).toMatchObject([{ ref: `${GH}#2`, by: 'you', excerpt: 'Within reach' }]);
    // Woken once, by that reply: it listens again before looking, and finds it.
    expect(waitFor).toHaveBeenCalledTimes(2);
  });

  it('times out with nothing when only what is out of reach happens', async () => {
    const h = setup();
    const cursor = h.db.get<{ id: number }>('SELECT max(id) AS id FROM comment_events')!.id;
    const waiting = h.okAs('gl', 'wait_for_reply', { timeout_s: 1, after: cursor });
    await later(30);
    await h.userReplies(h.gh.id, 'Out of reach');
    expect(await waiting).toEqual({ events: [], cursor });
  });
});

describe('sources added and deleted', () => {
  it('reaches a source added later only for the agents that reach every source', async () => {
    const h = setup();
    const added = ensureSource(h.db, { kind: 'gitlab', host: OTHER_HOST, baseUrl: `https://${OTHER_HOST}` });
    addManualRepo(h.db, 'team/tool', { source: added });
    const tool = `${OTHER_HOST}/team/tool`;
    expect(keys((await h.okAs('all', 'list_repos')).repos)).toContain(tool);
    expect((await h.okAs('all', 'whoami')).sources.map((s: { host: string }) => s.host)).toEqual(['github.com', GITLAB_HOST, OTHER_HOST]);
    for (const who of ['gh', 'gl'] as const) {
      expect(keys((await h.okAs(who, 'list_repos')).repos), who).not.toContain(tool);
      expect(await h.failsAs(who, 'list_prs', { repo: tool })).toBe(`Repository ${tool} isn't tracked in gh-dash (list_repos lists the ones that are)`);
    }
  });

  it('never widens an agent whose source is deleted: left with none, it reaches nothing, the same host added again included', async () => {
    const h = setup();
    removeSource(h.db, h.gitlab);
    const nothing = async () => {
      expect(await h.okAs('gl', 'whoami')).toMatchObject({ agent: { scoped: true }, sources: [] });
      expect(await h.okAs('gl', 'list_repos')).toEqual({ repos: [], total: 0 });
      expect(await h.okAs('gl', 'list_prs', { state: 'all' })).toMatchObject({ items: [], total: 0 });
      expect(await h.okAs('gl', 'list_threads', { status: 'all' })).toMatchObject({ items: [], total: 0 });
      expect((await h.okAs('gl', 'wait_for_reply', { after: 0, timeout_s: 1 })).events).toEqual([]);
      expect(await h.failsAs('gl', 'get_thread', { id: h.gh.id })).toBe('Thread not found');
      expect(await h.failsAs('gl', 'list_repos', { source: 'github.com' })).toBe("github.com isn't a source here.");
    };
    await nothing();
    // github.com stays within reach of the one limited to it.
    expect((await h.okAs('gh', 'whoami')).sources).toEqual([{ host: 'github.com', kind: 'github' }]);
    const again = ensureSource(h.db, { kind: 'gitlab', host: GITLAB_HOST, baseUrl: `https://${GITLAB_HOST}` });
    addManualRepo(h.db, 'platform/app', { source: again });
    await nothing();
    expect(keys((await h.okAs('all', 'list_repos')).repos)).toContain(GL);
  });
});
