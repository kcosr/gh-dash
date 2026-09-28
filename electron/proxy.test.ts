import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DESKTOP_SECRET_HEADER } from '../shared/desktop';
import { ERROR_PAGE_CSP } from './csp';
import { createProxy } from './proxy';

const SECRET = 'a'.repeat(64);
const CSP = "default-src 'none'";
let dir: string;
let socketPath: string;
let server: http.Server;
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
/** Requests to /upload: never answered; the tests end them from the app side. */
const uploads: http.IncomingMessage[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ghd-proxy-test-'));
  socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ghd-proxy-test-${process.pid}` : join(dir, 's');
  server = http.createServer((req, res) => {
    if (req.url === '/upload') {
      req.on('error', () => {});
      uploads.push(req);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/empty') return res.writeHead(204).end();
      if (req.url === '/cookies') {
        res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
        res.setHeader('content-security-policy', 'script-src *');
        return res.end('ok');
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first ');
        setTimeout(() => res.end('second'), 20);
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json', connection: 'keep-alive' });
      res.end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function proxy(overrides: Partial<Parameters<typeof createProxy>[0]> = {}) {
  return createProxy({
    socketPath,
    secret: SECRET,
    csp: CSP,
    whenSettled: async () => 'running',
    failure: () => 'port in use',
    errorPage: () => '<p>error page</p>',
    onAction: async () => {},
    log: () => {},
    ...overrides,
  });
}

describe('app:// proxy', () => {
  it('forwards method, path and a streamed body with the secret and Host gh-dash; strips spoofable headers', async () => {
    const p = proxy();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":'));
        c.enqueue(new TextEncoder().encode('1}'));
        c.close();
      },
    });
    const res = await p.handle(
      new Request('app://gh-dash/api/v1/views?x=1', {
        method: 'POST',
        body,
        duplex: 'half',
        headers: { 'content-type': 'application/json', [DESKTOP_SECRET_HEADER]: 'forged', 'x-forwarded-host': 'evil', host: 'evil' },
      } as RequestInit),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echo: '{"a":1}' });
    const req = seen.at(-1)!;
    expect(req).toMatchObject({ method: 'POST', url: '/api/v1/views?x=1', body: '{"a":1}' });
    expect(req.headers.host).toBe('gh-dash');
    expect(req.headers[DESKTOP_SECRET_HEADER]).toBe(SECRET);
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    expect(req.headers['content-type']).toBe('application/json');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('connection')).toBeNull();
    p.close();
  });

  it('answers when the upload fails midway, and aborts the upstream request', async () => {
    const p = proxy();
    let fail!: (error: Error) => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('partial'));
        fail = (error) => c.error(error);
      },
    });
    uploads.length = 0;
    const pending = p.handle(new Request('app://gh-dash/upload', { method: 'POST', body, duplex: 'half' } as RequestInit));
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    fail(new DOMException('The operation was aborted.', 'AbortError'));
    const res = await pending;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/request body failed: The operation was aborted/);
    await vi.waitFor(() => expect(uploads[0]!.destroyed).toBe(true));
    expect(uploads[0]!.complete).toBe(false);
    p.close();
  });

  it('cancels the upload and the upstream request when the request is aborted', async () => {
    const p = proxy();
    const abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('partial'));
      },
      cancel() {
        cancelled = true;
      },
    });
    uploads.length = 0;
    const pending = p.handle(new Request('app://gh-dash/upload', { method: 'POST', body, duplex: 'half', signal: abort.signal } as RequestInit));
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    abort.abort();
    expect((await pending).status).toBe(503);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    await vi.waitFor(() => expect(uploads[0]!.destroyed).toBe(true));
    p.close();
  });

  it('keeps multiple set-cookie headers and replaces a server CSP with ours', async () => {
    const p = proxy();
    const res = await p.handle(new Request('app://gh-dash/cookies'));
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    p.close();
  });

  it('streams responses and handles empty ones', async () => {
    const p = proxy();
    expect(await (await p.handle(new Request('app://gh-dash/stream'))).text()).toBe('first second');
    const empty = await p.handle(new Request('app://gh-dash/empty'));
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    const head = await p.handle(new Request('app://gh-dash/api/x', { method: 'HEAD' }));
    expect(head.body).toBeNull();
    p.close();
  });

  it('refuses other hosts', async () => {
    const res = await proxy().handle(new Request('app://elsewhere/prs'));
    expect(res.status).toBe(404);
  });

  it('answers 503 while the server is down: the error page for navigations, JSON otherwise', async () => {
    const p = proxy({ whenSettled: async () => 'failed' });
    const page = await p.handle(new Request('app://gh-dash/prs', { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } }));
    expect(page.status).toBe(503);
    expect(await page.text()).toBe('<p>error page</p>');
    expect(page.headers.get('content-security-policy')).toBe(ERROR_PAGE_CSP);
    const api = await p.handle(new Request('app://gh-dash/api/v1/prs'));
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: 'gh-dash server unavailable: port in use' });
  });

  it('answers 503 when the socket is gone', async () => {
    const missing = process.platform === 'win32' ? '\\\\.\\pipe\\ghd-proxy-test-missing' : join(dir, 'missing');
    const res = await proxy({ socketPath: missing }).handle(new Request('app://gh-dash/api/v1/prs'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/^gh-dash server unavailable: /);
  });

  it('runs error-page actions', async () => {
    const onAction = vi.fn(async () => {});
    const p = proxy({ onAction, whenSettled: async () => 'failed' });
    const retry = await p.handle(new Request('app://gh-dash/__gh-dash/retry'));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('http-equiv="refresh"');
    expect((await p.handle(new Request('app://gh-dash/__gh-dash/show-config'))).status).toBe(204);
    expect((await p.handle(new Request('app://gh-dash/__gh-dash/rm-rf'))).status).toBe(404);
    expect((await p.handle(new Request('app://gh-dash/__gh-dash/retry', { method: 'POST' }))).status).toBe(404);
    expect(onAction.mock.calls).toEqual([['retry'], ['show-config']]);
  });
});
