import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type AgentFootprint, DELETED_AGENT_NAME, DELETED_AGENT_PREFIX, type DeletedAgent, deletedAgentName } from '../../shared/agents';
import type { Agent, Principal } from '../../shared/api';
import { HttpError } from '../lib/errors';
import type { Db } from './db';
import { getMeta, setMeta } from './meta';
import { listSources } from './sources';

/**
 * Agents: principals of kind 'agent', each with one token for MCP. A token is `ghd_` and 32 random bytes (base64url),
 * or one the user chose (24–256 printable ASCII characters, no spaces), shown once when made; only its sha256 and its
 * first characters are stored. Agents are made, get a new token, are limited to some sources, disabled, enabled and
 * deleted by the desktop app (main, over IPC) or the headless `agents` command, never over HTTP.
 *
 * Disabling an agent refuses its token until it's enabled again; the token (its hash and prefix) and the sources stay,
 * and enabling lets the same token in again. agent_tokens.revoked_at is when it was disabled, NULL while enabled (the
 * column is from when this was revoking, for good: an agent revoked then reads as disabled now). A new token enables it.
 *
 * Deleting an agent keeps its principal, so its comments, their events and the threads it resolved keep pointing at it.
 * Its token and sources go, it reaches nothing (all_sources 0, no agent_sources), and it is renamed "Deleted agent #<id>"
 * (shared/agents.ts), which is what everything that names a principal shows from then on. No token and that name make
 * a deleted agent: a name no agent may be given, so none is taken for one. It is no agent any more (not listed or found,
 * nothing to change), and its old name is free.
 *
 * One agent is built in: "Agent", which MCP requests without a token act as while the desktop app doesn't require
 * tokens. It has no token of its own, its name is reserved, it is made the first time it's needed and listed once it
 * has done something (or is limited to some sources).
 *
 * An agent reaches every source through MCP (principals.all_sources, the default: sources added later included), or
 * only those it is limited to (agent_sources), which the same two places set. Deleting a source takes it out of every
 * agent's list and never widens one: an agent left with none reaches nothing. The dashboard's own user is never limited.
 */

const TOKEN_PREFIX = 'ghd_';
/** `ghd_` + base64url of 32 bytes (43 characters, no padding): what gh-dash generates. */
const TOKEN_SHAPE = /^ghd_[A-Za-z0-9_-]{43}$/;
/** Any token an agent may have: printable ASCII without spaces (it goes in an Authorization header). */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
export const TOKEN_MIN = 24;
export const TOKEN_MAX = 256;
/** How many of a generated token's first characters are kept, to tell tokens apart (`ghd_` and 4 random ones). */
const PREFIX_CHARS = 8;
/** Of a token the user chose, at most this many: little enough to give nothing away. */
const CHOSEN_PREFIX_CHARS = 4;
/** The built-in agent's name, reserved. */
export const BUILT_IN_AGENT = 'Agent';
/** last_used_at is written at most this often (a request per tool call shouldn't mean a write per call). */
const LAST_USED_EVERY_MS = 60_000;
const MAX_NAME_CHARS = 64;

interface AgentRow {
  id: number;
  name: string;
  created_at: string;
  prefix: string | null;
  last_used_at: string | null;
  /** When it was disabled (see above). */
  revoked_at: string | null;
  built_in: number;
  all_sources: number;
}

/** The built-in agent's principal id, once made (meta `builtInAgentId`). */
const BUILT_IN_ID = `(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'builtInAgentId')`;

/** A deleted agent's row (see above): no token, and the name deleteAgent gave it. */
const DELETED = `(t.principal_id IS NULL AND p.name = '${DELETED_AGENT_PREFIX}' || p.id)`;

/** Every agent but the deleted ones. */
const AGENT_SELECT = `SELECT p.id, p.name, p.created_at, t.prefix, t.last_used_at, t.revoked_at, p.id IS ${BUILT_IN_ID} AS built_in, p.all_sources
  FROM principals p LEFT JOIN agent_tokens t ON t.principal_id = p.id WHERE p.kind = 'agent' AND NOT ${DELETED}`;

