import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDesktopPatch, ConfigInputError, enableMcpPatch, isLoopbackHost, parseAgentTokenInput, parseDesktopPatch, parseTokenInput, toDesktopConfig } from './config';

const DEFAULT_DIR = '/home/me/.config/gh-dash-desktop/data';

describe('toDesktopConfig', () => {
  it('maps an empty config.json to the defaults', () => {
    expect(toDesktopConfig({}, DEFAULT_DIR)).toEqual({
      dataDir: DEFAULT_DIR, listen: false, restApi: true, mcp: true, mcpRequireTokens: true, network: false, port: 4780, allowedHosts: [], apiKeySet: false, passwordSet: false,
    });
  });

  it('derives the data folder from db, network from host, and hides secrets', () => {
    const config = toDesktopConfig(
      { db: '/data/gh/gh-dash.db', host: '0.0.0.0', listen: true, port: 4999, allowedHosts: ['box.lan'], apiKey: 'k'.repeat(20), password: 'secret' },
      DEFAULT_DIR,
    );
    expect(config).toEqual({
      dataDir: '/data/gh', listen: true, restApi: true, mcp: true, mcpRequireTokens: true, network: true, port: 4999, allowedHosts: ['box.lan'], apiKeySet: true, passwordSet: true,
    });
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it('treats loopback hosts as local only', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) expect(toDesktopConfig({ host }, DEFAULT_DIR).network).toBe(false);
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) expect(toDesktopConfig({ host }, DEFAULT_DIR).network).toBe(true);
    expect(isLoopbackHost(' localhost ')).toBe(true);
  });
});

describe('applyDesktopPatch', () => {
  it('points db at <dir>/gh-dash.db and lets the cache follow it', () => {
    const next = applyDesktopPatch({ db: '/old/gh-dash.db', cacheDb: '/old/cache.db', sync: false }, { dataDir: '/new/place/' }, DEFAULT_DIR);
    expect(next).toEqual({ db: join(resolve('/new/place'), 'gh-dash.db'), sync: false });
  });

  it('drops db for the default folder, and leaves a hand-picked db file alone when the folder is unchanged', () => {
    expect(applyDesktopPatch({ db: '/old/gh-dash.db' }, { dataDir: DEFAULT_DIR }, DEFAULT_DIR)).toEqual({});
    expect(applyDesktopPatch({ db: '/x/custom.db' }, { dataDir: '/x' }, DEFAULT_DIR)).toEqual({ db: '/x/custom.db' });
  });

  it('maps network to host, and keeps unrelated keys (timezone, tokenSource...)', () => {
    const base = { timezone: 'Europe/Paris', tokenSource: 'gh' as const, password: 'hunter2hunter2' };
    expect(applyDesktopPatch(base, { network: true, listen: true, port: 5000 }, DEFAULT_DIR)).toEqual({ ...base, host: '0.0.0.0', listen: true, port: 5000 });
    expect(applyDesktopPatch({ ...base, host: '0.0.0.0' }, { network: false }, DEFAULT_DIR)).toEqual({ ...base, host: '127.0.0.1' });
  });

  it('sets and clears secrets and allowed hosts', () => {
    const set = applyDesktopPatch({}, { apiKey: 'a'.repeat(20), password: 'longenough', allowedHosts: ['box.lan'] }, DEFAULT_DIR);
    expect(set).toEqual({ apiKey: 'a'.repeat(20), password: 'longenough', allowedHosts: ['box.lan'] });
    expect(applyDesktopPatch(set, { apiKey: null, password: null, allowedHosts: [] }, DEFAULT_DIR)).toEqual({});
  });

  it('refuses the Local API on all interfaces without a password', () => {
    expect(() => applyDesktopPatch({}, { network: true }, DEFAULT_DIR)).toThrow(ConfigInputError);
    expect(() => applyDesktopPatch({ host: '0.0.0.0' }, { listen: true }, DEFAULT_DIR)).toThrow(/password/);
    expect(() => applyDesktopPatch({ host: '0.0.0.0', listen: true, password: 'longenough' }, { password: null }, DEFAULT_DIR)).toThrow(/password/);
    expect(applyDesktopPatch({ password: 'longenough' }, { network: true, listen: true }, DEFAULT_DIR).host).toBe('0.0.0.0');
    // Off: a hand-edited 0.0.0.0 doesn't block unrelated edits.
    expect(applyDesktopPatch({ host: '0.0.0.0' }, { port: 4800 }, DEFAULT_DIR).port).toBe(4800);
  });
});

