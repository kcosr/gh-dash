import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentView, CurrentViewReply } from '../../../shared/current-view';
import { builtInAgent, setAgentSources, setAgentViewSharing } from '../../db/agents';
import { mcpHarness, sha } from '../../test/mcp';
import { GITLAB_HOST, seedGitLab } from '../../test/seed';

const view: CurrentView = {
  mode: 'diff', target: { kind: 'pr', repo: 'alice/app', number: 2 }, baseOid: sha('a'), headOid: sha('b'),
  file: { path: 'src/index.ts', previousPath: null },
  viewport: { first: { side: 'new', lineNumber: 42 }, visible: [{ side: 'new', startLine: 42, endLine: 51 }], hunk: null },
  selection: { kind: 'text', ranges: [{ path: 'src/index.ts', side: 'new', startLine: 43, endLine: 43, text: 'a + b' }], truncated: false },
  threadId: null,
};

type Harness = ReturnType<typeof mcpHarness>;

const allow = (h: Harness) => setAgentViewSharing(h.db, h.agent.id, true);

function reply(h: Harness, body: CurrentViewReply, headers: Record<string, string> = {}) {
  return h.app.request('http://localhost/api/v1/current-view/reply', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

async function openWindow(h: Harness, headers: Record<string, string> = {}) {
  const res = await h.app.request('http://localhost/api/v1/stream', { headers });
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return {
    close: () => reader.cancel(),
    async requestId(): Promise<string> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('The window disconnected before it got a view request');
          buffer += chunk.value;
        } else {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!event.startsWith('data: ')) continue;
          const message = JSON.parse(event.slice(6));
          expect(message).toEqual({ type: 'current_view_request', requestId: expect.any(String) });
          return message.requestId;
        }
      }
    },
  };
}

describe('get_current_view', () => {
  it('requires opt-in, leaves the tokenless agent out, and returns null with no open window', async () => {
    const h = mcpHarness({ config: { mcpRequireTokens: false } });
    const nonWindow = vi.fn();
    h.bus.subscribe(nonWindow);
    expect(await h.fails('get_current_view')).toContain('sharing is off');
    const builtIn = builtInAgent(h.db);
    expect(() => setAgentViewSharing(h.db, builtIn.id, true)).toThrow('built in');
    expect((await h.call('get_current_view', {}, { authorization: null })).error).toContain('sharing is off');
    expect(allow(h)?.shareView).toBe(true);
    expect(await h.ok('get_current_view')).toEqual({ view: null });
    expect(nonWindow).not.toHaveBeenCalled();
  });

  it('uses the most recently focused live reply, consumes each window ID once, and forgets the view after the call', async () => {
    const h = mcpHarness();
    allow(h);
    const nonWindow = vi.fn();
    h.bus.subscribe(nonWindow);
    const windows = await Promise.all([openWindow(h), openWindow(h)]);
    try {
      const call = h.ok('get_current_view');
      const [older, newer] = await Promise.all(windows.map((window) => window.requestId()));
      expect(older).not.toBe(newer);
      expect((await reply(h, { requestId: randomUUID(), focusedAt: 3, view })).status).toBe(404);
      expect((await reply(h, { requestId: newer!, focusedAt: 2, view })).status).toBe(204);
      expect((await reply(h, { requestId: newer!, focusedAt: 3, view: null })).status).toBe(404);
      expect((await reply(h, { requestId: older!, focusedAt: 1, view: null })).status).toBe(204);
      expect(await call).toEqual({ view });
      expect(nonWindow).not.toHaveBeenCalled();
    } finally {
      await Promise.all(windows.map((window) => window.close()));
    }
    expect(await h.ok('get_current_view')).toEqual({ view: null });
  });

  it('never substitutes a background window when the latest view is out of scope or there is no review', async () => {
    const h = mcpHarness();
    seedGitLab(h.db);
    setAgentSources(h.db, h.agent.id, ['github.com']);
    allow(h);
    const windows = await Promise.all([openWindow(h), openWindow(h)]);
    const privateView: CurrentView = { ...view, target: { kind: 'pr', repo: `${GITLAB_HOST}/platform/app`, number: 2 } };
    try {
      for (const foreground of [privateView, null]) {
        const call = h.ok('get_current_view');
        const [first, second] = await Promise.all(windows.map((window) => window.requestId()));
        expect((await reply(h, { requestId: first!, focusedAt: 1, view })).status).toBe(204);
        expect((await reply(h, { requestId: second!, focusedAt: 2, view: foreground })).status).toBe(204);
        expect(await call).toEqual({ view: null });
      }
    } finally {
      await Promise.all(windows.map((window) => window.close()));
    }
  });

  it('rechecks access before returning data and distinguishes a timeout from a missing window', async () => {
    const h = mcpHarness();
    allow(h);
    const window = await openWindow(h);
    try {
      const pending = h.fails('get_current_view');
      const requestId = await window.requestId();
      setAgentViewSharing(h.db, h.agent.id, false);
      expect((await reply(h, { requestId, focusedAt: 1, view })).status).toBe(204);
      expect(await pending).toContain('sharing is off');
      allow(h);
      const waiting = h.fails('get_current_view');
      const late = await window.requestId();
      expect(await waiting).toContain('answered the current view request in time');
      expect((await reply(h, { requestId: late, focusedAt: 1, view })).status).toBe(404);
    } finally {
      await window.close();
    }
  });

  it('authenticates and validates replies, and drops the request on cancellation', async () => {
    const headers = { authorization: `Bearer ${'k'.repeat(32)}` };
    const h = mcpHarness({ config: { apiKey: 'k'.repeat(32) } });
    const window = await openWindow(h, headers);
    const controller = new AbortController();
    try {
      const pending = h.bus.currentView(controller.signal);
      const requestId = await window.requestId();
      expect((await reply(h, { requestId, focusedAt: 1, view })).status).toBe(401);
      expect((await reply(h, { requestId, focusedAt: 1, view }, { ...headers, host: 'localhost', origin: 'https://elsewhere.example' })).status).toBe(403);
      expect((await reply(h, { requestId: 'bad', focusedAt: 1, view }, headers)).status).toBe(400);
      controller.abort(new Error('cancelled'));
      await expect(pending).rejects.toThrow('cancelled');
      expect((await reply(h, { requestId, focusedAt: 1, view }, headers)).status).toBe(404);
    } finally {
      await window.close();
    }
  });
});
