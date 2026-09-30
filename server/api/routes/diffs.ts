import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { isFullSha, type Payload, payloadText } from '../../diff/service';
import { parsePrNumber } from '../../services/lists';
import type { AppDeps } from '../app';
import { noCrossSiteReads } from '../auth';
import { parseWith } from '../http';

const refreshQuery = z.object({ refresh: z.literal('1').optional() });
const blobQuery = z.object({ ref: z.string(), path: z.string() });
const branchesQuery = z.object({ q: z.string().optional(), refresh: z.literal('1').optional() });

/**
 * Whether Accept-Encoding allows gzip: its own entry decides when present (so `gzip;q=0` wins over `*`), else `*`.
 * No header means identity, so plain clients (curl) get text.
 */
export function acceptsGzip(header: string | undefined): boolean {
  let gzip: number | null = null;
  let any: number | null = null;
  for (const part of (header ?? '').split(',')) {
    const [coding = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    const q = params.map((p) => /^q\s*=\s*([\d.]+)$/.exec(p)?.[1]).find((v) => v !== undefined);
    const weight = q === undefined ? 1 : Number(q);
    if (coding === 'gzip' || coding === 'x-gzip') gzip = weight;
    else if (coding === '*') any = weight;
  }
  return (gzip ?? any ?? 0) > 0;
}

/** Cached bodies are gzip already: browsers get them as stored, other clients get plain text. */
async function send(c: Context, body: Payload, type: string, headers: Record<string, string> = {}) {
  const common = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ...headers };
  // Bytes from zlib and node:sqlite are never backed by a SharedArrayBuffer.
  if (acceptsGzip(c.req.header('accept-encoding'))) return c.body(body.gz as Uint8Array<ArrayBuffer>, 200, { ...common, 'Content-Encoding': 'gzip' });
  return c.body(await payloadText(body), 200, common);
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function diffRoutes({ diffs }: AppDeps): Hono {
  const r = new Hono();

  // These spend the owner's GitHub quota: not on behalf of other sites.
  r.get('/prs/:repo/:number/diff', noCrossSiteReads, async (c) => {
    const number = parsePrNumber(c.req.param('number'));
    const { refresh } = parseWith(refreshQuery, c.req.query());
    return send(c, await diffs.prDiff(c.req.param('repo'), number, !!refresh), JSON_TYPE);
  });

  r.get('/commits/:repo/:oid/diff', noCrossSiteReads, async (c) => {
    const { refresh } = parseWith(refreshQuery, c.req.query());
    return send(c, await diffs.commitDiff(c.req.param('repo'), c.req.param('oid'), !!refresh), JSON_TYPE);
  });

  // A branch's name, like the repo's key, is one URL-encoded segment ("feature%2Fx"): Hono decodes it for us, and a name
  // written with its slashes doesn't match these routes (the threads' are /branches/:repo/:branch/threads, no clash).
  r.get('/branches/:repo', noCrossSiteReads, async (c) => {
    const { q, refresh } = parseWith(branchesQuery, c.req.query());
    return c.json(await diffs.branchList(c.req.param('repo'), q ?? null, !!refresh));
  });

  r.get('/branches/:repo/:branch/diff', noCrossSiteReads, async (c) => {
    const { refresh } = parseWith(refreshQuery, c.req.query());
    return send(c, await diffs.branchDiff(c.req.param('repo'), c.req.param('branch'), !!refresh), JSON_TYPE);
  });

  r.get('/blob/:repo', noCrossSiteReads, async (c) => {
    const { ref, path } = parseWith(blobQuery, c.req.query());
    const body = await diffs.blob(c.req.param('repo'), ref, path);
    // Contents at a full SHA never change.
    const immutable = isFullSha(ref) ? { 'Cache-Control': 'private, max-age=31536000, immutable' } : undefined;
    return send(c, body, 'text/plain; charset=utf-8', immutable);
  });

  r.get('/diff-cache', (c) => c.json(diffs.stats()));
  r.delete('/diff-cache', (c) => c.json(diffs.clear()));

  return r;
}
