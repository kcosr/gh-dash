import { Hono } from 'hono';
import { z } from 'zod';
import type { Me, Settings } from '../../../shared/api';
import { getMeta } from '../../db/meta';
import { getSettings, patchSettings, settingsPatchSchema } from '../../db/settings';
import { noTokenMessage } from '../../token';
import type { AppDeps } from '../app';
import { HttpError, jsonBody, parseWith } from '../http';

const syncBody = z.object({ repo: z.string().min(1).optional(), full: z.boolean().optional() }).strict();

export function systemRoutes({ db, sync, config, diffs, tokens }: AppDeps): Hono {
  const r = new Hono();
  const withEnv = (s: Settings): Settings => ({ ...s, myEmailsFromEnv: config.myEmails });

  r.get('/me', (c) => {
    const viewer = getMeta(db, 'viewer');
    const me: Me = {
      login: viewer?.login ?? '',
      name: viewer?.name ?? null,
      avatarUrl: viewer?.avatarUrl ?? null,
      tokenSource: sync.getTokenSource(),
    };
    return c.json(me);
  });

  r.get('/sync/status', (c) => c.json(sync.status()));

  r.post('/sync', async (c) => {
    const body = parseWith(syncBody, await jsonBody(c));
    // Resolves the token afresh, so "Sync now" works right after `gh auth login` or a new token file.
    const res = await sync.start('manual', body);
    if (!res.ok && res.reason === 'running') return c.json({ error: 'A sync is already running', details: sync.status() }, 409);
    if (!res.ok) throw new HttpError(503, noTokenMessage(tokens.peek()));
    return c.json(sync.status(), 202);
  });

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
