import { describe, expect, it } from 'vitest';
import type { Agent } from './api';
import { TOKEN_ENV, agentConfig, agentNameProblem, agentTokenProblem, generateAgentToken, mcpUrl, shellArg, sortAgents } from '../web/src/lib/agents';

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
  ({ id, name, tokenPrefix: 'ghd_abcd', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null, builtIn: false, sources: null, ...o });

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

  it('lists active agents by name, then revoked ones, newest revoked first', () => {
    const list = [
      agent(1, 'codex', { revokedAt: '2026-09-02T00:00:00.000Z', tokenPrefix: null }),
      agent(2, 'Zed'),
      agent(3, 'claude'),
      agent(4, 'old', { revokedAt: '2026-09-05T00:00:00.000Z', tokenPrefix: null }),
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
});
