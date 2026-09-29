// `gh-dash agents …` for the headless server (node dist/server/index.mjs agents …): make, list, regenerate and revoke
// the agents that comment through MCP. Tokens are made here or in the desktop app only, never over HTTP. It opens the
// database the server uses (GH_DASH_DB, config.json, the env file), so it works whether or not the server is running.

import type { Agent } from '../shared/api';
import { loadServerConfig } from './config';
import { createAgent, findAgent, listAgents, regenerateAgentToken, revokeAgent } from './db/agents';
import { type Db, openDb } from './db/db';
import { HttpError } from './lib/errors';
import { localApiUrl } from './start';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** The process environment (the env file and config.json are read as the server reads them). */
  env: NodeJS.ProcessEnv;
}

const USAGE = `Usage: gh-dash agents <command>

  add <name>               Make an agent and print its token (shown once)
  list                     List the agents (never their tokens)
  regenerate <id|name>     Give an agent a new token (the old one stops working) and print it
  revoke <id|name>         Revoke an agent's token; its comments stay

Agents comment through MCP at <server>/mcp with "Authorization: Bearer <token>".`;

/** A usage mistake: exit code 2, with the usage. */
class UsageError extends Error {}

/** Runs `agents <args>`; returns the exit code (0 done, 1 failed, 2 usage). */
export async function runAgentsCommand(args: string[], io: CliIo = { out: console.log, err: console.error, env: process.env }): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    (command === undefined ? io.err : io.out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  let db: Db | null = null;
  try {
    const { config } = loadServerConfig(io.env);
    const open = () => (db ??= openDb(config.dbPath, { allowDestructiveMigrations: config.syncEnabled }));
    const mcpUrl = `${localApiUrl(config.host, config.port)}/mcp`;
    const one = (what: string): string => {
      if (rest.length !== 1 || !rest[0]!.trim()) throw new UsageError(`agents ${command} takes one ${what}`);
      return rest[0]!;
    };
    const agentBy = (idOrName: string): Agent => {
      const agent = findAgent(open(), idOrName);
      if (!agent) throw new HttpError(404, `No agent is called or numbered ${idOrName} (see: gh-dash agents list)`);
      return agent;
    };
    const printToken = (agent: Agent, token: string) => {
      io.out(`Token (shown once, keep it somewhere safe): ${token}`);
      io.out(`MCP server: ${mcpUrl} (this server's address; use the one agents reach it at)`);
      io.out(`Claude Code: claude mcp add --transport http gh-dash ${mcpUrl} --header "Authorization: Bearer <token>"`);
      io.out(`Its comments are shown as ${agent.name}'s.`);
    };

    switch (command) {
      case 'add': {
        const { agent, token } = createAgent(open(), one('name'));
        io.out(`Added agent ${agent.name} (id ${agent.id}).`);
        printToken(agent, token);
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
          String(a.id), a.name, a.tokenPrefix ? `${a.tokenPrefix}…` : '-', a.createdAt, a.lastUsedAt ?? 'never', a.revokedAt ? `revoked ${a.revokedAt}` : 'active',
        ]);
        for (const line of table(['ID', 'NAME', 'TOKEN', 'CREATED', 'LAST USED', 'STATUS'], rows)) io.out(line);
        return 0;
      }
      case 'regenerate': {
        const { agent, token } = regenerateAgentToken(open(), agentBy(one('agent id or name')).id)!;
        io.out(`New token for ${agent.name} (id ${agent.id}); the old one no longer works.`);
        printToken(agent, token);
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
    (db as Db | null)?.close();
  }
}

/** Left-aligned columns, two spaces apart. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  '));
}
