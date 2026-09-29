import { Hono } from 'hono';
import { z } from 'zod';
import type { Me, Settings } from '../../../shared/api';
import { getSettings, patchSettings, settingsPatchSchema } from '../../db/settings';
import { GITHUB_SOURCE_ID, getSource } from '../../db/sources';
import type { AppDeps } from '../app';
import { jsonBody, parseWith } from '../http';

const syncBody = z
  .object({ repo: z.string().min(1).optional(), full: z.boolean().optional(), source: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/, 'a host').optional() })
  .strict();

export function systemRoutes({ db, sync, config, diffs }: AppDeps): Hono {
  const r = new Hono();
  const withEnv = (s: Settings): Settings => ({ ...s, myEmailsFromEnv: config.myEmails });

  r.get('/me', (c) => {
    const viewer = getSource(db, GITHUB_SOURCE_ID)?.viewer;
    const me: Me = {
      login: viewer?.login ?? '',
      name: viewer?.name ?? null,
      avatarUrl: viewer?.avatarUrl ?? null,
      tokenSource: sync.getTokenSource(),
    };
    return c.json(me);
  });

  r.get('/sync/status', (c) => c.json(sync.status()));

  // The checks and the run are SyncManager.request's; this is the adapter.
  r.post('/sync', async (c) => c.json(await sync.request(parseWith(syncBody, await jsonBody(c))), 202));

  r.get('/settings', (c) => c.json(withEnv(getSettings(db))));

  r.patch('/settings', async (c) => {
    const patch = parseWith(settingsPatchSchema, await jsonBody(c));
    const before = getSettings(db);
    const after = patchSettings(db, patch);
    if (after.syncIntervalMinutes !== before.syncIntervalMinutes) sync.reschedule();
    if (after.diffCacheMb < before.diffCacheMb) diffs.evict();
    return c.json(withEnv(after));
  });

  return r;
}
