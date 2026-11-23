import { Hono } from 'hono';
import { listAgentAccess } from '../../db/agent-access';
import type { AppDeps } from '../app';

/** Repository access can be inspected through the REST API. The desktop app and CLI administer it locally. */
export function agentAccessRoutes({ db }: AppDeps): Hono {
  const r = new Hono();
  r.get('/agent-access', (c) => c.json(listAgentAccess(db)));
  return r;
}
