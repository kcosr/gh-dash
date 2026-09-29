import { Hono } from 'hono';
import { queryStats } from '../../services/lists';
import type { AppDeps } from '../app';
import { parseWith } from '../http';
import { statsQuerySchema } from '../scope';

export function statsRoutes({ db, config }: AppDeps): Hono {
  const r = new Hono();
  r.get('/stats', (c) => c.json(queryStats({ db, config }, parseWith(statsQuerySchema, c.req.query()))));
  return r;
}
