import { describe, expect, it } from 'vitest';
import type { Agent } from './api';
import { TOKEN_ENV, agentConfig, agentNameProblem, mcpUrl, sortAgents } from '../web/src/lib/agents';

const agent = (id: number, name: string, o: Partial<Agent> = {}): Agent =>
  ({ id, name, tokenPrefix: 'ghd_abcd', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null, builtIn: false, ...o });

describe('Settings → Agents', () => {
  it("serves MCP at the API's URL, /mcp; none when nothing listens", () => {
    expect(mcpUrl('http://127.0.0.1:4780')).toBe('http://127.0.0.1:4780/mcp');
    expect(mcpUrl('https://dash.example.com/')).toBe('https://dash.example.com/mcp');
    expect(mcpUrl(null)).toBeNull();
  });

  it('gives ready-to-paste config for Claude Code and Codex', () => {
    const c = agentConfig('http://127.0.0.1:4780/mcp', 'ghd_secret');
    expect(c.claude).toBe('claude mcp add -s user --transport http gh-dash http://127.0.0.1:4780/mcp --header "Authorization: Bearer ghd_secret"');
    // Codex names the variable, not the token.
    expect(c.codex).toBe(`codex mcp add gh-dash --url http://127.0.0.1:4780/mcp --bearer-token-env-var ${TOKEN_ENV}`);
    expect(c.codex).not.toContain('ghd_secret');
    expect(c.codexEnv).toBe(`export ${TOKEN_ENV}=ghd_secret`);
  });

  it('lists active agents by name, then revoked ones, newest revoked first', () => {
    const list = [
      agent(1, 'codex', { revokedAt: '2026-09-02T00:00:00.000Z', tokenPrefix: null }),
      agent(2, 'Zed'),
      agent(3, 'claude'),
      agent(4, 'old', { revokedAt: '2026-09-05T00:00:00.000Z', tokenPrefix: null }),
    ];
    expect(sortAgents(list).map((a) => a.id)).toEqual([3, 2, 4, 1]);
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
  });
});
