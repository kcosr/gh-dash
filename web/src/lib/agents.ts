/**
 * Settings → Agents: how an agent connects (the MCP URL, and ready-to-paste config for Claude Code and Codex) and how
 * each agent is described. Pure, so the view and the tests share it.
 */
import type { Agent } from '../../../shared/api';
import { apiLink } from './account';

/** The agents' fixed address: the Local API's (or the server's) URL, then /mcp. Null when nothing listens. */
export const mcpUrl = (apiBase: string | null): string | null => apiLink(apiBase, '/mcp');

/** The variable Codex reads the token from (its config names the variable, not the token). */
export const TOKEN_ENV = 'GH_DASH_AGENT_TOKEN';

/**
 * What to paste to connect an agent (the lines the mcp-core lane checked with Claude Code 2.1 and Codex 0.155). Claude
 * Code: one command, the token in its header; `-s user` makes it every project's (gh-dash spans them; the default is
 * the project it's run in). Codex: its command names the variable the token is read from (it writes
 * `[mcp_servers.gh-dash]` with `url` and `bearer_token_env_var` to ~/.codex/config.toml), and the line that sets it.
 */
export function agentConfig(url: string, token: string): { claude: string; codex: string; codexEnv: string } {
  return {
    claude: `claude mcp add -s user --transport http gh-dash ${url} --header "Authorization: Bearer ${token}"`,
    codex: `codex mcp add gh-dash --url ${url} --bearer-token-env-var ${TOKEN_ENV}`,
    codexEnv: `export ${TOKEN_ENV}=${token}`,
  };
}

/** Agents in the order Settings lists them: active ones by name, then revoked ones (newest revoked first). */
export function sortAgents(list: readonly Agent[]): Agent[] {
  return [...list].sort((a, b) =>
    Number(!!a.revokedAt) - Number(!!b.revokedAt)
    || (a.revokedAt && b.revokedAt ? b.revokedAt.localeCompare(a.revokedAt) : 0)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.id - b.id);
}

/**
 * A new agent's name: what's wrong with it, or null. The server's rules (server/db/agents.ts `agentName`), checked
 * here first; it has the last word. Names tell agents apart, in any case, revoked ones too.
 */
export function agentNameProblem(name: string, taken: readonly Pick<Agent, 'name'>[]): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (Array.from(n).length > 64) return 'At most 64 characters';
  if (n.toLowerCase() === 'you') return '“You” is you: give the agent another name';
  if (taken.some((a) => a.name.toLowerCase() === n.toLowerCase())) return 'An agent has that name: give it a new token instead';
  return null;
}
