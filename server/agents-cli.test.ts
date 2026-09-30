import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentsCommand } from './agents-cli';
import { principalForToken } from './db/agents';
import { openDb } from './db/db';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghd-agents-'));
  // A home of its own: no env file or config.json of the machine's is read.
  env = { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), GH_DASH_DB: join(dir, 'dash.db') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentsCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const tokenIn = (text: string) => /Token \(shown once, keep it somewhere safe\): (ghd_[A-Za-z0-9_-]{43})$/m.exec(text)?.[1];
const principal = (token: string) => {
  const db = openDb(join(dir, 'dash.db'));
  try {
    return principalForToken(db, token);
  } finally {
    db.close();
  }
};

describe('gh-dash agents', () => {
  it('adds an agent, printing its token once with where to connect', async () => {
    const { code, out, err } = await run('add', 'Claude');
    expect([code, err]).toEqual([0, '']);
    expect(out).toContain('Added agent Claude (id 2).');
    expect(out).toContain('MCP server: http://127.0.0.1:4780/mcp');
    expect(out).toContain('claude mcp add -s user --transport http gh-dash http://127.0.0.1:4780/mcp --header "Authorization: Bearer <token>"');
    const token = tokenIn(out)!;
    expect(out.split(token)).toHaveLength(2);
    expect(principal(token)).toEqual({ id: 2, kind: 'agent', name: 'Claude' });
  });

  it("names the server's own address, from the environment or config.json like the server", async () => {
    env.PORT = '4841';
    expect((await run('add', 'A')).out).toContain('MCP server: http://127.0.0.1:4841/mcp');
    mkdirSync(join(dir, 'config', 'gh-dash'), { recursive: true });
    writeFileSync(join(dir, 'config', 'gh-dash', 'config.json'), JSON.stringify({ host: '0.0.0.0', port: 4900 }));
    delete env.PORT;
    expect((await run('add', 'B')).out).toContain('MCP server: http://127.0.0.1:4900/mcp');
    // The same database either way.
    expect((await run('list')).out).toMatch(/^2 +A +ghd_/m);
  });

  it('lists agents without their tokens', async () => {
    expect((await run('list')).out).toBe('No agents yet. Add one: gh-dash agents add <name>');
    const token = tokenIn((await run('add', 'Claude')).out)!;
    await run('add', 'Codex');
    await run('revoke', 'codex');
    const { code, out } = await run('list');
    expect(code).toBe(0);
    expect(out).not.toContain(token);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID +NAME +TOKEN +CREATED +LAST USED +STATUS$/);
    expect(lines[1]).toMatch(new RegExp(`^2 +Claude +${token.slice(0, 8)}… +\\S+ +never +active$`));
    expect(lines[2]).toMatch(/^3 +Codex +- +\S+ +never +revoked \S+$/);
  });

  it('regenerates a token by id or name: the old one stops working', async () => {
    const first = tokenIn((await run('add', 'Claude')).out)!;
    const { code, out } = await run('regenerate', 'claude');
    expect(code).toBe(0);
    expect(out).toContain('New token for Claude (id 2); the old one no longer works.');
    const second = tokenIn(out)!;
    expect(principal(first)).toBeNull();
    expect(principal(second)).toMatchObject({ id: 2 });
    const third = tokenIn((await run('regenerate', '2')).out)!;
    expect(principal(second)).toBeNull();
    expect(principal(third)).toMatchObject({ id: 2 });
  });

  it('revokes by id or name, once', async () => {
    const token = tokenIn((await run('add', 'Claude')).out)!;
    expect(await run('revoke', '2')).toEqual({ code: 0, out: 'Revoked Claude (id 2); its comments stay.', err: '' });
    expect(principal(token)).toBeNull();
    expect((await run('revoke', 'Claude')).out).toBe('Claude (id 2) was already revoked.');
  });

  it('says what went wrong: unknown agents, taken or bad names (1); usage (2)', async () => {
    await run('add', 'Claude');
    expect(await run('add', 'claude')).toMatchObject({ code: 1, err: 'gh-dash: There is already an agent called Claude (id 2); regenerate its token instead' });
    expect(await run('add', 'You')).toMatchObject({ code: 1, err: expect.stringContaining('"You" is the dashboard user') });
    expect(await run('revoke', 'nobody')).toMatchObject({ code: 1, err: 'gh-dash: No agent is called or numbered nobody (see: gh-dash agents list)' });
    expect(await run('regenerate', '1')).toMatchObject({ code: 1, err: expect.stringContaining('No agent is called or numbered 1') });
    for (const args of [[], ['add'], ['add', 'a', 'b'], ['add', '  '], ['add', '--help'], ['add', '-h'], ['revoke', '--help'], ['revoke'], ['list', 'x'], ['remove', 'Claude']]) {
      const res = await run(...args);
      expect([args, res.code, res.out]).toEqual([args, 2, '']);
      expect(res.err).toContain('Usage: gh-dash agents <command>');
    }
    expect(await run('--help')).toMatchObject({ code: 0, out: expect.stringContaining('Usage: gh-dash agents <command>'), err: '' });
    expect((await run('list')).out).not.toContain('--help');
  });

  it('reports a config it cannot read', async () => {
    mkdirSync(join(dir, 'config', 'gh-dash'), { recursive: true });
    writeFileSync(join(dir, 'config', 'gh-dash', 'config.json'), '{ nope');
    expect(await run('list')).toMatchObject({ code: 1, err: expect.stringMatching(/^gh-dash: .*config\.json/) });
  });
});
