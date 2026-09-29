/**
 * Contract between the desktop app's pieces:
 *  - Electron main process (electron/): owns the window, the OS keychain and config.json writes.
 *  - Server child (server/desktop.ts, run with utilityProcess.fork): the normal Hono app, served over a local socket.
 *  - Web app (web/): talks to the server over app://gh-dash/api/... and to main through `window.ghDashDesktop`.
 *
 * The web app must work without the bridge (headless server in a browser); desktop-only UI checks for it.
 */
import type { AccountStatus, SourceAccount, SourceCheck, TokenChoice } from './api';

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

/**
 * How a GitLab source's token is found, as the desktop app sets it up: a pasted token main holds (`app`), what glab has
 * for the host, a token file, or GITLAB_TOKEN in the app's environment.
 */
export type SourceMethod = 'app' | 'glab' | 'file' | 'env';

/**
 * A GitLab source to test (test-source): its URL and how its token would be found. Main fills in the token file (its
 * own picker's choice) and the variable; the renderer supplies neither (see CredentialDraft).
 */
export interface SourceTestDraft {
  url: string;
  method: SourceMethod;
  /** `app`: the pasted token. */
  token?: string;
  /** `file`: the absolute path main's file picker returned. */
  tokenFile?: string;
  /** `env`: the variable holding the token (GITLAB_TOKEN). */
  tokenEnv?: string;
}

export type MainToServer =
  /** Set (or clear) github.com's app-provided token and/or its chosen source. Answered with `token-result`. */
  | { type: 'set-token'; id: number; choice: TokenChoice | null; token?: string | null; source?: undefined }
  /**
   * A GitLab source's app token (pasted, or restored from the keychain); null forgets it. The source's method is its
   * config.json entry, which main writes and reloads first. Answered with `token-result` (a SourceAccount).
   */
  | { type: 'set-token'; id: number; source: string; token: string | null }
  /**
   * config.json's `sources` or `glabPath` changed: re-read them and rebuild the sources that changed, without a
   * restart. Answered with `sources-result`.
   */
  | { type: 'reload-sources'; id: number }
  /** Resolve and validate a draft source with a throwaway credential; nothing is kept. Answered with `source-test-result`. */
  | { type: 'test-source'; id: number; draft: SourceTestDraft }
  /**
   * Delete a source and all its data, once main has taken it out of config.json and reloaded (a configured source is
   * refused). Answered with `source-deleted`.
   */
  | { type: 'delete-source'; id: number; source: string }
  /** Start the source's sync now, or after the one running (a source just added). Answered with `sync-started`. */
  | { type: 'sync-source'; id: number; source: string }
  /** Close the listeners and databases, then exit 0. */
  | { type: 'shutdown' };

export type ServerToMain =
  /** Listening: the app:// transport is ready. `apiUrl` is the TCP listener's local URL, if one is enabled. */
  | { type: 'ready'; apiUrl: string | null }
  /**
   * Result of set-token after validating the token: github.com's AccountStatus, or the GitLab source's SourceAccount
   * when set-token named one. `ok` is false when the token was rejected (bad credentials, network failure); main only
   * remembers a pasted token when ok.
   */
  | { type: 'token-result'; id: number; ok: boolean; account: AccountStatus | SourceAccount }
  /**
   * Result of reload-sources: the hosts of the GitLab sources now configured, or why config.json couldn't be applied
   * (nothing changed then). Tokens are validated afterwards, in the background.
   */
  | { type: 'sources-result'; id: number; ok: boolean; error: string | null; sources: string[] }
  /** Result of test-source. */
  | { type: 'source-test-result'; id: number; check: SourceCheck }
  /** Result of delete-source: how many repositories went with it. */
  | { type: 'source-deleted'; id: number; repos: number }
  /** Result of sync-source. */
  | { type: 'sync-started'; id: number; result: 'started' | 'queued' }
  /** A request with an `id` failed (an unknown source, one still configured...): `message` says why, for the user. */
  | { type: 'request-failed'; id: number; message: string }
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
  /** The GitLab sources in config.json (the app adds them in Settings → Sources). */
  sources: DesktopSource[];
  /**
   * The GitLab CLI: config.json's glabPath when set (`chosen`), else where it was found on PATH or in the usual install
   * folders; null when it wasn't found (or the chosen one is gone).
   */
  glab: { path: string | null; chosen: boolean };
  /**
   * GITLAB_TOKEN in the app's environment, for a new GitLab source: `unset`; `offered` (one of the ways to sign in,
   * sent only after main's dialog); `in-use` (another source's entry names it). It is never a source's by default.
   */
  gitlabEnv: 'unset' | 'offered' | 'in-use';
}