/** The hosts of the sources each limited agent may reach, by principal id: github.com first, then as they were added. */
function limitedHosts(db: Db, id?: number): Map<number, string[]> {
  const rows = db.all<{ principal_id: number; host: string }>(
    `SELECT a.principal_id, s.host FROM agent_sources a JOIN sources s ON s.id = a.source_id${id === undefined ? '' : ' WHERE a.principal_id = ?'} ORDER BY s.id`,
    id === undefined ? [] : [id],
  );
  const out = new Map<number, string[]>();
  for (const r of rows) out.set(r.principal_id, [...(out.get(r.principal_id) ?? []), r.host]);
  return out;
}

const toAgent = (r: AgentRow, hosts: Map<number, string[]>): Agent => ({
  id: r.id,
  name: r.name,
  tokenPrefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  disabledAt: r.revoked_at,
  builtIn: !!r.built_in,
  sources: r.all_sources ? null : (hosts.get(r.id) ?? []),
});

const nowIso = () => new Date().toISOString();
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * A token the user chose: 24–256 printable ASCII characters without spaces (it travels in an Authorization header).
 * 400 otherwise. Its uniqueness is checked where it is stored.
 */
export function agentToken(input: unknown): string {
  if (typeof input !== 'string') throw new HttpError(400, 'An agent token is text');
  if (input.length < TOKEN_MIN || input.length > TOKEN_MAX) throw new HttpError(400, `An agent token has ${TOKEN_MIN} to ${TOKEN_MAX} characters`);
  if (!TOKEN_CHARS.test(input)) throw new HttpError(400, 'An agent token is printable ASCII without spaces (it goes in an Authorization header)');
  return input;
}

/**
 * A token to store: the one given (checked) or a new one, its hash, and the characters kept to tell it apart: a
 * generated token's first 8 (`ghd_` and 4 random ones), at most 4 of any other.
 */
function tokenToStore(given?: string | null): { token: string; hash: string; prefix: string } {
  const token = given == null ? `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` : agentToken(given);
  const prefix = TOKEN_SHAPE.test(token) ? token.slice(0, PREFIX_CHARS) : token.slice(0, CHOSEN_PREFIX_CHARS);
  return { token, hash: hashToken(token), prefix };
}

/** Refuses a token another agent already has (by its hash; there is nothing else to compare). */
function ensureTokenFree(db: Db, hash: string, owner: number | null): void {
  const other = db.get<{ principal_id: number }>('SELECT principal_id FROM agent_tokens WHERE token_hash = ?', [hash]);
  if (other && other.principal_id !== owner) throw new HttpError(409, "That token is already another agent's");
}

/**
 * Every agent, disabled ones included, oldest first; deleted ones aren't agents any more. The built-in agent only once
 * it has done something (a comment, a status change) or is limited to some sources: before, there is nothing of it to
 * show.
 */
export function listAgents(db: Db): Agent[] {
  const hosts = limitedHosts(db);
  return db
    .all<AgentRow>(`${AGENT_SELECT} AND (p.id IS NOT ${BUILT_IN_ID} OR p.all_sources = 0 OR EXISTS (SELECT 1 FROM comment_events WHERE actor_id = p.id)) ORDER BY p.id`)
    .map((r) => toAgent(r, hosts));
}

/** The built-in agent's names: "Agent", else (a user's agent from before it was reserved has it) "Agent (no token)", "… 2"… */
const BUILT_IN_NAME = /^agent(?: \(no token\)(?: \d+)?)?$/i;
const builtInName = (n: number) => (n === 0 ? BUILT_IN_AGENT : n === 1 ? `${BUILT_IN_AGENT} (no token)` : `${BUILT_IN_AGENT} (no token) ${n}`);

/**
 * The built-in agent (see above), made the first time it is needed, under the first of its names no agent has (they
 * are all reserved, but an older database may hold one).
 */
