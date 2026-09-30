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
import { branchDiffId, commitDiffId } from '../lib/urlState';
import { qk, threadChangeKeys } from './hooks';

export const STREAM_URL = '/api/v1/stream';

/** Events after which a thread has more or fewer comments (a repo's comment counts change). */
const COMMENTS_CHANGE: readonly CommentEventKind[] = ['thread_opened', 'replied', 'comment_deleted', 'thread_deleted'];

/**
 * The queries a message makes stale: for `comments`, what threadActions refetches after the same change (a thread with
 * a branch reaches its branch's view and its PRs'); none for `show`.
 */
export function streamInvalidations(msg: StreamMessage): QueryKey[] {
  if (msg.type === 'agents') return [qk.agents];
  if (msg.type !== 'comments') return [];
  const id = msg.kind === 'pr' && msg.number !== null ? `${msg.repo}#${msg.number}`
    : msg.kind === 'branch' && msg.branch ? branchDiffId(msg.repo, msg.branch)
      : commitDiffId(msg.repo, msg.commitOid);
  return threadChangeKeys(id, { comments: COMMENTS_CHANGE.includes(msg.event), branch: msg.branch });
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
 * signed out) a long while; after a dropped connection, a network error or a 5xx (a gateway, or a server with too
 * many streams open), 1 s doubling to 30 s, or the answer's Retry-After (seconds) when that is longer, up to the
 * long wait.
 */
export function retryDelay(attempt: number, status: number | null, retryAfter: number | null = null): number {
  const long = 5 * 60_000;
  if (status !== null && status >= 400 && status < 500) return long;
  const backoff = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return retryAfter !== null && retryAfter > 0 ? Math.min(long, Math.max(backoff, retryAfter * 1000)) : backoff;
}

/** A Retry-After header's seconds (a date is read as the time until it); null when absent or unreadable. */
function retryAfterOf(res: Response): number | null {
  const v = res.headers.get('retry-after')?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null;
}

/** Resolves after `ms`, or at once when `signal` aborts (already or meanwhile); leaves no listener behind either way. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface StreamHandlers {
  onMessage: (msg: StreamMessage) => void;
  /** Connected again after a drop (not the first time): whatever happened meanwhile was missed. */
  onReconnect: () => void;
}

/**
 * Keep a connection to the stream until `signal` aborts. `resumed`: an earlier connection was let go (a tab in the
 * background), so the first one is a reconnect too.
 */
export async function runStream(handlers: StreamHandlers, signal: AbortSignal, opts: { resumed?: boolean; fetch?: typeof fetch } = {}): Promise<void> {
  const fetchFn = opts.fetch ?? fetch;
  let attempt = 0;
  let connected = !!opts.resumed;
  while (!signal.aborted) {
    let status: number | null = null;
    let retryAfter: number | null = null;
    let opened = 0;
    try {
      const res = await fetchFn(STREAM_URL, { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal });
      status = res.status;
      retryAfter = retryAfterOf(res);
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
    await abortableDelay(retryDelay(attempt++, status, retryAfter), signal);
  }
}

/** Apply a message: refetch what it makes stale (only what's on screen is fetched now; the rest when it's next shown). */
export function applyStreamMessage(qc: QueryClient, msg: StreamMessage): void {
  for (const queryKey of streamInvalidations(msg)) void qc.invalidateQueries({ queryKey });
}

/** How long a browser tab stays connected in the background before it lets go of its connection. */
export const HIDDEN_MS = 60_000;

/**
 * Mount once per window (the shell). `onShow`: an agent's `show`, for the chip. A browser tab left in the background
 * lets go of its connection after a minute (a browser has six per server over HTTP/1.1, and each tab would hold one),
 * and catches up when it's shown again. The desktop app's window keeps it: its requests don't use the network.
 */
export function useStream(onShow: (msg: Extract<StreamMessage, { type: 'show' }>) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    let ctl: AbortController | null = null;
    let ran = false;
    let timer = 0;
    const handlers: StreamHandlers = {
      onMessage: (msg) => (msg.type === 'show' ? onShow(msg) : applyStreamMessage(qc, msg)),
      onReconnect: () => void qc.invalidateQueries({ predicate: (q) => missedByStream(q.queryKey) }),
    };
    const start = () => {
      if (ctl) return;
      ctl = new AbortController();
      void runStream(handlers, ctl.signal, { resumed: ran });
      ran = true;
    };
    const stop = () => { ctl?.abort(); ctl = null; };
    const keep = !!window.ghDashDesktop;
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') start();
      else if (!keep) timer = window.setTimeout(stop, HIDDEN_MS);
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [qc, onShow]);
}
