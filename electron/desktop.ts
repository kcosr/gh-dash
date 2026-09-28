/**
 * What the bridge methods do: token choices (persisted as config.json `tokenSource`), the keychain, and config.json
 * edits that restart the server child. Mutations run one at a time.
 */
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { type ConfigFile, readConfigFile, writeConfigFile } from '../server/config-file';
import type { AccountStatus, TokenChoice } from '../shared/api';
import type { DesktopConfigPatch, DesktopState, DesktopTokenResult } from '../shared/desktop';
import { applyDesktopPatch, ConfigInputError, parseDesktopPatch, toDesktopConfig } from './config';
import type { ServerChild, StartResult } from './server-child';
import type { TokenStore } from './token-store';

export interface DesktopDeps {
  child: ServerChild;
  tokens: TokenStore;
  configPath: string;
  /** Default data folder (<userData>/data). */
  dataDir: string;
  version: string;
  /** Restarts the child (dropping the proxy's kept-alive connections first). */
  restart: () => Promise<StartResult>;
  log: (line: string) => void;
}

export class Desktop {
  /** The pasted token in use this session (remembered or not): re-sent to the child after every restart. */
  private appToken: string | null = null;
  /** Why the last config change was rolled back. */
  private configError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: DesktopDeps) {}

  /** Serializes mutations: two quick clicks must not interleave restarts and token pushes. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** config.json, or {} when it's missing. Throws when it is invalid (the child reports that as its start error). */
  readConfig(): ConfigFile {
    return readConfigFile(this.d.configPath).data;
  }

  private configOrEmpty(): ConfigFile {
    try {
      return this.readConfig();
    } catch {
      return {};
    }
  }

  private writeTokenSource(choice: TokenChoice | null) {
    writeConfigFile(this.d.configPath, { ...this.readConfig(), tokenSource: choice });
  }

  async state(): Promise<DesktopState> {
    const running = this.d.child.status === 'running';
    return {
      version: this.d.version,
      platform: process.platform,
      config: toDesktopConfig(this.configOrEmpty(), this.d.dataDir),
      configPath: this.d.configPath,
      secureStorage: await this.d.tokens.secureStorage(),
      tokenRemembered: this.d.tokens.has(),
      apiUrl: running ? this.d.child.apiUrl : null,
      serverError: this.d.child.lastError ?? this.configError,
    };
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /** At launch: decrypt the remembered token when the saved choice is 'app', and hand it to the child. */
  async restoreToken(): Promise<void> {
    if (this.configOrEmpty().tokenSource !== 'app' || !this.d.tokens.has()) return;
    this.appToken = await this.d.tokens.load();
    this.d.log(`[token] remembered token ${this.appToken ? 'restored' : 'dropped'}`);
    // If the child is already up, onChildReady ran without the token.
    if (this.appToken && this.d.child.status === 'running') this.pushToken();
  }

  /** ServerChild.onReady: runs before requests are let through, so the first page load already has the token. */
  onChildReady(): void {
    if (this.appToken && this.configOrEmpty().tokenSource === 'app') this.pushToken();
  }

  private pushToken() {
    this.d.child
      .sendSetToken('app', this.appToken)
      .then((r) => this.d.log(`[token] app token ${r.ok ? `accepted (@${r.account.login})` : `rejected: ${r.account.error}`}`))
      .catch((error: Error) => this.d.log(`[token] could not hand over the app token: ${error.message}`));
  }

  /** Puts the child back on the saved choice after a rejected switch, so a typo doesn't sign the user out. */
  private async revertChild() {
    const choice = this.configOrEmpty().tokenSource ?? null;
    await this.d.child.setToken(choice, choice === 'app' ? this.appToken : null).catch(() => {});
  }

  useGitHubCli(): Promise<DesktopTokenResult> {
    return this.exclusive(async () => {
      const result = await this.d.child.setToken('gh', null);
      if (!result.ok) {
        await this.revertChild();
        return { ok: false, account: result.account, remembered: false };
      }
      this.writeTokenSource('gh');
      // One source at a time: a pasted token isn't kept around (or in the keychain) once gh is in use.
      this.appToken = null;
      this.d.tokens.remove();
      return { ok: true, account: result.account, remembered: false };
    });
  }

  setToken(token: string, remember: boolean): Promise<DesktopTokenResult> {
    return this.exclusive(async () => {
      const result = await this.d.child.setToken('app', token);
      if (!result.ok) {
        await this.revertChild();
        return { ok: false, account: result.account, remembered: false };
      }
      this.appToken = token;
      this.writeTokenSource('app');
      let remembered = false;
      if (remember) {
        try {
          remembered = await this.d.tokens.save(token);
        } catch (error) {
          this.d.log(`[keychain] could not store the token: ${(error as Error).message}`);
        }
      }
      // A previously remembered token is no longer the one in use.
      if (!remembered) this.d.tokens.remove();
      return { ok: true, account: result.account, remembered };
    });
  }

  signOut(): Promise<AccountStatus> {
    return this.exclusive(async () => {
      this.appToken = null;
      this.d.tokens.remove();
      this.writeTokenSource(null);
      const result = await this.d.child.setToken(null, null);
      return result.account;
    });
  }

  // -------------------------------------------------------------------------
  // config.json
  // -------------------------------------------------------------------------

  async updateConfig(input: unknown): Promise<DesktopState> {
    const patch = parseDesktopPatch(input);
    return this.exclusive(async () => {
      let loaded;
      try {
        loaded = readConfigFile(this.d.configPath);
      } catch (error) {
        throw new ConfigInputError(`Fix or remove ${this.d.configPath} first: ${(error as Error).message}`);
      }
      const next = applyDesktopPatch(loaded.data, patch, this.d.dataDir);
      if (patch.dataDir !== undefined) ensureWritableDir(patch.dataDir);
      if (isDeepStrictEqual(next, loaded.data) && this.d.child.status === 'running') return this.state();
      writeConfigFile(this.d.configPath, next);
      this.d.log(`[config] updated (${Object.keys(patch).join(', ')}); restarting the server`);
      const result = await this.d.restart();
      if (result.ok) {
        this.configError = null;
        return this.state();
      }
      // Keep the app usable: put the previous settings back and report why the new ones didn't work.
      this.d.log(`[config] the new settings failed (${result.message}); restoring the previous ones`);
      if (loaded.exists) writeConfigFile(this.d.configPath, loaded.data);
      else rmSync(this.d.configPath, { force: true });
      this.configError = `The new settings were not applied: ${result.message}`;
      await this.d.restart();
      return this.state();
    });
  }

  /** Error page: "Turn off the Local API" (its port is taken, say). */
  disableLocalApi(): Promise<StartResult> {
    return this.exclusive(async () => {
      writeConfigFile(this.d.configPath, { ...this.readConfig(), listen: false });
      return this.d.restart();
    });
  }

  retry(): Promise<StartResult> {
    return this.exclusive(() => this.d.restart());
  }

  generateApiKey(): string {
    return `ghd_${randomBytes(24).toString('base64url')}`;
  }

  currentDataDir(): string {
    return toDesktopConfig(this.configOrEmpty(), this.d.dataDir).dataDir;
  }
}

function ensureWritableDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (error) {
    throw new ConfigInputError(`Can't use ${dir} as the data folder (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`);
  }
}
