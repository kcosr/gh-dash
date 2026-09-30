import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors';
import { mcpHarness } from '../test/mcp';
import { REQUEST_CANCELLED } from './core';
import { within } from './diffs';
import { createMcpCore } from './index';

/** Rejections nobody handled while a test ran (Node's default for one is to stop the process). */
const unhandled: unknown[] = [];
const record = (reason: unknown) => unhandled.push(reason);
beforeAll(() => void process.on('unhandledRejection', record));
afterAll(() => void process.off('unhandledRejection', record));
afterEach(() => {
  unhandled.length = 0;
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('within', () => {
  it('handles the promise when the signal was aborted before, and it fails later', async () => {
    let fail!: (err: Error) => void;
    const fetching = new Promise<string>((_, reject) => (fail = reject));
    await expect(within(fetching, 1000, AbortSignal.abort('gone'))).rejects.toBe('gone');
    fail(new HttpError(503, 'No GitHub token'));
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('handles the promise when it fails after the wait gave up', async () => {
    let fail!: (err: Error) => void;
    const fetching = new Promise<string>((_, reject) => (fail = reject));
    await expect(within(fetching, 5, new AbortController().signal)).rejects.toMatchObject({ status: 504 });
    fail(new HttpError(502, 'host down'));
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe('a tool cancelled before it fetches a diff', () => {
  it('starts no fetch and leaves nothing unhandled when the host is failing', async () => {
    const h = mcpHarness();
    h.code.down = 'No GitHub token';
    const prDiff = vi.spyOn(h.diffs, 'prDiff');
    const core = createMcpCore({ db: h.db, config: h.config, diffs: h.diffs, bus: h.bus });
    const out = await core.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_pr', arguments: { repo: 'alice/app', number: 2 } } },
      { principal: h.agent, signal: AbortSignal.abort() },
    );
    expect(out).toMatchObject({ id: 1, error: { code: REQUEST_CANCELLED } });
    await settle();
    expect(prDiff).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
