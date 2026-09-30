import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../../shared/api';
import { CommentBus } from './bus';

const you = { id: 1, kind: 'self' as const, name: 'You' };
const comment = (threadId: number): StreamMessage => ({
  type: 'comments', repo: 'alice/app', kind: 'pr', number: 2, commitOid: 'a'.repeat(40), threadId, event: 'replied', by: you,
});

afterEach(() => vi.useRealTimers());

describe('CommentBus', () => {
  it('tells every subscriber in order, until it unsubscribes, and counts the windows it reached', () => {
    const bus = new CommentBus();
    const seen: string[] = [];
    const offA = bus.subscribe((m) => seen.push(`a${m.type}`), { window: true });
    bus.subscribe((m) => seen.push(`b${m.type}`));
    bus.subscribe((m) => seen.push(`c${m.type}`), { window: true });
    expect(bus.windows).toBe(2);
    expect(bus.emit({ type: 'agents' })).toBe(2);
    offA();
    offA();
    expect(bus.windows).toBe(1);
    expect(bus.emit(comment(1))).toBe(1);
    expect(seen).toEqual(['aagents', 'bagents', 'cagents', 'bcomments', 'ccomments']);
  });

  it("doesn't count a window that says the message didn't reach it", () => {
    const bus = new CommentBus();
    let open = true;
    bus.subscribe(() => open, { window: true });
    bus.subscribe(() => false);
    expect(bus.emit({ type: 'agents' })).toBe(1);
    open = false;
    expect(bus.emit({ type: 'agents' })).toBe(0);
  });

  it("keeps going when a listener throws, and says so", () => {
    const log = vi.fn();
    const bus = new CommentBus(log);
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(after);
    bus.emit({ type: 'agents' });
    expect(after).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[bus] a agents listener failed: boom');
  });

  it('waits for the first matching message after the call', async () => {
    const bus = new CommentBus();
    bus.emit(comment(1));
    const waiting = bus.waitFor((m) => m.type === 'comments' && m.threadId === 2, { timeoutMs: 1000 });
    bus.emit(comment(1));
    bus.emit({ type: 'agents' });
    bus.emit(comment(2));
    bus.emit(comment(2));
    expect(await waiting).toEqual(comment(2));
    // Done waiting: it no longer listens.
    expect(bus.windows).toBe(0);
    expect((bus as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
  });

  it('gives up with null after the timeout, on abort, or when the bus closes', async () => {
    vi.useFakeTimers();
    const bus = new CommentBus();
    const timedOut = bus.waitFor(() => true, { timeoutMs: 45_000 });
    vi.advanceTimersByTime(45_000);
    expect(await timedOut).toBeNull();

    const controller = new AbortController();
    const aborted = bus.waitFor(() => true, { timeoutMs: 45_000, signal: controller.signal });
    controller.abort();
    expect(await aborted).toBeNull();
    expect(await bus.waitFor(() => true, { timeoutMs: 45_000, signal: controller.signal })).toBeNull();

    const closing = bus.waitFor(() => true, { timeoutMs: 45_000 });
    bus.close();
    expect(await closing).toBeNull();
    expect(await bus.waitFor(() => true, { timeoutMs: 45_000 })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes once: every subscriber hears it, later ones at once, and nothing is delivered after', () => {
    const bus = new CommentBus();
    const closed = vi.fn();
    const listener = vi.fn();
    bus.subscribe(listener, { window: true, onClose: closed });
    bus.close();
    bus.close();
    expect(closed).toHaveBeenCalledOnce();
    const late = vi.fn();
    bus.subscribe(listener, { onClose: late });
    expect(late).toHaveBeenCalledOnce();
    expect(bus.emit({ type: 'agents' })).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
