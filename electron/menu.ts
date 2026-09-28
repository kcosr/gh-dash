import { type BaseWindow, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from 'electron';

const REPO_URL = 'https://github.com/kcosr/gh-dash';
const history = (win: BaseWindow | undefined) => (win instanceof BrowserWindow ? win.webContents.navigationHistory : null);

/** The standard menus (Edit roles make copy/paste work on macOS). Reload and DevTools only when debugging. */
export function installMenu(debug: boolean): void {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: mac ? 'Cmd+[' : 'Alt+Left', click: (_item, win) => history(win)?.goBack() },
        { label: 'Forward', accelerator: mac ? 'Cmd+]' : 'Alt+Right', click: (_item, win) => history(win)?.goForward() },
        { type: 'separator' },
        ...(debug ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const) : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'gh-dash on GitHub', click: () => void shell.openExternal(REPO_URL) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