describe('the Local API switches', () => {
  it('reads a config from before them as both on, tokens required', () => {
    expect(toDesktopConfig({ listen: true }, DEFAULT_DIR)).toMatchObject({ listen: true, restApi: true, mcp: true, mcpRequireTokens: true });
    expect(toDesktopConfig({ listen: true, restApi: false, mcp: true, mcpRequireTokens: false }, DEFAULT_DIR))
      .toMatchObject({ restApi: false, mcp: true, mcpRequireTokens: false });
  });

  it('writes each switch the patch names, and nothing else', () => {
    expect(applyDesktopPatch({ listen: true }, { restApi: false }, DEFAULT_DIR)).toEqual({ listen: true, restApi: false });
    expect(applyDesktopPatch({ listen: true }, { mcp: false, mcpRequireTokens: false }, DEFAULT_DIR)).toEqual({ listen: true, mcp: false, mcpRequireTokens: false });
  });

  it('asks for the password only while other devices reach the REST API', () => {
    // REST API off: the port serves 127.0.0.1 alone, so a network host left in the file needs no password.
    expect(applyDesktopPatch({ host: '0.0.0.0' }, { listen: true, restApi: false }, DEFAULT_DIR)).toMatchObject({ listen: true, restApi: false });
    expect(() => applyDesktopPatch({ host: '0.0.0.0', listen: true, restApi: false }, { restApi: true }, DEFAULT_DIR)).toThrow(/password/);
  });

  it("refuses MCP without tokens while other devices can connect (the server would require them anyway)", () => {
    const shared = { host: '0.0.0.0', listen: true, password: 'longenough' };
    expect(() => applyDesktopPatch(shared, { mcpRequireTokens: false }, DEFAULT_DIR)).toThrow(/Require agent tokens/);
    expect(() => applyDesktopPatch({ listen: true, mcpRequireTokens: false, password: 'longenough' }, { network: true }, DEFAULT_DIR)).toThrow(/Require agent tokens/);
    // Fine on this computer, with the REST API off (loopback then), or with MCP off.
    expect(applyDesktopPatch({ listen: true }, { mcpRequireTokens: false }, DEFAULT_DIR).mcpRequireTokens).toBe(false);
    expect(applyDesktopPatch(shared, { restApi: false, mcpRequireTokens: false }, DEFAULT_DIR)).toMatchObject({ restApi: false, mcpRequireTokens: false });
    expect(applyDesktopPatch(shared, { mcp: false, mcpRequireTokens: false }, DEFAULT_DIR)).toMatchObject({ mcp: false });
  });

  it('"Turn on MCP": the port for agents alone when it was off, MCP when it was on, nothing when it is served', () => {
    const cfg = (file: object) => toDesktopConfig(file, DEFAULT_DIR);
    expect(enableMcpPatch(cfg({}))).toEqual({ listen: true, restApi: false, mcp: true });
    expect(enableMcpPatch(cfg({ listen: false, restApi: true }))).toEqual({ listen: true, restApi: false, mcp: true });
    expect(enableMcpPatch(cfg({ listen: true, mcp: false }))).toEqual({ mcp: true });
    expect(enableMcpPatch(cfg({ listen: true, restApi: false }))).toEqual({});
  });

  it('"Turn on MCP" on a port other devices reach: tokens back on, so the patch is one applyDesktopPatch takes', () => {
    const file = { listen: true, restApi: true, host: '0.0.0.0', password: 'longenough', mcp: false, mcpRequireTokens: false };
    const patch = enableMcpPatch(toDesktopConfig(file, DEFAULT_DIR));
    expect(patch).toEqual({ mcp: true, mcpRequireTokens: true });
    expect(applyDesktopPatch(file, patch, DEFAULT_DIR)).toMatchObject({ mcp: true, mcpRequireTokens: true });
    // On this computer, or with the REST API off (loopback then), tokens stay as they were.
    expect(enableMcpPatch(toDesktopConfig({ ...file, host: '127.0.0.1' }, DEFAULT_DIR))).toEqual({ mcp: true });
    expect(enableMcpPatch(toDesktopConfig({ ...file, restApi: false }, DEFAULT_DIR))).toEqual({ mcp: true });
  });

  it('parses the switches as booleans', () => {
    expect(parseDesktopPatch({ restApi: false, mcp: true, mcpRequireTokens: false })).toEqual({ restApi: false, mcp: true, mcpRequireTokens: false });
    for (const key of ['restApi', 'mcp', 'mcpRequireTokens']) expect(() => parseDesktopPatch({ [key]: 'on' }), key).toThrow(new RegExp(key));
  });
});

