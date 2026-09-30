import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, ThreadAnchor } from '../../shared/api';
import { threadListMarkdown } from '../format/markdown';
import {
  AgentWrote, agentFootprint, agentForToken, agentSourceIds, agentTokenIs, BUILT_IN_AGENT, builtInAgent, createAgent, deleteAgent, findAgent, getAgent, listAgents, principalForToken,
  regenerateAgentToken, setAgentEnabled, setAgentSources,
} from './agents';
import { commentEventsAfter } from './comment-events';
import { addComment, createThread, getPrincipal, getThread, SELF_PRINCIPAL_ID, setThreadStatus } from './comments';
import { type Db, openDb } from './db';
import { loadQueryCtx } from './filters';
import { listActivity } from './lists';
import { listThreadItems } from './thread-list';
import { ensureSource, removeSource } from './sources';
import { GITLAB_HOST, seedDb, seedGitLab } from '../test/seed';

const T0 = '2026-09-29T10:00:00.000Z';
const T1 = '2026-09-29T11:00:00.000Z';
const ms = (iso: string) => Date.parse(iso);

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const stored = (id: number) =>
  db.get<{ token_hash: string; prefix: string; last_used_at: string | null; revoked_at: string | null }>(
    'SELECT token_hash, prefix, last_used_at, revoked_at FROM agent_tokens WHERE principal_id = ?',
    [id],
  )!;

