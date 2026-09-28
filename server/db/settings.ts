import { z } from 'zod';
import type { Settings } from '../../shared/api';
import type { Db } from './db';

export const DEFAULT_SETTINGS: Settings = {
  syncIntervalMinutes: 30,
  backfillDays: 365,
  myEmails: [],
  includeForks: false,
  diffCacheMb: 200,
};

export const settingsPatchSchema = z
  .object({
    syncIntervalMinutes: z.number().int().min(5).max(1440),
    backfillDays: z.number().int().min(1).max(3650),
    myEmails: z
      .array(z.string().trim().toLowerCase().pipe(z.email()))
      .max(50)
      .transform((emails) => [...new Set(emails)]),
    includeForks: z.boolean(),
    diffCacheMb: z.number().int().min(10).max(10000),
  })
  .partial()
  // Read-only (GH_DASH_MY_EMAILS): accepted and ignored, so a client can PATCH back a Settings object it fetched.
  .extend({ myEmailsFromEnv: z.unknown().optional() })
  .strict()
  .transform(({ myEmailsFromEnv: _readOnly, ...patch }) => patch);

export function getSettings(db: Db): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (row.key in DEFAULT_SETTINGS) out[row.key] = JSON.parse(row.value);
  }
  return out as unknown as Settings;
}

export function patchSettings(db: Db, patch: z.infer<typeof settingsPatchSchema>): Settings {
  db.tx(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        key,
        JSON.stringify(value),
      ]);
    }
  });
  return getSettings(db);
}
