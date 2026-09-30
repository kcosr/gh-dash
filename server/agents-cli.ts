// `gh-dash agents …` for the headless server (node dist/server/index.mjs agents …): make, list, regenerate, limit to
// some sources and revoke the agents that comment through MCP. Tokens and sources are set here or in the desktop app
// only, never over HTTP. It opens the database the server uses (GH_DASH_DB, config.json, the env file), so it works
// whether or not the server is running.

import type { Agent } from '../shared/api';
import { loadServerConfig } from './config';
import { createAgent, findAgent, listAgents, regenerateAgentToken, revokeAgent, setAgentSources } from './db/agents';
import { type Db, openDb } from './db/db';
import { HttpError } from './lib/errors';
import { localApiUrl } from './start';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** The process environment (the env file and config.json are read as the server reads them). */
  env: NodeJS.ProcessEnv;
  /** What was piped in (`--token-stdin`). Default: the process's stdin. */
  stdin?: () => Promise<string>;
}

const USAGE = `Usage: gh-dash agents <command>

  add <name> [--source <host>]... [--token-stdin]
                                        Make an agent and print its token (shown once)
  list                                  List the agents (never their tokens) and the sources they reach
  regenerate <id|name> [--token-stdin]  Give an agent a new token (the old one stops working) and print it
  scope <id|name> --source <host>... | --all
                                        Limit an agent to some sources, or let it reach every one again
  revoke <id|name>                      Revoke an agent's token; its comments stay

--source: a source the agent may reach through MCP, by its host (github.com, gitlab.example.com: see the sources in
Settings, or GET /api/v1/sources); repeat it for more. Without it, an agent reaches every source, those added later
too. The REST API isn't limited: it is yours.

--token-stdin: use the token on stdin's first line (24-256 printable ASCII characters, no spaces) instead of a
generated one. Never put a token on the command line: other users can read it there (ps).

Agents comment through MCP at <server>/mcp with "Authorization: Bearer <token>".`;

const TOKEN_STDIN = '--token-stdin';
const SOURCE = '--source';
const ALL = '--all';

/** The hosts of `--source <host>` and `--source=<host>`, any number of them, and the arguments left. */
function takeSources(args: string[]): { hosts: string[]; rest: string[] } {
  const hosts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === SOURCE) {
      const host = args[++i];
      if (host === undefined || !host.trim() || host.startsWith('-')) throw new UsageError(`${SOURCE} takes a source's host, such as github.com`);
      hosts.push(host);
    } else if (arg.startsWith(`${SOURCE}=`)) {
      const host = arg.slice(SOURCE.length + 1);
      if (!host.trim()) throw new UsageError(`${SOURCE} takes a source's host, such as github.com`);
      hosts.push(host);
    } else {
      rest.push(arg);
    }
  }
  return { hosts, rest };
}

/** What an agent reaches, in a sentence's words: "every source", or the hosts. */
const reachOf = (a: Agent) => (a.sources === null ? 'every source, those added later too' : a.sources.length ? `${a.sources.join(', ')} only` : 'no source');

/** The process's stdin, whole. */
async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

/** A usage mistake: exit code 2, with the usage. */
class UsageError extends Error {}

