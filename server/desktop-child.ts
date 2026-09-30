import { DESKTOP_ENV, type MainToServer, type ServerToMain } from '../shared/desktop';
import { loadServerConfig } from './config';
import {
  agentFootprint, agentTokenIs, builtInAgent, createAgent, deleteAgent, getAgent, regenerateAgentToken, setAgentEnabled, setAgentSources,
} from './db/agents';
import { deleteSource, testSourceDraft } from './services/sources';
import { type RunningServer, startServer } from './start';

/** Electron's `process.parentPort` in a utilityProcess, typed loosely so the server builds without Electron's types. */
export interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

/** A fatal message needs a moment to reach main before the process goes away. */
const FATAL_EXIT_DELAY_MS = 200;

/**
 * Handles one message from main (shared/desktop.ts has the protocol):
 * - `set-token` sets github.com's token choice and, when `token` is present, its app token (null forgets it), validates
 *   the result against GitHub and answers `token-result` (ok = no error: a valid token, or no token because nothing is
 *   chosen). With `source`, it sets that GitLab source's app token instead and answers with its SourceAccount.
 * - `reload-sources` re-reads config.json's sources and answers `sources-result`.
 * - `test-source` validates a draft source with a throwaway credential (`source-test-result`); `delete-source` removes
 *   an unconfigured source with its data (`source-deleted`); `sync-source` starts a source's sync (`sync-started`).
 * - `add-agent`, `regenerate-agent-token`, `set-agent-enabled` and `set-agent-sources` change the MCP agents
 *   (`agent-result`, with the new token for the first two), and `delete-agent` deletes one (`agent-deleted`); then they
 *   tell open windows (an `agents` stream message, saying which was deleted). `agent-footprint` says what one has
 *   written, for the warning before deleting it; `check-agent-token` whether a token main kept (by its sha256) is still
 *   the agent's.
 * - `shutdown` closes the listeners and databases, then exits 0.
 * A request that fails is answered with `request-failed` and the reason, so main never waits for nothing.
 */
