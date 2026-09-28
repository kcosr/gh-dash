import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFilePath, loadConfig, loadEnvironment, resolveToken } from './config';
import { openDb } from './db/db';

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

  it('loads a quoted config and gives process variables precedence, including empty strings', () => {
    const home = temp();
    const env = { HOME: home, PORT: '4789', GH_DASH_PASSWORD: '' };
    const path = file(env, '# config\nPORT=4788\nGH_DASH_PASSWORD="example password"\nGITHUB_TOKEN="synthetic-config-token"\nGH_DASH_SYNC=off\nGH_DASH_MY_EMAILS=Alice@Example.com\nTZ=Pacific/Honolulu\n');
    const loaded = loadEnvironment(env);
    expect(loaded.PORT).toBe('4789');
    expect(loaded.GH_DASH_PASSWORD).toBe('');
    expect(loadConfig(loaded)).toMatchObject({ port: 4789, password: null, syncEnabled: false, myEmails: ['alice@example.com'], defaultTz: 'Pacific/Honolulu' });
    expect(resolveToken(loaded)).toEqual({ token: 'synthetic-config-token', source: 'env' });
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
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const existing = join(home, 'existing');
    mkdirSync(existing, { mode: 0o750 });
    const mode = statSync(existing).mode;
    const other = openDb(join(existing, 'custom.db'));
    other.close();
    expect(statSync(existing).mode).toBe(mode);
  });
});
