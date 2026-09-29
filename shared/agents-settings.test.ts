import { describe, expect, it } from 'vitest';
import type { Agent } from './api';
import { TOKEN_ENV, agentConfig, agentNameProblem, mcpUrl, sortAgents } from '../web/src/lib/agents';

const agent = (id: number, name: string, o: Partial<Agent> = {}): Agent =>
  ({ id, name, tokenPrefix: 'ghd_abcd', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null, ...o });

describe('Settings → Agents', () => {
  it("serves MCP at the API's URL, /mcp; none when nothing listens", () => {
    expect(mcpUrl('http://127.0.0.1:4780')).toBe('http://127.0.0.1:4780/mcp');
    expect(mcpUrl('https://dash.example.com/')).toBe('https://dash.example.com/mcp');
    expect(mcpUrl(null)).toBeNull();
  });

  it('gives ready-to-paste config for Claude Code and Codex', () => {
    const c = agentConfig('http://127.0.0.1:4780/mcp', 'ghd_secret');
    expect(c.claude).toBe('claude mcp add --transport http --scope user gh-dash http://127.0.0.1:4780/mcp --header "Authorization: Bearer ghd_secret"');
    // Codex names the variable, not the token.
    expect(c.codexToml).toBe(`[mcp_servers.gh-dash]\nurl = "http://127.0.0.1:4780/mcp"\nbearer_token_env_var = "${TOKEN_ENV}"`);
    expect(c.codexToml).not.toContain('ghd_secret');
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
    expect(agentNameProblem('claude', list)).toBe('An agent has that name');
    expect(agentNameProblem(' Codex ', list)).toBeNull();
  });
});
