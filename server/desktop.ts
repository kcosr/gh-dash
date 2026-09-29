// The desktop app's server child, run by Electron's utilityProcess.fork (bundled as dist/server/desktop.mjs). Silence
// node:sqlite's ExperimentalWarning first (see sqlite-warning.ts), then load the server dynamically.
import './sqlite-warning';
import tls from 'node:tls';
import type { ParentPort } from './desktop-child';

// Packaged builds disable NODE_OPTIONS (an Electron fuse), so NODE_EXTRA_CA_CERTS and --use-system-ca are out of reach.
// Trust the OS certificate store as well as Node's bundled roots, as the window's Chromium does: otherwise GitHub is
// unreachable behind TLS-inspecting proxies and corporate CAs.
try {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
} catch (error) {
  console.warn(`[tls] could not add the system certificate store: ${(error as Error).message}`);
}

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
