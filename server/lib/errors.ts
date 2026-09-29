import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/**
 * The error every service throws (the design's ServiceError): a status, a message for the person or agent, and
 * optional structured details. The HTTP app turns it into `{ error, details? }` with that status; another transport
 * (an MCP tool) reports the message. It carries no Hono context, so services can be called without HTTP.
 */
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

/** Validates plain input (a query string's params, a JSON body, a tool's arguments); a 400 HttpError names what is wrong. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, zodMessage(r.error), r.error.issues);
  return r.data;
}
