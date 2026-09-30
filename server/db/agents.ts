import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Agent, Principal } from '../../shared/api';
import { HttpError } from '../lib/errors';
import type { Db } from './db';
import { getMeta, setMeta } from './meta';

/**
 * Agents: principals of kind 'agent', each with one token for MCP. A token is `ghd_` and 32 random bytes (base64url),
 * or one the user chose (24–256 printable ASCII characters, no spaces), shown once when made; only its sha256 and its
 * first characters are stored. Agents are made, get a new token and are revoked by the desktop app (main, over IPC) or
 * the headless `agents` command, never over HTTP. Revoking keeps the principal: its comments stay attributed to it.
 *
 * One agent is built in: "Agent", which MCP requests without a token act as while the desktop app doesn't require
 * tokens. It has no token of its own, its name is reserved, it is made the first time it's needed and listed once it
 * has done something.
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
  revoked_at: string | null;
  built_in: number;
}

/** The built-in agent's principal id, once made (meta `builtInAgentId`). */
const BUILT_IN_ID = `(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'builtInAgentId')`;

const AGENT_SELECT = `SELECT p.id, p.name, p.created_at, t.prefix, t.last_used_at, t.revoked_at, p.id IS ${BUILT_IN_ID} AS built_in
  FROM principals p LEFT JOIN agent_tokens t ON t.principal_id = p.id WHERE p.kind = 'agent'`;

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  tokenPrefix: r.revoked_at === null ? r.prefix : null,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  builtIn: !!r.built_in,
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
 * Every agent, revoked ones included, oldest first. The built-in agent only once it has done something (a comment, a
 * status change): before, there is nothing of it to show.
 */
export function listAgents(db: Db): Agent[] {
  return db.all<AgentRow>(`${AGENT_SELECT} AND (p.id IS NOT ${BUILT_IN_ID} OR EXISTS (SELECT 1 FROM comment_events WHERE actor_id = p.id)) ORDER BY p.id`).map(toAgent);
}

/**
 * The built-in agent (see above), made the first time it is needed. Named "Agent"; a database that already has a
 * user's agent of that name (from before the name was reserved) calls it "Agent (no token)".
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
    const name = agentByName(db, BUILT_IN_AGENT) ? `${BUILT_IN_AGENT} (no token)` : BUILT_IN_AGENT;
    const id = db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, ?)`, [name, now]).lastInsertRowid;
    setMeta(db, 'builtInAgentId', id);
    return { id, kind: 'agent', name };
  });
}

const notForBuiltIn = (a: Agent) =>
  new HttpError(400, `${a.name} is built in: it has no token (MCP requests without one act as it, while gh-dash doesn't require agent tokens)`);

export function getAgent(db: Db, id: number): Agent | null {
  const row = db.get<AgentRow>(`${AGENT_SELECT} AND p.id = ?`, [id]);
  return row ? toAgent(row) : null;
}

/** An agent by name (any case); null when none has it. */
export function agentByName(db: Db, name: string): Agent | null {
  const row = db.get<AgentRow>(`${AGENT_SELECT} AND p.name = ? COLLATE NOCASE`, [name.trim()]);
  return row ? toAgent(row) : null;
}

/** An agent by id (all digits: names never are) or by name (any case); null when none matches. */
export function findAgent(db: Db, idOrName: string): Agent | null {
  const text = idOrName.trim();
  return /^\d+$/.test(text) ? getAgent(db, Number(text)) : agentByName(db, text);
}

/**
 * A name for a new agent: trimmed, 1–64 characters, not all digits (those name an agent by id), no control characters,
 * not "You" (the dashboard user). 400 otherwise.
 */
export function agentName(input: string): string {
  const name = input.trim();
  if (!name) throw new HttpError(400, 'An agent needs a name');
  if (/^\d+$/.test(name)) throw new HttpError(400, "An agent's name can't be only digits (those are ids)");
  if (Array.from(name).length > MAX_NAME_CHARS) throw new HttpError(400, `An agent's name has at most ${MAX_NAME_CHARS} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "An agent's name can't hold control characters");
  if (name.toLowerCase() === 'you') throw new HttpError(400, '"You" is the dashboard user; give the agent another name');
  if (name.toLowerCase() === BUILT_IN_AGENT.toLowerCase()) {
    throw new HttpError(400, `"${BUILT_IN_AGENT}" is the built-in agent (requests without a token); give yours another name`);
  }
  return name;
}

/**
 * Makes an agent and its first token. The token is returned once, here: it can't be read back later. 409 when an agent
 * already has the name (any case), revoked or not: give it a new token instead.
 */
export function createAgent(db: Db, nameInput: string, now = nowIso(), chosenToken?: string | null): { agent: Agent; token: string } {
  const name = agentName(nameInput);
  const { token, hash, prefix } = tokenToStore(chosenToken);
  const taken = (existing: Agent) => new HttpError(409, `There is already an agent called ${existing.name} (id ${existing.id}); regenerate its token instead`);
  const id = db.tx(() => {
    const existing = agentByName(db, name);
    if (existing) throw taken(existing);
    ensureTokenFree(db, hash, null);
    let principal: number;
    try {
      principal = db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, ?)`, [name, now]).lastInsertRowid;
    } catch (err) {
      // principals_agent_name: another process made it since the lookup.
      const other = /UNIQUE/.test((err as Error).message) ? agentByName(db, name) : null;
      throw other ? taken(other) : err;
    }
    db.run('INSERT INTO agent_tokens (principal_id, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)', [principal, hash, prefix, now]);
    return principal;
  });
  return { agent: getAgent(db, id)!, token };
}

/**
 * A new token for an agent, revoked or not (generated, or the one given): the old one stops working at once and the
 * agent is active again, not yet used. null when there is no such agent; 400 for the built-in one.
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

/** Revokes an agent's token (at once; its comments stay). Revoking a revoked agent changes nothing. null when there is no such agent. */
export function revokeAgent(db: Db, id: number, now = nowIso()): Agent | null {
  const agent = getAgent(db, id);
  if (!agent) return null;
  if (agent.builtIn) throw notForBuiltIn(agent);
  db.run('UPDATE agent_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL', [now, id]);
  return getAgent(db, id);
}

/**
 * The agent a bearer token belongs to; null for anything else (malformed, unknown, revoked). Looked up by the token's
 * sha256, so the time taken says nothing about how close a guess came; the stored hash is compared in constant time
 * all the same. Marks the token used, at most once a minute. `now` is in ms (the others here take ISO strings).
 */
export function principalForToken(db: Db, token: string, now = Date.now()): Principal | null {
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX || !TOKEN_CHARS.test(token)) return null;
  const hash = hashToken(token);
  const row = db.get<{ token_hash: string; principal_id: number; name: string; last_used_at: string | null; revoked_at: string | null }>(
    `SELECT t.token_hash, t.principal_id, p.name, t.last_used_at, t.revoked_at
     FROM agent_tokens t JOIN principals p ON p.id = t.principal_id WHERE t.token_hash = ? AND p.kind = 'agent'`,
    [hash],
  );
  if (!row || row.revoked_at !== null) return null;
  if (!timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) return null;
  if (row.last_used_at === null || now - Date.parse(row.last_used_at) >= LAST_USED_EVERY_MS) {
    // Best effort: a database another process holds for a while mustn't turn a valid token into an error.
    try {
      db.run('UPDATE agent_tokens SET last_used_at = ? WHERE principal_id = ?', [new Date(now).toISOString(), row.principal_id]);
    } catch { /* kept for the next request */ }
  }
  return { id: row.principal_id, kind: 'agent', name: row.name };
}
