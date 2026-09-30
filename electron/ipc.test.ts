import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC } from '../shared/desktop';
import { ConfigInputError } from './config';
import type { Desktop } from './desktop';
import { registerIpc } from './ipc';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  showOpenDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => electron.handlers.set(channel, fn) },
  dialog: { showOpenDialog: electron.showOpenDialog },
}));

const webContents = {};
const win = { isDestroyed: () => false, webContents };
const appFrame = { event: { sender: webContents, senderFrame: { parent: null, url: 'app://gh-dash/settings' } } };
const invoke = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!(appFrame.event, ...args);

let desktop: Record<string, ReturnType<typeof vi.fn>>;
const logs: string[] = [];
beforeEach(() => {
  electron.handlers.clear();
  electron.showOpenDialog.mockReset();
  logs.length = 0;
  desktop = {
    testSource: vi.fn(async () => ({ ok: true })),
    addSource: vi.fn(async () => ({ saved: true })),
    setSourceCredential: vi.fn(async () => ({ saved: true })),
    signOutSource: vi.fn(async () => ({ source: 'none' })),
    removeSource: vi.fn(async () => ({ sources: [] })),
    setGlabPath: vi.fn(async (path: string) => ({ glab: { path, chosen: true } })),
    setTokenFile: vi.fn((path: string) => path),
    addAgent: vi.fn(async (name: string) => ({ agent: { id: 2, name }, token: 'ghd_x' })),
    regenerateAgentToken: vi.fn(async (id: number) => ({ agent: { id, name: 'Claude' }, token: 'ghd_y' })),
    revokeAgent: vi.fn(async (id: number) => ({ id, name: 'Claude', revokedAt: 'x' })),
    setAgentSources: vi.fn(async (id: number | 'built-in', sources: string[] | null) => ({ id: id === 'built-in' ? 5 : id, name: id === 'built-in' ? 'Agent' : 'Claude', sources })),
    enableMcp: vi.fn(async () => ({ mcpUrl: 'http://127.0.0.1:4780/mcp' })),
    tokenFileHost: vi.fn((url: unknown) => {
      if (url !== 'https://gitlab.example.com') throw new ConfigInputError('Enter the address first.');
      return 'gitlab.example.com';
    }),
  };
  registerIpc(desktop as unknown as Desktop, () => win as never, (line) => logs.push(line));
});

describe('the GitLab sources over IPC', () => {
  it('passes the renderer\'s arguments through to Desktop, which checks them', async () => {
    const draft = { kind: 'gitlab', url: 'https://gitlab.example.com', method: 'glab' };
    expect(await invoke(DESKTOP_IPC.testSource, draft)).toEqual({ value: { ok: true } });
    expect(await invoke(DESKTOP_IPC.addSource, draft)).toEqual({ value: { saved: true } });
    expect(await invoke(DESKTOP_IPC.setSourceCredential, 'gitlab.example.com', { method: 'glab' })).toEqual({ value: { saved: true } });
    await invoke(DESKTOP_IPC.signOutSource, 'gitlab.example.com');
    await invoke(DESKTOP_IPC.removeSource, 'gitlab.example.com');
    expect(desktop.testSource).toHaveBeenCalledWith(draft);
    expect(desktop.setSourceCredential).toHaveBeenCalledWith('gitlab.example.com', { method: 'glab' });
    expect(desktop.signOutSource).toHaveBeenCalledWith('gitlab.example.com');
    expect(desktop.removeSource).toHaveBeenCalledWith('gitlab.example.com');
    // A refusal is the message, without a stack in the log.
    desktop.addSource.mockRejectedValueOnce(new ConfigInputError('Unexpected tokenFile.'));
    expect(await invoke(DESKTOP_IPC.addSource, { ...draft, tokenFile: '/etc/shadow' })).toEqual({ error: 'Unexpected tokenFile.' });
    expect(logs).toEqual([]);
  });

  it('takes paths only from its own pickers', async () => {
    // The picker is for one source: named in its title, and kept for that host only.
    expect(await invoke(DESKTOP_IPC.chooseTokenFile, '/etc/shadow')).toEqual({ error: 'Enter the address first.' });
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/home/alice/gl-token'] });
    expect(await invoke(DESKTOP_IPC.chooseTokenFile, 'https://gitlab.example.com')).toEqual({ value: '/home/alice/gl-token' });
    expect(desktop.setTokenFile).toHaveBeenCalledWith('/home/alice/gl-token', 'gitlab.example.com');
    expect(electron.showOpenDialog.mock.calls[0]![0]).toBe(win);
    expect(electron.showOpenDialog.mock.calls[0]![1]).toMatchObject({ title: 'Choose the file holding the GitLab token for gitlab.example.com', properties: expect.arrayContaining(['openFile']) });
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(DESKTOP_IPC.chooseTokenFile, 'https://gitlab.example.com')).toEqual({ value: null });
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/opt/homebrew/bin/glab'] });
    expect(await invoke(DESKTOP_IPC.chooseGlabPath, '/tmp/evil')).toEqual({ value: { glab: { path: '/opt/homebrew/bin/glab', chosen: true } } });
    expect(desktop.setGlabPath).toHaveBeenCalledWith('/opt/homebrew/bin/glab');
    expect(desktop.setTokenFile).toHaveBeenCalledTimes(1);
  });

  it('refuses every call from anything but the app window\'s own page', async () => {
    const fn = electron.handlers.get(DESKTOP_IPC.addSource)!;
    const other = { sender: webContents, senderFrame: { parent: null, url: 'https://evil.example/' } };
    const framed = { sender: webContents, senderFrame: { parent: {}, url: 'app://gh-dash/' } };
    expect(await fn(other, { kind: 'gitlab' })).toEqual({ error: 'Not allowed.' });
    expect(await fn(framed, { kind: 'gitlab' })).toEqual({ error: 'Not allowed.' });
    expect(desktop.addSource).not.toHaveBeenCalled();
    expect(logs).toEqual([`[ipc] refused ${DESKTOP_IPC.addSource} from https://evil.example/`, `[ipc] refused ${DESKTOP_IPC.addSource} from app://gh-dash/`]);
  });
});

