/**
 * Settings → Agents: how an agent connects (the MCP URL, and ready-to-paste config for Claude Code and Codex) and how
 * each agent is described. Pure, so the view and the tests share it.
 */
import type { Agent, Source } from '../../../shared/api';
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
    claude: `claude mcp add -s user --transport http gh-dash ${shellArg(url)} --header ${shellArg(`Authorization: Bearer ${token}`)}`,
    codex: `codex mcp add gh-dash --url ${shellArg(url)} --bearer-token-env-var ${TOKEN_ENV}`,
    codexEnv: `export ${TOKEN_ENV}=${shellArg(token)}`,
  };
}

/**
 * One word for a POSIX shell, whatever it holds: as it is when it has nothing the shell would read (a generated token,
 * a URL), else in single quotes, where nothing is special but the quote itself (written '\''). A token of your own may
 * hold $, backticks, quotes, ; or \ : pasted, they must stay text.
 */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Agents in the order Settings lists them: active ones by name, the built-in one, then revoked ones (newest revoked first). */
export function sortAgents(list: readonly Agent[]): Agent[] {
  return [...list].sort((a, b) =>
    Number(!!a.revokedAt) - Number(!!b.revokedAt)
    || Number(!!a.builtIn) - Number(!!b.builtIn)
    || (a.revokedAt && b.revokedAt ? b.revokedAt.localeCompare(a.revokedAt) : 0)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.id - b.id);
}

/** A token of the shape the server generates: `ghd_` and 32 random bytes, base64url (from the browser's CSPRNG). */
export function generateAgentToken(random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => { crypto.getRandomValues(b); }): string {
  const bytes = new Uint8Array(32);
  random(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `ghd_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** What's wrong with a token the user typed or pasted, or null. The server's rules (server/db/agents.ts agentToken). */
export function agentTokenProblem(token: string): string | null {
  if (token.length < 24 || token.length > 256) return '24 to 256 characters';
  if (!/^[\x21-\x7e]+$/.test(token)) return 'Printable ASCII without spaces';
  return null;
}

/**
 * A new agent's name: what's wrong with it, or null. The server's rules (server/db/agents.ts `agentName`), checked
 * here first; it has the last word. Names tell agents apart, in any case, revoked ones too.
 */
export function agentNameProblem(name: string, taken: readonly Pick<Agent, 'name'>[]): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (/^\d+$/.test(n)) return 'Not only digits (those are ids)';
  if (Array.from(n).length > 64) return 'At most 64 characters';
  if (n.toLowerCase() === 'you') return '“You” is you: give the agent another name';
  if (/^agent(?: \(no token\)(?: \d+)?)?$/i.test(n)) return 'That is the built-in agent’s name (requests without a token)';
  if (taken.some((a) => a.name.toLowerCase() === n.toLowerCase())) return 'An agent has that name: give it a new token instead';
  return null;
}

/** A source as the agents' pickers and summaries name it. */
export type AgentSource = Pick<Source, 'host' | 'name'>;

/** A source's name, with its host when the name doesn't say it (GitHub github.com, GitLab gitlab.example.com). */
export const sourceLabel = (s: AgentSource): { name: string; host: string | null } => ({ name: s.name, host: s.name === s.host ? null : s.host });

/**
 * What an agent reaches through MCP, in a few words (they label a button in a crowded row): "All sources", "GitHub
 * only", "GitHub, GitLab only", or "No sources" (its sources were removed since). Sources are named as Settings →
 * Sources names them; a host the list doesn't know (yet) by its host.
 */
export function agentReach(sources: Agent['sources'], known: readonly AgentSource[]): string {
  if (sources === null) return 'All sources';
  if (!sources.length) return 'No sources';
  return `${sources.map((h) => known.find((s) => s.host === h)?.name ?? h).join(', ')} only`;
}

/** The sources picker's value: every source, or those hosts. */
export interface SourcePick {
  all: boolean;
  hosts: string[];
}

/** The picker for an agent's sources as they are (a new agent: every source). */
export const pickOf = (sources: Agent['sources'] | undefined): SourcePick => ({ all: sources == null, hosts: sources ?? [] });

/**
 * The picked sources as the bridge takes them (hosts, or null for every source), of those that are sources still, in
 * their order; or what's wrong with the pick.
 */
export function pickedSources(pick: SourcePick, known: readonly AgentSource[]): { sources: string[] | null; problem: string | null } {
  if (pick.all) return { sources: null, problem: null };
  const hosts = known.map((s) => s.host).filter((h) => pick.hosts.includes(h));
  return hosts.length ? { sources: hosts, problem: null } : { sources: null, problem: 'Pick at least one source, or all of them' };
}

/**
 * The agents Settings lists: those GET /agents has, sorted, and the built-in agent while requests without a token act
 * as it (`builtInLive`), before it has done anything too, so its sources can be chosen before it acts. Not listed yet,
 * it has no id: `id` 0 stands for it, and its actions name it 'built-in'.
 */
export function agentsShown(list: readonly Agent[], builtInLive: boolean): Agent[] {
  const sorted = sortAgents(list);
  if (!builtInLive || sorted.some((a) => a.builtIn)) return sorted;
  const builtIn: Agent = { id: 0, name: 'Agent', tokenPrefix: null, createdAt: '', lastUsedAt: null, revokedAt: null, builtIn: true, sources: null };
  return sortAgents([...sorted, builtIn]);
}
