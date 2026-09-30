import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFilePath, configJsonPath, findPackageRoot, loadConfig, loadEnvironment, loadServerConfig, rootDir } from './config';
import { configFileSchemaFor, readConfigFile, writeConfigFile, type ConfigFile } from './config-file';
import { openDb } from './db/db';
import { loadSources } from './sources/config';
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

  it("reads the Local API's switches from config.json: both on and tokens required unless it says otherwise", () => {
    const env = desktopEnv();
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true });
    expect(loadServerConfig(env).config).toMatchObject({ listen: true, restApi: true, mcp: true, mcpRequireTokens: true, warnings: [] });
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true, restApi: false, mcp: true, mcpRequireTokens: false });
    expect(loadServerConfig(env).config).toMatchObject({ restApi: false, mcp: true, mcpRequireTokens: false });
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true, mcp: false });
    expect(loadServerConfig(env).config).toMatchObject({ restApi: true, mcp: false });
  });

  it('serves agents alone on 127.0.0.1: without the REST API, the host and its password are set aside', () => {
    const env = desktopEnv();
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true, restApi: false, host: '0.0.0.0' });
    expect(loadServerConfig(env).config).toMatchObject({ host: '127.0.0.1', restApi: false });
  });

  it('requires agent tokens while the port listens beyond this computer, whatever config.json says, and warns', () => {
    const env = desktopEnv();
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true, host: '0.0.0.0', password: 'longenough', mcpRequireTokens: false });
    const { config } = loadServerConfig(env);
    expect(config).toMatchObject({ host: '0.0.0.0', mcpRequireTokens: true });
    expect(config.warnings).toContainEqual(expect.stringMatching(/agents need their tokens/));
    // On this computer, as asked.
    writeConfigFile(env.GH_DASH_CONFIG, { listen: true, host: '127.0.0.1', mcpRequireTokens: false });
    expect(loadServerConfig(env).config.mcpRequireTokens).toBe(false);
  });
});

