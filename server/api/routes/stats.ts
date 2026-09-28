import { Hono } from 'hono';
import { loadQueryCtx } from '../../db/filters';
import { computeStats } from '../../db/stats';
import type { AppDeps } from '../app';
import { parseWith } from '../http';
import { parseScope, statsQuerySchema } from '../scope';

export function statsRoutes({ db, config }: AppDeps): Hono {
  const r = new Hono();
  r.get('/stats', (c) => {
    const q = parseWith(statsQuerySchema, c.req.query());
    return c.json(computeStats(db, loadQueryCtx(db, config.myEmails), parseScope(q, config.defaultTz), q.bucket));
  });
  return r;
}
