/**
 * Silences only node:sqlite's ExperimentalWarning (older Node 22/24 releases). The filter must be in place before
 * node:sqlite loads, so entry points import this first and load the rest of the server dynamically.
 */
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const text = typeof warning === 'string' ? warning : warning.message;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
