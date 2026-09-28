import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { DESKTOP_HOST, DESKTOP_SECRET_HEADER } from '../../shared/desktop';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { getMeta, setMeta } from '../db/meta';

const COOKIE = 'gh_dash_session';
const SESSION_DAYS = 30;

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** HMAC key for session cookies; includes the password so changing it logs everyone out. */
function sessionKey(db: Db, config: Config): string {
  let secret = getMeta(db, 'sessionSecret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    setMeta(db, 'sessionSecret', secret);
  }
  return `${secret}:${config.password ?? ''}`;
}

async function hasSession(c: Context, key: string): Promise<boolean> {
  const value = await getSignedCookie(c, key, COOKIE);
  if (!value) return false;
  const issued = Number(value);
  return Number.isFinite(issued) && Date.now() - issued < SESSION_DAYS * 86_400_000;
}

async function issueSession(c: Context, key: string): Promise<void> {
  const secure = c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
  await setSignedCookie(c, COOKIE, String(Date.now()), key, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure,
    maxAge: SESSION_DAYS * 86_400,
  });
}

function hasApiKey(c: Context, apiKey: string): boolean {
  const auth = c.req.header('authorization');
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  const header = c.req.header('x-api-key');
  return (!!bearer && safeEqual(bearer.trim(), apiKey)) || (!!header && safeEqual(header.trim(), apiKey));
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (host: string) => LOOPBACK.has(host.replace(/:\d+$/, '').toLowerCase());

/** A Host header's name: lower-cased, without the port, IPv6 brackets or a trailing dot. */
export function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d*)?$/.exec(h)?.[1];
  // Several colons without brackets can only be a (malformed) IPv6 literal, never a name with a port.
  const name = bracketed ?? (h.indexOf(':') === h.lastIndexOf(':') ? h.replace(/:[^:]*$/, '') : h);
  return name.replace(/\.$/, '');
}

/** Without a Host header (HTTP/2, in-process requests) the URL's host is the authority the client asked for. */
const requestHost = (c: Context) => hostName(c.req.header('host') ?? new URL(c.req.url).host);

/** Names a DNS rebinding attack can't produce: localhost, *.localhost and IP literals, plus the configured ones. */
export function isAllowedHost(name: string, allowedHosts: readonly string[]): boolean {
  return name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0 || allowedHosts.includes(name);
}

/**
 * DNS rebinding protection for network listeners, installed first. A page on an attacker's domain that resolves to
 * this machine is same-origin with the server as far as the browser knows, so CORS, sameOriginWrites and
 * noCrossSiteReads all let it through; only the Host header still names the attacker's domain. The raw Host is
 * checked (a page can set X-Forwarded-Host itself); no path is exempt, /api/health included.
 */
export function hostAllowlist(allowedHosts: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const name = requestHost(c);
    if (!isAllowedHost(name, allowedHosts)) {
      return c.json({ error: `Host "${name.slice(0, 253)}" is not allowed; add it to GH_DASH_ALLOWED_HOSTS to serve it` }, 421);
    }
    await next();
  };
}

/**
 * The desktop app's socket: every request must come through the Electron main process, which adds the per-launch
 * secret (other local processes can open the socket or pipe too) and addresses the server as DESKTOP_HOST.
 */
export function desktopOnly(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const sent = c.req.header(DESKTOP_SECRET_HEADER);
    if (!sent || !safeEqual(sent, secret)) return c.json({ error: 'Forbidden' }, 403);
    if (requestHost(c) !== DESKTOP_HOST) return c.json({ error: `Host must be ${DESKTOP_HOST}` }, 421);
    await next();
  };
}

