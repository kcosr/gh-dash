import { Hono } from 'hono';
import { listAgents } from '../../db/agents';
import type { AppDeps } from '../app';

/**
 * GET /agents: who may write comments through MCP, without their tokens; deleted agents aren't listed. Agents are made,
 * given new tokens, limited, disabled, enabled and deleted by the desktop app (Settings → Agents) or the headless
 * `agents` command only: agents and their credentials are never changed over HTTP.
 */
export function agentRoutes({ db }: AppDeps): Hono {
  const r = new Hono();
  r.get('/agents', (c) => c.json({ items: listAgents(db) }));
  return r;
}
