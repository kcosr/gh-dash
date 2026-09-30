import { describe, expect, it } from 'vitest';
import { agentDeletionSentences, deletedAgentName, warningText } from './agents';
import type { Agent } from './api';
import {
  TOKEN_ENV, agentConfig, agentNameProblem, agentReach, agentsShown, agentTokenProblem, generateAgentToken, mcpUrl, pickedSources, pickOf, shellArg, sortAgents,
  sourceLabel,
} from '../web/src/lib/agents';

/**
 * Runs `line` in a real POSIX shell after `prelude` and returns what it printed. node:child_process by the running
 * Node (these tests run in Node; the web's tsconfig has no Node types, hence getBuiltinModule).
 */
function sh(prelude: string, line: string): string {
  const cp = (globalThis as unknown as { process: { getBuiltinModule: (m: string) => { execFileSync: (f: string, a: string[], o: object) => string } } })
    .process.getBuiltinModule('node:child_process');
  return cp.execFileSync('/bin/sh', ['-c', `${prelude}\n${line}`], { encoding: 'utf8' });
}

const agent = (id: number, name: string, o: Partial<Agent> = {}): Agent =>
  ({ id, name, tokenPrefix: 'ghd_abcd', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null, disabledAt: null, builtIn: false, sources: null, ...o });

