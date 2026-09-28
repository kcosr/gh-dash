import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly details?: unknown;
  constructor(status: ContentfulStatusCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, zodMessage(r.error), r.error.issues);
  return r.data;
}

/** Parses the JSON request body; an empty body is `{}`. */
export async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}
