import { randomUUID } from 'node:crypto';
import type { CurrentView, CurrentViewReply } from '../../shared/current-view';
import { HttpError } from '../lib/errors';

const REPLY_TIMEOUT_MS = 900;
const MAX_PENDING_REQUESTS = 32;

/** Deliver an opaque reply ID to a single stream. False means it could not receive the request. */
type ViewWindow = (requestId: string) => boolean;

/** A server-wide request collector. It only holds answers while their MCP call is pending. */
export class ViewRequests {
  private readonly requests = new Set<() => void>();
  private readonly replies = new Map<string, (reply: CurrentViewReply) => void>();

  async ask(windows: readonly ViewWindow[], signal: AbortSignal): Promise<CurrentView | null> {
    signal.throwIfAborted();
    if (!windows.length) return null;
    if (this.requests.size >= MAX_PENDING_REQUESTS) throw new HttpError(429, 'Too many current view requests are pending');

    return new Promise((resolve, reject) => {
      const remaining = new Map<string, ViewWindow>(windows.map((send) => [randomUUID(), send]));
      let newest: CurrentViewReply | null = null;

      const cleanup = () => {
        clearTimeout(deadline);
        for (const requestId of remaining.keys()) this.replies.delete(requestId);
        remaining.clear();
        this.requests.delete(close);
        signal.removeEventListener('abort', cancel);
      };
      const close = () => { cleanup(); resolve(null); };
      const cancel = () => { cleanup(); reject(signal.reason); };
      const complete = () => { cleanup(); resolve(newest?.view ?? null); };
      const deadline = setTimeout(() => {
        if (newest) complete();
        else {
          cleanup();
          reject(new HttpError(504, 'No gh-dash window answered the current view request in time'));
        }
      }, REPLY_TIMEOUT_MS);

      const retire = (requestId: string) => {
        if (!remaining.delete(requestId)) return;
        this.replies.delete(requestId);
        if (!remaining.size) complete();
      };
      this.requests.add(close);
      signal.addEventListener('abort', cancel, { once: true });
      // Register every recipient before dispatch. An opaque ID is valid for exactly one reply.
      for (const requestId of remaining.keys()) this.replies.set(requestId, (reply) => {
        if (!newest || reply.focusedAt > newest.focusedAt) newest = reply;
        retire(requestId);
      });
      for (const [requestId, send] of remaining) if (!send(requestId)) retire(requestId);
    });
  }

  reply(reply: CurrentViewReply): boolean {
    const accept = this.replies.get(reply.requestId);
    if (!accept) return false;
    accept(reply);
    return true;
  }

  close(): void {
    for (const close of this.requests) close();
  }
}