describe('parseAgentTokenInput', () => {
  it('passes a token of 24–256 printable ASCII characters without spaces; none means generate one', () => {
    expect(parseAgentTokenInput(undefined)).toBeUndefined();
    expect(parseAgentTokenInput(null)).toBeUndefined();
    const mine = `x${'!~'.repeat(11)}z`;
    expect(parseAgentTokenInput(mine)).toBe(mine);
    expect(parseAgentTokenInput('y'.repeat(256))).toBe('y'.repeat(256));
  });

  it.each([
    ['y'.repeat(23), /24 to 256/],
    ['y'.repeat(257), /24 to 256/],
    ['with a space somewhere in it!', /printable ASCII without spaces/],
    ['tab\tinside-the-token-000000', /printable ASCII/],
    ['ünïcode-token-000000000000', /printable ASCII/],
    [42, /text/],
  ])('refuses %j', (token, message) => {
    expect(() => parseAgentTokenInput(token)).toThrow(message);
  });
});

describe('parseDesktopPatch', () => {
  it('accepts a full, valid patch and normalizes it', () => {
    expect(
      parseDesktopPatch({ dataDir: ' /data/gh/ ', listen: true, network: false, port: 4800, allowedHosts: ['Box.LAN.', 'box.lan:4780', 'nas'], apiKey: 'ghd_abcdefghijklmnop', password: 'correct horse' }, 'linux'),
    ).toEqual({ dataDir: '/data/gh', listen: true, network: false, port: 4800, allowedHosts: ['box.lan', 'nas'], apiKey: 'ghd_abcdefghijklmnop', password: 'correct horse' });
    expect(parseDesktopPatch({ apiKey: null, password: null })).toEqual({ apiKey: null, password: null });
    expect(parseDesktopPatch({})).toEqual({});
  });

  it.each([
    [null, /settings object/],
    [[], /settings object/],
    [{ evil: 1 }, /Unknown setting: evil/],
    [{ listen: 'yes' }, /listen/],
    [{ port: 0 }, /port/],
    [{ port: 65536 }, /port/],
    [{ port: 4780.5 }, /port/],
    [{ port: '4780' }, /port/],
    [{ dataDir: 'relative/dir' }, /absolute/],
    [{ dataDir: '' }, /data folder/],
    [{ dataDir: '/a\0b' }, /not valid/],
    [{ dataDir: `/${'x'.repeat(1100)}` }, /not valid/],
    [{ allowedHosts: 'box.lan' }, /list/],
    [{ allowedHosts: ['http://box.lan/'] }, /Not a host name/],
    [{ allowedHosts: ['a b'] }, /Not a host name/],
    [{ allowedHosts: Array.from({ length: 51 }, (_, i) => `h${i}`) }, /At most 50/],
    [{ apiKey: 'short' }, /API key/],
    [{ apiKey: 'has spaces in the middle' }, /API key/],
    [{ apiKey: 42 }, /API key/],
    [{ password: 'short' }, /8 to 256/],
    [{ password: ' padded password ' }, /space/],
    [{ password: 12345678 }, /text/],
  ])('refuses %j', (input, message) => {
    expect(() => parseDesktopPatch(input, 'linux')).toThrow(message);
  });

  it('checks Windows paths as Windows paths', () => {
    expect(parseDesktopPatch({ dataDir: 'C:\\Users\\me\\gh-dash' }, 'win32').dataDir).toBe('C:\\Users\\me\\gh-dash');
    expect(parseDesktopPatch({ dataDir: '\\\\nas\\share\\gh' }, 'win32').dataDir).toBe('\\\\nas\\share\\gh');
    expect(() => parseDesktopPatch({ dataDir: '\\Users\\me' }, 'win32')).toThrow(/absolute/);
    expect(() => parseDesktopPatch({ dataDir: 'C:relative' }, 'win32')).toThrow(/absolute/);
  });
});

describe('parseTokenInput', () => {
  it('trims a pasted token', () => {
    expect(parseTokenInput('  github_pat_ABC123_xyz\n', true)).toEqual({ token: 'github_pat_ABC123_xyz', remember: true });
  });

  it.each([
    [undefined, false, /Paste/],
    ['   ', false, /Paste/],
    ['ghp_abc def', false, /does not look/],
    ['ghp_é', false, /does not look/],
    ['x'.repeat(513), false, /does not look/],
    ['ghp_abc', 'yes', /remember/],
  ])('refuses %j / %j', (token, remember, message) => {
    expect(() => parseTokenInput(token, remember)).toThrow(message);
  });
});
