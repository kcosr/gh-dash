import { Hono } from 'hono';
import type { AppDeps } from '../app';

/** A comment line this often keeps an idle stream open through proxies (nginx's default read timeout is 60 s). */
export const STREAM_PING_MS = 25_000;

/**
 * GET /stream: the bus's messages (StreamMessage) as server-sent events, `data: <json>`, one per message, as they happen;
 * nothing is replayed. A window opens one EventSource, which reconnects by itself. The stream ends when the client goes
 * or the server shuts down (the bus closes), so open windows never hold a shutdown up.
 */
export function streamRoutes({ bus }: AppDeps, pingMs = STREAM_PING_MS): Hono {
  if (!bus) throw new Error('streamRoutes needs the bus');
  const r = new Hono();
  r.get('/stream', (c) => {
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();
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
        const send = (text: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            end();
          }
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
    });
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