describe('Settings → Agents', () => {
  it("serves MCP at the API's URL, /mcp; none when nothing listens", () => {
    expect(mcpUrl('http://127.0.0.1:4780')).toBe('http://127.0.0.1:4780/mcp');
    expect(mcpUrl('https://dash.example.com/')).toBe('https://dash.example.com/mcp');
    expect(mcpUrl(null)).toBeNull();
  });

  it('gives ready-to-paste config for Claude Code and Codex', () => {
    const c = agentConfig('http://127.0.0.1:4780/mcp', 'ghd_secret');
    expect(c.claude).toBe("claude mcp add -s user --transport http gh-dash http://127.0.0.1:4780/mcp --header 'Authorization: Bearer ghd_secret'");
    // Codex names the variable, not the token.
    expect(c.codex).toBe(`codex mcp add gh-dash --url http://127.0.0.1:4780/mcp --bearer-token-env-var ${TOKEN_ENV}`);
    expect(c.codex).not.toContain('ghd_secret');
    expect(c.codexEnv).toBe(`export ${TOKEN_ENV}=ghd_secret`);
  });

  // A real POSIX shell: there is none on Windows (the quoting itself is covered by shellArg's own tests everywhere).
  it.skipIf((globalThis as unknown as { process: { platform: string } }).process.platform === 'win32')("keeps a token of your own text when the lines are pasted into a shell, whatever it holds", () => {
    const tokens = [
      'abcdefghijklmnopqrstuvwx$(true)', 'abcdefghijklmnopqrstuvwx`id`', "it's-a-token-with-'quotes'-0", 'a"double"quoted-token-00000',
      'semi;colon;token;000000000', 'back\\slash\\token\\0000000', 'bang!bang!history!00000000', '$HOME-${PATH}-$((1+1))-token',
      `mixed'"$\`;\\!&|<>(){}[]*?~#-0`,
    ];
    for (const token of tokens) {
      const c = agentConfig('http://127.0.0.1:4780/mcp', token);
      // `claude` stands in for the CLI: it prints each argument it gets, one per line.
      const args = sh(`claude() { for a in "$@"; do printf '%s\\n' "$a"; done; }`, c.claude).split('\n');
      expect(args.slice(-3, -1), token).toEqual(['--header', `Authorization: Bearer ${token}`]);
      expect(sh(c.codexEnv, `printf '%s' "$${TOKEN_ENV}"`), token).toBe(token);
    }
    expect(shellArg('ghd_Zp3cQ1mN8vT2xR7kL0aB5sD4fG6hJ9wE3yU1iO8pZc')).toBe('ghd_Zp3cQ1mN8vT2xR7kL0aB5sD4fG6hJ9wE3yU1iO8pZc');
    expect(shellArg("a'b")).toBe(`'a'\\''b'`);
  });

  it('lists active agents by name, then disabled ones, newest disabled first', () => {
    const list = [
      agent(1, 'codex', { disabledAt: '2026-09-02T00:00:00.000Z' }),
      agent(2, 'Zed'),
      agent(3, 'claude'),
      agent(4, 'old', { disabledAt: '2026-09-05T00:00:00.000Z' }),
    ];
    expect(sortAgents(list).map((a) => a.id)).toEqual([3, 2, 4, 1]);
    // The built-in agent after the ones you added.
    expect(sortAgents([...list, agent(5, 'Agent', { builtIn: true, tokenPrefix: null })]).map((a) => a.id)).toEqual([3, 2, 5, 4, 1]);
  });

  it("asks for a name no agent has", () => {
    const list = [agent(1, 'Claude')];
    expect(agentNameProblem('  ', list)).toBe('Give it a name');
    expect(agentNameProblem('claude', list)).toBe('An agent has that name: give it a new token instead');
    expect(agentNameProblem('YOU', list)).toBe('“You” is you: give the agent another name');
    expect(agentNameProblem('x'.repeat(65), list)).toBe('At most 64 characters');
    expect(agentNameProblem('x'.repeat(64), list)).toBeNull();
    expect(agentNameProblem('42', list)).toBe('Not only digits (those are ids)');
    expect(agentNameProblem('R2D2', list)).toBeNull();
    expect(agentNameProblem(' Codex ', list)).toBeNull();
    for (const name of ['agent', 'Agent (no token)', 'agent (no token) 3']) expect(agentNameProblem(name, list), name).toMatch(/built-in agent/);
    expect(agentNameProblem('Agent Smith', list)).toBeNull();
    for (const name of ['Deleted agent #4', ' deleted AGENT #12 ']) expect(agentNameProblem(name, list), name).toBe('Names like that are kept for deleted agents');
    expect(agentNameProblem('Deleted agent', list)).toBeNull();
  });

  describe('deleting an agent: what the warning says', () => {
    const say = (f: { comments: number; threads: number; openThreads: number; opened?: number }, disabled = false, done = false) =>
      agentDeletionSentences({ id: 4, disabled }, { opened: 0, ...f }, done);

    it('says how many comments stay, in how many threads, how many are open, and that its token stops', () => {
      expect(deletedAgentName(4)).toBe('Deleted agent #4');
      expect(say({ comments: 12, threads: 5, openThreads: 3, opened: 4 })).toEqual([
        { text: 'Its 12 comments in 5 threads stay, shown as by “Deleted agent #4”.' },
        { text: '3 of those threads are still open.', stress: true },
        { text: 'Its token stops working now.' },
        { text: "This can't be undone." },
      ]);
      expect(warningText(say({ comments: 12, threads: 5, openThreads: 1 }))).toBe(
        "Its 12 comments in 5 threads stay, shown as by “Deleted agent #4”. 1 of those threads is still open. Its token stops working now. This can't be undone.",
      );
    });

    it('leaves out open threads when there are none, and says it plainly for one comment, one thread, both or all', () => {
      expect(warningText(say({ comments: 3, threads: 2, openThreads: 0 }))).toBe(
        "Its 3 comments in 2 threads stay, shown as by “Deleted agent #4”. Its token stops working now. This can't be undone.",
      );
      expect(warningText(say({ comments: 1, threads: 1, openThreads: 1 }))).toBe(
        "Its comment stays, shown as by “Deleted agent #4”. That thread is still open. Its token stops working now. This can't be undone.",
      );
      expect(say({ comments: 4, threads: 1, openThreads: 0 })[0]!.text).toBe('Its 4 comments in one thread stay, shown as by “Deleted agent #4”.');
      expect(say({ comments: 4, threads: 2, openThreads: 2 })[1]).toEqual({ text: 'Both of those threads are still open.', stress: true });
      expect(say({ comments: 9, threads: 6, openThreads: 6 })[1]).toEqual({ text: 'All 6 of those threads are still open.', stress: true });
    });

    it("says an agent that wrote nothing hasn't, and nothing is lost", () => {
      expect(warningText(say({ comments: 0, threads: 0, openThreads: 0 }))).toBe("It hasn't written anything. Its token stops working now.");
    });

    it('says a disabled agent’s token goes with it, and, once done, what happened', () => {
      expect(say({ comments: 0, threads: 0, openThreads: 0 }, true).at(-1)).toEqual({ text: 'Its token is deleted with it.' });
      expect(warningText(say({ comments: 2, threads: 1, openThreads: 1 }, false, true))).toBe(
        'Its 2 comments in one thread stay, shown as by “Deleted agent #4”. That thread is still open. Its token no longer works.',
      );
      expect(warningText(say({ comments: 0, threads: 0, openThreads: 0 }, true, true))).toBe("It hadn't written anything. Its token was deleted with it.");
    });
  });

  it('generates tokens shaped like the server’s, and checks one the user typed as the server does', () => {
    const a = generateAgentToken();
    expect(a).toMatch(/^ghd_[A-Za-z0-9_-]{43}$/);
    expect(generateAgentToken()).not.toBe(a);
    expect(generateAgentToken((b) => b.fill(255))).toBe(`ghd_${'_'.repeat(42)}8`);
    expect(agentTokenProblem(a)).toBeNull();
    expect(agentTokenProblem('my-own-agent-token-0123456789')).toBeNull();
    expect(agentTokenProblem('short')).toBe('24 to 256 characters');
    expect(agentTokenProblem('y'.repeat(257))).toBe('24 to 256 characters');
    expect(agentTokenProblem('with a space in the middle of it')).toBe('Printable ASCII without spaces');
    expect(agentTokenProblem('ünïcode-token-000000000000')).toBe('Printable ASCII without spaces');
  });

  describe('sources', () => {
    const known = [
      { host: 'github.com', name: 'GitHub' },
      { host: 'gitlab.example.com', name: 'gitlab.example.com' },
      { host: 'gitlab.other.example', name: 'gitlab.other.example' },
    ];

    it('says what an agent reaches in a few words, naming sources as Settings → Sources does', () => {
      expect(agentReach(null, known)).toBe('All sources');
      expect(agentReach([], known)).toBe('No sources');
      expect(agentReach(['github.com'], known)).toBe('GitHub only');
      expect(agentReach(['github.com', 'gitlab.example.com'], known)).toBe('GitHub, gitlab.example.com only');
      expect(agentReach(['github.com', 'gitlab.example.com', 'gitlab.other.example'], known)).toBe('GitHub, gitlab.example.com, gitlab.other.example only');
      // A host the list doesn't know yet, by its host.
      expect(agentReach(['gitlab.new.example'], [])).toBe('gitlab.new.example only');
      expect(agentReach(['gitlab.example.com'], [{ host: 'gitlab.example.com', name: 'GitLab' }])).toBe('GitLab only');
    });

    it("names a source, with its host when the name doesn't say it", () => {
      expect(sourceLabel({ host: 'github.com', name: 'GitHub' })).toEqual({ name: 'GitHub', host: 'github.com' });
      expect(sourceLabel({ host: 'gitlab.example.com', name: 'gitlab.example.com' })).toEqual({ name: 'gitlab.example.com', host: null });
    });

    it('turns the picker into hosts for the bridge: every source (null), or those picked that are sources, in their order', () => {
      expect(pickOf(null)).toEqual({ all: true, hosts: [] });
      expect(pickOf(undefined)).toEqual({ all: true, hosts: [] });
      expect(pickOf(['gitlab.example.com'])).toEqual({ all: false, hosts: ['gitlab.example.com'] });
      expect(pickedSources({ all: true, hosts: ['github.com'] }, known)).toEqual({ sources: null, problem: null });
      expect(pickedSources({ all: false, hosts: ['gitlab.other.example', 'github.com'] }, known)).toEqual({ sources: ['github.com', 'gitlab.other.example'], problem: null });
      expect(pickedSources({ all: false, hosts: ['gone.example', 'github.com'] }, known)).toEqual({ sources: ['github.com'], problem: null });
      for (const hosts of [[], ['gone.example']]) {
        expect(pickedSources({ all: false, hosts }, known)).toEqual({ sources: null, problem: 'Pick at least one source, or all of them' });
      }
    });

    it('lists the built-in agent while requests without a token act as it, before it has done anything too', () => {
      const list = [agent(3, 'Claude'), agent(2, 'Codex', { disabledAt: '2026-09-02T00:00:00.000Z' })];
      expect(agentsShown(list, false).map((a) => a.name)).toEqual(['Claude', 'Codex']);
      const shown = agentsShown(list, true);
      expect(shown.map((a) => [a.id, a.name, a.builtIn, a.sources])).toEqual([[3, 'Claude', false, null], [0, 'Agent', true, null], [2, 'Codex', false, null]]);
      // Once listed, as it is.
      const listed = [...list, agent(5, 'Agent (no token)', { builtIn: true, tokenPrefix: null, sources: ['github.com'] })];
      expect(agentsShown(listed, true).filter((a) => a.builtIn)).toEqual([listed[2]]);
      expect(agentsShown(listed, false).filter((a) => a.builtIn)).toEqual([listed[2]]);
    });
  });
});
