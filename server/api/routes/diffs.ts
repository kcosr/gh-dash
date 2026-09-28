import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { type Payload, payloadText } from '../../diff/service';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';

const refreshQuery = z.object({ refresh: z.literal('1').optional() });
const blobQuery = z.object({ ref: z.string(), path: z.string() });

/** True unless the client refuses gzip (`gzip;q=0`) or doesn't list it (or `*`). */
function acceptsGzip(c: Context): boolean {
  return (c.req.header('accept-encoding') ?? '').split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return (name === 'gzip' || name === '*') && (!q || Number(q.slice(2)) > 0);
  });
}

/** Cached bodies are gzip already: browsers get them as stored, other clients get plain text. */
async function send(c: Context, body: Payload, type: string, headers: Record<string, string> = {}) {
  const common = { 'Content-Type': type, Vary: 'Accept-Encoding', ...headers };
  if (acceptsGzip(c)) return c.body(new Uint8Array(body.gz), 200, { ...common, 'Content-Encoding': 'gzip' });
  return c.body(await payloadText(body), 200, common);
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function diffRoutes({ diffs }: AppDeps): Hono {
  const r = new Hono();

  r.get('/prs/:repo/:number/diff', async (c) => {
    const number = Number(c.req.param('number'));
    if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Invalid PR number');
    const { refresh } = parseWith(refreshQuery, c.req.query());
    return send(c, await diffs.prDiff(c.req.param('repo'), number, !!refresh), JSON_TYPE);
  });

  r.get('/commits/:repo/:oid/diff', async (c) => {
    const { refresh } = parseWith(refreshQuery, c.req.query());
    return send(c, await diffs.commitDiff(c.req.param('repo'), c.req.param('oid'), !!refresh), JSON_TYPE);
  });

  r.get('/blob/:repo', async (c) => {
    const { ref, path } = parseWith(blobQuery, c.req.query());
    const body = await diffs.blob(c.req.param('repo'), ref, path);
    // Contents at a full SHA never change.
    const immutable = ref.length === 40 ? { 'Cache-Control': 'private, max-age=31536000, immutable' } : undefined;
    return send(c, body, 'text/plain; charset=utf-8', immutable);
  });

  r.get('/diff-cache', (c) => c.json(diffs.stats()));
  r.delete('/diff-cache', (c) => c.json(diffs.clear()));

  return r;
}