/** A GitLab source in the app's config.json. */
export interface DesktopSource {
  host: string;
  /** Its URL, relative root included. */
  url: string;
  /** A pasted token for it is stored in the OS keychain. */
  tokenRemembered: boolean;
}

/**
 * How to get a GitLab source's token, as the renderer asks for it. Never a path or a variable name: `file` is the file
 * last picked with chooseTokenFile() for the same source (main keeps it), and `env` is GITLAB_TOKEN, allowed only when
 * it is set in the app's environment and the user agrees, in main's own dialog, to send it to that host. A pasted
 * token goes to main once and is never read back.
 */
export type CredentialDraft =
  | { method: 'app'; token: string; remember: boolean }
  | { method: 'glab' }
  | { method: 'file' }
  | { method: 'env' };

/** A GitLab source to test or add: its URL (with any relative root) and a credential. */
export type SourceDraft = { kind: 'gitlab'; url: string } & CredentialDraft;

export interface DesktopSourceResult {
  /** The test that decided: the account, instance, scopes and expiry, or the error or conflict. */
  check: SourceCheck;
  /** Added (addSource) or switched to the new credential (setSourceCredential). When false, nothing changed. */
  saved: boolean;
  /** The pasted token was stored in the OS keychain. */
  remembered: boolean;
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
  /** Tests a GitLab source before adding it: the account, instance, scopes and expiry, or why not. Saves nothing. */
  testSource(draft: SourceDraft): Promise<SourceCheck>;
  /**
   * Tests the source again, then adds it to config.json (the pasted token to the OS keychain when asked and possible),
   * loads it without a restart and starts its first sync. Nothing is saved when the test fails.
   */
  addSource(draft: SourceDraft): Promise<DesktopSourceResult>;
  /** Tests a new credential for a GitLab source the app added, then uses it; nothing changes when the test fails. */
  setSourceCredential(host: string, credential: CredentialDraft): Promise<DesktopSourceResult>;
  /** Forgets a GitLab source's credential (a pasted token, keychain included). The source and its data stay. */
  signOutSource(host: string): Promise<SourceAccount>;
  /** Takes a GitLab source out of config.json, then deletes it and everything synced from it (not on GitLab). */
  removeSource(host: string): Promise<DesktopState>;
  /**
   * Native file picker for glab when it isn't found. The file must answer `--version` like glab; it's saved as
   * config.json `glabPath` and the sources are reloaded (no restart). null when cancelled.
   */
  chooseGlabPath(): Promise<DesktopState | null>;
  /**
   * Native file picker for the GitLab token file of the source at `url` (named in the picker). Main keeps the path for
   * that host's next `file` credential only; it's returned for display. null when cancelled.
   */
  chooseTokenFile(url: string): Promise<string | null>;
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
  testSource: 'gh-dash:test-source',
  addSource: 'gh-dash:add-source',
  setSourceCredential: 'gh-dash:set-source-credential',
  signOutSource: 'gh-dash:sign-out-source',
  removeSource: 'gh-dash:remove-source',
  chooseGlabPath: 'gh-dash:choose-glab-path',
  chooseTokenFile: 'gh-dash:choose-token-file',
} as const;

declare global {
  interface Window {
    /** Present only inside the desktop app. */
    ghDashDesktop?: DesktopBridge;
  }
}
