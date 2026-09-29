import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeInstance, smokeOps } from '../test/gitlab-instance';
import mergeRequestsFixture from '../test/fixtures/gitlab/merge-requests.json';
import ownedFixture from '../test/fixtures/gitlab/owned-projects.json';
import { BASE, graphqlErrors, page, type Handler, type Reply } from '../test/gitlab';
import { Check, checkTokenInfo, glabToken, linkCommits, main, parseArgs, restTemplate, type Exec, type MergedMr } from './smoke';

const TOKEN = 'glpat-SmokeTestToken123';
const ENV = { GITLAB_URL: BASE, GITLAB_TOKEN: TOKEN };

async function run(argv: string[] = [], opts: { env?: Record<string, string>; over?: Parameters<typeof fakeInstance>[0]; ops?: Parameters<typeof fakeInstance>[2]; exec?: Exec } = {}) {
  const fake = fakeInstance(opts.over, BASE, opts.ops);
  const lines: string[] = [];
  const code = await main(argv, { ...ENV, ...opts.env }, { out: (l) => lines.push(l), fetchImpl: fake.fetchImpl, exec: opts.exec, build: 'test', sleep: async () => {} });
  return { code, text: lines.join('\n'), fake };
}

/** One step's report: its result line and the ! and ~ lines under it. */
function block(text: string, name: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*\\d+ ${name}\\s+(PASS|FAIL|SKIP)`).test(l));
  if (at < 0) throw new Error(`no step "${name}" in the report`);
  const out = [lines[at]!];
  for (let i = at + 1; /^ {6}[!~] /.test(lines[i] ?? ''); i++) out.push(lines[i]!);
  return out.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
/** A variant of one of the smoke tool's fake GraphQL operations, its data edited by `edit`. */
const mutate = (op: string, edit: (data: Data, vars: Record<string, unknown>) => void): NonNullable<Parameters<typeof fakeInstance>[2]> => ({
  [op]: (vars) => {
    const data = structuredClone(smokeOps()[op]!(vars)) as Data;
    edit(data, vars);
    return data;
  },
});

/** Strings from the fixtures that must never reach the default (shareable) output. */
const PRIVATE = ['alice', 'corp.tools', 'Fix login flow', 'Login broken', 'src/login.ts', 'login.ts', 'example.com', 'Bob', 'Retry logins', 'gitlab.example.com', 'platform', 'svc', 'noreply', 'Work.Example'];

describe('gitlab smoke: arguments', () => {
  it('takes the token from the environment only, and needs the URL', () => {
    expect(parseArgs(['--token', TOKEN], ENV)).toMatch(/never from the command line/);
    expect(parseArgs(['--private-token=x'], ENV)).toMatch(/never from the command line/);
    expect(parseArgs([], { GITLAB_TOKEN: TOKEN })).toMatch(/GITLAB_URL/);
    expect(parseArgs([], { GITLAB_URL: BASE })).toMatch(/GITLAB_TOKEN/);
    expect(parseArgs(['--mr', 'x'], ENV)).toMatch(/--mr/);
    expect(parseArgs(['--what'], ENV)).toMatch(/Unknown option/);
    expect(parseArgs(['--project', 'g/p', '--mr', '5', '--record', 'out', '--verbose'], ENV)).toEqual({
      baseUrl: BASE, token: TOKEN, project: 'g/p', mr: 5, record: 'out', verbose: true, glab: null, pool: 3,
    });
  });

  it('takes the size of the concurrency check from --pool, 1 to 10', () => {
    expect(parseArgs(['--pool', '6'], ENV)).toMatchObject({ pool: 6 });
    for (const bad of ['0', '11', 'x', '2.5']) expect(parseArgs(['--pool', bad], ENV)).toMatch(/--pool needs a number from 1 to 10/);
    expect(parseArgs(['--pool'], ENV)).toMatch(/--pool needs a value/);
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
    expect(text).toMatch(/Summary: 26 passed, 0 failed, 0 skipped/);
    expect(code).toBe(0);
    const steps = ['instance', 'token', 'viewer', 'owned projects', 'project', 'probes', 'round commits', 'round stars', 'recheck', 'prRevision', 'prFiles', 'blob', 'commit diff'];
    for (const name of [...steps, 'validation query', 'projects by ids', 'candidates', 'lookup', 'lookup group', 'permissions', 'merge shas', 'concurrency']) {
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
    // The concurrency check reads stars too, so it meets the same 500s.
    expect(text).toMatch(/Summary: 24 passed, 2 failed, 0 skipped \(failed: round stars, concurrency\)/);
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
      // Then the same questions for a host glab has never seen.
      ['./glab', '--version'],
      ['./glab', 'config get token --host unknown.invalid'],
      ['./glab', 'auth status --help'],
      ['./glab', 'auth status --hostname unknown.invalid --show-token'],
      ['./glab', 'auth status'],
    ]);
    expect(text).toMatch(/glab other host\s+PASS\s+unknown\.invalid: glab has no token for it, as wanted/);
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

describe('gitlab smoke: glab and a host it is not logged in to', () => {
  const host = 'gitlab.example.com';
  const STRAY = 'glpat-StrayGlobalToken000';
  /** glab that has a token for `host` in its config file and, when `stray`, also hands a token out for any host. */
  const glabWith = (stray: boolean): Exec => async (_cmd, args) => {
    const a = args.join(' ');
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (a === '--version') return ok('glab 1.119.0\n');
    if (a === `config get token --host ${host}`) return ok(`${TOKEN}\n`);
    if (a === 'config get token --host unknown.invalid') return stray ? ok(`${STRAY}\n`) : ok('\n');
    if (a === 'auth status') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unknown command' };
  };

  it('passes when glab has nothing for it', async () => {
    const { text } = await run(['--glab'], { exec: glabWith(false) });
    expect(block(text, 'glab other host')).toMatch(/PASS\s+unknown\.invalid: glab has no token for it, as wanted/);
  });

  it('fails when glab hands out a token for it (a global token), and never prints that token', async () => {
    const { code, text } = await run(['--glab'], { exec: glabWith(true) });
    expect(code).toBe(1);
    expect(block(text, 'glab other host')).toMatch(/FAIL\s+unknown\.invalid: glab handed out a token/);
    expect(text).toMatch(/! glab gave a token for unknown\.invalid, a host it isn't logged in to \(a global token\?\): the resolver must check the host/);
    expect(text).not.toContain(STRAY);
  });

  it('is skipped when glab did not run, or was not asked for', async () => {
    const none = await run(['--glab'], { exec: async () => ({ code: 'ENOENT', stdout: '', stderr: '' }), env: { GITLAB_TOKEN: TOKEN } });
    expect(block(none.text, 'glab other host')).toMatch(/SKIP\s+glab did not run/);
    expect(await run()).toMatchObject({ text: expect.not.stringContaining('glab other host') });
  });
});

describe('gitlab smoke: the integration wave\'s checks', () => {
  it('sends the candidates query as the Add dialog will', async () => {
    const { fake } = await run();
    const listing = fake.calls.filter((c) => c.url.pathname.endsWith('/api/v4/projects'));
    expect(listing).toHaveLength(1);
    expect(Object.fromEntries(listing[0]!.url.searchParams)).toEqual({ membership: 'true', archived: 'false', simple: 'true', order_by: 'last_activity_at', sort: 'desc', per_page: '100', page: '1' });
  });

  it('keeps the new documents read-only and the output shareable', async () => {
    const { text, fake } = await run();
    expect(fake.requests.filter((r) => r.startsWith('graphql Smoke')).sort()).toEqual([
      'graphql SmokeLookup',
      'graphql SmokeLookup',
      'graphql SmokeLookup',
      'graphql SmokeMergedMrs',
      'graphql SmokePermissions',
      'graphql SmokeProjectsByIds',
      'graphql SmokeProjectsByIds',
      'graphql SmokeMeta',
      'graphql SmokeValidate',
    ].sort());
    // Every GraphQL document is a query, and REST is only ever read.
    for (const call of fake.calls) {
      if (call.method === 'POST') expect((call.body as { query: string }).query.trimStart()).toMatch(/^query\b/);
      else expect(call.method).toBe('GET');
    }
    expect(text).toContain('3 distinct address(es)');
    expect(text).toContain('your address on 2 of the project\'s 2 commits');
    expect(text).not.toContain('@');
    for (const p of [TOKEN, ...PRIVATE]) expect(text).not.toContain(p);
  });

  it('prints the token page for the user to open, with the real address only in verbose mode', async () => {
    const shareable = await run();
    expect(shareable.text).toContain('  <gitlab>/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api');
    const verbose = await run(['--verbose']);
    expect(verbose.text).toContain(`  ${BASE}/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api`);
    expect(verbose.text).toContain('alice@example.com');
  });

  it('lists each kind of request once, with a median and slowest for repeats, and how many ran at once', async () => {
    const { text } = await run();
    expect(text).toMatch(/Requests: \d+ · most at once: \d+ · rate limit/);
    expect(text).toMatch(/200 {2}GraphQL MergeRequests {2}\(x\d+, slowest \d+ ms\)/);
    expect(text).toMatch(/200 {2}GraphQL SmokeValidate\n/);
  });

  it('records the new requests too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-smoke-'));
    try {
      await run(['--record', dir]);
      const files = readdirSync(dir);
      for (const op of ['SmokeValidate', 'SmokeProjectsByIds', 'SmokeLookup', 'SmokePermissions', 'SmokeMergedMrs']) expect(files.some((f) => f.includes(op))).toBe(true);
      expect(files.some((f) => f.endsWith('GET-projects.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('token', () => {
    it('shows whether Settings would warn that the token can write', async () => {
      const scopes = (s: string[]) => ({ '/api/v4/personal_access_tokens/self': { body: { name: 'x', scopes: s, active: true, expires_at: '2027-01-31' } } });
      expect(block((await run([], { over: scopes(['read_api']) })).text, 'token')).toContain('no write scope (no warning)');
      expect(block((await run([], { over: scopes(['api', 'read_user']) })).text, 'token')).toContain('Settings would warn: can change things (api)');
      expect(block((await run([], { over: scopes(['read_api', 'write_repository']) })).text, 'token')).toContain('(write_repository)');
      const check = new Check();
      expect(checkTokenInfo(check, { scopes: ['read_api'], expiresAt: null })).toBe('no write scope (no warning)');
      expect(check.problems.size).toBe(0);
    });

    it('fails when expires_at is not a plain date', async () => {
      const { text } = await run([], { over: { '/api/v4/personal_access_tokens/self': { body: { name: 'x', scopes: ['read_api'], active: true, expires_at: '2027-01-31T00:00:00.000Z' } } } });
      expect(block(text, 'token')).toMatch(/FAIL[^]*! expires_at is not a plain date \(YYYY-MM-DD\)/);
    });

    it('notes a token without the glpat- prefix', async () => {
      const { text } = await run([], { env: { GITLAB_TOKEN: 'plain-token-value' } });
      expect(block(text, 'token')).toMatch(/PASS[^]*~ the token does not start with glpat-/);
    });
  });

  describe('validation query (viewer emails, instance, personal count)', () => {
    const cases: [string, ReturnType<typeof mutate>, RegExp][] = [
      ['commitEmail left out', mutate('SmokeValidate', (d) => delete d.currentUser.commitEmail), /currentUser\.commitEmail is missing from the response/],
      ['publicEmail left out', mutate('SmokeValidate', (d) => delete d.currentUser.publicEmail), /currentUser\.publicEmail is missing from the response/],
      ['emails left out', mutate('SmokeValidate', (d) => delete d.currentUser.emails), /currentUser\.emails is missing from the response/],
      [
        'no address anywhere',
        mutate('SmokeValidate', (d) => Object.assign(d.currentUser, { publicEmail: null, commitEmail: null, emails: { nodes: [] } })),
        /no address from publicEmail, commitEmail or emails: "me" on GitLab commits would need myEmails/,
      ],
      ['an email that is not an address', mutate('SmokeValidate', (d) => (d.currentUser.emails.nodes[0].email = 'nope')), /an email is not an address/],
      ['metadata left out', mutate('SmokeValidate', (d) => delete d.metadata), /metadata is missing from the response/],
      ['a version that is not one', mutate('SmokeValidate', (d) => (d.metadata.version = 'next')), /metadata has no version like 19\.3\.3/],
      ['the count left out', mutate('SmokeValidate', (d) => delete d.projects), /projects\(personal: true\) is missing from the response/],
      ['a count that disagrees with the listing', mutate('SmokeValidate', (d) => (d.projects.count = 7)), /projects\(personal: true\)\.count is 7, but 2 projects were listed/],
      ['another user than the viewer', mutate('SmokeValidate', (d) => (d.currentUser.username = 'bob')), /another user than the viewer step found/],
      ['no user', mutate('SmokeValidate', (d) => (d.currentUser = null)), /currentUser is null/],
    ];
    it.each(cases)('fails, saying what, when %s', async (_why, ops, expected) => {
      const { code, text } = await run([], { ops });
      expect(block(text, 'validation query')).toMatch(/FAIL/);
      expect(block(text, 'validation query')).toMatch(expected);
      expect(text).toMatch(/Summary: 25 passed, 1 failed, 0 skipped \(failed: validation query\)/);
      expect(code).toBe(1);
      for (const p of [TOKEN, ...PRIVATE]) expect(text).not.toContain(p);
    });

    it('shows GitLab\'s own message when the schema has no such field, and the rest of the run carries on', async () => {
      const { text } = await run([], { ops: { SmokeValidate: () => graphqlErrors("Field 'commitEmail' doesn't exist on type 'UserCore'") } });
      expect(block(text, 'validation query')).toMatch(/FAIL[^]*kind graphql[^]*Field 'commitEmail' doesn't exist on type 'UserCore'/);
      expect(block(text, 'lookup')).toMatch(/PASS/);
    });

    it('takes an unlisted emails connection as a note when the other addresses are there', async () => {
      const { text } = await run([], { ops: mutate('SmokeValidate', (d) => (d.currentUser.emails = null)) });
      expect(block(text, 'validation query')).toMatch(/PASS[^]*emails not listed[^]*~ currentUser\.emails is null/);
    });

    it('notes when none of the project\'s commits carries one of the addresses', async () => {
      const { text } = await run([], { ops: mutate('SmokeValidate', (d) => Object.assign(d.currentUser, { publicEmail: 'x@example.org', commitEmail: null, emails: { nodes: [] } })) });
      expect(block(text, 'validation query')).toMatch(/PASS[^]*~ none of the project's 2 commits carries one of these addresses/);
    });
  });

  describe('projects(ids:)', () => {
    const cases: [string, ReturnType<typeof mutate>, RegExp][] = [
      ['a project is not returned', mutate('SmokeProjectsByIds', (d) => d.projects.nodes.pop()), /1 of 2 requested project\(s\) not returned/],
      ['a project comes back twice', mutate('SmokeProjectsByIds', (d) => d.projects.nodes.push(d.projects.nodes[0])), /a project came back twice/],
      ['a project that was not asked for comes back', mutate('SmokeProjectsByIds', (d) => (d.projects.nodes[0].id = 'gid://gitlab/Project/999')), /a project that was not asked for came back/],
      ['visibility is in capitals', mutate('SmokeProjectsByIds', (d) => (d.projects.nodes[0].visibility = 'PUBLIC')), /visibility is not exactly public, internal or private/],
      ['visibility is null', mutate('SmokeProjectsByIds', (d) => (d.projects.nodes[0].visibility = null)), /visibility is null/],
      ['the connection is null', mutate('SmokeProjectsByIds', (d) => (d.projects = null)), /projects\(ids:\) is null/],
      ['a probe field is left out', mutate('SmokeProjectsByIds', (d) => delete d.projects.nodes[0].latestReleases), /project\.latestReleases is missing from the response/],
      ['a project field is left out', mutate('SmokeProjectsByIds', (d) => delete d.projects.nodes[1].starCount), /project\.starCount is missing from the response/],
    ];
    it.each(cases)('fails when %s', async (_why, ops, expected) => {
      const { text } = await run([], { ops });
      expect(block(text, 'projects by ids')).toMatch(/FAIL/);
      expect(block(text, 'projects by ids')).toMatch(expected);
    });

    it('fails when an id that does not exist makes GitLab fail the whole request', async () => {
      const { text } = await run([], {
        ops: { SmokeProjectsByIds: (v) => ((v.ids as string[]).includes('gid://gitlab/Project/2147483000') ? graphqlErrors('Could not find Project 2147483000') : smokeOps().SmokeProjectsByIds!(v)) },
      });
      expect(block(text, 'projects by ids')).toMatch(/FAIL[^]*a project id that does not exist made projects\(ids:\) fail, which would lose its whole chunk: Could not find Project/);
    });

    it('fails when the missing id comes back as something', async () => {
      const { text } = await run([], { ops: mutate('SmokeProjectsByIds', (d, v) => (v.ids as string[]).length === 2 && d.projects.nodes.push({ ...d.projects.nodes[0], id: 'gid://gitlab/Project/2147483000' })) });
      expect(block(text, 'projects by ids')).toMatch(/did not return exactly the project that exists/);
    });

    it('sends at most 25 ids per request, one of them the chosen project', async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({ ...structuredClone(smokeOps().SmokeProjectsByIds!({ ids: ['gid://gitlab/Project/11'], first: 1 }) as Data).projects.nodes[0], id: `gid://gitlab/Project/${100 + i}`, path: `p${i}`, fullPath: `alice/p${i}` }));
      const owned = { currentUser: ownedFixture.currentUser, projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: many } };
      const ops = {
        OwnedProjects: () => owned,
        Project: (v: Record<string, unknown>) => ({ currentUser: ownedFixture.currentUser, project: many.find((m) => m.fullPath === v.path) ?? null }),
        SmokeProjectsByIds: (v: Record<string, unknown>) => ({ projects: { nodes: (v.ids as string[]).map((id) => ({ ...many[0], id })) } }),
      };
      const { fake } = await run(['--project', 'alice/p0'], { ops });
      const asked = fake.calls.filter((c) => (c.body as { query?: string } | null)?.query?.includes('query SmokeProjectsByIds'));
      const first = (asked[0]!.body as { variables: { ids: string[]; first: number } }).variables;
      expect(first.ids).toHaveLength(25);
      expect(first.first).toBe(25);
    });
  });

  describe('candidates (REST projects listing)', () => {
    const listing = (items: unknown[], extra: Record<string, string> = {}): Record<string, Handler> => ({ '/api/v4/projects': page(items, null, extra) });
    const item = (over: Record<string, unknown> = {}) => ({
      id: 21,
      path_with_namespace: 'platform/team/svc',
      web_url: 'https://gitlab.example.com/gitlab/platform/team/svc',
      last_activity_at: '2026-09-25T09:00:00.000Z',
      namespace: { kind: 'group', full_path: 'platform/team' },
      ...over,
    });
    const personal = item({ id: 11, path_with_namespace: 'alice/app', namespace: { kind: 'user', full_path: 'alice' } });

    it('passes on the default listing and remembers a group project', async () => {
      const { text } = await run();
      expect(block(text, 'candidates')).toMatch(/PASS\s+6 listed in 1 request\(s\) \(X-Total 6\) · in your namespace 1 · in groups 4 · in other users' namespaces 1/);
    });

    const cases: [string, Record<string, Handler>, RegExp][] = [
      ['a project has no namespace', listing([personal, item({ namespace: undefined })]), /namespace\.kind \(user or group\) or namespace\.full_path is missing/],
      ['a namespace has another kind', listing([personal, item({ namespace: { kind: 'organization', full_path: 'platform/team' } })]), /namespace\.kind/],
      ['the path does not start with its namespace', listing([personal, item({ namespace: { kind: 'group', full_path: 'other' } })]), /path_with_namespace does not start with the namespace path/],
      ['a path has no namespace', listing([personal, item({ path_with_namespace: 'svc' })]), /path_with_namespace is missing, or has no namespace/],
      ['an id is not a number', listing([personal, item({ id: 'x' })]), /a project id is not a number/],
      ['a URL is not absolute', listing([personal, item({ web_url: '/x' })]), /web_url is not absolute/],
      ['a time is not a time', listing([personal, item({ last_activity_at: null })]), /last_activity_at is not a time/],
      ['the order is not newest first', listing([item(), personal].map((x, i) => ({ ...x, last_activity_at: i ? '2026-10-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z' }))), /candidates by last_activity_at not newest first/],
      ['X-Total disagrees', listing([personal, item()], { 'x-total': '9' }), /2 projects listed, but X-Total says 9/],
      ['your personal projects are missing', listing([item()]), /your 1 non-archived personal projects and the 0 in your namespace in this listing differ: 1 missing here, 0 not personal \(a project pending deletion can do this\)/],
      ['a personal project the listing has is not one of yours', listing([personal, item({ id: 99, path_with_namespace: 'alice/ghost' })].map((x) => ({ ...x, namespace: { kind: 'user', full_path: 'alice' } }))), /0 missing here, 1 not personal/],
      ['GitLab answers with an error', { '/api/v4/projects': { status: 500, body: { message: 'boom' } } }, /kind transient/],
    ];
    it.each(cases)('fails when %s', async (_why, over, expected) => {
      const { text } = await run([], { over });
      expect(block(text, 'candidates')).toMatch(/FAIL/);
      expect(block(text, 'candidates')).toMatch(expected);
    });

    it('notes X-Total being left out, and passes', async () => {
      const { text } = await run([], { over: listing([personal, item()]) });
      expect(block(text, 'candidates')).toMatch(/PASS[^]*~ GitLab sent no X-Total/);
    });

    it('stops at 1000 projects (ten pages) and says the listing is truncated', async () => {
      const over: Record<string, Handler> = {
        '/api/v4/projects': (req) => {
          const n = Number(req.url.searchParams.get('page'));
          return page(Array.from({ length: 100 }, (_, i) => item({ id: 1000 + n * 100 + i, path_with_namespace: `platform/team/p${n}-${i}` })), n + 1, { 'x-total': '5000' });
        },
      };
      const { text, fake } = await run([], { over });
      expect(block(text, 'candidates')).toMatch(/PASS\s+1000 listed in 10 request\(s\) \(X-Total 5000\)[^]*~ the listing stops at 1000 projects/);
      expect(fake.calls.filter((c) => c.url.pathname.endsWith('/api/v4/projects'))).toHaveLength(10);
    });

    it('skips the group lookup when there is no group project', async () => {
      const { text } = await run([], { over: listing([personal]) });
      expect(block(text, 'lookup group')).toMatch(/SKIP\s+no group project among the candidates/);
      const failed = await run([], { over: { '/api/v4/projects': { status: 500, body: {} } } });
      expect(block(failed.text, 'lookup group')).toMatch(/SKIP\s+no candidates/);
    });
  });

  describe('lookup', () => {
    it('passes, with the permission fields and counts', async () => {
      const { text } = await run();
      expect(block(text, 'lookup')).toMatch(/PASS\s+project#1 · downloadCode true · readMergeRequest true · issuesEnabled true · since \d{4}-\d\d-\d\d: MRs 4, issues 2 · releases 3 · a missing project answers null/);
      expect(block(text, 'lookup group')).toMatch(/PASS\s+project#3 \(first group project in the candidates\) · owned: no \(namespace is not yours\) · downloadCode true/);
    });

    const cases: [string, ReturnType<typeof mutate>, RegExp][] = [
      ['readMergeRequest is left out', mutate('SmokeLookup', (d) => delete d.project.userPermissions.readMergeRequest), /userPermissions\.readMergeRequest is missing from the response/],
      ['downloadCode is not true/false', mutate('SmokeLookup', (d) => (d.project.userPermissions.downloadCode = 'yes')), /userPermissions\.downloadCode is not true\/false \(it is string\)/],
      ['userPermissions is left out', mutate('SmokeLookup', (d) => delete d.project.userPermissions), /userPermissions is missing from the response/],
      ['userPermissions is null', mutate('SmokeLookup', (d) => (d.project.userPermissions = null)), /userPermissions is null/],
      ['issuesEnabled is left out', mutate('SmokeLookup', (d) => delete d.project.issuesEnabled), /issuesEnabled is missing from the response/],
      ['issuesEnabled is null', mutate('SmokeLookup', (d) => (d.project.issuesEnabled = null)), /issuesEnabled is not true\/false \(it is null\)/],
      ['the merge request count is left out', mutate('SmokeLookup', (d) => delete d.project.mergeRequestsSince), /mergeRequests\(updatedAfter:\) is missing from the response/],
      ['the issue count is null', mutate('SmokeLookup', (d) => (d.project.issuesSince = null)), /issues\(updatedAfter:, types: \[ISSUE\]\) is null \(the token can't read it\)/],
      ['the release count is negative', mutate('SmokeLookup', (d) => (d.project.releaseTotal.count = -1)), /releases\.count is not a non-negative integer/],
      ['the issue count disagrees with a complete listing', mutate('SmokeLookup', (d) => (d.project.issuesSince.count = 9)), /issues\(updatedAfter:\) counts 9, but the complete listing has 2/],
      ['the merge request count is below what is listed', mutate('SmokeLookup', (d) => (d.project.mergeRequestsSince.count = 0)), /mergeRequests\(updatedAfter:\) counts 0, fewer than the 4 already listed/],
      ['the release count is below what is listed', mutate('SmokeLookup', (d) => (d.project.releaseTotal.count = 1)), /releases counts 1, fewer than the 2 already listed/],
      ['the project is null', mutate('SmokeLookup', (d) => (d.project = null)), /project is null for a project that exists and that the token can see/],
      ['the token may not read its own project\'s code', mutate('SmokeLookup', (d, v) => v.path === 'alice/app' && (d.project.userPermissions.downloadCode = false)), /userPermissions says the token cannot read the code or merge requests of a project it just listed/],
      ['another project comes back', mutate('SmokeLookup', (d, v) => v.path === 'alice/app' && (d.project.id = 'gid://gitlab/Project/12')), /another project came back/],
      ['a probe field is left out', mutate('SmokeLookup', (d) => delete d.project.openMergeRequests), /project\.openMergeRequests is missing from the response/],
      ['a project field is left out', mutate('SmokeLookup', (d) => delete d.project.visibility), /project\.visibility is missing from the response/],
      ['currentUser is another user', mutate('SmokeLookup', (d) => (d.currentUser.username = 'bob')), /currentUser is not the user the viewer step found/],
      ['currentUser is null', mutate('SmokeLookup', (d) => (d.currentUser = null)), /currentUser is null/],
    ];
    it.each(cases)('fails when %s', async (_why, ops, expected) => {
      const { text } = await run([], { ops });
      const lookup = block(text, 'lookup');
      expect(lookup.split('\n')[0]).toMatch(/FAIL|PASS/);
      expect(lookup).toMatch(/FAIL/);
      expect(lookup).toMatch(expected);
    });

    it('holds a complete merge request listing to the exact count', async () => {
      const complete: NonNullable<Parameters<typeof fakeInstance>[2]> = {
        MergeRequests: (v) => {
          const data = structuredClone(mergeRequestsFixture);
          data.project.mergeRequests.pageInfo.hasNextPage = false;
          data.project.mergeRequests.nodes = data.project.mergeRequests.nodes.filter((m) => v.state === 'all' || m.state === v.state);
          return data;
        },
      };
      expect(block((await run([], { ops: complete })).text, 'lookup')).toMatch(/PASS/);
      const off = await run([], { ops: { ...complete, ...mutate('SmokeLookup', (d) => (d.project.mergeRequestsSince.count = 9)) } });
      expect(block(off.text, 'lookup')).toMatch(/FAIL[^]*mergeRequests\(updatedAfter:\) counts 9, but the complete listing has 4/);
    });

    it('fails on the lookup of a group project with the same rules', async () => {
      const { text } = await run([], { ops: mutate('SmokeLookup', (d, v) => v.path === 'platform/team/svc' && delete d.project.userPermissions.readMergeRequest) });
      expect(block(text, 'lookup group')).toMatch(/FAIL[^]*userPermissions\.readMergeRequest is missing from the response/);
      expect(block(text, 'lookup')).toMatch(/PASS/);
    });

    it('shows GitLab\'s message when a field is not in the schema, for both lookups', async () => {
      const { text } = await run([], { ops: { SmokeLookup: () => graphqlErrors("Field 'readMergeRequest' doesn't exist on type 'ProjectPermissions'") } });
      for (const step of ['lookup', 'lookup group']) expect(block(text, step)).toMatch(/FAIL[^]*kind graphql[^]*Field 'readMergeRequest' doesn't exist on type 'ProjectPermissions'/);
      expect(text).toMatch(/failed: lookup, lookup group\)/);
    });

    it('fails when a project that does not exist errors, or comes back', async () => {
      const gone = (v: Record<string, unknown>) => v.path === 'smoke-check-no-such-group/no-such-project';
      const errors = await run([], { ops: { SmokeLookup: (v) => (gone(v) ? graphqlErrors('Project not found') : smokeOps().SmokeLookup!(v)) } });
      expect(block(errors.text, 'lookup')).toMatch(/FAIL[^]*a project that does not exist made the lookup fail instead of answering null: Project not found/);
      const found = await run([], { ops: { SmokeLookup: (v) => smokeOps().SmokeLookup!(gone(v) ? { ...v, path: 'alice/app' } : v) } });
      expect(block(found.text, 'lookup')).toMatch(/FAIL[^]*a project that does not exist came back/);
    });

    it('fails when "owned = your namespace" would misjudge a project of yours', async () => {
      const elsewhere = structuredClone(ownedFixture);
      elsewhere.projects.nodes[1]!.namespace.fullPath = 'bob';
      const { text } = await run([], { ops: { OwnedProjects: () => elsewhere } });
      expect(block(text, 'lookup')).toMatch(/FAIL[^]*1 of your 2 personal projects are not in a namespace named like your username, so "owned = your namespace" would misjudge them/);
    });
  });

  describe('permissions', () => {
    it('counts the false values over the member projects', async () => {
      const { text } = await run();
      expect(block(text, 'permissions')).toMatch(/PASS\s+3 of 3 member projects · downloadCode false 1 · readMergeRequest false 1 · issues disabled 1/);
      expect(block(text, 'permissions')).not.toContain('~');
    });

    it('notes when no project shows a false permission, so the classification was not exercised', async () => {
      const { text } = await run([], { ops: mutate('SmokePermissions', (d) => d.projects.nodes.forEach((n: Data) => Object.assign(n, { userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: true }))) });
      expect(block(text, 'permissions')).toMatch(/PASS[^]*~ every project grants everything/);
    });

    const cases: [string, ReturnType<typeof mutate>, RegExp][] = [
      ['downloadCode is left out', mutate('SmokePermissions', (d) => delete d.projects.nodes[0].userPermissions.downloadCode), /userPermissions\.downloadCode is missing from the response/],
      ['readMergeRequest is not true/false', mutate('SmokePermissions', (d) => (d.projects.nodes[0].userPermissions.readMergeRequest = 1)), /userPermissions\.readMergeRequest is not true\/false \(it is number\)/],
      ['userPermissions is left out', mutate('SmokePermissions', (d) => delete d.projects.nodes[1].userPermissions), /userPermissions is missing from the response/],
      ['issuesEnabled is left out', mutate('SmokePermissions', (d) => delete d.projects.nodes[2].issuesEnabled), /issuesEnabled is missing from the response/],
      ['the count is below the projects listed', mutate('SmokePermissions', (d) => (d.projects.count = 1)), /count is not a number, or is below the projects listed/],
      ['the connection is null', mutate('SmokePermissions', (d) => (d.projects = null)), /projects\(membership: true\) is null/],
    ];
    it.each(cases)('fails when %s', async (_why, ops, expected) => {
      const { text } = await run([], { ops });
      expect(block(text, 'permissions')).toMatch(/FAIL/);
      expect(block(text, 'permissions')).toMatch(expected);
    });
  });

  describe('merge commit SHAs', () => {
    it('links the commits page to the merged MRs by SHA', async () => {
      const { text } = await run();
      expect(block(text, 'merge shas')).toMatch(
        /PASS\s+3 merged MRs · merge SHA on 2 · none 1 · commits page 2: linked by merge SHA 1, by listed MR commits 1, not linked 0 · recent default-branch MRs linkable 2 of 2/,
      );
    });

    const cases: [string, ReturnType<typeof mutate>, RegExp][] = [
      ['mergeCommitSha is left out', mutate('SmokeMergedMrs', (d) => delete d.project.mergeRequests.nodes[0].mergeCommitSha), /merge request\.mergeCommitSha is missing from the response/],
      ['a merge SHA is not a SHA', mutate('SmokeMergedMrs', (d) => (d.project.mergeRequests.nodes[1].mergeCommitSha = 'HEAD')), /a merge commit SHA is not a SHA/],
      ['a merge SHA is abbreviated', mutate('SmokeMergedMrs', (d) => (d.project.mergeRequests.nodes[1].mergeCommitSha = '3333333')), /a merge commit SHA is not a SHA/],
      ['an MR that is not merged comes back', mutate('SmokeMergedMrs', (d) => (d.project.mergeRequests.nodes[0].state = 'opened')), /a merge request that is not merged came back/],
      ['the connection is null', mutate('SmokeMergedMrs', (d) => (d.project.mergeRequests = null)), /project\.mergeRequests is null/],
      [
        'no SHA leads to a commit on the page',
        mutate('SmokeMergedMrs', (d) =>
          d.project.mergeRequests.nodes.forEach((n: Data) => Object.assign(n, { mergeCommitSha: n.mergeCommitSha && '9'.repeat(40), commits: { nodes: [{ sha: '8'.repeat(40) }] } })),
        ),
        /none of the 2 MRs merged into the default branch within the commits page can be linked to a commit on it: Activity would show their commits as direct pushes/,
      ],
    ];
    it.each(cases)('fails when %s', async (_why, ops, expected) => {
      const { text } = await run([], { ops });
      expect(block(text, 'merge shas')).toMatch(/FAIL/);
      expect(block(text, 'merge shas')).toMatch(expected);
    });

    it('links through the MR\'s listed commits when it has no merge SHA (fast-forward or squash), and notes it', async () => {
      const ff = mutate('SmokeMergedMrs', (d) =>
        d.project.mergeRequests.nodes.forEach((n: Data) => Object.assign(n, { mergeCommitSha: null, commits: { nodes: [{ sha: n.iid === '6' ? '4'.repeat(40) : '3'.repeat(40) }] } })),
      );
      const { text } = await run([], { ops: ff });
      expect(block(text, 'merge shas')).toMatch(/PASS[^]*merge SHA on 0 · none 3[^]*by listed MR commits 2, not linked 0[^]*~ no merged MR has a mergeCommitSha/);
    });

    it('notes a recent MR that has no commit on the page, without failing while another links', async () => {
      const { text } = await run([], { ops: mutate('SmokeMergedMrs', (d) => (d.project.mergeRequests.nodes[0].commits = { nodes: [{ sha: '9'.repeat(40) }] })) });
      expect(block(text, 'merge shas')).toMatch(/PASS[^]*~ 1 of 2 recent default-branch MRs have no commit on the page to link to/);
    });

    it('is skipped when the project has no merged MRs, and when it is an empty repository', async () => {
      const none = await run([], { ops: mutate('SmokeMergedMrs', (d) => (d.project.mergeRequests.nodes = [])) });
      expect(block(none.text, 'merge shas')).toMatch(/SKIP\s+no merged merge requests in this project \(pass --project with one that has some\)/);
      expect(none.code).toBe(0);
    });

    it('links in memory as the SQL of the design does', () => {
      const mr = (over: Partial<MergedMr>): MergedMr => ({ iid: '1', state: 'merged', mergedAt: null, targetBranch: 'main', mergeCommitSha: null, diffHeadSha: null, commits: null, ...over });
      const linked = linkCommits(['a', 'b', 'c', 'd', 'e'], [mr({ mergeCommitSha: 'a' }), mr({ commits: { nodes: [{ sha: 'c' }, { sha: 'a' }] } })]);
      expect(linked).toEqual({ merge: 1, listed: 1, none: 3 });
    });
  });

  describe('concurrency under the pool', () => {
    it('runs the pool of rounds at once and reports the load', async () => {
      const { text, fake } = await run();
      expect(block(text, 'concurrency')).toMatch(
        /PASS\s+3 rounds at once \(1 project\(s\), 7 sections each\) · 21 requests · peak in flight \d+ · wall \d+(\.\d s| ms) vs \d+(\.\d s| ms) for one round alone \(x\d+\.\d\) · request ms: median \d+, p95 \d+, max \d+ · throttled or failed 0/,
      );
      expect(block(text, 'concurrency')).toContain('~ only 1 project(s) of your own to use, so some rounds ran on the same project');
      // One round alone (7 requests), then the pool's three (21).
      expect(fake.requests.filter((r) => r.startsWith('/api/v4/projects/11/starrers'))).toHaveLength(1 + 1 + 3);
    });

    it('takes the pool size from --pool', async () => {
      const { text } = await run(['--pool', '5']);
      expect(block(text, 'concurrency')).toMatch(/PASS\s+5 rounds at once \(1 project\(s\), 7 sections each\) · 35 requests/);
    });

    it('uses distinct projects of your own when there are enough', async () => {
      const three = structuredClone(ownedFixture);
      for (const [i, n] of three.projects.nodes.entries()) Object.assign(n, { archived: false, repository: { ...n.repository, rootRef: 'main' }, id: `gid://gitlab/Project/${11 + i}` });
      three.projects.nodes.push({ ...structuredClone(three.projects.nodes[0]!), id: 'gid://gitlab/Project/13', path: 'c', fullPath: 'alice/c' });
      const { text } = await run(['--pool', '2'], {
        ops: { OwnedProjects: () => three },
        over: { '/api/v4/projects/12/issues': { body: [], headers: { 'x-next-page': '' } }, '/api/v4/projects/12/repository/commits': { body: [], headers: { 'x-next-page': '' } }, '/api/v4/projects/12/starrers': { body: [], headers: { 'x-next-page': '' } } },
      });
      expect(block(text, 'concurrency')).not.toContain('only 1 project');
    });

    it('fails, naming the statuses, when the instance throttles or errors under the pool', async () => {
      let n = 0;
      const throttled: Record<string, Handler> = {
        // The issues listings before the concurrency check answer; the ones in it are throttled.
        '/api/v4/projects/11/issues': (): Reply => (++n > 4 ? { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Retry later' } } : { body: [], headers: { 'x-next-page': '' } }),
      };
      const { code, text } = await run([], { over: throttled });
      expect(code).toBe(1);
      expect(block(text, 'concurrency')).toMatch(/FAIL[^]*! \d+ of \d+ request\(s\) were throttled or failed with 3 rounds at once \(429 x\d+\): the pool for GitLab should be smaller/);
      expect(block(text, 'concurrency')).toMatch(/! round \d of 3 failed \(kind (rate-limit|transient)/);
    });

    it('fails on server errors under the pool but only notes a round a project refuses for its own reasons', async () => {
      const off = await run([], { over: { '/api/v4/projects/11/issues': { status: 403, body: { message: '403 Forbidden' } } } });
      expect(block(off.text, 'concurrency')).toMatch(/PASS[^]*~ round 1 of 3 failed \(kind http, status 403\)[^]*~ \d+ request\(s\) answered 403 x\d+/);
      const broken = await run([], { over: { '/api/v4/projects/11/issues': { status: 502, body: {} } } });
      expect(block(broken.text, 'concurrency')).toMatch(/FAIL[^]*\(502 x\d+\)/);
    });

    it('is skipped without a project of your own with commits', async () => {
      const empty = structuredClone(ownedFixture);
      for (const n of empty.projects.nodes) n.repository = { rootRef: null as unknown as string, tree: null as never };
      const { text } = await run([], { ops: { OwnedProjects: () => empty } });
      expect(block(text, 'concurrency')).toMatch(/SKIP\s+no non-archived project with commits among your own/);
    });
  });
});
