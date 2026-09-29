/** ipcMain handlers behind window.ghDashDesktop (electron/preload.ts). */
import { type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { DESKTOP_IPC } from '../shared/desktop';
import { ConfigInputError, parseTokenInput } from './config';
import type { Desktop } from './desktop';
import { isAppUrl } from './navigation';

/** Only the app window's own top frame, showing app://gh-dash. */
function trusted(event: IpcMainInvokeEvent, win: BrowserWindow | null): boolean {
  const frame = event.senderFrame;
  return !!win && !win.isDestroyed() && event.sender === win.webContents && !!frame && frame.parent === null && isAppUrl(frame.url);
}

export function registerIpc(desktop: Desktop, window: () => BrowserWindow | null, log: (line: string) => void): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!trusted(event, window())) {
        log(`[ipc] refused ${channel} from ${event.senderFrame?.url ?? 'an unknown frame'}`);
        return { error: 'Not allowed.' };
      }
      try {
        return { value: await fn(...args) };
      } catch (error) {
        if (!(error instanceof ConfigInputError)) log(`[ipc] ${channel} failed: ${(error as Error).stack ?? error}`);
        return { error: (error as Error).message || 'Something went wrong.' };
      }
    });

  handle(DESKTOP_IPC.getState, () => desktop.state());
  handle(DESKTOP_IPC.useGitHubCli, () => desktop.useGitHubCli());
  handle(DESKTOP_IPC.setToken, (token, remember) => {
    const input = parseTokenInput(token, remember);
    return desktop.setToken(input.token, input.remember);
  });
  handle(DESKTOP_IPC.signOut, () => desktop.signOut());
  handle(DESKTOP_IPC.updateConfig, (patch) => desktop.updateConfig(patch));
  handle(DESKTOP_IPC.chooseDataDir, async () => {
    const win = window();
    const options: Electron.OpenDialogOptions = {
      title: 'Choose the gh-dash data folder',
      buttonLabel: 'Use this folder',
      defaultPath: desktop.currentDataDir(),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(DESKTOP_IPC.generateApiKey, () => desktop.generateApiKey());
  handle(DESKTOP_IPC.chooseGhPath, async () => {
    const win = window();
    const options: Electron.OpenDialogOptions = {
      title: 'Locate the GitHub CLI (gh)',
      buttonLabel: 'Use this gh',
      defaultPath: homedir(),
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'gh.exe', extensions: ['exe'] }] } : {}),
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = result.canceled ? null : (result.filePaths[0] ?? null);
    return file ? desktop.setGhPath(file) : null;
  });

  // GitLab sources. The renderer names a URL, a host and a method; paths come from main's own pickers (below), and
  // Desktop refuses anything else in the arguments.
  handle(DESKTOP_IPC.testSource, (draft) => desktop.testSource(draft));
  handle(DESKTOP_IPC.addSource, (draft) => desktop.addSource(draft));
  handle(DESKTOP_IPC.setSourceCredential, (host, credential) => desktop.setSourceCredential(host, credential));
  handle(DESKTOP_IPC.signOutSource, (host) => desktop.signOutSource(host));
  handle(DESKTOP_IPC.removeSource, (host) => desktop.removeSource(host));
  const pickFile = async (title: string, buttonLabel: string, exe: string | null) => {
    const win = window();
    const options: Electron.OpenDialogOptions = {
      title,
      buttonLabel,
      defaultPath: homedir(),
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
      ...(exe && process.platform === 'win32' ? { filters: [{ name: exe, extensions: ['exe'] }] } : {}),
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
  handle(DESKTOP_IPC.chooseGlabPath, async () => {
    const file = await pickFile('Locate the GitLab CLI (glab)', 'Use this glab', 'glab.exe');
    return file ? desktop.setGlabPath(file) : null;
  });
  handle(DESKTOP_IPC.chooseTokenFile, async () => {
    const file = await pickFile('Choose the file holding the GitLab token', 'Use this file', null);
    return file ? desktop.setTokenFile(file) : null;
  });
}
