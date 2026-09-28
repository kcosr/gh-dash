/**
 * protocol.handle('app') → the server child over its socket/pipe. Requests and responses are streamed; main adds
 * the per-launch secret and Host gh-dash, and the CSP on the way back. No Electron imports: it takes a web Request
 * and returns a web Response, so it runs under plain Node in tests.
 */
import http from 'node:http';
import { pipeline, Readable } from 'node:stream';
import { DESKTOP_HOST, DESKTOP_SECRET_HEADER } from '../shared/desktop';
import { ERROR_PAGE_CSP } from './csp';
import { ACTION_PREFIX, type ErrorPageAction } from './error-page';

export interface ProxyOptions {
  socketPath: string;
  secret: string;
  csp: string;
  /** Waits out a start/restart; anything but 'running' means the server is unavailable. */
  whenSettled: () => Promise<string>;
  /** Why the server is unavailable (its start error). */
  failure: () => string;
  /** HTML for navigations while the server is unavailable. */
  errorPage: () => string;
  /** An error-page button (/__gh-dash/<action>); resolves when done. */
  onAction: (action: ErrorPageAction) => Promise<void>;
  log: (line: string) => void;
}

// Hop-by-hop headers, forwarding headers the server might trust, and our own secret (never from the renderer).
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', DESKTOP_SECRET_HEADER,
]);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-security-policy']);
const ACTIONS = new Set<ErrorPageAction>(['retry', 'disable-local-api', 'show-config', 'quit']);

const isNavigation = (req: Request) =>
  req.method === 'GET' && (req.headers.get('sec-fetch-dest') === 'document' || /text\/html/.test(req.headers.get('accept') ?? ''));

export function createProxy(opts: ProxyOptions) {
  let agent = new http.Agent({ keepAlive: true, maxSockets: 32 });

  const unavailable = (req: Request, message: string) =>
    isNavigation(req)
      ? new Response(opts.errorPage(), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ERROR_PAGE_CSP, 'cache-control': 'no-store' } })
      : Response.json({ error: `gh-dash server unavailable: ${message}` }, { status: 503, headers: { 'content-security-policy': opts.csp } });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.host !== DESKTOP_HOST) return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith(ACTION_PREFIX)) return action(req, url.pathname.slice(ACTION_PREFIX.length) as ErrorPageAction);
    const status = await opts.whenSettled();
    if (status !== 'running') return unavailable(req, opts.failure());
    return forward(req, url);
  }

  async function action(req: Request, name: ErrorPageAction): Promise<Response> {
    if (req.method !== 'GET' || !ACTIONS.has(name)) return new Response('Not found', { status: 404 });
    await opts.onAction(name);
    // 204 leaves the current page as is; the others reload the app (or show the error page again).
    if (name === 'show-config' || name === 'quit') return new Response(null, { status: 204 });
    return new Response('<!doctype html><meta http-equiv="refresh" content="0; url=/">', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ERROR_PAGE_CSP, 'cache-control': 'no-store' },
    });
  }

  function forward(req: Request, url: URL, retried = false): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const [name, value] of req.headers) if (!DROP_REQUEST.has(name)) headers[name] = value;
    headers.host = DESKTOP_HOST;
    headers[DESKTOP_SECRET_HEADER] = opts.secret;
    const path = url.pathname + url.search;
    return new Promise<Response>((resolve) => {
      let responded = false;
      const upstream = http.request({ agent, socketPath: opts.socketPath, method: req.method, path, headers }, (res) => {
        responded = true;
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined || DROP_RESPONSE.has(name)) continue;
          for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
        }
        out.set('content-security-policy', opts.csp);
        out.set('x-content-type-options', 'nosniff');
        const status = res.statusCode ?? 502;
        const empty = req.method === 'HEAD' || status === 204 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: out }));
      });
      // The upload and the upstream request fail together (pipeline below); whichever fails first answers.
      let failed = false;
      upstream.on('error', (error: NodeJS.ErrnoException) => {
        if (responded || failed) return; // mid-body failures surface on the response stream
        failed = true;
        // A kept-alive connection the (restarted) server already closed: safe to retry an idempotent request once.
        const idempotent = req.method === 'GET' || req.method === 'HEAD';
        if (!retried && upstream.reusedSocket && error.code === 'ECONNRESET' && idempotent && !req.signal?.aborted) {
          resolve(forward(req, url, true));
          return;
        }
        opts.log(`[proxy] ${req.method} ${path}: ${error.message}`);
        resolve(unavailable(req, error.message));
      });
      req.signal?.addEventListener('abort', () => upstream.destroy(), { once: true });
      if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
        const body = Readable.fromWeb(req.body as import('node:stream/web').ReadableStream);
        // Answered here: pipeline aborts the upstream request, which then may not emit an error at all.
        body.once('error', (error) => {
          if (responded || failed) return;
          failed = true;
          opts.log(`[proxy] ${req.method} ${path}: the request body failed: ${error.message}`);
          resolve(Response.json({ error: `The request body failed: ${error.message}` }, { status: 400, headers: { 'content-security-policy': opts.csp } }));
        });
        // Not pipe(): a failed or cancelled upload must abort the upstream request, and a failed upstream request
        // cancel the upload, rather than throw in the main process. The listeners above report the error.
        pipeline(body, upstream, () => {});
      } else {
        upstream.end();
      }
    });
  }

  return {
    handle,
    /** Drops kept-alive connections (after the server restarts). */
    reset() {
      agent.destroy();
      agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
    },
    close() {
      agent.destroy();
    },
  };
}
