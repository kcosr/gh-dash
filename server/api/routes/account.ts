import { Hono } from 'hono';
import type { AppDeps } from '../app';

/** The GitHub account behind the token (never the token itself). */
export function accountRoutes({ tokens }: AppDeps): Hono {
  const r = new Hono();

  // Polled by the web app: never calls GitHub (a new token is validated in the background when it turns up).
  r.get('/account', async (c) => c.json(await tokens.account()));

  // "Retry": resolve the token again (gh, token file) and re-validate it now.
  r.post('/account/check', async (c) => c.json(await tokens.check()));

  return r;
}
