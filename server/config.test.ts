import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFilePath, configJsonPath, findPackageRoot, loadConfig, loadEnvironment, loadServerConfig, rootDir } from './config';
import { readConfigFile, writeConfigFile, type ConfigFile } from './config-file';
import { openDb } from './db/db';
import { testTokens } from './test/tokens';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'gh-dash-config-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file(env: NodeJS.ProcessEnv, body: string) {
  const path = configFilePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

describe('XDG config and state', () => {
  it('uses home defaults without touching the filesystem', () => {
    const home = temp();
    expect(configFilePath({ HOME: home })).toBe(join(home, '.config/gh-dash/env'));
    expect(loadConfig({ HOME: home }).dbPath).toBe(join(home, '.local/state/gh-dash/gh-dash.db'));
    expect(configFilePath({})).toBe(join(homedir(), '.config/gh-dash/env'));
  });

  it('honors absolute XDG directories and ignores empty/relative ones', () => {
    const home = temp();
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') };
    expect(configFilePath(env)).toBe(join(home, 'config/gh-dash/env'));
    expect(loadConfig(env).dbPath).toBe(join(home, 'state/gh-dash/gh-dash.db'));
    for (const value of ['', 'relative', '~/config']) {
      expect(configFilePath({ HOME: home, XDG_CONFIG_HOME: value })).toBe(join(home, '.config/gh-dash/env'));
      expect(loadConfig({ HOME: home, XDG_STATE_HOME: value }).dbPath).toBe(join(home, '.local/state/gh-dash/gh-dash.db'));
    }
  });

  it('keeps explicit database overrides, including in-memory and relative paths', () => {
    expect(loadConfig({ GH_DASH_DB: ':memory:' }).dbPath).toBe(':memory:');
    const path = join(temp(), 'custom.db');
    expect(loadConfig({ GH_DASH_DB: path }).dbPath).toBe(path);
    expect(loadConfig({ GH_DASH_DB: 'custom.db' }).dbPath).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'custom.db'));
  });

  it('puts the diff cache next to the database unless GH_DASH_CACHE_DB says otherwise', () => {
    const home = temp();
    expect(loadConfig({ HOME: home }).cacheDbPath).toBe(join(home, '.local/state/gh-dash/gh-dash-cache.db'));
    // Derived paths are native: \data\dash-cache.sqlite on Windows.
    expect(loadConfig({ GH_DASH_DB: '/data/dash.sqlite' }).cacheDbPath).toBe(join('/data', 'dash-cache.sqlite'));
    expect(loadConfig({ GH_DASH_DB: '/data/dash' }).cacheDbPath).toBe(join('/data', 'dash-cache.db'));
    expect(loadConfig({ GH_DASH_DB: ':memory:' }).cacheDbPath).toBe(':memory:');
    expect(loadConfig({ GH_DASH_DB: '/data/a.db', GH_DASH_CACHE_DB: '/tmp/c.db' }).cacheDbPath).toBe('/tmp/c.db');
    expect(() => loadConfig({ GH_DASH_DB: '/data/a.db', GH_DASH_CACHE_DB: '/data/a.db' })).toThrow(/must not be the main database/);
  });

  it('loads a quoted config and gives process variables precedence, including empty strings', async () => {
    const home = temp();
    const env = { HOME: home, PORT: '4789', GH_DASH_PASSWORD: '' };
    const path = file(env, '# config\nPORT=4788\nGH_DASH_PASSWORD="example password"\nGITHUB_TOKEN="synthetic-config-token"\nGH_DASH_SYNC=off\nGH_DASH_MY_EMAILS=Alice@Example.com\nTZ=Pacific/Honolulu\n');
    const loaded = loadEnvironment(env);
    expect(loaded.PORT).toBe('4789');
    expect(loaded.GH_DASH_PASSWORD).toBe('');
    expect(loadConfig(loaded)).toMatchObject({ port: 4789, password: null, syncEnabled: false, myEmails: ['alice@example.com'], defaultTz: 'Pacific/Honolulu' });
    expect(await testTokens(null, { env: loaded }).get()).toMatchObject({ token: 'synthetic-config-token', source: 'env' });
    expect(env).toEqual({ HOME: home, PORT: '4789', GH_DASH_PASSWORD: '' });
    expect(readFileSync(path, 'utf8')).toContain('PORT=4788');
  });

  it('accepts a missing optional file but reports unreadable config', () => {
    const env = { HOME: temp() };
    expect(loadEnvironment(env)).toEqual(env);
    mkdirSync(configFilePath(env), { recursive: true });
    expect(() => loadEnvironment(env)).toThrow();
  });

  it('lets config choose state location and does not expand shell expressions', () => {
    const home = temp();
    const state = join(home, 'custom-state');
    file({ HOME: home }, `XDG_STATE_HOME=${state}\nGH_DASH_PASSWORD='$HOME is literal'\n`);
    const loaded = loadEnvironment({ HOME: home });
    expect(loadConfig(loaded).dbPath).toBe(join(state, 'gh-dash/gh-dash.db'));
    expect(loaded.GH_DASH_PASSWORD).toBe('$HOME is literal');
  });

  it('accepts IANA TZ settings and tolerates process-specific TZ forms', () => {
    expect(loadConfig({ TZ: ':America/New_York' }).defaultTz).toBe('America/New_York');
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    for (const TZ of [':/etc/localtime', 'UTC0', 'not-a-timezone']) {
      expect(loadConfig({ TZ }).defaultTz).toBe(system);
    }
  });

  it('creates the state directory privately and preserves existing directory permissions', () => {
    const home = temp();
    const path = loadConfig({ HOME: home }).dbPath;
    const db = openDb(path);
    db.close();
    // Windows has no file modes (only a read-only bit): nothing to check there.
    if (posix) expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const existing = join(home, 'existing');
    mkdirSync(existing, { mode: 0o750 });
    const mode = statSync(existing).mode;
    const other = openDb(join(existing, 'custom.db'));
    other.close();
    expect(statSync(existing).mode).toBe(mode);
  });
});

