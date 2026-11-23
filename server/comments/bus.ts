import type { StreamMessage } from '../../shared/api';
import type { CurrentView, CurrentViewReply } from '../../shared/current-view';
import { ViewRequests } from './view-requests';

/** A window's stream returns false when the message didn't reach it (it has ended, or was just cut off as too slow). */
export type StreamListener = (message: StreamMessage) => unknown;
type StreamNotice = Exclude<StreamMessage, { type: 'current_view_request' }>;

interface Subscription {
  listener: StreamListener;
  window: boolean;
  onClose?: () => void;
}

export interface SubscribeOptions {
  /** A window's stream (GET /stream): counted by `emit` and `windows`, as a `show` reaches it. */
  window?: boolean;
  /** Called once when the bus closes (the server is shutting down), so a stream can end its response. */
  onClose?: () => void;
}

export interface WaitOptions {
  timeoutMs: number;
  /** Aborting ends the wait at once (MCP notifications/cancelled, the request closing). */
  signal?: AbortSignal;
}

/**
 * What happens to comments and agents, as it happens, inside one server: startServer makes one and every listener's app
 * shares it (like the database and the sync). The comment services emit after each write, desktop main's agent changes
 * emit `agents`, MCP `show` emits `show`; GET /stream relays every message to the open windows and MCP's
 * wait_for_reply waits on it. Nothing is buffered: a subscriber sees what is emitted after it subscribed.
 */
export class CommentBus {
  private readonly subscribers = new Set<Subscription>();
  private readonly views = new ViewRequests();
  private closed = false;

  constructor(private readonly log: (line: string) => void = (line) => console.error(line)) {}

  /** Tells every subscriber, in the order they subscribed; returns how many windows (streams) took it. */
  emit(message: StreamNotice): number {
    let windows = 0;
    for (const s of [...this.subscribers]) {
      if (this.deliver(s, message) && s.window) windows++;
    }
    return windows;
  }

  private deliver(s: Subscription, message: StreamMessage): boolean {
    try {
      return s.listener(message) !== false;
    } catch (err) {
      this.log(`[bus] a ${message.type} listener failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Ask only the open window streams; agents waiting on comments do not see these events. */
  currentView(signal: AbortSignal): Promise<CurrentView | null> {
    return this.views.ask([...this.subscribers].filter((s) => s.window).map((s) =>
      (requestId) => this.subscribers.has(s) && this.deliver(s, { type: 'current_view_request', requestId })), signal);
  }

  replyCurrentView(reply: CurrentViewReply): boolean {
    return this.views.reply(reply);
  }

  /** Listens until the returned function is called (or the bus closes). */
  subscribe(listener: StreamListener, opts: SubscribeOptions = {}): () => void {
    if (this.closed) {
      opts.onClose?.();
      return () => {};
    }
    const entry = { listener, window: !!opts.window, onClose: opts.onClose };
    this.subscribers.add(entry);
    return () => void this.subscribers.delete(entry);
  }

  /** Windows listening now (open GET /stream connections). */
  get windows(): number {
    let n = 0;
    for (const s of this.subscribers) if (s.window) n++;
    return n;
  }

  /**
   * The first message after now that `matches`; null once `timeoutMs` passes, the signal aborts or the bus closes
   * (check `signal.aborted` to tell). Listening starts at the call: subscribe first, then look at the database, so
   * nothing that happens in between is missed.
   */
  waitFor(matches: (message: StreamMessage) => boolean, { timeoutMs, signal }: WaitOptions): Promise<StreamMessage | null> {
    return new Promise((resolve) => {
      if (signal?.aborted || this.closed) return resolve(null);
      let unsubscribe = () => {};
      const done = (message: StreamMessage | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        unsubscribe();
        resolve(message);
      };
      const aborted = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      signal?.addEventListener('abort', aborted, { once: true });
      unsubscribe = this.subscribe((message) => {
        if (matches(message)) done(message);
      }, { onClose: () => done(null) });
    });
  }

  /** Server shutdown: every subscriber's onClose runs (streams end, waits return null), and later subscribers get none. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.views.close();
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const s of subscribers) {
      try {
        s.onClose?.();
      } catch (err) {
        this.log(`[bus] closing a listener failed: ${(err as Error).message}`);
      }
    }
  }
}