describe('the agents over IPC', () => {
  it("passes the renderer's arguments to Desktop and the new token back, once", async () => {
    expect(await invoke(DESKTOP_IPC.addAgent, 'Claude')).toEqual({ value: { agent: { id: 2, name: 'Claude' }, token: 'ghd_x' } });
    expect(await invoke(DESKTOP_IPC.regenerateAgentToken, 2)).toEqual({ value: { agent: { id: 2, name: 'Claude' }, token: 'ghd_y' } });
    expect(await invoke(DESKTOP_IPC.revokeAgent, 2)).toEqual({ value: { id: 2, name: 'Claude', revokedAt: 'x' } });
    expect(desktop.addAgent).toHaveBeenCalledWith('Claude', undefined, undefined);
    expect(desktop.regenerateAgentToken).toHaveBeenCalledWith(2, undefined);
    expect(desktop.revokeAgent).toHaveBeenCalledWith(2);
    desktop.addAgent.mockRejectedValueOnce(new ConfigInputError('There is already an agent called Claude (id 2); regenerate its token instead'));
    expect(await invoke(DESKTOP_IPC.addAgent, 'claude')).toEqual({ error: 'There is already an agent called Claude (id 2); regenerate its token instead' });
    expect(logs).toEqual([]);
    const fn = electron.handlers.get(DESKTOP_IPC.addAgent)!;
    expect(await fn({ sender: webContents, senderFrame: { parent: null, url: 'https://evil.example/' } }, 'Evil')).toEqual({ error: 'Not allowed.' });
    expect(desktop.addAgent).toHaveBeenCalledTimes(2);
  });

  it('passes a token the user chose along, and turns MCP on', async () => {
    await invoke(DESKTOP_IPC.addAgent, 'Claude', 'my-own-agent-token-0123456789');
    await invoke(DESKTOP_IPC.regenerateAgentToken, 2, 'another-token-of-mine-98765');
    expect(desktop.addAgent).toHaveBeenLastCalledWith('Claude', 'my-own-agent-token-0123456789', undefined);
    expect(desktop.regenerateAgentToken).toHaveBeenLastCalledWith(2, 'another-token-of-mine-98765');
    expect(await invoke(DESKTOP_IPC.enableMcp)).toEqual({ value: { mcpUrl: 'http://127.0.0.1:4780/mcp' } });
    expect(logs).toEqual([]);
  });

  it('passes the sources an agent may reach along, for a new agent and one already there', async () => {
    await invoke(DESKTOP_IPC.addAgent, 'Work', undefined, ['gitlab.example.com']);
    expect(desktop.addAgent).toHaveBeenLastCalledWith('Work', undefined, ['gitlab.example.com']);
    expect(await invoke(DESKTOP_IPC.setAgentSources, 'built-in', ['github.com'])).toEqual({ value: { id: 5, name: 'Agent', sources: ['github.com'] } });
    expect(desktop.setAgentSources).toHaveBeenLastCalledWith('built-in', ['github.com']);
    const fn = electron.handlers.get(DESKTOP_IPC.setAgentSources)!;
    expect(await fn({ sender: webContents, senderFrame: { parent: null, url: 'https://evil.example/' } }, 2, null)).toEqual({ error: 'Not allowed.' });
    expect(desktop.setAgentSources).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['[ipc] refused gh-dash:set-agent-sources from https://evil.example/']);
  });
});
