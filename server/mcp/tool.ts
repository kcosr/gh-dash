// What a tool is: a name, what an agent reads about it, a zod input schema (published as JSON Schema) and a function
// from validated arguments to a JSON object. Tools reach gh-dash through McpDeps and act as the calling principal.

import { z } from 'zod';
import type { Principal } from '../../shared/api';
import type { Config } from '../config';
import type { Db } from '../db/db';
import type { DiffService } from '../diff/service';

/** What tools read and write. */
export interface McpDeps {
  db: Db;
  config: Pick<Config, 'version' | 'defaultTz' | 'myEmails'>;
  diffs: DiffService;
}

/** One call: who is asking, and a signal that aborts when the request is cancelled or its connection closes. */
export interface CallContext {
  principal: Principal;
  signal: AbortSignal;
}

export interface ToolContext extends CallContext {
  deps: McpDeps;
}

/** MCP's tool annotations: hints for the client (confirmation prompts, auto-approval), never enforced. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  /** A human-readable name, for the client's UI. */
  title: string;
  /** What the agent reads to decide when and how to call it: short and concrete. */
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** A JSON object (the result's structuredContent); failures throw HttpError, whose message the agent reads. */
  run(args: z.output<S>, ctx: ToolContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Every tool works on gh-dash's own database (openWorldHint false: it never posts to the code host). The spec's defaults
 * for a tool that isn't read-only are destructive and not idempotent, so writes say what they are.
 */
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function readTool<S extends z.ZodObject>(t: Omit<Tool<S>, 'annotations'>): Tool<S> {
  return { ...t, annotations: READ };
}

export function writeTool<S extends z.ZodObject>(t: Omit<Tool<S>, 'annotations'>, hints: Pick<ToolAnnotations, 'destructiveHint' | 'idempotentHint'> = {}): Tool<S> {
  return { ...t, annotations: { ...WRITE, ...hints } };
}

/** The tool as tools/list describes it. `$schema` is left out: MCP input schemas are JSON Schema 2020-12 by default. */
export function toolListing(t: Tool): Record<string, unknown> {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { name: t.name, title: t.title, description: t.description, inputSchema, annotations: t.annotations };
}