describe('config.json layering', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  function json(data: ConfigFile | Record<string, unknown>) {
    const path = join(temp(), 'config.json');
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    return readConfigFile(path);
  }

  it('layers defaults < config.json < environment and records each source', () => {
    const file = json({ host: '0.0.0.0', port: 4790, sync: false, db: '/data/a.db', myEmails: ['A@x.com'], allowedHosts: ['Dash.Example.com.'], timezone: 'Europe/Berlin', password: 'pw' });
    const config = loadConfig({ PORT: '4791', GH_DASH_API_KEY: 'key' }, file);
    expect(config).toMatchObject({
      host: '0.0.0.0', port: 4791, syncEnabled: false, dbPath: '/data/a.db', cacheDbPath: join('/data', 'a-cache.db'), myEmails: ['a@x.com'],
      allowedHosts: ['dash.example.com'], defaultTz: 'Europe/Berlin', password: 'pw', apiKey: 'key', configPath: file.path, warnings: [],
    });
    expect(config.sources).toMatchObject({ host: 'file', port: 'env', sync: 'file', db: 'file', cacheDb: 'default', apiKey: 'env', password: 'file', tokenFile: 'default' });
    // Without a file every setting is a default (or env).
    expect(loadConfig({ GH_DASH_SYNC: 'off' }).sources).toMatchObject({ host: 'default', sync: 'env', timezone: 'default' });
    expect(loadConfig({}).configPath).toBeNull();
  });

  it('lets a set but empty variable override config.json, as it does over the env file', () => {
    const file = json({ password: 'pw', apiKey: 'k', host: '0.0.0.0', db: '/data/a.db' });
    const config = loadConfig({ GH_DASH_PASSWORD: '', GH_DASH_API_KEY: ' ', HOST: '', GH_DASH_DB: '', HOME: '/home/u' }, file);
    expect(config).toMatchObject({ password: null, apiKey: null, host: '127.0.0.1', dbPath: join('/home/u', '.local/state/gh-dash/gh-dash.db') });
    expect(config.sources).toMatchObject({ password: 'env', apiKey: 'env', host: 'env', db: 'env' });
  });

  it('reads token settings and resolves relative paths against the app root in headless mode', () => {
    expect(loadConfig({})).toMatchObject({ tokenChoice: 'auto', tokenFile: null, ghPath: null, desktop: false, listen: true });
    const config = loadConfig({ GITHUB_TOKEN_FILE: 'secrets/token', GH_DASH_TOKEN_SOURCE: 'GH', GH_DASH_GH_PATH: '/opt/gh' }, json({ tokenSource: 'file', db: 'data/x.db' }));
    expect(config).toMatchObject({ tokenChoice: 'gh', tokenFile: join(ROOT, 'secrets/token'), ghPath: '/opt/gh', dbPath: join(ROOT, 'data/x.db') });
    expect(config.sources).toMatchObject({ tokenSource: 'env', tokenFile: 'env', ghPath: 'env', db: 'file' });
    expect(loadConfig({ GH_DASH_TOKEN_SOURCE: '' }).tokenChoice).toBe('auto');
    expect(() => loadConfig({ GH_DASH_TOKEN_SOURCE: 'keychain' })).toThrow(/Invalid GH_DASH_TOKEN_SOURCE: keychain/);
  });

  it('warns about unknown keys, a bad timezone and `listen` on a headless server', () => {
    const file = json({ port: 4790, colour: 'blue', timezone: 'Mars/Olympus', listen: false });
    const config = loadConfig({}, file);
    expect(config.port).toBe(4790);
    expect(config.listen).toBe(true);
    expect(config.warnings).toEqual([
      `${file.path}: unknown key "colour" ignored`,
      expect.stringContaining('listen in'),
      expect.stringMatching(/timezone "Mars\/Olympus" is not an IANA time zone/),
    ]);
  });

  it('finds config.json via GH_DASH_CONFIG or XDG and reads it with the env file in headless mode', () => {
    const home = temp();
    expect(configJsonPath({ HOME: home })).toBe(join(home, '.config/gh-dash/config.json'));
    expect(configJsonPath({ HOME: home, GH_DASH_CONFIG: '/etc/gh-dash/config.json' })).toBe('/etc/gh-dash/config.json');
    expect(configJsonPath({ GH_DASH_CONFIG: 'conf/c.json' })).toBe(join(ROOT, 'conf/c.json'));

    const path = configJsonPath({ HOME: home });
    writeConfigFile(path, { port: 4790, host: '127.0.0.2', tokenFile: '/run/token' });
    file({ HOME: home }, 'PORT=4791\nGITHUB_TOKEN=from-env-file\n');
    const { config, env } = loadServerConfig({ HOME: home, HOST: '127.0.0.3' });
    expect(config).toMatchObject({ port: 4791, host: '127.0.0.3', tokenFile: '/run/token', configPath: path });
    expect(config.sources).toMatchObject({ port: 'env', host: 'env', tokenFile: 'file' });
    expect(env.GITHUB_TOKEN).toBe('from-env-file');
    expect(() => loadServerConfig({ HOME: home, GH_DASH_CONFIG: join(home, 'missing.json') })).not.toThrow();
    writeFileSync(path, '{ nope');
    expect(() => loadServerConfig({ HOME: home })).toThrow(`${path}: invalid JSON`);
    writeFileSync(path, '{"port": "4790"}');
    expect(() => loadServerConfig({ HOME: home })).toThrow(/port: /);
  });

  // Unix file modes; the check is skipped on Windows.
  it.runIf(posix)('warns when a config.json holding secrets is readable by others', () => {
    const home = temp();
    const path = configJsonPath({ HOME: home });
    writeConfigFile(path, { password: 'pw' });
    expect(loadServerConfig({ HOME: home }).config.warnings).toEqual([]);
    chmodSync(path, 0o644);
    expect(loadServerConfig({ HOME: home }).config.warnings).toEqual([expect.stringMatching(/readable by others \(mode 644\)/)]);
  });
});

