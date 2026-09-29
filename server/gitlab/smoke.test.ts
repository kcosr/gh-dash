import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeInstance } from '../test/gitlab-instance';
import { BASE } from '../test/gitlab';
import { glabToken, main, parseArgs, restTemplate, type Exec } from './smoke';

const TOKEN = 'glpat-SmokeTestToken123';
const ENV = { GITLAB_URL: BASE, GITLAB_TOKEN: TOKEN };

async function run(argv: string[] = [], opts: { env?: Record<string, string>; over?: Parameters<typeof fakeInstance>[0]; exec?: Exec } = {}) {
  const fake = fakeInstance(opts.over);
  const lines: string[] = [];
  const code = await main(argv, { ...ENV, ...opts.env }, { out: (l) => lines.push(l), fetchImpl: fake.fetchImpl, exec: opts.exec, build: 'test' });
  return { code, text: lines.join('\n'), fake };
}

/** Strings from the fixtures that must never reach the default (shareable) output. */
const PRIVATE = ['alice', 'corp.tools', 'Fix login flow', 'Login broken', 'src/login.ts', 'login.ts', 'example.com', 'Bob', 'Retry logins', 'gitlab.example.com'];

describe('gitlab smoke: arguments', () => {
  it('takes the token from the environment only, and needs the URL', () => {
    expect(parseArgs(['--token', TOKEN], ENV)).toMatch(/never from the command line/);
    expect(parseArgs(['--private-token=x'], ENV)).toMatch(/never from the command line/);
    expect(parseArgs([], { GITLAB_TOKEN: TOKEN })).toMatch(/GITLAB_URL/);
    expect(parseArgs([], { GITLAB_URL: BASE })).toMatch(/GITLAB_TOKEN/);
    expect(parseArgs(['--mr', 'x'], ENV)).toMatch(/--mr/);
    expect(parseArgs(['--what'], ENV)).toMatch(/Unknown option/);
    expect(parseArgs(['--project', 'g/p', '--mr', '5', '--record', 'out', '--verbose'], ENV)).toEqual({
      baseUrl: BASE, token: TOKEN, project: 'g/p', mr: 5, record: 'out', verbose: true, glab: null,
    });
  });

  it('finds glab from --glab <path>, else GLAB_PATH, else PATH; either one is enough without GITLAB_TOKEN', () => {
    expect(parseArgs(['--glab', './glab', '--verbose'], { GITLAB_URL: BASE })).toMatchObject({ glab: './glab', token: null, verbose: true });
    expect(parseArgs(['--glab'], { GITLAB_URL: BASE, GLAB_PATH: '/opt/bin/glab' })).toMatchObject({ glab: '/opt/bin/glab' });
    expect(parseArgs(['--glab', '--verbose'], { GITLAB_URL: BASE })).toMatchObject({ glab: 'glab', verbose: true });
    expect(parseArgs([], { GITLAB_URL: BASE, GLAB_PATH: '/opt/bin/glab' })).toMatchObject({ glab: '/opt/bin/glab' });
  });

  it('prints usage without echoing anything from the environment', async () => {
    const { code, text } = await run(['--token', TOKEN]);
    expect(code).toBe(2);
    expect(text).toContain('usage:');
    expect(text).not.toContain(TOKEN);
  });

  it('reduces API paths to templates', () => {
    expect(restTemplate('/projects/alice%2Fapp/merge_requests/7/versions/103')).toBe('/projects/:project/merge_requests/:iid/versions/:version');
    expect(restTemplate('/projects/11/repository/files/src%2Flogin%2Ets/raw')).toBe('/projects/:project/repository/files/:path/raw');
  });
});

