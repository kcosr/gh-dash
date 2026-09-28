import { describe, expect, it } from 'vitest';
import type { InstanceInfo } from './api';
import type { DesktopConfig } from './desktop';
import {
  apiLink, authLabel, bridgeError, ghUnavailable, instanceForm, instancePatch, instanceProblems, parseHosts, resolveApiBase,
  settingSource, tokenAccess, tokenExpiry, tokenKindLabel, tokenSourceLabel,
} from '../web/src/lib/account';

const DAY = 864e5;
const now = new Date(2026, 8, 28, 15, 0).getTime(); // Sep 28, 2026, 3 PM local
const at = (days: number, hour = 12) => new Date(2026, 8, 28 + days, hour).toISOString();

describe('token labels', () => {
  it('names every token source, desktop wording included', () => {
    expect(tokenSourceLabel('env')).toBe('GITHUB_TOKEN (environment or env file)');
    expect(tokenSourceLabel('env', { desktop: true })).toBe('GITHUB_TOKEN environment variable');
    expect(tokenSourceLabel('file')).toBe('Token file');
    expect(tokenSourceLabel('gh-cli')).toBe('GitHub CLI (gh auth token)');
    expect(tokenSourceLabel('app', { desktop: true, remembered: true })).toMatch(/OS keychain/);
    expect(tokenSourceLabel('app', { desktop: true, remembered: false })).toMatch(/until gh-dash quits/);
    expect(tokenSourceLabel('none')).toBe('No token found');
    expect(tokenSourceLabel('none', { desktop: true, chosen: false })).toBe('Not connected');
    expect(tokenSourceLabel('none', { desktop: true, chosen: true })).toBe('No token found');
  });

  it('names token kinds', () => {
    expect(tokenKindLabel('fine-grained')).toBe('Fine-grained personal access token');
    expect(tokenKindLabel('classic')).toBe('Classic personal access token');
    expect(tokenKindLabel('oauth')).toBe('OAuth token');
    expect(tokenKindLabel('app')).toBe('GitHub App token');
    expect(tokenKindLabel('unknown')).toBe('Token');
  });

  it('calls a token with the repo scope full access and claims nothing for fine-grained ones', () => {
    expect(tokenAccess(['gist', 'read:org', 'repo', 'workflow'])).toBe('full');
    expect(tokenAccess(['public_repo', 'read:org'])).toBe('public');
    expect(tokenAccess([])).toBe('public');
    expect(tokenAccess(null)).toBeNull();
  });
});

describe('tokenExpiry', () => {
  it('says "never expires" only for personal access tokens without an expiry', () => {
    expect(tokenExpiry(null, 'fine-grained', now)).toEqual({ text: 'never expires', warn: false });
    expect(tokenExpiry(null, 'classic', now)).toEqual({ text: 'never expires', warn: false });
    expect(tokenExpiry(null, 'oauth', now)).toBeNull();
    expect(tokenExpiry(null, null, now)).toBeNull();
    expect(tokenExpiry('not a date', 'classic', now)).toBeNull();
  });

  it('warns within 14 days, counting calendar days', () => {
    expect(tokenExpiry(at(200), 'fine-grained', now)).toEqual({ text: 'expires Apr 16, 2027', warn: false });
    expect(tokenExpiry(at(15), 'fine-grained', now)).toEqual({ text: 'expires Oct 13, 2026', warn: false });
    expect(tokenExpiry(at(14), 'fine-grained', now)).toEqual({ text: 'expires in 14 days (Oct 12, 2026)', warn: true });
    // 4.9 days away, 5 calendar days.
    expect(tokenExpiry(at(5, 12), 'fine-grained', now)).toEqual({ text: 'expires in 5 days (Oct 3, 2026)', warn: true });
    expect(tokenExpiry(at(1, 9), 'classic', now)).toEqual({ text: 'expires tomorrow (Sep 29, 2026)', warn: true });
    expect(tokenExpiry(at(0, 23), 'classic', now)).toEqual({ text: 'expires today (Sep 28, 2026)', warn: true });
    expect(tokenExpiry(at(-2), 'classic', now)).toEqual({ text: 'expired Sep 26, 2026', warn: true });
    // An OAuth token with a reported expiry is shown too.
    expect(tokenExpiry(new Date(now + 3 * DAY).toISOString(), 'oauth', now)?.warn).toBe(true);
  });
});

describe('GitHub CLI availability', () => {
  const gh = (available: boolean) => ({ available, path: available ? '/usr/bin/gh' : null, login: null });
  it('explains why "Use GitHub CLI" is unavailable', () => {
    expect(ghUnavailable({ gh: gh(true), locked: false })).toBeNull();
    expect(ghUnavailable({ gh: gh(false), locked: false })).toMatch(/not found/);
    expect(ghUnavailable({ gh: gh(true), locked: true })).toMatch(/GITHUB_TOKEN/);
  });
});