/**
 * Rejects state-changing requests sent by a browser from another origin (CSRF, including against
 * localhost). Non-browser clients (curl) send no Origin header and pass. Loopback origins are accepted
 * when the server is also addressed via loopback, so dev proxies that rewrite Host (Vite) keep working.
 */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" or malformed origin
    }
    const sameSite = !!originHost && (originHost === host || (isLoopback(originHost) && isLoopback(host)));
    if (!sameSite) return c.json({ error: 'Cross-origin request rejected' }, 403);
  }
  await next();
};

/**
 * For GETs that spend the owner's GitHub quota or churn the diff cache: rejects requests a browser marks as
 * cross-site (e.g. `<img src="http://127.0.0.1:4780/api/v1/blob/...">` on another site). Same-origin and same-site
 * requests, direct navigation (`none`) and clients that send no Sec-Fetch-Site header (curl, scripts) pass.
 */
export const noCrossSiteReads: MiddlewareHandler = async (c, next) => {
  if (c.req.header('sec-fetch-site')?.trim().toLowerCase() === 'cross-site') return c.json({ error: 'Cross-site request rejected' }, 403);
  await next();
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function loginPage(next: string, failed: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>gh-dash · sign in</title><style>
body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1f2328}
form{background:#fff;border:1px solid #d0d7de;border-radius:10px;padding:28px;width:300px;display:grid;gap:12px}
h1{font-size:18px;margin:0}input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #d0d7de}
button{background:#1f6feb;color:#fff;border-color:#1f6feb;cursor:pointer}.err{color:#cf222e;margin:0}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}form{background:#161b22;border-color:#30363d}input{background:#0d1117;color:#e6edf3;border-color:#30363d}}
</style></head><body><form method="post" action="/login"><h1>gh-dash</h1>
${failed ? '<p class="err">Wrong password.</p>' : ''}<input type="hidden" name="next" value="${escapeHtml(next)}">
<input type="password" name="password" placeholder="Password" autofocus required aria-label="Password"><button type="submit">Sign in</button>
</form></body></html>`;
}

/**
 * Only same-origin paths are allowed as post-login redirects. Browsers read `/\host` and `/<tab>/host` as
 * `//host`, so backslashes and control characters are rejected too, and the result must resolve to our origin.
 */
function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !/^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/.test(next)) return '/';
  const base = 'http://gh-dash.invalid';
  return new URL(next, base).origin === base ? next : '/';
}

/**
 * Optional auth, configured by env:
 *  - GH_DASH_PASSWORD: the UI and API require a session cookie obtained from /login (API key also accepted).
 *  - GH_DASH_API_KEY: /api/* requires the key (Bearer or X-API-Key) or a UI session cookie. Without a
 *    password, loading any UI page issues the session cookie.
 * /api/health is always open.
 */
export function installAuth(app: Hono, db: Db, config: Config): void {
  const { apiKey, password } = config;
  if (!apiKey && !password) return;
  const key = sessionKey(db, config);

  if (password) {
    app.get('/login', (c) => c.html(loginPage(safeNext(c.req.query('next')), false)));
    app.post('/login', async (c) => {
      const form = await c.req.parseBody();
      const next = safeNext(form.next);
      if (typeof form.password !== 'string' || !safeEqual(form.password, password)) return c.html(loginPage(next, true), 401);
      await issueSession(c, key);
      return c.redirect(next, 303);
    });
    app.get('/logout', (c) => {
      deleteCookie(c, COOKIE, { path: '/' });
      return c.redirect('/login', 303);
    });
  }

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/health' || path === '/login') return next();
    const isApi = path === '/api' || path.startsWith('/api/');
    if (await hasSession(c, key)) return next();
    if (isApi) {
      if (apiKey && hasApiKey(c, apiKey)) return next();
      const hint = apiKey ? 'send Authorization: Bearer <GH_DASH_API_KEY> or X-API-Key' : 'sign in at /login';
      return c.json({ error: `Unauthorized: ${hint}` }, 401);
    }
    if (password) {
      const target = path + new URL(c.req.url).search;
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 303);
    }
    await issueSession(c, key);
    return next();
  });
}