describe('gitlab smoke: a run against the fake instance', () => {
  it('passes every step, and says nothing private', async () => {
    const { code, text } = await run();
    expect(text).toMatch(/Summary: 18 passed, 0 failed, 0 skipped/);
    expect(code).toBe(0);
    for (const name of ['instance', 'token', 'viewer', 'owned projects', 'project', 'probes', 'round commits', 'round stars', 'recheck', 'prRevision', 'prFiles', 'blob', 'commit diff']) {
      expect(text).toMatch(new RegExp(`\\d+ ${name}\\s+PASS`));
    }
    expect(text).toContain('GitLab 19.3.3-ee (EE)');
    expect(text).toContain('relative root: /gitlab');
    expect(text).toContain('project#1 (your most recently pushed project)');
    expect(text).toContain('scopes: read_api');
    expect(text).toMatch(/GraphQL MergeRequests/);
    expect(text).toMatch(/GET \/projects\/:project\/merge_requests\/:iid\/versions\/:version/);
    for (const p of [TOKEN, ...PRIVATE]) expect(text).not.toContain(p);
  });

  it('reports mapping findings without failing on what GitLab legitimately leaves out', async () => {
    const { text } = await run();
    // The fixture diff has binary, over-limit and rename-only files.
    expect(text).toMatch(/file\(s\) without a patch/);
    expect(text).toMatch(/an MR without a head SHA/);
  });

  it('shows a project given with --project as given', async () => {
    const { text, code } = await run(['--project', 'alice/app']);
    expect(code).toBe(0);
    expect(text).toContain('alice/app (--project)');
    expect(text).not.toContain('corp.tools');
  });

  it('carries on past a failure, scrubbed, and exits 1', async () => {
    const { code, text } = await run([], {
      over: { '/api/v4/projects/11/starrers': { status: 500, body: { message: `boom for alice/app with ${TOKEN}` } } },
    });
    expect(code).toBe(1);
    expect(text).toMatch(/round stars\s+FAIL/);
    expect(text).toMatch(/kind transient/);
    expect(text).toMatch(/recheck\s+PASS/);
    expect(text).toMatch(/Summary: 17 passed, 1 failed, 0 skipped \(failed: round stars\)/);
    for (const p of [TOKEN, ...PRIVATE]) expect(text).not.toContain(p);
  });

  it('skips what depends on a missing project', async () => {
    const { code, text } = await run(['--project', 'group/gone']);
    expect(code).toBe(1);
    expect(text).toMatch(/project\s+FAIL/);
    expect(text).toMatch(/round prs\s+SKIP\s+no project/);
    expect(text).toMatch(/commit diff\s+SKIP/);
  });

  it('shows real values with --verbose, marked as private, and still never the token', async () => {
    const { text } = await run(['--verbose']);
    expect(text).toContain('VERBOSE');
    expect(text).toContain('Fix login flow');
    expect(text).toContain('alice/app');
    expect(text).not.toContain(TOKEN);
  });

  it('records raw responses with a review note, never the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-smoke-'));
    try {
      const { text } = await run(['--record', dir], {
        over: { '/api/v4/personal_access_tokens/self': { body: { name: 'x', scopes: ['read_api'], active: true, expires_at: null, echo: TOKEN } } },
      });
      expect(text).toContain('RECORDING');
      const files = readdirSync(dir);
      expect(files).toContain('README-REVIEW-BEFORE-SHARING.txt');
      expect(files.filter((f) => f.endsWith('.json')).length).toBeGreaterThan(15);
      const all = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
      expect(all).toContain('Fix login flow');
      expect(all).toContain('[token]');
      expect(all).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitlab smoke: glab', () => {
  const GLAB_TOKEN = 'glpat-FromGlabKeyring999';
  const host = 'gitlab.example.com';
  /** `glab auth status` as glab 1.119 prints it: the token in the OS keyring, and a second host it isn't logged in to. */
  const status = (token = '**************************') =>
    `${host}\n  ✓ Logged in to ${host} as alice (/home/alice/.config/glab-cli/config.yml)\n` +
    `  ✓ Git operations for ${host} configured to use https protocol.\n  ✓ API calls for ${host} are made over https protocol.\n` +
    `  ✓ REST API Endpoint: ${BASE}/api/v4/\n  ✓ GraphQL API Endpoint: ${BASE}/api/graphql/\n` +
    `  ✓ Token found in operating system keyring: ${token}\n` +
    'gitlab.com\n  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}\n' +
    '  ✓ API calls for gitlab.com are made over https protocol.\n  ! No token found (checked config file, keyring, and environment variables).\n';
  const HELP_1119 = 'Usage:\n  glab auth status [flags]\n\nFlags:\n  -h, --hostname string   Check a specific instance\'s authentication status.\n  -t, --show-token        Display the authentication token.\n';

  /** A fake glab answering by its full argument list (unknown ones fail like glab does); records how it was run. */
  const fakeGlab = (answers: Record<string, { code?: number | string; stdout?: string; stderr?: string }>) => {
    const runs: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      runs.push({ cmd, args, env: opts.env });
      const a = answers[args.join(' ')] ?? { code: 1, stderr: `Error: unknown command "${args[1]}" for "glab ${args[0]}"` };
      return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    };
    return { exec, runs };
  };
  /** glab 1.119: token only in the keyring, shown by `auth status --show-token`. */
  const keyringGlab = () =>
    fakeGlab({
      '--version': { stdout: 'glab 1.119.0 (2026-09-01)\n' },
      [`config get token --host ${host}`]: { stdout: '\n' },
      'auth status --help': { stdout: HELP_1119 },
      [`auth status --hostname ${host} --show-token`]: { stderr: status(GLAB_TOKEN).split('gitlab.com\n')[0] },
      'auth status': { code: 1, stderr: status() },
    });

  it('reads a keyring token through auth status --show-token, without token variables, and runs with it', async () => {
    const glab = keyringGlab();
    const { code, text } = await run(['--glab', './glab'], { env: { GITLAB_TOKEN: '', GLAB_TOKEN: 'x', OAUTH_TOKEN: 'y' }, exec: glab.exec });
    expect(code).toBe(0);
    expect(text).toMatch(/glab\s+PASS\s+glab 1\.119\.0 · via glab auth status --show-token · scopes: read_api · expires: 2027-01-31 · active: true · the run uses this token/);
    expect(text).toContain('glab config get token: empty');
    expect(text).toContain('<host> · logged in: yes · token in: OS keyring · API over https · REST endpoint matches GITLAB_URL · GraphQL endpoint matches GITLAB_URL');
    expect(text).toContain('host#1 · logged in: no · token in: none');
    expect(text).toContain("lacks the api scope");
    expect(glab.runs.map((r) => [r.cmd, r.args.join(' ')])).toEqual([
      ['./glab', '--version'],
      ['./glab', `config get token --host ${host}`],
      ['./glab', 'auth status --help'],
      ['./glab', `auth status --hostname ${host} --show-token`],
      ['./glab', 'auth status'],
    ]);
    for (const r of glab.runs) expect(Object.keys(r.env).filter((k) => /TOKEN/.test(k))).toEqual([]);
    for (const p of [GLAB_TOKEN, 'gitlab.com', 'alice', '.config']) expect(text).not.toContain(p);
  });

  it('uses a token kept in the config file without asking auth status to show it', async () => {
    const glab = fakeGlab({ '--version': { stdout: 'glab version 1.119.0\n' }, [`config get token --host ${host}`]: { stdout: `${GLAB_TOKEN}\n` }, 'auth status': { stderr: status() } });
    const { text } = await run(['--glab'], { env: { GITLAB_TOKEN: '' }, exec: glab.exec });
    expect(text).toContain('via glab config get token');
    expect(glab.runs.some((r) => r.args.includes('--show-token'))).toBe(false);
    expect(text).not.toContain(GLAB_TOKEN);
  });

  it('says so when this glab has no --show-token, and compares tokens with GITLAB_TOKEN by hash only', async () => {
    const old = fakeGlab({ '--version': { stdout: 'glab 1.40.0' }, [`config get token --host ${host}`]: { stdout: '' }, 'auth status --help': { stdout: 'Usage: glab auth status' }, 'auth status': { stderr: status() } });
    const oldRun = await run(['--glab'], { exec: old.exec });
    expect(oldRun.text).toContain('this glab has no --show-token');
    expect(oldRun.text).toMatch(/glab\s+FAIL/);

    const same = fakeGlab({ '--version': { stdout: 'glab 1.119.0' }, [`config get token --host ${host}`]: { stdout: TOKEN }, 'auth status': { stderr: status() } });
    expect((await run(['--glab'], { exec: same.exec })).text).toContain('same token as GITLAB_TOKEN');
    const other = keyringGlab();
    const otherRun = await run(['--glab'], { exec: other.exec, over: { '/api/v4/personal_access_tokens/self': { status: 400, body: { message: '400 Bad request - This endpoint requires token type to be a personal access token' } } } });
    expect(otherRun.text).toContain('a different token from GITLAB_TOKEN (the run uses GITLAB_TOKEN)');
    expect(otherRun.text).toContain('not a PAT (GitLab answers 400 for OAuth tokens)');
    for (const t of [oldRun.text, otherRun.text]) for (const p of [TOKEN, GLAB_TOKEN]) expect(t).not.toContain(p);
  });

  it('reports a missing glab, and has no token to run with then', async () => {
    const noGlab = await run(['--glab'], { env: { GITLAB_TOKEN: '' }, exec: async () => ({ code: 'ENOENT', stdout: '', stderr: '' }) });
    expect(noGlab.code).toBe(1);
    expect(noGlab.text).toContain('glab not found');
    expect(noGlab.text).toContain('No token to run with');
    expect(await glabToken('glab', host, {}, keyringGlab().exec, () => {})).toMatchObject({ version: '1.119.0', token: GLAB_TOKEN });
  });
});
