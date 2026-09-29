/**
 * Contract between the desktop app's pieces:
 *  - Electron main process (electron/): owns the window, the OS keychain and config.json writes.
 *  - Server child (server/desktop.ts, run with utilityProcess.fork): the normal Hono app, served over a local socket.
 *  - Web app (web/): talks to the server over app://gh-dash/api/... and to main through `window.ghDashDesktop`.
 *
 * The web app must work without the bridge (headless server in a browser); desktop-only UI checks for it.
 */
import type { AccountStatus, TokenChoice } from './api';

/** The window loads app://gh-dash/...; main forwards every request to the server child. */
export const DESKTOP_SCHEME = 'app';
export const DESKTOP_HOST = 'gh-dash';
export const DESKTOP_ORIGIN = `${DESKTOP_SCHEME}://${DESKTOP_HOST}`;

/** Main adds this header (a per-launch random secret) to every forwarded request; the server child requires it. */
export const DESKTOP_SECRET_HEADER = 'x-gh-dash-desktop';

/** Environment the main process sets for the server child. */
export const DESKTOP_ENV = {
  /** "1": run as the desktop child (no env file, no default TCP listener). */
  desktop: 'GH_DASH_DESKTOP',
  /** Absolute path of config.json in the app's userData folder. */
  config: 'GH_DASH_CONFIG',
  /** Unix socket path, or \\.\pipe\... on Windows, for the app:// transport. */
  socket: 'GH_DASH_SOCKET',
  /** The per-launch secret for DESKTOP_SECRET_HEADER. */
  secret: 'GH_DASH_DESKTOP_SECRET',
  /** Default data folder (userData/data) used when config.json sets no db path. */
  dataDir: 'GH_DASH_DATA_DIR',
  /** App root (where dist/web and package.json live, possibly inside app.asar). */
  root: 'GH_DASH_ROOT_DIR',
} as const;

// ---------------------------------------------------------------------------
// Main <-> server child (utilityProcess parentPort messages)
// ---------------------------------------------------------------------------

export type MainToServer =
  /** Set (or clear) the app-provided token and/or the chosen source. Answered with `token-result`. */
  | { type: 'set-token'; id: number; choice: TokenChoice | null; token?: string | null }
  /**
   * config.json's `sources` or `glabPath` changed: re-read them and rebuild the sources that changed, without a
   * restart. Answered with `sources-result`.
   */
  | { type: 'reload-sources'; id: number }
  /** Close the listeners and databases, then exit 0. */
  | { type: 'shutdown' };

export type ServerToMain =
  /** Listening: the app:// transport is ready. `apiUrl` is the TCP listener's local URL, if one is enabled. */
  | { type: 'ready'; apiUrl: string | null }
  /**
   * Result of set-token after validating against GitHub. `ok` is false when the token was rejected
   * (bad credentials, network failure); main only remembers a pasted token when ok.
   */
  | { type: 'token-result'; id: number; ok: boolean; account: AccountStatus }
  /**
   * Result of reload-sources: the hosts of the GitLab sources now configured, or why config.json couldn't be applied
   * (nothing changed then). Tokens are validated afterwards, in the background.
   */
  | { type: 'sources-result'; id: number; ok: boolean; error: string | null; sources: string[] }
  /** Startup failed (bad config, database locked, port in use...). The child exits after sending it. */
  | { type: 'fatal'; message: string };

// ---------------------------------------------------------------------------
// Renderer <-> main (preload bridge, exposed as window.ghDashDesktop)
// ---------------------------------------------------------------------------

/** Whether a pasted token can be remembered: only with a real OS keychain (not Linux basic_text). */
export type SecureStorage = 'available' | 'unavailable';

/** Instance settings the desktop app edits (a subset of config.json). Secrets are write-only. */
export interface DesktopConfig {
  /** Folder holding gh-dash.db and gh-dash-cache.db. */
  dataDir: string;
  /** Local API: also listen on TCP so browsers, curl and scripts can use the API. Off by default. */
  listen: boolean;
  /** true = all interfaces (0.0.0.0, other devices on the network; requires a password); false = 127.0.0.1 only. */
  network: boolean;
  port: number;
  /** Extra host names accepted on the TCP listener (e.g. the machine's LAN name). */
  allowedHosts: string[];
  /** Whether an API key / password is set (the values are never sent to the renderer). */
  apiKeySet: boolean;
  passwordSet: boolean;
}

export interface DesktopConfigPatch {
  dataDir?: string;
  listen?: boolean;
  network?: boolean;
  port?: number;
  allowedHosts?: string[];
  /** A new API key; null clears it. Use `generateApiKey` to create one. */
  apiKey?: string | null;
  /** A new password; null clears it. */
  password?: string | null;
}

export interface DesktopState {
  version: string;
  platform: 'darwin' | 'win32' | 'linux' | string;
  config: DesktopConfig;
  configPath: string;
  secureStorage: SecureStorage;
  /** A pasted token is stored in the OS keychain. */
  tokenRemembered: boolean;
  /** Local API URL when the listener is on and running. */
  apiUrl: string | null;
  /** Last server start error (config problem, port in use...), shown in Settings. */
  serverError: string | null;
}

export interface DesktopTokenResult {
  ok: boolean;
  account: AccountStatus;
  /** True when the token was stored in the keychain (remember requested, ok, and secure storage available). */
  remembered: boolean;
}

export interface DesktopBridge {
  getState(): Promise<DesktopState>;
  /** Use `gh auth token` (persists choice 'gh'). */
  useGitHubCli(): Promise<DesktopTokenResult>;
  /** Validate a pasted token and use it; remember it in the OS keychain when asked and possible (choice 'app'). */
  setToken(token: string, remember: boolean): Promise<DesktopTokenResult>;
  /** Forget the pasted token (keychain included) and clear the choice. */
  signOut(): Promise<AccountStatus>;
  /** Write config.json and restart the server child; resolves once it's back (or with serverError set). */
  updateConfig(patch: DesktopConfigPatch): Promise<DesktopState>;
  /** Native folder picker for the data folder; null when cancelled. */
  chooseDataDir(): Promise<string | null>;
  /** A new random API key (not saved until passed to updateConfig). */
  generateApiKey(): Promise<string>;
  /**
   * Native file picker for the gh executable when it isn't found (a GUI app doesn't get the shell's PATH). The file
   * must answer `--version` like gh; it's saved as config.json `ghPath` and the server restarts. null when cancelled.
   */
  chooseGhPath(): Promise<DesktopState | null>;
}

/** IPC channel names used by the preload script (ipcRenderer.invoke) and main (ipcMain.handle). */
export const DESKTOP_IPC = {
  getState: 'gh-dash:get-state',
  useGitHubCli: 'gh-dash:use-gh',
  setToken: 'gh-dash:set-token',
  signOut: 'gh-dash:sign-out',
  updateConfig: 'gh-dash:update-config',
  chooseDataDir: 'gh-dash:choose-data-dir',
  generateApiKey: 'gh-dash:generate-api-key',
  chooseGhPath: 'gh-dash:choose-gh-path',
} as const;

declare global {
  interface Window {
    /** Present only inside the desktop app. */
    ghDashDesktop?: DesktopBridge;
  }
}
