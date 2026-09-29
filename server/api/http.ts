import type { Context } from 'hono';
import { HttpError } from '../lib/errors';

// HttpError and parseWith live in lib/errors.ts, where the services can reach them without HTTP; the routes and tests
// keep importing them from here.
export { HttpError, parseWith } from '../lib/errors';

/** Public origin of the request, honouring a reverse proxy's forwarded headers. */
export function origin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  return `${proto}://${host}`;
}

/** Parses the JSON request body; an empty body is `{}`. */
export async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}