describe('API links', () => {
  it('joins the base URL and a path, or gives null without a base', () => {
    expect(apiLink('http://127.0.0.1:4780', '/api/docs')).toBe('http://127.0.0.1:4780/api/docs');
    expect(apiLink('https://dash.example.com/', '/api/v1/prs?repos=a,b')).toBe('https://dash.example.com/api/v1/prs?repos=a,b');
    expect(apiLink('http://h:1', 'api/docs')).toBe('http://h:1/api/docs');
    expect(apiLink(null, '/api/docs')).toBeNull();
  });

  it("prefers the server's apiUrl; before it answers, a browser tab uses its origin and the desktop app has none", () => {
    expect(resolveApiBase({ apiUrl: 'http://127.0.0.1:4780' }, true, 'app://gh-dash')).toBe('http://127.0.0.1:4780');
    expect(resolveApiBase({ apiUrl: null }, true, 'app://gh-dash')).toBeNull();
    expect(resolveApiBase({ apiUrl: null }, false, 'http://127.0.0.1:4780')).toBeNull();
    expect(resolveApiBase(undefined, false, 'http://127.0.0.1:4780')).toBe('http://127.0.0.1:4780');
    expect(resolveApiBase(undefined, true, 'app://gh-dash')).toBeNull();
  });
});

describe('instance settings', () => {
  it('shows where each setting came from', () => {
    expect(settingSource('dbPath', 'default')).toBe('default');
    expect(settingSource('dbPath', 'file')).toBe('config.json');
    expect(settingSource('dbPath', 'env')).toBe('GH_DASH_DB');
    expect(settingSource('tokenFile', 'env')).toBe('GITHUB_TOKEN_FILE');
    expect(settingSource('defaultTz', 'env')).toBe('TZ');
  });

  it('describes the auth mode', () => {
    const auth = (password: boolean, apiKey: boolean): InstanceInfo['auth'] => ({ password, apiKey });
    expect(authLabel(auth(false, false))).toBe('None');
    expect(authLabel(auth(true, false))).toBe('Password');
    expect(authLabel(auth(true, true))).toMatch(/Password, and an API key/);
    expect(authLabel(auth(false, true))).toMatch(/API key only/);
  });

  it('unwraps errors from the desktop bridge', () => {
    expect(bridgeError(new Error("Error invoking remote method 'gh-dash:set-token': Error: Bad credentials"))).toBe('Bad credentials');
    expect(bridgeError(new Error("Error invoking remote method 'gh-dash:update-config': TypeError: nope"))).toBe('nope');
    expect(bridgeError(new Error('Port 4780 is in use'))).toBe('Port 4780 is in use');
    expect(bridgeError('plain')).toBe('plain');
  });
});

describe('desktop instance form', () => {
  const cfg: DesktopConfig = { dataDir: '/data', listen: false, network: false, port: 4780, allowedHosts: [], apiKeySet: false, passwordSet: false };

  it('sends only what changed', () => {
    const f = instanceForm(cfg);
    expect(instancePatch(cfg, f)).toEqual({});
    expect(instancePatch(cfg, { ...f, listen: true, port: 4790 })).toEqual({ listen: true, port: 4790 });
    expect(instancePatch(cfg, { ...f, dataDir: '/other', allowedHosts: ['box.local'] })).toEqual({ dataDir: '/other', allowedHosts: ['box.local'] });
    expect(instancePatch(cfg, { ...f, apiKey: 'k', password: 'pw' })).toEqual({ apiKey: 'k', password: 'pw' });
    // Clearing a secret that isn't set is no change; clearing one that is, is.
    expect(instancePatch(cfg, { ...f, apiKey: null, password: null })).toEqual({});
    const set = { ...cfg, apiKeySet: true, passwordSet: true };
    expect(instancePatch(set, { ...instanceForm(set), apiKey: null, password: null })).toEqual({ apiKey: null, password: null });
  });

  it('needs a valid port and, for other devices, a password', () => {
    const f = { ...instanceForm(cfg), listen: true };
    expect(instanceProblems(cfg, f)).toEqual({});
    expect(instanceProblems(cfg, { ...f, port: 0 }).port).toBeTruthy();
    expect(instanceProblems(cfg, { ...f, port: 70000 }).port).toBeTruthy();
    expect(instanceProblems(cfg, { ...f, port: Number.NaN }).port).toBeTruthy();
    // The port doesn't matter while the Local API is off.
    expect(instanceProblems(cfg, { ...f, listen: false, port: 0 })).toEqual({});
    expect(instanceProblems(cfg, { ...f, network: true }).network).toMatch(/password/);
    expect(instanceProblems(cfg, { ...f, network: true, password: 'long enough' })).toEqual({});
    expect(instanceProblems(cfg, { ...f, network: true, password: 'pw' }).password).toBeTruthy();
    expect(instanceProblems(cfg, { ...f, password: ' padded pass ' }).password).toBeTruthy();
    const withPw = { ...cfg, passwordSet: true };
    expect(instanceProblems(withPw, { ...f, network: true })).toEqual({});
    expect(instanceProblems(withPw, { ...f, network: true, password: null }).network).toBeTruthy();
    expect(instanceProblems(cfg, { ...f, dataDir: ' ' }).dataDir).toBeTruthy();
  });

  it('normalizes host names and drops invalid ones', () => {
    expect(parseHosts('MyBox.local, dash.example.com:8443  nas.')).toEqual(['mybox.local', 'dash.example.com', 'nas']);
    expect(parseHosts('bad_name, -x.com, ok-1.lan')).toEqual(['ok-1.lan']);
    expect(parseHosts('  ')).toEqual([]);
  });
});
