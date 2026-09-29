/**
 * GET /stream: what the server tells open windows as it happens (StreamMessage, as server-sent events). One connection
 * per window, opened by the shell (useStream): `comments` refetches what a change to that target's threads makes stale,
 * as threadActions does after a change made here; `agents` the agents list; `show` goes to the show chip. It reconnects
 * by itself (a server restart, the desktop app's proxy dropping it), and having missed what happened meanwhile, refetches
 * all of that once back. A server without the stream (older, or behind a proxy that won't stream) is left alone,
 * quietly: nothing else waits for it.
 *
 * fetch rather than EventSource: an EventSource gives up for good on an error answer (a 502 while the server restarts),
 * and reports nothing about why, so it couldn't tell "not there" from "back soon".
 */
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { CommentEventKind, StreamMessage } from '../../../shared/api';
import { commitDiffId } from '../lib/urlState';
import { qk, threadChangeKeys } from './hooks';

export const STREAM_URL = '/api/v1/stream';

/** Events after which a thread has more or fewer comments (a repo's comment counts change). */
const COMMENTS_CHANGE: readonly CommentEventKind[] = ['thread_opened', 'replied', 'comment_deleted', 'thread_deleted'];

/** The queries a message makes stale: for `comments`, what threadActions refetches after the same change; none for `show`. */
export function streamInvalidations(msg: StreamMessage): QueryKey[] {
  if (msg.type === 'agents') return [qk.agents];
  if (msg.type !== 'comments') return [];
  const id = msg.kind === 'pr' && msg.number !== null ? `${msg.repo}#${msg.number}` : commitDiffId(msg.repo, msg.commitOid);
  return threadChangeKeys(id, { comments: COMMENTS_CHANGE.includes(msg.event) });
}

/** What a missed stretch may have changed (after a reconnect): every list and count the stream would have refetched. */
const MISSED = new Set(['threads', 'thread-list', 'prs', 'pr', 'repos', 'activity', 'agents']);
export const missedByStream = (key: QueryKey) => MISSED.has(key[0] as string);

/** A message from the wire, or null for anything this app doesn't know (a newer server's). */
export function parseStreamMessage(data: string): StreamMessage | null {
  try {
    const m = JSON.parse(data) as StreamMessage | null;
    return m && typeof m === 'object' && (m.type === 'comments' || m.type === 'show' || m.type === 'agents') ? m : null;
  } catch {
    return null;
  }
}

/**
 * A server-sent events parser: feed it text as it arrives, in chunks of any size; it calls `onData` with each event's
 * data (its `data:` lines joined by newlines). Comments (`: ping`), `event:`, `id:` and `retry:` lines are skipped.
 */
export function sseParser(onData: (data: string) => void): (chunk: string) => void {
  let buf = '';
  let data: string[] = [];
  return (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      // A CR at the end may be the first half of a CRLF: wait for the rest.
      if (buf[i] === '\r' && i === buf.length - 1) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
      if (line === '') {
        if (data.length) onData(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line[5] === ' ' ? 6 : 5));
      }
    }
  };
}

/**
 * How long to wait before connecting again: after an error answer that won't change soon (no stream on this server,
 * signed out) a long while; after a dropped connection, a network error or a gateway's 5xx, 1 s doubling to 30 s.
 */
export function retryDelay(attempt: number, status: number | null): number {
  if (status !== null && status >= 400 && status < 500) return 5 * 60_000;
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

export interface StreamHandlers {
  onMessage: (msg: StreamMessage) => void;
  /** Connected again after a drop (not the first time): whatever happened meanwhile was missed. */
  onReconnect: () => void;
}

/** Keep a connection to the stream until `signal` aborts. */
export async function runStream(handlers: StreamHandlers, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<void> {
  let attempt = 0;
  let connected = false;
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  while (!signal.aborted) {
    let status: number | null = null;
    let opened = 0;
    try {
      const res = await fetchFn(STREAM_URL, { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal });
      status = res.status;
      if (res.ok && res.body && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        if (connected) handlers.onReconnect();
        connected = true;
        opened = Date.now();
        const feed = sseParser((data) => {
          const msg = parseStreamMessage(data);
          if (msg) handlers.onMessage(msg);
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(value);
        }
        status = null;
      } else {
        // An answer that isn't the stream: the SPA's index.html from an older server (a 200), a 404, the login's 401.
        void res.body?.cancel();
        if (res.ok) status = 404;
      }
    } catch {
      if (signal.aborted) return;
    }
    // Back off from the first try again, unless it closed at once (a proxy that won't keep it open).
    if (opened && Date.now() - opened > 10_000) attempt = 0;
    await wait(retryDelay(attempt++, status));
  }
}

/** Apply a message: refetch what it makes stale (only what's on screen is fetched now; the rest when it's next shown). */
export function applyStreamMessage(qc: QueryClient, msg: StreamMessage): void {
  for (const queryKey of streamInvalidations(msg)) void qc.invalidateQueries({ queryKey });
}

/** Mount once per window (the shell). `onShow`: an agent's `show`, for the chip. */
export function useStream(onShow: (msg: Extract<StreamMessage, { type: 'show' }>) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    const ctl = new AbortController();
    void runStream({
      onMessage: (msg) => (msg.type === 'show' ? onShow(msg) : applyStreamMessage(qc, msg)),
      onReconnect: () => void qc.invalidateQueries({ predicate: (q) => missedByStream(q.queryKey) }),
    }, ctl.signal);
    return () => ctl.abort();
  }, [qc, onShow]);
}
