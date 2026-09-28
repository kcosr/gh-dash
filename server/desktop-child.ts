import { DESKTOP_ENV, type MainToServer, type ServerToMain } from '../shared/desktop';
import { loadServerConfig } from './config';
import { type RunningServer, startServer } from './start';

/** Electron's `process.parentPort` in a utilityProcess, typed loosely so the server builds without Electron's types. */
export interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

/** A fatal message needs a moment to reach main before the process goes away. */
const FATAL_EXIT_DELAY_MS = 200;

/**
 * Handles one message from main. `set-token` sets the token choice and, when `token` is present, the app token (null
 * forgets it), validates the result against GitHub and answers `token-result` (ok = no error: a valid token, or no
 * token because nothing is chosen). `shutdown` closes the listeners and databases, then exits 0.
 */
export function mainMessageHandler(
  server: Pick<RunningServer, 'tokens' | 'close'>,
  post: (message: ServerToMain) => void,
  exit: (code: number) => void,
): (message: unknown) => Promise<void> {
  return async (message) => {
    const msg = message as MainToServer | null | undefined;
    if (msg?.type === 'set-token') {
      if (msg.token !== undefined) server.tokens.setAppToken(msg.token);
      server.tokens.setChoice(msg.choice);
      const account = await server.tokens.check();
      post({ type: 'token-result', id: msg.id, ok: account.error === null, account });
    } else if (msg?.type === 'shutdown') {
      try {
        await server.close();
      } finally {
        exit(0);
      }
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
  post({ type: 'ready', apiUrl: server.apiUrl });
  started(mainMessageHandler(server, post, exit));
  return server;
}
