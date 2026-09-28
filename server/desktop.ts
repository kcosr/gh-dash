// The desktop app's server child, run by Electron's utilityProcess.fork (bundled as dist/server/desktop.mjs). Silence
// node:sqlite's ExperimentalWarning first (see sqlite-warning.ts), then load the server dynamically.
import './sqlite-warning';
import type { ParentPort } from './desktop-child';

const { runDesktopChild } = await import('./desktop-child');

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) {
  console.error('server/desktop.ts runs inside the desktop app; start a headless server with server/index.ts');
  process.exit(1);
}
const server = await runDesktopChild(port);
// Main normally sends `shutdown`; utilityProcess.kill() sends SIGTERM.
if (server) process.once('SIGTERM', () => void server.close().finally(() => process.exit(0)));

export {};
