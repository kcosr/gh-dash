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
 * What to paste to connect an agent. Claude Code: one command (the header carries the token; `--scope user` makes it
 * every project's, as gh-dash spans them). Codex: its config.toml entry reading the token from the environment, and
 * the line that sets it.
 */
export function agentConfig(url: string, token: string): { claude: string; codexToml: string; codexEnv: string } {
  return {
    claude: `claude mcp add --transport http --scope user gh-dash ${url} --header "Authorization: Bearer ${token}"`,
    codexToml: `[mcp_servers.gh-dash]\nurl = "${url}"\nbearer_token_env_var = "${TOKEN_ENV}"`,
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

/** A new agent's name: what's wrong with it, or null (the server has the last word). Names tell agents apart. */
export function agentNameProblem(name: string, taken: readonly Pick<Agent, 'name'>[]): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (taken.some((a) => a.name.toLowerCase() === n.toLowerCase())) return 'An agent has that name';
  return null;
}