describe('agents', () => {
  it('makes an agent with a token shown once: only its hash and first characters are kept', () => {
    const { agent, token } = createAgent(db, '  Claude  ', T0);
    expect(token).toMatch(/^ghd_[A-Za-z0-9_-]{43}$/);
    expect(agent).toEqual({ id: 2, name: 'Claude', tokenPrefix: token.slice(0, 8), createdAt: T0, lastUsedAt: null, disabledAt: null, builtIn: false, sources: null });
    expect(stored(agent.id)).toEqual({ token_hash: createHash('sha256').update(token).digest('hex'), prefix: token.slice(0, 8), last_used_at: null, revoked_at: null });
    expect(JSON.stringify(db.all('SELECT * FROM agent_tokens'))).not.toContain(token);
    expect(db.get('SELECT id, kind, name FROM principals WHERE id = ?', [agent.id])).toEqual({ id: agent.id, kind: 'agent', name: 'Claude' });
    // Every token is new.
    expect(createAgent(db, 'Codex').token).not.toBe(token);
  });

  it('refuses a name that is empty, too long, has control characters, is "You", or is taken in any case', () => {
    createAgent(db, 'Claude');
    expect(() => createAgent(db, '   ')).toThrow('An agent needs a name');
    expect(() => createAgent(db, 'x'.repeat(65))).toThrow('at most 64 characters');
    expect(() => createAgent(db, 'a\u0007b')).toThrow("can't hold control characters");
    expect(() => createAgent(db, 'you')).toThrow('"You" is the dashboard user');
    // Digits alone are how the CLI and tools name an agent by id.
    expect(() => createAgent(db, ' 42 ')).toThrow("An agent's name can't be only digits (those are ids)");
    expect(createAgent(db, 'Agent 2').agent.name).toBe('Agent 2');
    expect(() => createAgent(db, 'CLAUDE')).toThrow('There is already an agent called Claude (id 2); regenerate its token instead');
    expect(createAgent(db, 'x'.repeat(64)).agent.name).toHaveLength(64);
    expect(listAgents(db).map((a) => a.name)).toEqual(['Claude', 'Agent 2', 'x'.repeat(64)]);
  });

  it('lists agents oldest first and finds one by id or name', () => {
    const a = createAgent(db, 'Claude', T0).agent;
    const b = createAgent(db, 'Codex', T1).agent;
    // A name that looks like another agent's id is a name.
    expect(createAgent(db, '3x').agent).toMatchObject({ id: 4, name: '3x' });
    expect(findAgent(db, '3x')).toMatchObject({ id: 4 });
    expect(listAgents(db).slice(0, 2)).toEqual([a, b]);
    expect(findAgent(db, String(b.id))).toEqual(b);
    expect(findAgent(db, ' claude ')).toEqual(a);
    expect(findAgent(db, '1')).toBeNull(); // the dashboard user isn't an agent
    expect(findAgent(db, 'nobody')).toBeNull();
    expect(getAgent(db, 1)).toBeNull();
  });

  it('knows an agent by its token, marking it used at most once a minute', () => {
    const { agent, token } = createAgent(db, 'Claude', T0);
    expect(principalForToken(db, token, ms(T0))).toEqual({ id: agent.id, kind: 'agent', name: 'Claude' });
    expect(getAgent(db, agent.id)!.lastUsedAt).toBe(T0);
    principalForToken(db, token, ms(T0) + 59_000);
    expect(getAgent(db, agent.id)!.lastUsedAt).toBe(T0);
    principalForToken(db, token, ms(T0) + 60_000);
    expect(getAgent(db, agent.id)!.lastUsedAt).toBe('2026-09-29T10:01:00.000Z');
  });

  it('knows nothing of malformed, unknown or near-miss tokens', () => {
    const { token } = createAgent(db, 'Claude');
    for (const bad of ['', 'ghd_', token.slice(0, -1), `${token}x`, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, ` ${token}`, token.toUpperCase()]) {
      expect(principalForToken(db, bad), bad).toBeNull();
    }
  });

  it('disables an agent at once, keeping its token (hash and prefix); enabling lets the same token in again', () => {
    const { agent, token } = createAgent(db, 'Claude', T0);
    const before = stored(agent.id);
    const disabled = setAgentEnabled(db, agent.id, false, T1)!;
    expect(disabled).toEqual({ ...agent, disabledAt: T1 });
    expect(stored(agent.id)).toEqual({ ...before, revoked_at: T1 });
    expect(principalForToken(db, token)).toBeNull();
    // Known for what it is: a disabled agent's token, never marked used.
    expect(agentForToken(db, token, ms(T1))).toEqual({ principal: { id: agent.id, kind: 'agent', name: 'Claude' }, disabled: true });
    expect(getAgent(db, agent.id)!.lastUsedAt).toBeNull();
    // Again: still disabled when it first was.
    expect(setAgentEnabled(db, agent.id, false, '2026-09-30T00:00:00.000Z')!.disabledAt).toBe(T1);
    expect(listAgents(db)).toEqual([disabled]);
    // Enabled: the same token works again, the same prefix shown.
    expect(setAgentEnabled(db, agent.id, true)).toEqual(agent);
    expect(stored(agent.id)).toEqual(before);
    expect(principalForToken(db, token, ms(T1))).toEqual({ id: agent.id, kind: 'agent', name: 'Claude' });
    expect(agentForToken(db, token, ms(T1))).toMatchObject({ disabled: false });
    expect(setAgentEnabled(db, agent.id, true)).toMatchObject({ disabledAt: null, lastUsedAt: T1 });
    // No such agent; the dashboard's user is none.
    expect(setAgentEnabled(db, 99, false)).toBeNull();
    expect(setAgentEnabled(db, 1, false)).toBeNull();
    expect(db.get('SELECT kind FROM principals WHERE id = ?', [agent.id])).toEqual({ kind: 'agent' });
  });

  it("says whether a token (by its sha256) is an agent's, disabled or not; a deleted agent's is no one's", () => {
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const { agent, token } = createAgent(db, 'Claude');
    const other = createAgent(db, 'Codex');
    expect(agentTokenIs(db, agent.id, sha(token))).toBe(true);
    expect(agentTokenIs(db, agent.id, sha(other.token))).toBe(false);
    expect(agentTokenIs(db, 99, sha(token))).toBe(false);
    setAgentEnabled(db, agent.id, false);
    expect(agentTokenIs(db, agent.id, sha(token))).toBe(true);
    const next = regenerateAgentToken(db, agent.id)!;
    expect(agentTokenIs(db, agent.id, sha(token))).toBe(false);
    expect(agentTokenIs(db, agent.id, sha(next.token))).toBe(true);
    deleteAgent(db, agent.id);
    expect(agentTokenIs(db, agent.id, sha(next.token))).toBe(false);
  });

  it('reads an agent revoked before disabling existed as disabled, and enables it with its old token', () => {
    const { agent, token } = createAgent(db, 'Claude', T0);
    // What revoking left: revoked_at set, the token's hash and prefix kept.
    db.run('UPDATE agent_tokens SET revoked_at = ? WHERE principal_id = ?', [T1, agent.id]);
    expect(getAgent(db, agent.id)).toMatchObject({ disabledAt: T1, tokenPrefix: token.slice(0, 8) });
    expect(principalForToken(db, token)).toBeNull();
    setAgentEnabled(db, agent.id, true);
    expect(principalForToken(db, token)).toMatchObject({ id: agent.id });
  });

  it('regenerates a token: the old one stops working, the agent is enabled and not yet used', () => {
    const { agent, token } = createAgent(db, 'Claude', T0);
    principalForToken(db, token, ms(T0));
    setAgentEnabled(db, agent.id, false, T0);
    const next = regenerateAgentToken(db, agent.id, T1)!;
    expect(next.token).not.toBe(token);
    expect(next.agent).toEqual({ ...agent, tokenPrefix: next.token.slice(0, 8), lastUsedAt: null, disabledAt: null });
    expect(agentForToken(db, token)).toBeNull();
    expect(principalForToken(db, token)).toBeNull();
    expect(principalForToken(db, next.token)).toMatchObject({ id: agent.id });
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM agent_tokens')!.n).toBe(1);
    expect(regenerateAgentToken(db, 99)).toBeNull();
    expect(regenerateAgentToken(db, 1)).toBeNull();
  });

  it('takes a token the user chose: 24–256 printable ASCII characters, at most 4 of them kept to tell it apart', () => {
    const mine = 'correct-horse-battery-staple!';
    const { agent, token } = createAgent(db, 'Claude', T0, mine);
    expect(token).toBe(mine);
    expect(agent.tokenPrefix).toBe('corr');
    expect(stored(agent.id)).toMatchObject({ token_hash: createHash('sha256').update(mine).digest('hex'), prefix: 'corr' });
    expect(principalForToken(db, mine)).toMatchObject({ id: agent.id, name: 'Claude' });
    // One shaped like a generated token keeps a generated one's prefix (`ghd_` and 4 more).
    const shaped = `ghd_${'A'.repeat(43)}`;
    expect(createAgent(db, 'Codex', T0, shaped).agent.tokenPrefix).toBe('ghd_AAAA');
    // Regenerating with a chosen token.
    const next = regenerateAgentToken(db, agent.id, T1, 'another-long-enough-token-000')!;
    expect(next.agent.tokenPrefix).toBe('anot');
    expect(principalForToken(db, mine)).toBeNull();
    expect(principalForToken(db, 'another-long-enough-token-000')).toMatchObject({ id: agent.id });
  });

  it("refuses a chosen token of the wrong shape, or another agent's", () => {
    for (const bad of ['y'.repeat(23), 'y'.repeat(257), 'has a space in the middle of it', 'tab\tin-the-middle-of-it-000', 'ünïcode-in-a-long-token-000', '']) {
      expect(() => createAgent(db, 'Claude', T0, bad), JSON.stringify(bad)).toThrow(/24 to 256|printable ASCII/);
    }
    const taken = 'a-token-another-agent-has-000';
    const { agent } = createAgent(db, 'Claude', T0, taken);
    expect(() => createAgent(db, 'Codex', T0, taken)).toThrow("That token is already another agent's");
    expect(listAgents(db).map((a) => a.name)).toEqual(['Claude']);
    const codex = createAgent(db, 'Codex', T0).agent;
    expect(() => regenerateAgentToken(db, codex.id, T1, taken)).toThrow("That token is already another agent's");
    // Its own current token is no other agent's.
    expect(regenerateAgentToken(db, agent.id, T1, taken)!.token).toBe(taken);
  });

  it('has a built-in agent, made once when needed, listed once it has done something, with no token to change', () => {
    db = seedDb();
    createAgent(db, 'Claude', T0);
    const agent = builtInAgent(db, T0);
    expect(agent).toMatchObject({ kind: 'agent', name: BUILT_IN_AGENT });
    expect(builtInAgent(db)).toEqual(agent);
    expect(listAgents(db).map((a) => a.name)).toEqual(['Claude']);
    db.run(
      `INSERT INTO comment_events (at, actor_id, kind, repo_id, commit_oid, thread_id) VALUES (?, ?, 'thread_opened', (SELECT id FROM repos LIMIT 1), ?, 1)`,
      [T1, agent.id, 'a'.repeat(40)],
    );
    expect(listAgents(db).map((a) => [a.name, a.builtIn])).toEqual([['Claude', false], [BUILT_IN_AGENT, true]]);
    expect(getAgent(db, agent.id)).toMatchObject({ name: BUILT_IN_AGENT, builtIn: true, tokenPrefix: null, disabledAt: null });
    expect(() => regenerateAgentToken(db, agent.id)).toThrow(/built in/);
    expect(() => setAgentEnabled(db, agent.id, false)).toThrow(/built in/);
    expect(() => setAgentEnabled(db, agent.id, true)).toThrow(/built in/);
    expect(() => deleteAgent(db, agent.id)).toThrow("Agent is built in and can't be deleted: MCP requests without a token act as it while gh-dash doesn't require agent tokens (Settings → Instance)");
    expect(getAgent(db, agent.id)).toMatchObject({ name: BUILT_IN_AGENT, builtIn: true });
    expect(() => createAgent(db, ' AGENT ')).toThrow(/built-in agent/);
  });

  it("names the built-in agent otherwise when older agents already have its names, keeping theirs", () => {
    const legacy = (name: string) => db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, ?)`, [name, T0]).lastInsertRowid;
    const kept = [legacy('Agent'), legacy('agent (NO TOKEN)'), legacy('Agent (no token) 2')];
    const agent = builtInAgent(db);
    expect(agent.name).toBe('Agent (no token) 3');
    expect(builtInAgent(db)).toEqual(agent);
    expect(kept.map((id) => getAgent(db, id)!.name)).toEqual(['Agent', 'agent (NO TOKEN)', 'Agent (no token) 2']);
  });

  it("reserves the built-in agent's names, the fallbacks too", () => {
    for (const name of ['Agent', 'agent', 'Agent (no token)', 'AGENT (No Token) 7']) expect(() => createAgent(db, name), name).toThrow(/built-in agent/);
    for (const name of ['Agents', 'Agent Smith', 'Agent (no token) x', 'My Agent']) expect(createAgent(db, name).agent.name, name).toBe(name);
  });
});

describe('agent sources', () => {
  const OTHER = 'gitlab.other.example';
  /** github.com and gitlab.example.com, as `sources` lists them. */
  const withGitLab = () => {
    db = seedDb();
    return seedGitLab(db).src.id;
  };

  it('makes an agent that reaches every source, or only those named (any case), github.com first', () => {
    const gitlab = withGitLab();
    const all = createAgent(db, 'Claude').agent;
    expect(all.sources).toBeNull();
    expect(agentSourceIds(db, all.id)).toBeNull();
    const some = createAgent(db, 'Codex', T0, null, [` ${GITLAB_HOST.toUpperCase()} `, 'GitHub.com', GITLAB_HOST]).agent;
    expect(some.sources).toEqual(['github.com', GITLAB_HOST]);
    expect(agentSourceIds(db, some.id)).toEqual([1, gitlab]);
    const one = createAgent(db, 'Work', T0, null, [GITLAB_HOST]).agent;
    expect(getAgent(db, one.id)!.sources).toEqual([GITLAB_HOST]);
    expect(listAgents(db).map((a) => [a.name, a.sources])).toEqual([['Claude', null], ['Codex', ['github.com', GITLAB_HOST]], ['Work', [GITLAB_HOST]]]);
    // The dashboard's user reaches everything; a principal that isn't there, nothing.
    expect(agentSourceIds(db, 1)).toBeNull();
    expect(agentSourceIds(db, 99)).toEqual([]);
  });

  it('refuses a host that is no source, naming those that are, and none at all; nothing is made then', () => {
    withGitLab();
    expect(() => createAgent(db, 'Claude', T0, null, ['github.com', OTHER])).toThrow(`${OTHER} isn't a source here (the sources: github.com, ${GITLAB_HOST})`);
    expect(() => createAgent(db, 'Claude', T0, null, [OTHER, 'x'])).toThrow(`${OTHER}, x aren't sources here`);
    expect(() => createAgent(db, 'Claude', T0, null, [])).toThrow('Give an agent at least one source, or all of them');
    expect(listAgents(db)).toEqual([]);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM principals')!.n).toBe(1);
  });

  it('limits an agent later, or lets it reach every source again; a bad host changes nothing', () => {
    const gitlab = withGitLab();
    const { agent, token } = createAgent(db, 'Claude');
    expect(setAgentSources(db, agent.id, ['github.com'])).toEqual({ ...agent, sources: ['github.com'] });
    expect(agentSourceIds(db, agent.id)).toEqual([1]);
    expect(setAgentSources(db, agent.id, [GITLAB_HOST])!.sources).toEqual([GITLAB_HOST]);
    expect(agentSourceIds(db, agent.id)).toEqual([gitlab]);
    expect(() => setAgentSources(db, agent.id, ['github.com', OTHER])).toThrow(`${OTHER} isn't a source here`);
    expect(() => setAgentSources(db, agent.id, [])).toThrow('at least one source');
    expect(getAgent(db, agent.id)!.sources).toEqual([GITLAB_HOST]);
    expect(setAgentSources(db, agent.id, null)!.sources).toBeNull();
    expect(agentSourceIds(db, agent.id)).toBeNull();
    expect(db.all('SELECT * FROM agent_sources')).toEqual([]);
    // Its token is untouched.
    expect(principalForToken(db, token)).toMatchObject({ id: agent.id });
    // No such agent; the dashboard's user is none.
    expect(setAgentSources(db, 99, ['github.com'])).toBeNull();
    expect(setAgentSources(db, 1, ['github.com'])).toBeNull();
    expect(agentSourceIds(db, 1)).toBeNull();
    expect(() => db.run('UPDATE principals SET all_sources = 2 WHERE id = 1')).toThrow(/CHECK constraint/);
  });

  it('limits disabled agents and the built-in one too, which is listed once limited', () => {
    withGitLab();
    const { agent } = createAgent(db, 'Claude');
    setAgentEnabled(db, agent.id, false, T1);
    expect(setAgentSources(db, agent.id, ['github.com'])).toMatchObject({ disabledAt: T1, sources: ['github.com'] });
    // Enabling keeps them too.
    expect(setAgentEnabled(db, agent.id, true)!.sources).toEqual(['github.com']);
    // Regenerating its token keeps its sources.
    expect(regenerateAgentToken(db, agent.id)!.agent.sources).toEqual(['github.com']);
    const builtIn = builtInAgent(db);
    expect(listAgents(db).map((a) => a.name)).toEqual(['Claude']);
    expect(setAgentSources(db, builtIn.id, [GITLAB_HOST])).toMatchObject({ builtIn: true, sources: [GITLAB_HOST] });
    expect(listAgents(db).map((a) => [a.name, a.sources])).toEqual([['Claude', ['github.com']], [BUILT_IN_AGENT, [GITLAB_HOST]]]);
    expect(agentSourceIds(db, builtIn.id)).toEqual([gitlabId()]);
    // Every source again: nothing of it to show until it does something.
    setAgentSources(db, builtIn.id, null);
    expect(listAgents(db).map((a) => a.name)).toEqual(['Claude']);
  });

  it('gives a source added later to the agents that reach every source only', () => {
    withGitLab();
    const all = createAgent(db, 'Claude').agent;
    const some = createAgent(db, 'Codex', T0, null, ['github.com']).agent;
    const added = ensureSource(db, { kind: 'gitlab', host: OTHER, baseUrl: `https://${OTHER}` });
    expect(agentSourceIds(db, all.id)).toBeNull();
    expect(agentSourceIds(db, some.id)).toEqual([1]);
    expect(getAgent(db, some.id)!.sources).toEqual(['github.com']);
    expect(setAgentSources(db, some.id, ['github.com', OTHER])!.sources).toEqual(['github.com', OTHER]);
    expect(agentSourceIds(db, some.id)).toEqual([1, added.id]);
  });

  it('never widens an agent when a source is deleted: one left with none reaches nothing, the same host added again included', () => {
    const gitlab = withGitLab();
    const work = createAgent(db, 'Work', T0, null, [GITLAB_HOST]).agent;
    const both = createAgent(db, 'Both', T0, null, ['github.com', GITLAB_HOST]).agent;
    removeSource(db, gitlab);
    expect(getAgent(db, work.id)!.sources).toEqual([]);
    expect(agentSourceIds(db, work.id)).toEqual([]);
    expect(getAgent(db, both.id)!.sources).toEqual(['github.com']);
    expect(agentSourceIds(db, both.id)).toEqual([1]);
    // Added again, the host is another source (a new id): not the agents' until they are given it.
    const again = ensureSource(db, { kind: 'gitlab', host: GITLAB_HOST, baseUrl: `https://${GITLAB_HOST}` });
    expect(again.id).not.toBe(gitlab);
    expect(agentSourceIds(db, work.id)).toEqual([]);
    expect(agentSourceIds(db, both.id)).toEqual([1]);
  });

  function gitlabId(): number {
    return db.get<{ id: number }>('SELECT id FROM sources WHERE host = ?', [GITLAB_HOST])!.id;
  }
});

