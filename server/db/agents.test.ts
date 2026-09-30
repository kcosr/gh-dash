import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentSourceIds, BUILT_IN_AGENT, builtInAgent, createAgent, findAgent, getAgent, listAgents, principalForToken, regenerateAgentToken, revokeAgent,
  setAgentSources,
} from './agents';
import { type Db, openDb } from './db';
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
    expect(agent).toEqual({ id: 2, name: 'Claude', tokenPrefix: token.slice(0, 8), createdAt: T0, lastUsedAt: null, revokedAt: null, builtIn: false, sources: null });
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

  it('revokes a token at once, keeping the agent (and its comments) without a prefix', () => {
    const { agent, token } = createAgent(db, 'Claude', T0);
    const revoked = revokeAgent(db, agent.id, T1)!;
    expect(revoked).toEqual({ ...agent, tokenPrefix: null, revokedAt: T1 });
    expect(principalForToken(db, token)).toBeNull();
    // Again: still revoked when it first was.
    expect(revokeAgent(db, agent.id, '2026-09-30T00:00:00.000Z')!.revokedAt).toBe(T1);
    expect(revokeAgent(db, 99)).toBeNull();
    expect(revokeAgent(db, 1)).toBeNull();
    expect(db.get('SELECT kind FROM principals WHERE id = ?', [agent.id])).toEqual({ kind: 'agent' });
  });

  it('regenerates a token: the old one stops working, the agent is active again and not yet used', () => {
    const { agent, token } = createAgent(db, 'Claude', T0);
    principalForToken(db, token, ms(T0));
    revokeAgent(db, agent.id, T0);
    const next = regenerateAgentToken(db, agent.id, T1)!;
    expect(next.token).not.toBe(token);
    expect(next.agent).toEqual({ ...agent, tokenPrefix: next.token.slice(0, 8), lastUsedAt: null, revokedAt: null });
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
    expect(getAgent(db, agent.id)).toMatchObject({ name: BUILT_IN_AGENT, builtIn: true, tokenPrefix: null, revokedAt: null });
    expect(() => regenerateAgentToken(db, agent.id)).toThrow(/built in/);
    expect(() => revokeAgent(db, agent.id)).toThrow(/built in/);
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

  it('limits revoked agents and the built-in one too, which is listed once limited', () => {
    withGitLab();
    const { agent } = createAgent(db, 'Claude');
    revokeAgent(db, agent.id, T1);
    expect(setAgentSources(db, agent.id, ['github.com'])).toMatchObject({ revokedAt: T1, sources: ['github.com'] });
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