export function builtInAgent(db: Db, now = nowIso()): Principal {
  const byId = () => {
    const id = getMeta(db, 'builtInAgentId');
    const row = id === null ? undefined : db.get<{ id: number; name: string }>(`SELECT id, name FROM principals WHERE id = ? AND kind = 'agent'`, [id]);
    return row ? { id: row.id, kind: 'agent' as const, name: row.name } : null;
  };
  const known = byId();
  if (known) return known;
  return db.tx(() => {
    const again = byId();
    if (again) return again;
    let n = 0;
    while (agentByName(db, builtInName(n))) n++;
    const name = builtInName(n);
    const id = db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, ?)`, [name, now]).lastInsertRowid;
    setMeta(db, 'builtInAgentId', id);
    return { id, kind: 'agent', name };
  });
}

const notForBuiltIn = (a: Agent) =>
  new HttpError(400, `${a.name} is built in: it has no token (MCP requests without one act as it, while gh-dash doesn't require agent tokens)`);
const builtInStays = (a: Agent) =>
  new HttpError(400, `${a.name} is built in and can't be deleted: MCP requests without a token act as it while gh-dash doesn't require agent tokens (Settings → Instance)`);

export function getAgent(db: Db, id: number): Agent | null {
  const row = db.get<AgentRow>(`${AGENT_SELECT} AND p.id = ?`, [id]);
  return row ? toAgent(row, limitedHosts(db, row.id)) : null;
}

/** An agent by name (any case); null when none has it. */
export function agentByName(db: Db, name: string): Agent | null {
  const row = db.get<AgentRow>(`${AGENT_SELECT} AND p.name = ? COLLATE NOCASE`, [name.trim()]);
  return row ? toAgent(row, limitedHosts(db, row.id)) : null;
}

/** An agent by id (all digits: names never are) or by name (any case); null when none matches. */
export function findAgent(db: Db, idOrName: string): Agent | null {
  const text = idOrName.trim();
  return /^\d+$/.test(text) ? getAgent(db, Number(text)) : agentByName(db, text);
}

/**
 * A name for a new agent: trimmed, 1–64 characters, not all digits (those name an agent by id), no control characters,
 * not "You" (the dashboard user), not the built-in agent's or a deleted agent's ("Deleted agent #4"). 400 otherwise.
 */
export function agentName(input: string): string {
  const name = input.trim();
  if (!name) throw new HttpError(400, 'An agent needs a name');
  if (/^\d+$/.test(name)) throw new HttpError(400, "An agent's name can't be only digits (those are ids)");
  if (Array.from(name).length > MAX_NAME_CHARS) throw new HttpError(400, `An agent's name has at most ${MAX_NAME_CHARS} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "An agent's name can't hold control characters");
  if (name.toLowerCase() === 'you') throw new HttpError(400, '"You" is the dashboard user; give the agent another name');
  if (BUILT_IN_NAME.test(name)) {
    throw new HttpError(400, `"${name}" is the built-in agent's (requests without a token); give yours another name`);
  }
  if (DELETED_AGENT_NAME.test(name)) throw new HttpError(400, `Names like "${name}" are kept for deleted agents; give yours another name`);
  return name;
}

/**
 * The sources `hosts` name, by id: each a source's host as `sources` lists it (github.com, gitlab.example.com), in any
 * case. 400 for a host that isn't a source here (naming those that are), and for none at all: an agent limited to
 * nothing is one to disable.
 */
function sourcesNamed(db: Db, hosts: readonly string[]): number[] {
  const known = listSources(db);
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const given of hosts) {
    const src = known.find((s) => s.host === given.trim().toLowerCase());
    if (src) ids.add(src.id);
    else unknown.push(given.trim());
  }
  if (unknown.length) {
    const list = known.map((s) => s.host).join(', ');
    throw new HttpError(400, `${unknown.join(', ')} ${unknown.length === 1 ? "isn't a source" : "aren't sources"} here (the sources: ${list})`);
  }
  if (!ids.size) throw new HttpError(400, 'Give an agent at least one source, or all of them (disable it to stop it altogether)');
  return [...ids].sort((a, b) => a - b);
}

/** Sets which sources an agent reaches: every one (null), or these (by id). Run in a transaction. */
function writeSources(db: Db, id: number, sources: readonly number[] | null): void {
  db.run('DELETE FROM agent_sources WHERE principal_id = ?', [id]);
  db.run('UPDATE principals SET all_sources = ? WHERE id = ?', [sources === null ? 1 : 0, id]);
  for (const source of sources ?? []) db.run('INSERT INTO agent_sources (principal_id, source_id) VALUES (?, ?)', [id, source]);
}

/**
 * Makes an agent and its first token. The token is returned once, here: it can't be read back later. 409 when an agent
 * already has the name (any case), disabled or not: give it a new token instead. `sources`: the hosts of the sources it
 * may reach (see sourcesNamed); absent or null, every source.
 */
export function createAgent(
  db: Db,
  nameInput: string,
  now = nowIso(),
  chosenToken?: string | null,
  sources?: readonly string[] | null,
): { agent: Agent; token: string } {
  const name = agentName(nameInput);
  const { token, hash, prefix } = tokenToStore(chosenToken);
  const taken = (existing: Agent) => new HttpError(409, `There is already an agent called ${existing.name} (id ${existing.id}); regenerate its token instead`);
  const id = db.tx(() => {
    const existing = agentByName(db, name);
    if (existing) throw taken(existing);
    ensureTokenFree(db, hash, null);
    const limited = sources == null ? null : sourcesNamed(db, sources);
    let principal: number;
    try {
      principal = db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, ?)`, [name, now]).lastInsertRowid;
    } catch (err) {
      // principals_agent_name: another process made it since the lookup.
      const other = /UNIQUE/.test((err as Error).message) ? agentByName(db, name) : null;
      throw other ? taken(other) : err;
    }
    db.run('INSERT INTO agent_tokens (principal_id, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)', [principal, hash, prefix, now]);
    if (limited) writeSources(db, principal, limited);
    return principal;
  });
  return { agent: getAgent(db, id)!, token };
}

/**
 * Limits an agent to some sources (their hosts, see sourcesNamed), or lets it reach every one again, sources added later
 * included (null). Disabled agents and the built-in one too; the dashboard's user is no agent. It applies from the
 * agent's next MCP request. null when there is no such agent.
 */
export function setAgentSources(db: Db, id: number, hosts: readonly string[] | null): Agent | null {
  return db.tx(() => {
    if (!getAgent(db, id)) return null;
    writeSources(db, id, hosts === null ? null : sourcesNamed(db, hosts));
    return getAgent(db, id);
  });
}

/**
 * The ids of the sources a principal reaches through MCP: null for every source (an agent that isn't limited, and the
 * dashboard's user), else those it is limited to, possibly none (they were deleted since, or the agent was). A principal
 * that isn't there reaches nothing. The MCP route reads it once per request, so a change applies from the agent's next one.
 */
export function agentSourceIds(db: Db, principalId: number): number[] | null {
  const row = db.get<{ all_sources: number }>(`SELECT all_sources OR kind <> 'agent' AS all_sources FROM principals WHERE id = ?`, [principalId]);
  if (!row) return [];
  if (row.all_sources) return null;
  return db.all<{ source_id: number }>('SELECT source_id FROM agent_sources WHERE principal_id = ? ORDER BY source_id', [principalId]).map((r) => r.source_id);
}

/**
 * A new token for an agent, disabled or not (generated, or the one given): the old one stops working at once, and the
 * agent is enabled, not yet used. null when there is no such agent; 400 for the built-in one.
 */
export function regenerateAgentToken(db: Db, id: number, now = nowIso(), chosenToken?: string | null): { agent: Agent; token: string } | null {
  const { token, hash, prefix } = tokenToStore(chosenToken);
  const done = db.tx(() => {
    const agent = getAgent(db, id);
    if (!agent) return false;
    if (agent.builtIn) throw notForBuiltIn(agent);
    ensureTokenFree(db, hash, id);
    db.run(
      `INSERT INTO agent_tokens (principal_id, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (principal_id) DO UPDATE SET token_hash = excluded.token_hash, prefix = excluded.prefix, created_at = excluded.created_at,
         last_used_at = NULL, revoked_at = NULL`,
      [id, hash, prefix, now],
    );
    return true;
  });
  return done ? { agent: getAgent(db, id)!, token } : null;
}

/**
 * Disables an agent (its token is refused from its next request on, until it's enabled again) or enables it (the same
 * token works again). The token and the sources stay either way. Disabling a disabled agent keeps when it first was.
 * null when there is no such agent; 400 for the built-in one, which has no token (the desktop app's "Require agent
 * tokens" setting says whether requests without one act as it).
 */
export function setAgentEnabled(db: Db, id: number, enabled: boolean, now = nowIso()): Agent | null {
  const agent = getAgent(db, id);
  if (!agent) return null;
  if (agent.builtIn) throw notForBuiltIn(agent);
  if (enabled) db.run('UPDATE agent_tokens SET revoked_at = NULL WHERE principal_id = ?', [id]);
  else db.run('UPDATE agent_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL', [now, id]);
  return getAgent(db, id);
}

/**
 * What a principal has written, for the warning before an agent is deleted: its comments, the threads they are in,
 * those still open, and those it opened.
 */
export function agentFootprint(db: Db, id: number): AgentFootprint {
  return db.get<AgentFootprint>(
    `SELECT count(*) AS comments, count(DISTINCT c.thread_id) AS threads,
       count(DISTINCT CASE WHEN t.status = 'open' THEN c.thread_id END) AS openThreads,
       count(CASE WHEN c.id = (SELECT min(m.id) FROM comments m WHERE m.thread_id = c.thread_id) THEN 1 END) AS opened
     FROM comments c JOIN comment_threads t ON t.id = c.thread_id WHERE c.author_id = ?`,
    [id],
  )!;
}

/**
 * Deletes an agent, enabled or disabled, in one transaction (see above): its token stops working at once and goes, with
 * its sources; it reaches nothing; its principal stays, renamed "Deleted agent #<id>", so what it wrote stays, under
 * that name. Answers what it had written. null when there is no such agent (a deleted one included; the dashboard's user
 * is none); 400 for the built-in one; 409 when an agent from before such names were kept already has the one it would
 * take.
 */
export function deleteAgent(db: Db, id: number): DeletedAgent | null {
  return db.tx(() => {
    const agent = getAgent(db, id);
    if (!agent) return null;
    if (agent.builtIn) throw builtInStays(agent);
    const deletedAs = deletedAgentName(id);
    const holder = db.get<{ id: number; name: string }>(`SELECT id, name FROM principals WHERE kind = 'agent' AND id <> ? AND name = ? COLLATE NOCASE`, [id, deletedAs]);
    if (holder) throw new HttpError(409, `Another agent (id ${holder.id}) is called ${holder.name}, the name ${agent.name} would take: delete that one first`);
    const footprint = agentFootprint(db, id);
    db.run('DELETE FROM agent_tokens WHERE principal_id = ?', [id]);
    db.run('DELETE FROM agent_sources WHERE principal_id = ?', [id]);
    db.run('UPDATE principals SET name = ?, all_sources = 0 WHERE id = ?', [deletedAs, id]);
    return { id, name: agent.name, deletedAs, footprint };
  });
}

/**
 * The agent a bearer token belongs to, and whether it is disabled; null for anything else (malformed, unknown, a
 * deleted agent's). Looked up by the token's sha256, so the time taken says nothing about how close a guess came; the
 * stored hash is compared in constant time all the same. Marks an enabled agent's token used, at most once a minute.
 * `now` is in ms (the others here take ISO strings).
 */
export function agentForToken(db: Db, token: string, now = Date.now()): { principal: Principal; disabled: boolean } | null {
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX || !TOKEN_CHARS.test(token)) return null;
  const hash = hashToken(token);
  const row = db.get<{ token_hash: string; principal_id: number; name: string; last_used_at: string | null; revoked_at: string | null }>(
    `SELECT t.token_hash, t.principal_id, p.name, t.last_used_at, t.revoked_at
     FROM agent_tokens t JOIN principals p ON p.id = t.principal_id WHERE t.token_hash = ? AND p.kind = 'agent'`,
    [hash],
  );
  if (!row) return null;
  if (!timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) return null;
  const principal: Principal = { id: row.principal_id, kind: 'agent', name: row.name };
  if (row.revoked_at !== null) return { principal, disabled: true };
  if (row.last_used_at === null || now - Date.parse(row.last_used_at) >= LAST_USED_EVERY_MS) {
    // Best effort: a database another process holds for a while mustn't turn a valid token into an error.
    try {
      db.run('UPDATE agent_tokens SET last_used_at = ? WHERE principal_id = ?', [new Date(now).toISOString(), row.principal_id]);
    } catch { /* kept for the next request */ }
  }
  return { principal, disabled: false };
}

/** The enabled agent a bearer token belongs to (agentForToken); null for anything else, a disabled agent's included. */
export function principalForToken(db: Db, token: string, now = Date.now()): Principal | null {
  const found = agentForToken(db, token, now);
  return found && !found.disabled ? found.principal : null;
}
