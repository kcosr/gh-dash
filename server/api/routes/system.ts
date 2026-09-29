import { Hono } from 'hono';
import { z } from 'zod';
import type { Me, Settings } from '../../../shared/api';
import { resolveRepo, resolveRepoOn } from '../../db/repo-key';
import { getSettings, patchSettings, settingsPatchSchema } from '../../db/settings';
import { GITHUB_SOURCE_ID, getSource, sourceLabel } from '../../db/sources';
import { notASource } from '../../sync/tracking';
import type { AppDeps } from '../app';
import { HttpError, jsonBody, parseWith } from '../http';

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

  r.post('/sync', async (c) => {
    const body = parseWith(syncBody, await jsonBody(c));
    // `source` syncs that source alone; it must be one this instance syncs.
    const source = body.source === undefined ? null : sync.sources.byHost(body.source);
    if (body.source !== undefined) {
      if (!source) throw new HttpError(404, notASource(body.source));
      if (!source.configured) throw new HttpError(400, `${source.label} isn't configured on this server.`);
    }
    if (body.repo !== undefined) {
      // A tracked repo is synced by its key (with `source`, by its path there too); a bare name nothing tracks may be a
      // repo the viewer just created on github.com.
      const ref = source ? resolveRepoOn(db, body.repo, source) : resolveRepo(db, body.repo);
      if (ref) {
        body.repo = ref.key;
        const on = sync.sources.byId(ref.sourceId);
        if (!on?.configured) throw new HttpError(400, `${on?.label ?? sourceLabel(getSource(db, ref.sourceId)!)} isn't configured on this server.`);
      } else if (body.repo.includes('/') || (source && source.id !== GITHUB_SOURCE_ID)) {
        throw new HttpError(404, `${body.repo} isn't tracked${source ? ` on ${source.label}` : ''}. Add it first (POST /api/v1/repos).`);
      }
    }
    // Resolves the tokens afresh, so "Sync now" works right after `gh auth login` or a new token file.
    const res = await sync.start('manual', body);
    if (!res.ok && res.reason === 'running') return c.json({ error: 'A sync is already running', details: sync.status() }, 409);
    if (!res.ok && res.reason === 'no-token') throw new HttpError(503, sync.noTokenMessage(body));
    if (!res.ok) throw new HttpError(400, 'Nothing here to sync');
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
