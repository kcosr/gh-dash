import { Hono } from 'hono';
import type { AppDeps } from '../app';

/** A comment line this often keeps an idle stream open through proxies (nginx's default read timeout is 60 s). */
export const STREAM_PING_MS = 25_000;
/** Most streams (open windows) one server serves at once; more are refused with 503 and Retry-After. */
export const MAX_STREAMS = 32;
/**
 * Most bytes a stream holds for a client that isn't reading them (the connection's own buffers aside). Past it the client
 * is cut off and what it hadn't read is dropped: a window refetches everything when it reconnects, so nothing is lost.
 */
export const MAX_QUEUED_BYTES = 256 * 1024;
/** What a refused stream is told to wait, in seconds. */
const RETRY_AFTER_S = 15;

export interface StreamOptions {
  pingMs?: number;
  maxStreams?: number;
  maxQueuedBytes?: number;
}

/**
 * GET /stream: the bus's messages (StreamMessage) as server-sent events, `data: <json>`, one per message, as they happen;
 * nothing is replayed. A window opens one EventSource, which reconnects by itself. The stream ends when the client goes
 * or the server shuts down (the bus closes), so open windows never hold a shutdown up. Bounded: at most `maxStreams` at
 * once per server (503 beyond), and a client that stops reading is cut off once `maxQueuedBytes` wait for it.
 */
export function streamRoutes({ bus }: AppDeps, opts: StreamOptions = {}): Hono {
  if (!bus) throw new Error('streamRoutes needs the bus');
  const { pingMs = STREAM_PING_MS, maxStreams = MAX_STREAMS, maxQueuedBytes = MAX_QUEUED_BYTES } = opts;
  const r = new Hono();
  r.get('/stream', (c) => {
    // The bus is the server's (every listener's app shares it), so this counts every open window.
    if (bus.windows >= maxStreams) {
      c.header('Retry-After', String(RETRY_AFTER_S));
      return c.json({ error: `Too many live streams open (${maxStreams}); try again later` }, 503);
    }
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();
    // What the stream may hold unread, in bytes: its desiredSize goes below zero past it.
    const budget = new ByteLengthQueuingStrategy({ highWaterMark: maxQueuedBytes });
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        let unsubscribe = () => {};
        const ping = setInterval(() => send(': ping\n\n'), pingMs);
        cleanup = () => {
          clearInterval(ping);
          unsubscribe();
          signal.removeEventListener('abort', end);
        };
        const end = () => {
          if (!open) return;
          open = false;
          cleanup();
          try {
            controller.close();
          } catch { /* already closed or errored */ }
        };
        // Too far behind: stop listening and let the client go, dropping what it hasn't read. On Node the connection is
        // closed, and the server then cancels the stream (its queue goes) without logging an error; elsewhere the stream
        // errors, which drops its queue too.
        const cutOff = () => {
          open = false;
          cleanup();
          const outgoing = (c.env as { outgoing?: { destroy(): void } } | undefined)?.outgoing;
          if (outgoing) outgoing.destroy();
          else controller.error(new Error('The client fell too far behind'));
        };
        /** False when the text didn't reach the client: the stream has ended, or this cut it off. */
        const send = (text: string): boolean => {
          if (!open) return false;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            end();
            return false;
          }
          if ((controller.desiredSize ?? 0) >= 0) return true;
          cutOff();
          return false;
        };
        signal.addEventListener('abort', end, { once: true });
        // A closed bus (the server is going) ends the stream at once, through onClose.
        unsubscribe = bus.subscribe((message) => send(`data: ${JSON.stringify(message)}\n\n`), { window: true, onClose: end });
        if (signal.aborted) end();
        // Something at once: proxies pass the headers on, and the EventSource opens.
        send(': connected\n\n');
      },
      cancel() {
        cleanup();
      },
    }, budget);
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        // nginx: pass each event on as it comes (see deploy/nginx.conf.example).
        'X-Accel-Buffering': 'no',
        // Not kept alive once it ends: at shutdown, the connection goes with its stream instead of idling past close().
        Connection: 'close',
      },
    });
  });
  return r;
}
