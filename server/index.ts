// The headless server's entry point. Silence node:sqlite's ExperimentalWarning first (see sqlite-warning.ts); the
// filter must be in place before node:sqlite loads, so the rest of the server is imported dynamically.
import './sqlite-warning';

await import('./main');

export {};
