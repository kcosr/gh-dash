import { describe, expect, it } from 'vitest';
import { backoffMs, readCapped, redact, RetryableError } from './transport';

describe('provider transport helpers', () => {
  it('masks every copy of the token, but leaves text alone for a token too short to mask safely', () => {
    expect(redact('glpat-0123456789', 'Bearer glpat-0123456789 and glpat-0123456789 again')).toBe('Bearer [token] and [token] again');
    expect(redact('short', 'a short message')).toBe('a short message');
  });

  it('backs off exponentially with jitter, capped at 30 s', () => {
    for (const [attempt, base] of [[1, 1000], [2, 2000], [4, 8000], [10, 30_000]] as const) {
      const ms = backoffMs(attempt);
      expect(ms).toBeGreaterThanOrEqual(base);
      expect(ms).toBeLessThan(base + 500);
    }
    expect(new RetryableError('busy', 1500)).toMatchObject({ message: 'busy', retryAfterMs: 1500 });
  });

  it('reads a body under the cap, and refuses a declared or streamed body over it without keeping any of it', async () => {
    const ok = await readCapped(new Response('hello'), 10);
    expect([ok.tooLarge, Buffer.from(ok.bytes).toString()]).toEqual([false, 'hello']);
    expect(await readCapped(new Response('x', { headers: { 'content-length': '11' } }), 10)).toEqual({ bytes: new Uint8Array(), tooLarge: true });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(6));
      },
    });
    expect(await readCapped(new Response(stream), 10)).toEqual({ bytes: new Uint8Array(), tooLarge: true });
    expect(await readCapped(new Response(null), 10)).toEqual({ bytes: new Uint8Array(), tooLarge: false });
  });
});
