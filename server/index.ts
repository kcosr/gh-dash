// The headless server's entry point. Silence node:sqlite's ExperimentalWarning first (see sqlite-warning.ts); the
// filter must be in place before node:sqlite loads, so the rest of the server is imported dynamically.
// `agents …` manages the MCP agents (agents-cli.ts) instead of starting the server; anything else starts it, as before.
import './sqlite-warning';

if (process.argv[2] === 'agents') {
  const { runAgentsCommand } = await import('./agents-cli');
  process.exitCode = await runAgentsCommand(process.argv.slice(3));
} else {
  await import('./main');
}

export {};