export function mainMessageHandler(
  server: Pick<RunningServer, 'tokens' | 'close'> & Partial<Pick<RunningServer, 'reloadSources' | 'sources' | 'sync' | 'db' | 'diffs' | 'bus'>>,
  post: (message: ServerToMain) => void,
  exit: (code: number) => void,
): (message: unknown) => Promise<void> {
  const need = <K extends 'sources' | 'sync' | 'db' | 'diffs'>(key: K): NonNullable<RunningServer[K]> => {
    const part = server[key];
    if (!part) throw new Error("This server can't manage sources");
    return part as NonNullable<RunningServer[K]>;
  };
  const agentsDb = () => {
    if (!server.db) throw new Error("This server can't manage agents");
    return server.db;
  };
  const agentChanged = (deleted?: number) => server.bus?.emit(deleted === undefined ? { type: 'agents' } : { type: 'agents', deleted });
  const noAgent = (agent: number) => new Error(`There is no agent with id ${agent}.`);
  const handle = async (msg: MainToServer): Promise<void> => {
    if (msg.type === 'set-token' && msg.source !== undefined) {
      const runtime = need('sources').setAppToken(msg.source, msg.token);
      if (!runtime) throw new Error(`${msg.source} isn't a GitLab source here.`);
      const account = await runtime.tokens.check();
      post({ type: 'token-result', id: msg.id, ok: account.error === null, account });
    } else if (msg.type === 'set-token') {
      if (msg.token !== undefined) server.tokens.setAppToken(msg.token);
      server.tokens.setChoice(msg.choice);
      const account = await server.tokens.check();
      post({ type: 'token-result', id: msg.id, ok: account.error === null, account });
    } else if (msg.type === 'reload-sources') {
      try {
        if (!server.reloadSources) throw new Error("This server can't reload its sources");
        const runtimes = server.reloadSources();
        const sources = runtimes.filter((r) => r.config).map((r) => r.host);
        post({ type: 'sources-result', id: msg.id, ok: true, error: null, sources });
      } catch (err) {
        post({ type: 'sources-result', id: msg.id, ok: false, error: (err as Error).message, sources: [] });
      }
    } else if (msg.type === 'test-source') {
      const check = await testSourceDraft({ sources: need('sources') }, msg.draft);
      post({ type: 'source-test-result', id: msg.id, check });
    } else if (msg.type === 'delete-source') {
      const removed = deleteSource({ db: need('db'), sources: need('sources'), sync: need('sync'), diffs: need('diffs') }, msg.source);
      post({ type: 'source-deleted', id: msg.id, repos: removed.repos });
    } else if (msg.type === 'sync-source') {
      const result = await need('sync').startOrQueue({ source: msg.source });
      post({ type: 'sync-started', id: msg.id, result });
    } else if (msg.type === 'add-agent') {
      const { agent, token } = createAgent(agentsDb(), String(msg.name), undefined, msg.token ?? null, msg.sources ?? null);
      agentChanged();
      post({ type: 'agent-result', id: msg.id, agent, token });
    } else if (msg.type === 'regenerate-agent-token') {
      const made = regenerateAgentToken(agentsDb(), msg.agent, undefined, msg.token ?? null);
      if (!made) throw noAgent(msg.agent);
      agentChanged();
      post({ type: 'agent-result', id: msg.id, agent: made.agent, token: made.token });
    } else if (msg.type === 'set-agent-enabled') {
      const agent = setAgentEnabled(agentsDb(), msg.agent, msg.enabled === true);
      if (!agent) throw noAgent(msg.agent);
      agentChanged();
      post({ type: 'agent-result', id: msg.id, agent, token: null });
    } else if (msg.type === 'agent-footprint') {
      const db = agentsDb();
      if (!getAgent(db, msg.agent)) throw noAgent(msg.agent);
      post({ type: 'agent-footprint', id: msg.id, footprint: agentFootprint(db, msg.agent) });
    } else if (msg.type === 'check-agent-token') {
      const matches = typeof msg.hash === 'string' && /^[0-9a-f]{64}$/i.test(msg.hash) && agentTokenIs(agentsDb(), msg.agent, msg.hash);
      post({ type: 'agent-token-checked', id: msg.id, matches });
    } else if (msg.type === 'delete-agent') {
      const deleted = deleteAgent(agentsDb(), msg.agent);
      if (!deleted) throw noAgent(msg.agent);
      agentChanged(deleted.id);
      post({ type: 'agent-deleted', id: msg.id, deleted });
    } else if (msg.type === 'set-agent-sources') {
      const db = agentsDb();
      // The built-in agent is made the first time it's needed: limiting it before it has acted is such a time.
      const id = msg.agent === 'built-in' ? builtInAgent(db).id : msg.agent;
      const agent = setAgentSources(db, id, msg.sources ?? null);
      if (!agent) throw noAgent(id);
      agentChanged();
      post({ type: 'agent-result', id: msg.id, agent, token: null });
    } else if (msg.type === 'shutdown') {
      try {
        await server.close();
      } finally {
        exit(0);
      }
    }
  };
  return async (message) => {
    const msg = message as MainToServer | null | undefined;
    if (!msg || typeof msg !== 'object') return;
    try {
      await handle(msg);
    } catch (err) {
      if (!('id' in msg) || typeof msg.id !== 'number') throw err;
      post({ type: 'request-failed', id: msg.id, message: (err as Error).message || 'Something went wrong' });
    }
  };
}

/**
 * The desktop app's server child: reads its config in desktop mode (DESKTOP_ENV), serves the app over the socket main
 * named, plus the Local API when config.json turns it on, and answers main over `port`. Posts `ready` once listening,
 * or `fatal` and exits 1. Messages that arrive while starting wait for the server; set-token messages run one at a
 * time, in order, while shutdown doesn't wait for them.
 */
export async function runDesktopChild(
  port: ParentPort,
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<RunningServer | null> {
  const post = (message: ServerToMain) => port.postMessage(message);
  let started!: (handler: ((message: unknown) => Promise<void>) | null) => void;
  const handler = new Promise<((message: unknown) => Promise<void>) | null>((resolve) => (started = resolve));
  let queue = Promise.resolve();
  port.on('message', ({ data }) => {
    const run = async () => (await handler)?.(data);
    const report = (err: unknown) => console.error(`[desktop] ${(data as { type?: string } | null)?.type ?? 'message'} failed: ${(err as Error).message}`);
    if ((data as MainToServer | null)?.type === 'shutdown') void run().catch(report);
    else queue = queue.then(run).catch(report);
  });

  let server: RunningServer;
  try {
    const socket = env[DESKTOP_ENV.socket]?.trim();
    const secret = env[DESKTOP_ENV.secret]?.trim();
    if (!socket || !secret) throw new Error(`${DESKTOP_ENV.socket} and ${DESKTOP_ENV.secret} must be set by the desktop app`);
    const { config, env: merged } = loadServerConfig({ ...env, [DESKTOP_ENV.desktop]: '1' });
    server = await startServer({ config, env: merged, socket: { path: socket, secret } });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[startup] ${message}`);
    started(null);
    post({ type: 'fatal', message });
    setTimeout(() => exit(1), FATAL_EXIT_DELAY_MS);
    return null;
  }
  post({ type: 'ready', apiUrl: server.apiUrl, mcpUrl: server.mcpUrl });
  started(mainMessageHandler(server, post, exit));
  return server;
}
