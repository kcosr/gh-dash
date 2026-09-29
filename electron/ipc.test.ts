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
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/home/alice/gl-token'] });
    expect(await invoke(DESKTOP_IPC.chooseTokenFile, '/etc/shadow')).toEqual({ value: '/home/alice/gl-token' });
    expect(desktop.setTokenFile).toHaveBeenCalledWith('/home/alice/gl-token');
    expect(electron.showOpenDialog.mock.calls[0]![0]).toBe(win);
    expect(electron.showOpenDialog.mock.calls[0]![1]).toMatchObject({ title: 'Choose the file holding the GitLab token', properties: expect.arrayContaining(['openFile']) });
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(DESKTOP_IPC.chooseTokenFile)).toEqual({ value: null });
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
