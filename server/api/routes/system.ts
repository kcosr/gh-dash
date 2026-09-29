import { Hono } from 'hono';
import { z } from 'zod';
import type { Me, Settings } from '../../../shared/api';
import { resolveRepo } from '../../db/repo-key';
import { getSettings, patchSettings, settingsPatchSchema } from '../../db/settings';
import { GITHUB_SOURCE_ID, getSource } from '../../db/sources';
import { noTokenMessage } from '../../token';
import type { AppDeps } from '../app';
import { HttpError, jsonBody, parseWith } from '../http';

const syncBody = z.object({ repo: z.string().min(1).optional(), full: z.boolean().optional() }).strict();

export function systemRoutes({ db, sync, config, diffs, tokens }: AppDeps): Hono {
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

  r.post('/sync', async (c) => {
    const body = parseWith(syncBody, await jsonBody(c));
    if (body.repo !== undefined) {
      // A tracked repo is synced by its key; a bare name nothing tracks may be a repo the viewer just created.
      const ref = resolveRepo(db, body.repo);
      if (ref) body.repo = ref.key;
      else if (body.repo.includes('/')) throw new HttpError(404, `${body.repo} isn't tracked. Add it first (POST /api/v1/repos).`);
    }
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
