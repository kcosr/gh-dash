import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../shared/api';
import { runAgentsCommand } from './agents-cli';
import { agentForToken, agentSourceIds, principalForToken } from './db/agents';
import { addComment, createThread, getPrincipal, getThread, SELF_PRINCIPAL_ID, setThreadStatus } from './db/comments';
import { type Db, openDb } from './db/db';
import { ensureSource, removeSource } from './db/sources';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghd-agents-'));
  // A home of its own: no env file or config.json of the machine's is read.
  env = { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), GH_DASH_DB: join(dir, 'dash.db') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(...args: string[]) {
  return runWith(null, ...args);
}
/** With `stdin` piped in (null: none, and reading it would fail). */
async function runWith(stdin: string | null, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const read = async () => {
    if (stdin === null) throw new Error('stdin was read');
    return stdin;
  };
  const code = await runAgentsCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l), env, stdin: read });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const tokenIn = (text: string) => /Token \(shown once, keep it somewhere safe\): (ghd_[A-Za-z0-9_-]{43})$/m.exec(text)?.[1];
/** `fn` on the database the command uses, closed after. */
const withDb = <T>(fn: (db: Db) => T): T => {
  const db = openDb(join(dir, 'dash.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const principal = (token: string) => withDb((db) => principalForToken(db, token));

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
    const codex = tokenIn((await run('add', 'Codex')).out)!;
    await run('disable', 'codex');
    const { code, out } = await run('list');
    expect(code).toBe(0);
    expect(out).not.toContain(token);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID +NAME +TOKEN +CREATED +LAST USED +STATUS +SOURCES$/);
    expect(lines[1]).toMatch(new RegExp(`^2 +Claude +${token.slice(0, 8)}… +\\S+ +never +active +all$`));
    // A disabled agent's token is kept: its prefix still tells it apart.
    expect(lines[2]).toMatch(new RegExp(`^3 +Codex +${codex.slice(0, 8)}… +\\S+ +never +disabled \\S+ +all$`));
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

  it('disables and enables by id or name, keeping the token: the same one works again', async () => {
    const token = tokenIn((await run('add', 'Claude')).out)!;
    expect(await run('disable', '2')).toEqual({ code: 0, out: 'Disabled Claude (id 2): its token is refused until you enable it again. Its comments stay.', err: '' });
    expect(principal(token)).toBeNull();
    expect(withDb((db) => agentForToken(db, token))).toMatchObject({ disabled: true });
    expect((await run('disable', 'Claude')).out).toBe('Claude (id 2) was already disabled.');
    expect(await run('enable', 'claude')).toEqual({ code: 0, out: 'Enabled Claude (id 2): its token works again.', err: '' });
    expect(principal(token)).toEqual({ id: 2, kind: 'agent', name: 'Claude' });
    expect((await run('enable', '2')).out).toBe('Claude (id 2) is already enabled.');
    // A new token enables a disabled agent too.
    await run('disable', 'Claude');
    const next = tokenIn((await run('regenerate', 'Claude')).out)!;
    expect(principal(next)).toMatchObject({ id: 2 });
    expect((await run('list')).out).toMatch(/^2 +Claude +ghd_\S+… +\S+ +\S+ +active +all$/m);
  });

  it('takes revoke as disable, for the scripts that use it', async () => {
    const token = tokenIn((await run('add', 'Claude')).out)!;
    expect(await run('revoke', 'Claude')).toEqual({ code: 0, out: 'Disabled Claude (id 2): its token is refused until you enable it again. Its comments stay.', err: '' });
    expect(principal(token)).toBeNull();
    expect((await run('revoke', '2')).out).toBe('Claude (id 2) was already disabled.');
    await run('enable', 'Claude');
    expect(principal(token)).toMatchObject({ id: 2 });
  });

  it('says what went wrong: unknown agents, taken or bad names (1); usage (2)', async () => {
    await run('add', 'Claude');
    expect(await run('add', 'claude')).toMatchObject({ code: 1, err: 'gh-dash: There is already an agent called Claude (id 2); regenerate its token instead' });
    expect(await run('add', 'You')).toMatchObject({ code: 1, err: expect.stringContaining('"You" is the dashboard user') });
    expect(await run('add', 'Deleted agent #7')).toMatchObject({ code: 1, err: 'gh-dash: Names like "Deleted agent #7" are kept for deleted agents; give yours another name' });
    for (const command of ['disable', 'enable', 'revoke', 'delete']) {
      expect(await run(command, 'nobody')).toMatchObject({ code: 1, err: 'gh-dash: No agent is called or numbered nobody (see: gh-dash agents list)' });
    }
    expect(await run('regenerate', '1')).toMatchObject({ code: 1, err: expect.stringContaining('No agent is called or numbered 1') });
    for (const args of [
      [], ['add'], ['add', 'a', 'b'], ['add', '  '], ['add', '--help'], ['add', '-h'], ['revoke', '--help'], ['revoke'], ['disable'], ['enable', 'a', 'b'],
      ['delete'], ['delete', '--yes'], ['delete', 'Claude', 'Codex'], ['list', 'x'], ['remove', 'Claude'], ['disable', 'Claude', '--yes'], ['add', 'X', '--yes'],
    ]) {
      const res = await run(...args);
      expect([args, res.code, res.out]).toEqual([args, 2, '']);
      expect(res.err).toContain('Usage: gh-dash agents <command>');
    }
    expect(await run('--help')).toMatchObject({ code: 0, out: expect.stringContaining('Usage: gh-dash agents <command>'), err: '' });
    expect((await run('list')).out).not.toContain('--help');
  });

  it('takes a token of your own from stdin (--token-stdin), never from the command line', async () => {
    const mine = 'my-own-agent-token-0123456789';
    const { code, out } = await runWith(`${mine}\nignored second line\n`, 'add', 'Claude', '--token-stdin');
    expect(code).toBe(0);
    expect(out).toContain(`Token (shown once, keep it somewhere safe): ${mine}`);
    expect(principal(mine)).toMatchObject({ id: 2, name: 'Claude' });
    expect((await run('list')).out).toMatch(/^2 +Claude +my-o… /m);
    const next = 'another-token-of-mine-98765';
    expect((await runWith(`${next}\r\n`, 'regenerate', 'claude', '--token-stdin')).code).toBe(0);
    expect(principal(mine)).toBeNull();
    expect(principal(next)).toMatchObject({ id: 2 });
    // Checked, and never another agent's.
    expect(await runWith('short\n', 'add', 'Codex', '--token-stdin')).toMatchObject({ code: 1, err: expect.stringContaining('24 to 256') });
    expect(await runWith(`${next}\n`, 'add', 'Codex', '--token-stdin')).toMatchObject({ code: 1, err: "gh-dash: That token is already another agent's" });
    expect(await runWith('', 'add', 'Codex', '--token-stdin')).toMatchObject({ code: 1, err: 'gh-dash: --token-stdin: no token on stdin' });
    // Not on the command line, and only with add or regenerate.
    for (const args of [['add', 'Codex', '--token', mine], ['add', 'Codex', `--token=${mine}`], ['list', '--token-stdin'], ['revoke', 'claude', '--token-stdin'], ['delete', 'claude', '--token-stdin']]) {
      const res = await run(...args);
      expect([args, res.code]).toEqual([args, 2]);
      expect(res.err).not.toContain(`${mine} `);
    }
    expect((await run('add', 'Codex', '--token', mine)).err).toContain('Never put a token on the command line');
    // Without the flag, stdin isn't read at all.
    expect((await run('add', 'Codex')).code).toBe(0);
  });

  it('shows the built-in agent in the list, once it has written, without a token', async () => {
    const db = openDb(join(dir, 'dash.db'));
    try {
      const { builtInAgent } = await import('./db/agents');
      const agent = builtInAgent(db);
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`INSERT INTO comment_events (at, actor_id, kind, repo_id, commit_oid, thread_id) VALUES ('2026-09-30T00:00:00.000Z', ?, 'resolved', 1, ?, 1)`, [agent.id, 'a'.repeat(40)]);
    } finally {
      db.close();
    }
    expect((await run('list')).out).toMatch(/^2 +Agent +- +\S+ +never +built in \(no token\) +all$/m);
  });

  describe('sources', () => {
    const GITLAB = 'gitlab.example.com';
    /** A GitLab source beside github.com, as a sync of a configured one leaves it; its id. */
    const addGitLab = (host = GITLAB) => withDb((db) => ensureSource(db, { kind: 'gitlab', host, baseUrl: `https://${host}` }).id);
    const reach = (id: number) => withDb((db) => agentSourceIds(db, id));

    it('adds an agent that reaches only the sources named (--source, any case), or every one', async () => {
      const gitlab = addGitLab();
      const some = await run('add', 'Work', '--source', 'GitLab.example.com');
      expect([some.code, some.err]).toEqual([0, '']);
      expect(some.out).toContain(`Added agent Work (id 2); it reaches ${GITLAB} only.`);
      expect(tokenIn(some.out)).toBeDefined();
      expect(reach(2)).toEqual([gitlab]);
      expect((await run('add', 'Both', `--source=${GITLAB}`, '--source', 'github.com')).out).toContain(`it reaches github.com, ${GITLAB} only.`);
      expect(reach(3)).toEqual([1, gitlab]);
      expect((await run('add', 'All')).out).toContain('Added agent All (id 4).');
      expect(reach(4)).toBeNull();
      // With a token of your own too.
      expect((await runWith('my-own-agent-token-0123456789\n', 'add', 'Mine', '--token-stdin', '--source', 'github.com')).code).toBe(0);
      expect(principal('my-own-agent-token-0123456789')).toMatchObject({ name: 'Mine' });
      expect(reach(5)).toEqual([1]);
      const lines = (await run('list')).out.split('\n');
      expect(lines.slice(1).map((l) => l.split(/ {2,}/).at(-1))).toEqual([GITLAB, `github.com,${GITLAB}`, 'all', 'github.com']);
    });

    it('limits an agent later, or lets it reach every source again, by id or name', async () => {
      const gitlab = addGitLab();
      const token = tokenIn((await run('add', 'Claude')).out)!;
      expect(await run('scope', 'claude', '--source', GITLAB)).toEqual({ code: 0, out: `Claude (id 2) now reaches ${GITLAB} only, from its next request.`, err: '' });
      expect(reach(2)).toEqual([gitlab]);
      expect((await run('scope', '2', '--source', 'github.com', '--source', GITLAB)).out).toBe(`Claude (id 2) now reaches github.com, ${GITLAB} only, from its next request.`);
      expect((await run('scope', 'Claude', '--all')).out).toBe('Claude (id 2) now reaches every source, those added later too, from its next request.');
      expect(reach(2)).toBeNull();
      // Its token is untouched; a disabled agent can be limited too.
      expect(principal(token)).toMatchObject({ id: 2 });
      await run('disable', 'Claude');
      expect((await run('scope', 'Claude', '--source', 'github.com')).code).toBe(0);
      expect((await run('list')).out).toMatch(/^2 +Claude +ghd_\S+… +\S+ +\S+ +disabled \S+ +github\.com$/m);
    });

    it('says which hosts are sources when one is not, and changes nothing', async () => {
      addGitLab();
      const known = `(the sources: github.com, ${GITLAB})`;
      expect(await run('add', 'Claude', '--source', 'gitlab.nope.example')).toMatchObject({ code: 1, err: `gh-dash: gitlab.nope.example isn't a source here ${known}` });
      expect((await run('list')).out).toBe('No agents yet. Add one: gh-dash agents add <name>');
      await run('add', 'Claude', '--source', 'github.com');
      expect(await run('scope', 'Claude', '--source', GITLAB, '--source', 'https://github.com')).toMatchObject({ code: 1, err: `gh-dash: https://github.com isn't a source here ${known}` });
      expect(reach(2)).toEqual([1]);
      expect(await run('scope', 'nobody', '--all')).toMatchObject({ code: 1, err: 'gh-dash: No agent is called or numbered nobody (see: gh-dash agents list)' });
    });

    it('shows an agent whose sources were all deleted as reaching none, never all', async () => {
      const gitlab = addGitLab();
      await run('add', 'Work', '--source', GITLAB);
      withDb((db) => removeSource(db, gitlab));
      expect((await run('list')).out).toMatch(/^2 +Work +ghd_\S+… +\S+ +never +active +none$/m);
      expect(reach(2)).toEqual([]);
      addGitLab();
      expect(reach(2)).toEqual([]);
    });

    it('takes --source with add or scope only, --all with scope only, and one of them for scope (usage: 2)', async () => {
      await run('add', 'Claude');
      for (const args of [
        ['scope', 'Claude'], ['scope', 'Claude', '--all', '--source', 'github.com'], ['scope', '--all'], ['scope', 'Claude', 'Codex', '--all'],
        ['scope', 'Claude', '--source'], ['scope', 'Claude', '--source', '--all'], ['scope', 'Claude', '--source='], ['add', 'Codex', '--all'],
        ['list', '--source', 'github.com'], ['regenerate', 'Claude', '--source', 'github.com'], ['revoke', 'Claude', '--all'], ['delete', 'Claude', '--all'],
      ]) {
        const res = await run(...args);
        expect([args, res.code, res.out]).toEqual([args, 2, '']);
        expect(res.err).toContain('Usage: gh-dash agents <command>');
      }
      expect((await run('scope', 'Claude')).err).toContain('gh-dash: agents scope takes --source <host> (one or more), or --all');
      expect(reach(2)).toBeNull();
      expect((await run('list')).out.split('\n')).toHaveLength(2);
    });
  });

  describe('delete', () => {
    const HEAD = 'a'.repeat(40);
    /** Comments by agent `id` on alice/app#2: `open` threads left open and `resolved` ones resolved, each with a reply of its. */
    const write = (id: number, open: number, resolved = 0) => withDb((db) => {
      db.run(`INSERT INTO repos (source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at)
        SELECT 1, 'alice/app', 'R_app', 'app', 'alice/app', 'alice', 'https://github.com/alice/app', 'public', '2026-09-01T00:00:00Z'
        WHERE NOT EXISTS (SELECT 1 FROM repos WHERE key = 'alice/app')`);
      const repoId = db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
      const agent = getPrincipal(db, id)!;
      const threads: number[] = [];
      for (let i = 0; i < open + resolved; i++) {
        const t = createThread(db, { repoId, kind: 'pr', number: 2 }, { commitOid: HEAD, baseOid: null, anchor: { path: null, side: null, startLine: null, endLine: null, snippet: null }, body: `Note ${i}` }, agent);
        addComment(db, t.id, agent, 'More');
        if (i >= open) setThreadStatus(db, t.id, 'resolved', getPrincipal(db, SELF_PRINCIPAL_ID)!);
        threads.push(t.id);
      }
      return threads;
    });
    const authorOf = (thread: number): Principal => withDb((db) => getThread(db, thread)!.comments[0]!.author);

    it('deletes an agent that wrote nothing right away, saying so', async () => {
      const token = tokenIn((await run('add', 'Claude')).out)!;
      expect(await run('delete', 'claude')).toEqual({ code: 0, out: "Deleted Claude (id 2). It hadn't written anything. Its token no longer works.", err: '' });
      expect(withDb((db) => agentForToken(db, token))).toBeNull();
      expect((await run('list')).out).toBe('No agents yet. Add one: gh-dash agents add <name>');
      // Not found again; its name is free.
      expect(await run('delete', '2')).toMatchObject({ code: 1, err: 'gh-dash: No agent is called or numbered 2 (see: gh-dash agents list)' });
      expect(await run('add', 'Claude')).toMatchObject({ code: 0, out: expect.stringContaining('Added agent Claude (id 3).') });
    });

    it('refuses without --yes when it wrote anything, saying what stays; deletes with it', async () => {
      const token = tokenIn((await run('add', 'Claude')).out)!;
      const threads = write(2, 3, 2);
      const refused = await run('delete', 'Claude');
      expect(refused).toEqual({
        code: 1,
        out: '',
        err: 'Delete Claude (id 2)? Its 10 comments in 5 threads stay, shown as by “Deleted agent #2”. 3 of those threads are still open. ' +
          "Its token stops working now. This can't be undone.\nRun again with --yes to delete it: gh-dash agents delete 2 --yes",
      });
      // Nothing changed.
      expect(principal(token)).toMatchObject({ id: 2, name: 'Claude' });
      expect(authorOf(threads[0]!).name).toBe('Claude');
      const done = await run('delete', 'Claude', '--yes');
      expect(done).toEqual({
        code: 0,
        out: 'Deleted Claude (id 2). Its 10 comments in 5 threads stay, shown as by “Deleted agent #2”. 3 of those threads are still open. Its token no longer works.',
        err: '',
      });
      expect(principal(token)).toBeNull();
      expect(authorOf(threads[0]!)).toEqual({ id: 2, kind: 'agent', name: 'Deleted agent #2' });
      expect((await run('list')).out).toBe('No agents yet. Add one: gh-dash agents add <name>');
    });

    it('says when none of its threads is open, and when its token was disabled already', async () => {
      await run('add', 'Claude');
      write(2, 0, 1);
      await run('disable', 'Claude');
      expect((await run('delete', '2')).err).toBe(
        'Delete Claude (id 2)? Its 2 comments in one thread stay, shown as by “Deleted agent #2”. Its token is deleted with it. This can\'t be undone.\n' +
          'Run again with --yes to delete it: gh-dash agents delete 2 --yes',
      );
      expect((await run('delete', '--yes', '2')).out).toBe('Deleted Claude (id 2). Its 2 comments in one thread stay, shown as by “Deleted agent #2”. Its token was deleted with it.');
    });

    it("refuses the built-in agent, with or without --yes", async () => {
      const { builtInAgent } = await import('./db/agents');
      withDb((db) => builtInAgent(db));
      for (const args of [['delete', 'Agent'], ['delete', 'agent', '--yes']]) {
        expect(await run(...args)).toMatchObject({ code: 1, err: expect.stringContaining("Agent is built in and can't be deleted") });
      }
    });
  });

  it('reports a config it cannot read', async () => {
    mkdirSync(join(dir, 'config', 'gh-dash'), { recursive: true });
    writeFileSync(join(dir, 'config', 'gh-dash', 'config.json'), '{ nope');
    expect(await run('list')).toMatchObject({ code: 1, err: expect.stringMatching(/^gh-dash: .*config\.json/) });
  });
});
