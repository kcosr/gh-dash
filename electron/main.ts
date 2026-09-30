/**
 * Electron main process: owns the window, the app:// proxy to the server child, navigation rules, the keychain
 * and config.json. See local-notes' DESIGN.md "Desktop main" and shared/desktop.ts for the contract.
 */
import { app, BrowserWindow, dialog, protocol, screen, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { CONFIG_ENV } from '../server/config-file';
import { DESKTOP_ENV, DESKTOP_ORIGIN, DESKTOP_SCHEME } from '../shared/desktop';
import { toDesktopConfig } from './config';
import { appCsp, AVATARS_ORIGIN, inlineScriptHashes } from './csp';
import { Desktop } from './desktop';
import { errorPageHtml, type ErrorPageAction } from './error-page';
import { registerIpc } from './ipc';
import { installMenu } from './menu';
import { decideLink, isAppUrl, type LinkDecision } from './navigation';
import { createProxy } from './proxy';
import { ServerChild } from './server-child';
import { mergePath, resolveShellPath } from './shell-path';
import { cleanupStaleSocketDirs, createSocketLocation } from './socket';
import { TokenStores } from './token-store';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, saveWindowState } from './window-state';

const APP_ID = 'io.github.kcosr.gh-dash';
const debug = !app.isPackaged || process.env.GH_DASH_DEBUG === '1';

// Separate from the headless server's ~/.config/gh-dash. GH_DASH_DESKTOP_USER_DATA: another profile (tests, portable).
app.setName('gh-dash');
const override = process.env.GH_DASH_DESKTOP_USER_DATA;
const userData = override && isAbsolute(override) ? override : join(app.getPath('appData'), 'gh-dash-desktop');
app.setPath('userData', userData);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  // Another launch owns this profile; it gets a 'second-instance' event and shows its window.
  app.quit();
} else {
  run();
}

