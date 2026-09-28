/** ipcMain handlers behind window.ghDashDesktop (electron/preload.ts). */
import { type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from 'electron';
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
}