describe('a headless server and the desktop switches', () => {
  it('serves the REST API and MCP with tokens, and says the switches are ignored', () => {
    const config = loadConfig({ GH_DASH_REST_API: 'off', GH_DASH_MCP: 'off', GH_DASH_MCP_REQUIRE_TOKENS: 'off' });
    expect(config).toMatchObject({ restApi: true, mcp: true, mcpRequireTokens: true });
    expect(config.warnings.filter((w) => /desktop app's/.test(w))).toHaveLength(3);
    expect(loadConfig({})).toMatchObject({ restApi: true, mcp: true, mcpRequireTokens: true });
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

describe('GitLab sources', () => {
  function json(data: ConfigFile | Record<string, unknown>) {
    const path = join(temp(), 'config.json');
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    return path;
  }
  const load = (data: ConfigFile | Record<string, unknown>, env: NodeJS.ProcessEnv = {}) => loadConfig(env, readConfigFile(json(data)));
  const gitlab = (url: string, over: Record<string, unknown> = {}) => ({ kind: 'gitlab', url, ...over });

  it('reads sources from config.json: the host is the identity, the URL keeps its relative root', () => {
    const config = load({ glabPath: '/opt/homebrew/bin/glab', sources: [gitlab(' https://GitLab.Example.com:8443/gitlab/ ', { tokenSource: 'glab' })] });
    expect(config.glabPath).toBe('/opt/homebrew/bin/glab');
    expect(config.sourceConfigs).toEqual([
      { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com:8443/gitlab', tokenChoice: 'glab', tokenFile: null, tokenEnv: 'GITLAB_TOKEN', from: 'file' },
    ]);
    expect(config.sources).toMatchObject({ glabPath: 'file', sources: 'file' });
    expect(loadConfig({})).toMatchObject({ glabPath: null, sourceConfigs: [] });
    expect(loadConfig({}).sources).toMatchObject({ glabPath: 'default', sources: 'default' });
  });

  it('defaults the method to a token file (headless) or nothing chosen (desktop)', () => {
    const headless = load({ sources: [gitlab('https://gitlab.example.com', { tokenFile: '/home/alice/.config/gh-dash/gitlab-token' })] });
    expect(headless.sourceConfigs[0]).toMatchObject({ tokenChoice: 'auto', tokenFile: '/home/alice/.config/gh-dash/gitlab-token' });
    const dir = temp();
    const desktop = load({ sources: [gitlab('https://gitlab.example.com')] }, { GH_DASH_DESKTOP: '1', GH_DASH_DATA_DIR: dir });
    expect(desktop.sourceConfigs[0]).toMatchObject({ tokenChoice: null, tokenFile: null });
    expect(load({ sources: [gitlab('https://gitlab.example.com', { tokenSource: null })] }).sourceConfigs[0]!.tokenChoice).toBeNull();
    // `file` without a file is allowed, and said at startup.
    expect(load({ sources: [gitlab('https://gitlab.example.com', { tokenSource: 'file' })] }).warnings).toEqual([expect.stringMatching(/gitlab\.example\.com uses a token file, but none is set/)]);
  });

  it('gives GITLAB_TOKEN to the only GitLab source; with several, each names its own tokenEnv or has none', () => {
    const several = load({
      sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'WORK_GITLAB_TOKEN' }), gitlab('https://gitlab2.example.com/gitlab'), gitlab('http://gitlab.test', { tokenEnv: 'GITLAB_TOKEN' })],
    });
    expect(several.sourceConfigs.map((s) => [s.host, s.tokenEnv])).toEqual([
      ['gitlab.example.com', 'WORK_GITLAB_TOKEN'],
      ['gitlab2.example.com', null],
      ['gitlab.test', 'GITLAB_TOKEN'],
    ]);
  });

  it('never gives GITLAB_TOKEN to a source by default in the desktop app: only an entry that names it has it', () => {
    const dir = temp();
    const desktop = (data: Record<string, unknown>) => load(data, { GH_DASH_DESKTOP: '1', GH_DASH_DATA_DIR: dir, GITLAB_TOKEN: 'glpat-not-a-real-token' });
    // The only source, as when the app starts with GITLAB_TOKEN set, or after the one that named it was removed.
    expect(desktop({ sources: [gitlab('https://gitlab.example.com', { tokenSource: 'app' })] }).sourceConfigs[0]!.tokenEnv).toBeNull();
    expect(desktop({ sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'GITLAB_TOKEN' })] }).sourceConfigs[0]!.tokenEnv).toBe('GITLAB_TOKEN');
    // Headless keeps the default.
    expect(load({ sources: [gitlab('https://gitlab.example.com', { tokenSource: 'glab' })] }).sourceConfigs[0]!.tokenEnv).toBe('GITLAB_TOKEN');
  });

  it('refuses github.com, other kinds, duplicate hosts and bad URLs, naming the entry', () => {
    const bad = (data: Record<string, unknown>) => {
      const path = json(data);
      return () => readConfigFile(path);
    };
    expect(bad({ sources: [gitlab('https://github.com')] })).toThrow(/sources\.0\.url: github\.com is built in; configure it with tokenSource/);
    expect(bad({ sources: [{ kind: 'github', url: 'https://github.example.com' }] })).toThrow(/sources\.0\.kind/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com'), gitlab('http://GITLAB.example.com:8080/gitlab')] })).toThrow(/sources\.1\.url: gitlab\.example\.com is already sources\[0\]/);
    expect(bad({ sources: [gitlab('ftp://gitlab.example.com')] })).toThrow(/sources\.0\.url: GitLab URL must start with https:\/\/ or http:\/\//);
    expect(bad({ sources: [gitlab('https://alice:secret@gitlab.example.com')] })).toThrow(/must not contain credentials, a query or a fragment/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com/?x=1')] })).toThrow(/must not contain credentials/);
    expect(bad({ sources: [gitlab('not a url')] })).toThrow(/Invalid GitLab URL/);
    expect(bad({ sources: [gitlab('https://[::1]:8443')] })).toThrow(/host must be a host name/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com', { tokenFile: 'token.txt' })] })).toThrow(/sources\.0\.tokenFile: must be an absolute path: token\.txt/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com', { tokenSource: 'gh' })] })).toThrow(/sources\.0\.tokenSource/);
  });

  it('refuses a tokenEnv that holds another secret, or one two sources share', () => {
    const bad = (data: Record<string, unknown>) => {
      const path = json(data);
      return () => readConfigFile(path);
    };
    expect(bad({ sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'GITHUB_TOKEN' })] })).toThrow(/sources\.0\.tokenEnv: GITHUB_TOKEN holds another secret/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'GH_DASH_PASSWORD' })] })).toThrow(/GH_DASH_PASSWORD holds another secret/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'NOT-A-NAME' })] })).toThrow(/must be an environment variable name/);
    expect(bad({ sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'T' }), gitlab('https://gitlab2.example.com', { tokenEnv: 'T' })] })).toThrow(/sources\.1\.tokenEnv: T is already sources\[0\]'s tokenEnv/);
  });

  it("refuses tokenEnv names Windows can't tell apart there, as its credential lookup would give both sources one token", () => {
    const two = { sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'TEAM_TOKEN' }), gitlab('https://gitlab2.example.com', { tokenEnv: 'team_token' })] };
    const win = configFileSchemaFor('win32').safeParse(two);
    expect(win.success).toBe(false);
    expect(win.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['sources.1.tokenEnv', "team_token is already sources[0]'s tokenEnv (TEAM_TOKEN: Windows doesn't tell them apart)"],
    ]);
    // Elsewhere they are two variables.
    expect(configFileSchemaFor('linux').safeParse(two).success).toBe(true);
    expect(configFileSchemaFor('darwin').safeParse(two).success).toBe(true);

    // The final check, after the environment's source takes GITLAB_TOKEN: config.json's gitlab_token is that variable on Windows.
    const file = { path: '/etc/gh-dash/config.json', exists: true, data: { sources: [{ kind: 'gitlab' as const, url: 'https://gitlab.example.com', tokenEnv: 'gitlab_token' }] }, unknownKeys: [] };
    const env = { GH_DASH_GITLAB_URL: 'https://gitlab2.example.com' };
    expect(() => loadSources(env, file, 'win32')).toThrow(
      'GITLAB_TOKEN (the same variable as gitlab_token on Windows) would lock both gitlab.example.com and gitlab2.example.com: give one of them its own tokenEnv',
    );
    expect(loadSources(env, file, 'linux').sources.map((s) => [s.host, s.tokenEnv])).toEqual([['gitlab.example.com', 'gitlab_token'], ['gitlab2.example.com', 'GITLAB_TOKEN']]);
    // Two config.json entries meet the same check.
    expect(() => loadSources({}, { ...file, data: two as ConfigFile }, 'win32')).toThrow(/^team_token \(the same variable as TEAM_TOKEN on Windows\) would lock both/);
  });

  it('warns about unknown keys inside a source, and keeps sources when the desktop app writes config.json', () => {
    const file = readConfigFile(json({ sources: [gitlab('https://gitlab.example.com', { tokenfile: '/x' })] }));
    expect(loadConfig({}, file).warnings).toEqual([`${file.path}: unknown key "sources[0].tokenfile" ignored`]);

    const path = join(temp(), 'config.json');
    const sources = [{ kind: 'gitlab' as const, url: 'https://gitlab.example.com/gitlab', tokenSource: 'app' as const }];
    writeConfigFile(path, { tokenSource: 'gh', glabPath: '/usr/local/bin/glab', sources });
    expect(readConfigFile(path).data).toEqual({ tokenSource: 'gh', glabPath: '/usr/local/bin/glab', sources });
    expect(() => writeConfigFile(path, { sources: [...sources, { kind: 'gitlab', url: 'https://gitlab.example.com' }] })).toThrow(/already sources\[0\]/);
    expect(readConfigFile(path).data.sources).toEqual(sources);
  });

  it('lets the environment declare a source on a headless server, with GITLAB_TOKEN as its lock', () => {
    const config = loadConfig({ GH_DASH_GITLAB_URL: 'http://127.0.0.1:4885/gitlab', GITLAB_TOKEN_FILE: '/run/secrets/gitlab', GH_DASH_GITLAB_TOKEN_SOURCE: 'FILE' });
    expect(config.sourceConfigs).toEqual([
      { kind: 'gitlab', host: '127.0.0.1', baseUrl: 'http://127.0.0.1:4885/gitlab', tokenChoice: 'file', tokenFile: '/run/secrets/gitlab', tokenEnv: 'GITLAB_TOKEN', from: 'env' },
    ]);
    expect(config.sources.sources).toBe('env');
    // Next to config.json's sources: GITLAB_TOKEN is for the one the environment named, not the others.
    const both = load({ sources: [gitlab('https://gitlab.example.com', { tokenSource: 'glab' })] }, { GH_DASH_GITLAB_URL: 'https://gitlab2.example.com' });
    expect(both.sourceConfigs.map((s) => [s.host, s.tokenEnv, s.tokenChoice, s.from])).toEqual([
      ['gitlab.example.com', null, 'glab', 'file'],
      ['gitlab2.example.com', 'GITLAB_TOKEN', 'auto', 'env'],
    ]);
    expect(() => load({ sources: [gitlab('https://gitlab.example.com', { tokenEnv: 'GITLAB_TOKEN' })] }, { GH_DASH_GITLAB_URL: 'https://gitlab2.example.com' }))
      .toThrow('GITLAB_TOKEN would lock both gitlab.example.com and gitlab2.example.com: give one of them its own tokenEnv');
  });

  it('lets the environment override the config.json source on the same host, or the only one', () => {
    const file = { sources: [gitlab('https://gitlab.example.com', { tokenSource: 'glab', tokenEnv: 'WORK_GITLAB_TOKEN' })] };
    const byUrl = load(file, { GH_DASH_GITLAB_URL: 'https://GITLAB.example.com/gitlab', GITLAB_TOKEN_FILE: '/run/t' });
    expect(byUrl.sourceConfigs).toEqual([
      { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com/gitlab', tokenChoice: 'glab', tokenFile: '/run/t', tokenEnv: 'WORK_GITLAB_TOKEN', from: 'env' },
    ]);
    const only = load(file, { GH_DASH_GITLAB_TOKEN_SOURCE: 'file', GITLAB_TOKEN_FILE: '/run/t' });
    expect(only.sourceConfigs[0]).toMatchObject({ baseUrl: 'https://gitlab.example.com', tokenChoice: 'file', tokenFile: '/run/t', from: 'env' });
    // Set but empty: the default, as for every other variable.
    expect(load(file, { GH_DASH_GITLAB_TOKEN_SOURCE: '', GITLAB_TOKEN_FILE: '' }).sourceConfigs[0]).toMatchObject({ tokenChoice: 'auto', tokenFile: null });
    expect(load(file, { GH_DASH_GITLAB_URL: '' }).sourceConfigs[0]).toMatchObject({ from: 'file' });
  });

  it('refuses what the environment says unclearly, and ignores it with nothing to apply to', () => {
    const two = { sources: [gitlab('https://gitlab.example.com'), gitlab('https://gitlab2.example.com')] };
    expect(() => load(two, { GITLAB_TOKEN_FILE: '/run/t' })).toThrow('GITLAB_TOKEN_FILE applies to one GitLab source, and 2 are configured: set GH_DASH_GITLAB_URL to say which');
    expect(loadConfig({ GITLAB_TOKEN_FILE: '/run/t' }).warnings).toEqual(['GITLAB_TOKEN_FILE is ignored: no GitLab source is configured (set GH_DASH_GITLAB_URL)']);
    expect(loadConfig({ GITLAB_TOKEN: 'glpat-not-a-real-token' })).toMatchObject({ sourceConfigs: [], warnings: [] });
    expect(() => loadConfig({ GH_DASH_GITLAB_URL: 'gitlab.example.com' })).toThrow(/Invalid GH_DASH_GITLAB_URL: Invalid GitLab URL/);
    expect(() => loadConfig({ GH_DASH_GITLAB_URL: 'https://github.com' })).toThrow(/Invalid GH_DASH_GITLAB_URL: github\.com is built in/);
    expect(() => loadConfig({ GH_DASH_GITLAB_URL: 'https://gitlab.example.com', GH_DASH_GITLAB_TOKEN_SOURCE: 'app' })).toThrow('Invalid GH_DASH_GITLAB_TOKEN_SOURCE: app (expected glab, file)');
    expect(() => loadConfig({ GH_DASH_GITLAB_URL: 'https://gitlab.example.com', GITLAB_TOKEN_FILE: 'token' })).toThrow('GITLAB_TOKEN_FILE must be an absolute path: token');
  });

  it("takes the desktop app's sources from config.json alone, with an absolute glabPath", () => {
    const dir = temp();
    const env = { GH_DASH_DESKTOP: '1', GH_DASH_DATA_DIR: dir, GH_DASH_GITLAB_URL: 'https://gitlab2.example.com', GITLAB_TOKEN_FILE: '/run/t' };
    const config = load({ sources: [gitlab('https://gitlab.example.com', { tokenSource: 'app' })] }, env);
    expect(config.sourceConfigs).toEqual([
      { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com', tokenChoice: 'app', tokenFile: null, tokenEnv: null, from: 'file' },
    ]);
    expect(() => load({ glabPath: 'glab' }, env)).toThrow(/glabPath in .*config\.json must be an absolute path: glab/);
    expect(() => loadConfig({ ...env, GH_DASH_GLAB_PATH: 'glab' })).toThrow('GH_DASH_GLAB_PATH must be an absolute path: glab');
    // Headless, a bare name is found on PATH like ghPath's; env (even empty) beats config.json.
    expect(load({ glabPath: '/opt/glab' }, { GH_DASH_GLAB_PATH: '' })).toMatchObject({ glabPath: null });
    expect(load({ glabPath: '/opt/glab' }, { GH_DASH_GLAB_PATH: 'glab' }).sources.glabPath).toBe('env');
  });
});