describe('desktop child mode', () => {
  function desktopEnv(over: NodeJS.ProcessEnv = {}) {
    const dir = temp();
    return { GH_DASH_DESKTOP: '1', GH_DASH_CONFIG: join(dir, 'config.json'), GH_DASH_DATA_DIR: join(dir, 'data'), HOME: dir, ...over };
  }

  it('skips the env file, keeps the database in the data folder and starts with no token choice', () => {
    const env = desktopEnv();
    file(env, 'PORT=4791\nGITHUB_TOKEN=from-env-file\n');
    const { config, env: merged } = loadServerConfig(env);
    expect(config).toMatchObject({
      desktop: true, listen: false, port: 4780, tokenChoice: null, configPath: env.GH_DASH_CONFIG,
      dbPath: join(env.GH_DASH_DATA_DIR, 'gh-dash.db'), cacheDbPath: join(env.GH_DASH_DATA_DIR, 'gh-dash-cache.db'),
    });
    expect(merged.GITHUB_TOKEN).toBeUndefined();
  });

  it('takes listen, host and paths from config.json', () => {
    const env = desktopEnv();
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true, port: 4799, db: '/elsewhere/dash.db', tokenSource: 'gh' });
    expect(loadServerConfig(env).config).toMatchObject({ listen: true, port: 4799, dbPath: '/elsewhere/dash.db', tokenChoice: 'gh' });
    expect(loadConfig({ ...env, GH_DASH_LISTEN: 'off' }, readConfigFile(env.GH_DASH_CONFIG)).listen).toBe(false);
    expect(() => loadConfig({ ...env, GH_DASH_LISTEN: 'maybe' })).toThrow(/Invalid GH_DASH_LISTEN/);
  });

  it('requires absolute paths, its own config.json and a data folder', () => {
    const env = desktopEnv();
    expect(() => loadConfig({ ...env, GH_DASH_DB: 'dash.db' })).toThrow('GH_DASH_DB must be an absolute path: dash.db');
    writeConfigFile(env.GH_DASH_CONFIG, { tokenFile: 'token.txt' });
    expect(() => loadServerConfig(env)).toThrow(`tokenFile in ${env.GH_DASH_CONFIG} must be an absolute path: token.txt`);
    expect(() => loadConfig({ ...env, GH_DASH_GH_PATH: 'gh' })).toThrow(/GH_DASH_GH_PATH must be an absolute path/);
    expect(() => loadServerConfig({ ...env, GH_DASH_CONFIG: '' })).toThrow(/GH_DASH_CONFIG must be an absolute path/);
    expect(() => loadConfig({ ...env, GH_DASH_DATA_DIR: undefined })).toThrow(/GH_DASH_DATA_DIR must be an absolute path/);
    expect(loadConfig({ ...env, GH_DASH_DATA_DIR: undefined, GH_DASH_DB: '/x/y.db' }).dbPath).toBe('/x/y.db');
  });

  it('refuses a Local API reachable from the network without a password', () => {
    const env = desktopEnv({ GH_DASH_LISTEN: 'on' });
    expect(() => loadConfig({ ...env, HOST: '0.0.0.0' })).toThrow(/only with a password/);
    expect(loadConfig({ ...env, HOST: '0.0.0.0', GH_DASH_PASSWORD: 'pw' }).host).toBe('0.0.0.0');
    for (const HOST of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.1.1']) expect(loadConfig({ ...env, HOST }).host).toBe(HOST);
    // Not listening: the address doesn't matter.
    expect(loadConfig({ ...env, GH_DASH_LISTEN: 'off', HOST: '0.0.0.0' }).listen).toBe(false);
  });
});

describe('app root', () => {
  it('walks up to the gh-dash package.json, or takes GH_DASH_ROOT_DIR', () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(rootDir({})).toBe(ROOT);
    expect(findPackageRoot(join(ROOT, 'dist/server'))).toBe(ROOT);
    const app = temp();
    mkdirSync(join(app, 'app.asar/dist/server'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'other' }));
    writeFileSync(join(app, 'app.asar/package.json'), JSON.stringify({ name: 'gh-dash', version: '9.9.9' }));
    expect(findPackageRoot(join(app, 'app.asar/dist/server'))).toBe(join(app, 'app.asar'));
    expect(findPackageRoot(app)).toBeNull();
    const config = loadConfig({ GH_DASH_ROOT_DIR: join(app, 'app.asar') });
    expect(config).toMatchObject({ version: '9.9.9', webDir: join(app, 'app.asar/dist/web') });
    expect(() => loadConfig({ GH_DASH_ROOT_DIR: app + '/nope' })).toThrow(/Can't read the app's .*package\.json/);
  });
});