/** Runs `agents <args>`; returns the exit code (0 done, 1 failed, 2 usage). */
export async function runAgentsCommand(args: string[], io: CliIo = { out: console.log, err: console.error, env: process.env }): Promise<number> {
  const [command, ...given] = args;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    (command === undefined ? io.err : io.out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  const opened: { db?: Db } = {};
  try {
    const fromStdin = given.includes(TOKEN_STDIN);
    const all = given.includes(ALL);
    const { hosts, rest } = takeSources(given.filter((a) => a !== TOKEN_STDIN && a !== ALL));
    const { config } = loadServerConfig(io.env);
    const open = () => (opened.db ??= openDb(config.dbPath, { allowDestructiveMigrations: config.syncEnabled }));
    const mcpUrl = `${localApiUrl(config.host, config.port)}/mcp`;
    if (rest.some((a) => /^--?token\b/i.test(a))) {
      throw new UsageError(`Never put a token on the command line (other users can read it there): pipe it in with ${TOKEN_STDIN}`);
    }
    if (fromStdin && command !== 'add' && command !== 'regenerate') throw new UsageError(`${TOKEN_STDIN} goes with add or regenerate`);
    if (hosts.length && command !== 'add' && command !== 'scope') throw new UsageError(`${SOURCE} goes with add or scope`);
    if (all && command !== 'scope') throw new UsageError(`${ALL} goes with scope (an agent added without ${SOURCE} reaches every source)`);
    /** The token piped in (its first line), or undefined for a generated one. Checked where it is stored. */
    const chosenToken = async () => {
      if (!fromStdin) return undefined;
      const line = (await (io.stdin ?? readStdin)()).split(/\r?\n/)[0] ?? '';
      if (!line) throw new HttpError(400, `${TOKEN_STDIN}: no token on stdin`);
      return line;
    };
    const one = (what: string): string => {
      // `add --help` is a question, not an agent called "--help".
      if (rest.length !== 1 || !rest[0]!.trim() || rest[0]!.startsWith('-')) throw new UsageError(`agents ${command} takes one ${what}`);
      return rest[0]!;
    };
    const agentBy = (idOrName: string): Agent => {
      const agent = findAgent(open(), idOrName);
      if (!agent) throw new HttpError(404, `No agent is called or numbered ${idOrName} (see: gh-dash agents list)`);
      return agent;
    };
    const printToken = (token: string) => {
      io.out(`Token (shown once, keep it somewhere safe): ${token}`);
      io.out(`MCP server: ${mcpUrl} (this server's address; use the one agents reach it at)`);
      io.out(`Claude Code: claude mcp add -s user --transport http gh-dash ${mcpUrl} --header "Authorization: Bearer <token>"`);
    };

    switch (command) {
      case 'add': {
        const name = one('name');
        const { agent, token } = createAgent(open(), name, undefined, await chosenToken(), hosts.length ? hosts : null);
        io.out(agent.sources ? `Added agent ${agent.name} (id ${agent.id}); it reaches ${reachOf(agent)}.` : `Added agent ${agent.name} (id ${agent.id}).`);
        printToken(token);
        return 0;
      }
      case 'list': {
        if (rest.length) throw new UsageError('agents list takes no arguments');
        const agents = listAgents(open());
        if (!agents.length) {
          io.out('No agents yet. Add one: gh-dash agents add <name>');
          return 0;
        }
        const rows = agents.map((a) => [
          String(a.id), a.name, a.tokenPrefix ? `${a.tokenPrefix}…` : '-', a.createdAt, a.lastUsedAt ?? 'never',
          a.builtIn ? 'built in (no token)' : a.revokedAt ? `revoked ${a.revokedAt}` : 'active',
          a.sources === null ? 'all' : a.sources.join(',') || 'none',
        ]);
        for (const line of table(['ID', 'NAME', 'TOKEN', 'CREATED', 'LAST USED', 'STATUS', 'SOURCES'], rows)) io.out(line);
        return 0;
      }
      case 'regenerate': {
        const target = agentBy(one('agent id or name'));
        const { agent, token } = regenerateAgentToken(open(), target.id, undefined, await chosenToken())!;
        io.out(`New token for ${agent.name} (id ${agent.id}); the old one no longer works.`);
        printToken(token);
        return 0;
      }
      case 'scope': {
        const target = agentBy(one('agent id or name'));
        if (all === !!hosts.length) throw new UsageError(`agents scope takes ${SOURCE} <host> (one or more), or ${ALL}`);
        const agent = setAgentSources(open(), target.id, all ? null : hosts)!;
        io.out(`${agent.name} (id ${agent.id}) now reaches ${reachOf(agent)}, from its next request.`);
        return 0;
      }
      case 'revoke': {
        const before = agentBy(one('agent id or name'));
        const agent = revokeAgent(open(), before.id)!;
        io.out(before.revokedAt ? `${agent.name} (id ${agent.id}) was already revoked.` : `Revoked ${agent.name} (id ${agent.id}); its comments stay.`);
        return 0;
      }
      default:
        throw new UsageError(`Unknown command: agents ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`gh-dash: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`gh-dash: ${(err as Error).message}`);
    return 1;
  } finally {
    opened.db?.close();
  }
}

/** Left-aligned columns, two spaces apart. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  '));
}