function run() {
  // ---------------------------------------------------------------------------
  // Logging: stdout and <userData>/logs/main.log (the server child's output included).
  // ---------------------------------------------------------------------------
  const logFile = join(userData, 'logs', 'main.log');
  mkdirSync(join(userData, 'logs'), { recursive: true });
  try {
    if (statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
  } catch {
    /* no log yet */
  }
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    try {
      appendFileSync(logFile, `${stamped}\n`);
    } catch {
      /* logging must never take the app down */
    }
  };

  // Started now so it overlaps Electron's own startup. Everything spawned later (the server child, gh, the
  // "Locate gh" check) inherits the merged PATH from process.env.
  const shellPath = resolveShellPath().then((resolved) => {
    const before = process.env.PATH;
    if (resolved) process.env.PATH = mergePath(resolved, before);
    log(resolved ? `[env] PATH from the login shell (${process.env.PATH!.split(delimiter).length} entries)` : '[env] login shell PATH not available; using the inherited PATH');
  });
  log(`[app] gh-dash ${app.getVersion()} · electron ${process.versions.electron} · ${process.platform}-${process.arch}${app.isPackaged ? '' : ' · unpackaged'}`);

  // Chromium keeps renderer/compositor shared memory in /dev/shm; containers and some distros make it tiny (64 MB),
  // and the renderer then dies allocating tiles on the chart views. Use /tmp instead.
  if (process.platform === 'linux') {
    try {
      const st = statfsSync('/dev/shm');
      if (st.bsize * st.blocks < 512 * 1024 * 1024) {
        app.commandLine.appendSwitch('disable-dev-shm-usage');
        log(`[app] /dev/shm is ${Math.round((st.bsize * st.blocks) / 1048576)} MB: --disable-dev-shm-usage`);
      }
    } catch {
      /* no /dev/shm */
    }
  }

  protocol.registerSchemesAsPrivileged([
    { scheme: DESKTOP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } },
  ]);

  // ---------------------------------------------------------------------------
  // Paths, transport, server child
  // ---------------------------------------------------------------------------
  const appRoot = app.getAppPath();
  const configPath = join(userData, 'config.json');
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const removedSockets = cleanupStaleSocketDirs();
  if (removedSockets.length) log(`[app] removed stale socket folders: ${removedSockets.join(', ')}`);
  const socket = createSocketLocation();
  const secret = randomBytes(32).toString('hex');
  // Development only: point at another server entry (e.g. while server/desktop.ts is being written).
  const devScript = !app.isPackaged ? process.env.GH_DASH_DESKTOP_SERVER : undefined;
  const script = devScript || join(appRoot, 'dist/server/desktop.mjs');

  let scriptHashes: string[] = [];
  try {
    scriptHashes = inlineScriptHashes(readFileSync(join(appRoot, 'dist/web/index.html'), 'utf8'));
  } catch (error) {
    log(`[app] dist/web/index.html not readable (${(error as Error).message}); run npm run build`);
  }
  const csp = appCsp(scriptHashes);

  const childEnv = () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    delete env.ELECTRON_RUN_AS_NODE;
    // Instance settings live in config.json and are edited in Settings; a launching shell's HOST, PORT, GH_DASH_DB...
    // would silently override them. GITHUB_TOKEN and GITLAB_TOKEN stay (they deliberately lock the token, and Settings
    // says so), as does TZ. The child ignores the rest of the GitLab env declaration (GITLAB_TOKEN_FILE...) itself.
    for (const [key, name] of Object.entries(CONFIG_ENV)) if (key !== 'timezone') delete env[name];
    // A child that crashed can leave its socket file behind; listen() would fail with EADDRINUSE.
    if (socket.dir) rmSync(socket.path, { force: true });
    return {
      ...env,
      [DESKTOP_ENV.desktop]: '1',
      [DESKTOP_ENV.config]: configPath,
      [DESKTOP_ENV.socket]: socket.path,
      [DESKTOP_ENV.secret]: secret,
      [DESKTOP_ENV.dataDir]: dataDir,
      [DESKTOP_ENV.root]: appRoot,
    };
  };

  // github.com's pasted token in github-token.enc (as before); each GitLab source's in tokens/<host>.enc; each agent's
  // in agent-tokens/<id>.enc.
  const tokens = new TokenStores(userData, log);
  // Assigned right below; the callbacks only run once the child starts.
  let desktop!: Desktop;
  const child = new ServerChild({
    script,
    env: childEnv,
    log,
    onReady: () => {
      proxy.reset();
      desktop.onChildReady();
    },
  });
  desktop = new Desktop({
    child,
    tokens: tokens.github,
    sourceTokens: (host) => tokens.source(host),
    agentTokens: (id) => tokens.agent(id),
    configPath,
    dataDir,
    version: app.getVersion(),
    restart: () => child.restart(),
    log,
    // The renderer names the address, so main asks the user itself before GITLAB_TOKEN goes there.
    confirmEnv: async (host) => {
      const options: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: ['Use GITLAB_TOKEN', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Send GITLAB_TOKEN to ${host}?`,
        detail: `gh-dash signs in to ${host} with the token in GITLAB_TOKEN. Only go ahead if that is the GitLab it is for.`,
      };
      const win = mainWindow;
      const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      return response === 0;
    },
  });
  // The first start waits for the app to be ready and for the login shell's PATH (the child, and gh, need it);
  // requests that arrive before then wait for it too, rather than finding the child not started.
  let appReady!: () => void;
  const firstStart = Promise.all([shellPath, new Promise<void>((resolve) => (appReady = resolve))]).then(() => {
    void child.start();
  });
  const apiUrl = () => (child.status === 'running' ? child.apiUrl : null);

  const onAction = async (action: ErrorPageAction) => {
    log(`[app] error page: ${action}`);
    if (action === 'retry' && child.status !== 'running') await desktop.retry();
    else if (action === 'disable-local-api') await desktop.disableLocalApi();
    else if (action === 'show-config') {
      if (existsSync(configPath)) shell.showItemInFolder(configPath);
      else void shell.openPath(userData);
    } else if (action === 'quit') setTimeout(() => app.quit(), 0);
  };
  const localApiOn = () => {
    try {
      return toDesktopConfig(desktop.readConfig(), dataDir).listen;
    } catch {
      return false;
    }
  };
  const proxy = createProxy({
    socketPath: socket.path,
    secret,
    csp,
    whenSettled: () => firstStart.then(() => child.whenSettled()),
    failure: () => child.lastError ?? 'the server is not running',
    errorPage: () => errorPageHtml({ message: child.lastError ?? 'The server is not running.', configPath, localApiOn: localApiOn() }),
    onAction,
    log,
  });

  // ---------------------------------------------------------------------------
  // Navigation: nothing but app://gh-dash in the window; web links go to the browser.
  // ---------------------------------------------------------------------------
  const follow = (decision: LinkDecision, raw: string, via: string) => {
    if (decision.action === 'external') {
      log(`[nav] ${via}: open in browser ${decision.url}`);
      shell.openExternal(decision.url).catch((error: Error) => log(`[nav] openExternal failed: ${error.message}`));
    } else if (decision.action === 'ignore') {
      log(`[nav] ${via}: ignored ${raw.slice(0, 200)} (${decision.reason})`);
    }
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideLink(url, apiUrl());
      if (decision.action === 'app') void contents.loadURL(url);
      else follow(decision, url, 'window.open');
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event) => {
      const decision = decideLink(event.url, apiUrl());
      if (decision.action === 'app') return;
      event.preventDefault();
      follow(decision, event.url, 'navigate');
    });
    contents.on('will-redirect', (event) => {
      if (isAppUrl(event.url)) return;
      event.preventDefault();
      log(`[nav] blocked a redirect to ${event.url.slice(0, 200)}`);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  // ---------------------------------------------------------------------------
  // Window
  // ---------------------------------------------------------------------------
  const windowStateFile = join(userData, 'window-state.json');
  let mainWindow: BrowserWindow | null = null;

  function createWindow() {
    const state = loadWindowState(windowStateFile, screen.getAllDisplays().map((d) => d.workArea));
    const win = new BrowserWindow({
      ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
      width: state.width,
      height: state.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      title: 'gh-dash',
      backgroundColor: '#f6f6f3',
      ...(process.platform === 'linux' ? { icon: join(appRoot, 'dist/electron/icon.png') } : {}),
      webPreferences: {
        preload: join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        safeDialogs: true,
        devTools: debug,
      },
    });
    mainWindow = win;
    if (state.maximized) win.maximize();
    // Show on first paint; don't stay invisible if the server is slow to start (migrations, a big database).
    const show = () => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    };
    win.once('ready-to-show', show);
    setTimeout(show, 2000);
    win.on('close', () => saveWindowState(windowStateFile, { ...win.getNormalBounds(), maximized: win.isMaximized() }));
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    let crashes: number[] = [];
    win.webContents.on('render-process-gone', (_event, details) => {
      log(`[window] renderer gone: ${details.reason} (${details.exitCode})`);
      if (details.reason === 'clean-exit') return;
      const now = Date.now();
      crashes = [...crashes.filter((t) => now - t < 60_000), now];
      if (crashes.length <= 3) setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 500);
    });
    void win.loadURL(`${DESKTOP_ORIGIN}/`);
    return win;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  app.on('second-instance', () => {
    const win = mainWindow ?? createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('activate', () => {
    if (!mainWindow && app.isReady()) createWindow();
  });
  // macOS apps stay open without windows (the server keeps syncing); elsewhere closing the window quits.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting: 'no' | 'stopping' | 'done' = 'no';
  app.on('before-quit', (event) => {
    if (quitting === 'done') return;
    event.preventDefault();
    if (quitting === 'stopping') return;
    quitting = 'stopping';
    const t0 = Date.now();
    log('[quit] stopping the server');
    void child
      .stop(5_000)
      .catch((error: Error) => log(`[quit] ${error.message}`))
      .finally(() => {
        proxy.close();
        if (socket.dir) rmSync(socket.dir, { recursive: true, force: true });
        log(`[quit] done in ${Date.now() - t0} ms`);
        quitting = 'done';
        app.quit();
      });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') log(`[app] ${details.type} ${details.name ?? ''} gone: ${details.reason} (${details.exitCode})`);
  });

  void app.whenReady().then(() => {
    installMenu(debug);
    const ses = session.defaultSession;
    // The only permission the app uses: copy buttons (navigator.clipboard.writeText).
    const allowed = (permission: string, origin: string) => permission === 'clipboard-sanitized-write' && isAppUrl(origin);
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
    ses.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, origin));
    // The renderer doesn't talk to the network itself (the CSP says so too; GitHub is the server child's business),
    // except for the account's avatar image in Settings.
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      if (details.resourceType === 'image' && details.method === 'GET' && details.url.startsWith(`${AVATARS_ORIGIN}/`)) return callback({});
      log(`[net] blocked ${details.resourceType} ${details.url.slice(0, 200)}`);
      callback({ cancel: true });
    });
    protocol.handle(DESKTOP_SCHEME, (request) => proxy.handle(request));
    registerIpc(desktop, () => mainWindow, log);
    appReady();
    void desktop.restoreToken().catch((error: Error) => log(`[token] ${error.message}`));
    createWindow();
  });
}