describe('deleting agents', () => {
  const HEAD = 'a'.repeat(40);
  const general: ThreadAnchor = { path: null, side: null, startLine: null, endLine: null, snippet: null };
  let me: Principal;
  let app: number;
  const as = (id: number): Principal => getPrincipal(db, id)!;
  const open = (number: number, body: string, author: Principal) =>
    createThread(db, { repoId: app, kind: 'pr', number }, { commitOid: HEAD, baseOid: null, anchor: general, body }, author, T0);

  beforeEach(() => {
    db = seedDb();
    me = getPrincipal(db, SELF_PRINCIPAL_ID)!;
    app = db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
  });

  /** Claude: two threads of its own (one resolved), a reply in one of yours, and it resolved yours; Codex: one comment. */
  function withComments() {
    const claude = createAgent(db, 'Claude', T0);
    const codex = createAgent(db, 'Codex', T0).agent;
    const c = as(claude.agent.id);
    const mine = open(2, 'Why?', me);
    addComment(db, mine.id, c, 'Because.', T1);
    setThreadStatus(db, mine.id, 'resolved', c, T1);
    const own = open(2, 'Rename this', c);
    addComment(db, own.id, c, 'And this', T1);
    const done = open(4, 'Nit', c);
    setThreadStatus(db, done.id, 'resolved', me, T1);
    open(2, 'From Codex', as(codex.id));
    return { claude, codex, mine, own, done };
  }

  it('counts what an agent wrote: its comments, their threads, those still open, and those it opened', () => {
    const { claude, codex, mine, own } = withComments();
    expect(agentFootprint(db, claude.agent.id)).toEqual({ comments: 4, threads: 3, openThreads: 1, opened: 2 });
    expect(agentFootprint(db, codex.id)).toEqual({ comments: 1, threads: 1, openThreads: 1, opened: 1 });
    expect(agentFootprint(db, createAgent(db, 'Quiet').agent.id)).toEqual({ comments: 0, threads: 0, openThreads: 0, opened: 0 });
    setThreadStatus(db, mine.id, 'open', me, T1);
    setThreadStatus(db, own.id, 'resolved', me, T1);
    expect(agentFootprint(db, claude.agent.id)).toMatchObject({ threads: 3, openThreads: 1 });
  });

  it('deletes an agent in one go: its token and sources go, it reaches nothing, and it is renamed "Deleted agent #<id>"', () => {
    seedGitLab(db);
    const { agent, token } = createAgent(db, 'Claude', T0, null, [GITLAB_HOST]);
    const other = createAgent(db, 'Codex', T0);
    const deleted = deleteAgent(db, agent.id)!;
    expect(deleted).toEqual({ id: agent.id, name: 'Claude', deletedAs: `Deleted agent #${agent.id}`, footprint: { comments: 0, threads: 0, openThreads: 0, opened: 0 } });
    expect(db.all('SELECT * FROM agent_tokens WHERE principal_id = ?', [agent.id])).toEqual([]);
    expect(db.all('SELECT * FROM agent_sources WHERE principal_id = ?', [agent.id])).toEqual([]);
    expect(db.get('SELECT kind, name, all_sources FROM principals WHERE id = ?', [agent.id])).toEqual({ kind: 'agent', name: `Deleted agent #${agent.id}`, all_sources: 0 });
    // Its token is unknown now, like any other; whatever still resolved it reaches nothing.
    expect(agentForToken(db, token)).toBeNull();
    expect(agentSourceIds(db, agent.id)).toEqual([]);
    // No agent any more: not listed or found, by id or by either name.
    expect(listAgents(db).map((a) => a.name)).toEqual(['Codex']);
    expect(getAgent(db, agent.id)).toBeNull();
    for (const name of ['Claude', `Deleted agent #${agent.id}`, String(agent.id)]) expect(findAgent(db, name), name).toBeNull();
    // The others are as they were.
    expect(principalForToken(db, other.token)).toMatchObject({ name: 'Codex' });
  });

  it('leaves an agent that wrote something as it is when asked to delete it only if it wrote nothing, counting as it deletes', () => {
    const { claude, mine } = withComments();
    const quiet = createAgent(db, 'Quiet', T0);
    // Nothing written: deleted.
    expect(deleteAgent(db, quiet.agent.id, { unlessItWrote: true })).toMatchObject({ deletedAs: `Deleted agent #${quiet.agent.id}` });
    // Written: refused with what it wrote, and nothing changed (its token still works, its name is its own).
    const refused = (() => {
      try {
        deleteAgent(db, claude.agent.id, { unlessItWrote: true });
      } catch (err) {
        return err;
      }
    })();
    expect(refused).toBeInstanceOf(AgentWrote);
    expect(refused).toMatchObject({ agent: { id: claude.agent.id, name: 'Claude' }, footprint: { comments: 4, threads: 3, openThreads: 1 } });
    expect(principalForToken(db, claude.token)).toMatchObject({ name: 'Claude' });
    // A first comment made after a look at the agent, but before the delete, is counted: the count is the delete's own.
    const fresh = createAgent(db, 'Fresh', T0);
    expect(agentFootprint(db, fresh.agent.id).comments).toBe(0);
    addComment(db, mine.id, as(fresh.agent.id), 'Just now', T1);
    expect(() => deleteAgent(db, fresh.agent.id, { unlessItWrote: true })).toThrow(AgentWrote);
    expect(getAgent(db, fresh.agent.id)).toMatchObject({ name: 'Fresh' });
  });

  it('keeps what it wrote, resolved and did, everywhere its name shows, under its new name', () => {
    const { claude, mine, own } = withComments();
    const id = claude.agent.id;
    const gone = { id, kind: 'agent', name: `Deleted agent #${id}` };
    deleteAgent(db, id);
    // Threads: its comments, and those it resolved.
    expect(getThread(db, mine.id)).toMatchObject({ resolvedBy: gone, comments: [{ author: me }, { author: gone, body: 'Because.' }] });
    expect(getThread(db, own.id)!.comments.map((c) => c.author)).toEqual([gone, gone]);
    // The event log (MCP's wait_for_reply, the stream), and Activity.
    expect(commentEventsAfter(db, 0, {}).filter((e) => e.by.id === id).map((e) => [e.kind, e.by.name])).toEqual([
      ['replied', gone.name], ['resolved', gone.name], ['thread_opened', gone.name], ['replied', gone.name], ['thread_opened', gone.name],
    ]);
    const scope = { repos: null, visibility: 'all', ownership: 'all', who: 'everyone', from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-10-01T00:00:00Z'), tz: 'UTC', q: null } as const;
    const activity = listActivity(db, loadQueryCtx(db), scope, ['comment'], null).items;
    expect(activity.filter((e) => e.type === 'comment' && e.comment.by.id === id).map((e) => e.actor!.name)).toEqual(Array(5).fill(gone.name));
    // The Comments list and its Markdown.
    const { items } = listThreadItems(db, loadQueryCtx(db), scope, { status: 'all', kind: 'all', sort: 'recent', author: id }, null);
    expect(items.map((t) => t.comments[0]!.author.name)).toEqual([gone.name, gone.name]);
    expect(threadListMarkdown(items, { status: 'all', kind: 'all', q: null, by: gone.name, waiting: false })).toContain(`**${gone.name}**: Rename this`);
    // And still what agents wrote.
    expect(listThreadItems(db, loadQueryCtx(db), scope, { status: 'all', kind: 'all', sort: 'recent', author: 'agents' }, null).items).toHaveLength(3);
  });

  it("frees its name for a new agent, and keeps names like a deleted agent's from any agent", () => {
    const { agent } = createAgent(db, 'Claude');
    deleteAgent(db, agent.id);
    const again = createAgent(db, 'claude').agent;
    expect(again).toMatchObject({ name: 'claude', disabledAt: null });
    expect(again.id).not.toBe(agent.id);
    for (const name of [`Deleted agent #${agent.id}`, 'deleted agent #99', ' DELETED AGENT #0042 ']) {
      expect(() => createAgent(db, name), name).toThrow('are kept for deleted agents');
    }
    for (const name of ['Deleted agent', 'Deleted agent #', 'Deleted agent #4b', 'Deleted agents #4', 'My deleted agent #4']) expect(createAgent(db, name).agent.name, name).toBe(name);
  });

  it('deletes a disabled agent too; a deleted one is not found again, nor can it be changed', () => {
    const { agent, token } = createAgent(db, 'Claude');
    setAgentEnabled(db, agent.id, false, T1);
    expect(deleteAgent(db, agent.id)).toMatchObject({ name: 'Claude' });
    expect(agentForToken(db, token)).toBeNull();
    expect(deleteAgent(db, agent.id)).toBeNull();
    expect(setAgentEnabled(db, agent.id, true)).toBeNull();
    expect(setAgentEnabled(db, agent.id, false)).toBeNull();
    expect(regenerateAgentToken(db, agent.id)).toBeNull();
    expect(setAgentSources(db, agent.id, null)).toBeNull();
    expect(agentSourceIds(db, agent.id)).toEqual([]);
    expect(db.get('SELECT name, all_sources FROM principals WHERE id = ?', [agent.id])).toEqual({ name: `Deleted agent #${agent.id}`, all_sources: 0 });
  });

  it("never deletes the dashboard's user, or an agent that isn't there", () => {
    expect(deleteAgent(db, SELF_PRINCIPAL_ID)).toBeNull();
    expect(deleteAgent(db, 99)).toBeNull();
    expect(getPrincipal(db, SELF_PRINCIPAL_ID)).toEqual({ id: 1, kind: 'self', name: 'You' });
  });

  it('refuses when an agent from before such names were kept already has the name, changing nothing', () => {
    const { agent } = createAgent(db, 'Claude');
    // An older database: an agent made before the names were kept.
    const legacy = db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, ?)`, [`deleted agent #${agent.id}`, T0]).lastInsertRowid;
    db.run(`INSERT INTO agent_tokens (principal_id, token_hash, prefix, created_at) VALUES (?, 'h', 'ghd_', ?)`, [legacy, T0]);
    expect(() => deleteAgent(db, agent.id)).toThrow(`Another agent (id ${legacy}) is called deleted agent #${agent.id}, the name Claude would take: delete that one first`);
    expect(getAgent(db, agent.id)).toMatchObject({ name: 'Claude' });
    // Listed as the agent it is (its token says so), and deleted like any.
    expect(listAgents(db).map((a) => a.name)).toEqual(['Claude', `deleted agent #${agent.id}`]);
    deleteAgent(db, legacy);
    expect(deleteAgent(db, agent.id)).toMatchObject({ deletedAs: `Deleted agent #${agent.id}` });
    expect(listAgents(db)).toEqual([]);
  });
});
