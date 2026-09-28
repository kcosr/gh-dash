import { loadServerConfig } from './config';
import { type RunningServer, startServer } from './start';

let server: RunningServer;
try {
  const { config, env } = loadServerConfig();
  server = await startServer({ config, env });
} catch (err) {
  console.error(`gh-dash: ${(err as Error).message}`);
  process.exit(1);
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[shutdown] ${signal}`);
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
