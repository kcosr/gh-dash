// Transport helpers every source's HTTP clients share: retry signalling and backoff, token redaction, and reading a
// response body under a size cap. Each provider keeps its own error classification and request loop.

/** A failure worth retrying (network error, 5xx, a short throttle, a body that didn't parse). */
export class RetryableError extends Error {
  /** null = use exponential backoff. */
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s … capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long a client keeps trying, when its caller wants other than the client's defaults: a person waiting on the
 * answer (the Add dialog) wants few attempts and no long waits, where a background sync can wait out a throttle.
 */
export interface RetryLimits {
  maxAttempts?: number;
  /** A throttle asking for a longer wait fails as 'rate-limit' instead of sleeping. */
  maxRetryWaitMs?: number;
}

/** Error messages end up in logs, /sync/status and API errors: never let the token through. */
export function redact(token: string, message: string): string {
  return token.length >= 8 ? message.split(token).join('[token]') : message;
}

/** A response body read under a size cap. */
export interface CappedBody {
  bytes: Uint8Array;
  /** The body exceeded maxBytes; `bytes` is empty. */
  tooLarge: boolean;
}

/**
 * Reads at most `maxBytes` of the body: a Content-Length over the cap isn't read at all, and a stream that grows past
 * it is cancelled. Hosts send files of any size, so the cap is enforced here rather than trusted to them.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    return { bytes: new Uint8Array(), tooLarge: true };
  }
  if (!res.body) return { bytes: new Uint8Array(), tooLarge: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { bytes: new Uint8Array(), tooLarge: true };
    }
  }
  return { bytes: Buffer.concat(chunks), tooLarge: false };
}
