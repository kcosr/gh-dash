/**
 * What the bridge methods do: token choices (persisted as config.json `tokenSource`), the keychain, and config.json
 * edits that restart the server child; GitLab sources (config.json `sources`, a keychain file per source, reloaded in
 * the child without a restart). Mutations run one at a time.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { type ConfigFile, type LoadedConfigFile, readConfigFile, sourceUrl, writeConfigFile } from '../server/config-file';
import type { AccountStatus, Agent, SourceAccount, SourceCheck, TokenChoice } from '../shared/api';
import type {
  CredentialDraft,
  DesktopAgentToken,
  DesktopConfigPatch,
  DesktopSourceResult,
  DesktopState,
  DesktopTokenResult,
  SourceMethod,
  SourceTestDraft,
} from '../shared/desktop';
import { applyDesktopPatch, ConfigInputError, parseDesktopPatch, toDesktopConfig } from './config';
import type { ServerChild, StartResult } from './server-child';
import {
  addEntry,
  draftTarget,
  findGlab,
  gitlabEnvState,
  lockingEnv,
  parseCredentialDraft,
  parseHostInput,
  parseSourceDraft,
  removeEntry,
  sourceIndex,
  withMethod,
} from './sources';
import type { TokenStore } from './token-store';

/** The variable a GitLab source may sign in with (design §8: only this one, and only when it is set). */
const GITLAB_TOKEN = 'GITLAB_TOKEN';

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
  /** The keychain file for a GitLab source's pasted token (TokenStores.source). */
  sourceTokens?: (host: string) => TokenStore;
  /** The app's environment, for GITLAB_TOKEN. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where glab is (see sources.ts findGlab); a seam for tests. */
  findGlab?: (glabPath: string | null) => Promise<string | null>;
  /**
   * Main's own dialog: may GITLAB_TOKEN be sent to `host`? The renderer names the URL, so it doesn't get to answer.
   * Without one, GITLAB_TOKEN is never used for a new source.
   */
  confirmEnv?: (host: string) => Promise<boolean>;
}

export class Desktop {
  /** The pasted token in use this session (remembered or not): re-sent to the child after every restart. */
  private appToken: string | null = null;
  /** Why the last config change was rolled back. */
  private configError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** GitLab sources' pasted tokens in use this session (remembered or not), by host: re-sent after every restart. */
  private readonly sourceAppTokens = new Map<string, string>();
  /**
   * The token file last picked (chooseTokenFile), and the source's host it was picked for: the next `file` credential
   * of that host only, so the renderer can't send the file's token to another address.
   */
  private tokenFile: { path: string; host: string } | null = null;
  /** Hosts the user let GITLAB_TOKEN go to, this session. */
  private readonly envHosts = new Set<string>();

  constructor(private readonly d: DesktopDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.d.env ?? process.env;
  }

  private store(host: string): TokenStore {
    if (!this.d.sourceTokens) throw new Error('No keychain for GitLab sources');
    return this.d.sourceTokens(host);
  }

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

  /** github.com's choice (config.json's top-level tokenSource: glab is for GitLab sources only). */
  private writeTokenSource(choice: Exclude<TokenChoice, 'glab'> | null) {
    writeConfigFile(this.d.configPath, { ...this.readConfig(), tokenSource: choice });
  }

  async state(): Promise<DesktopState> {
    const running = this.d.child.status === 'running';
    const config = this.configOrEmpty();
    const sources = (config.sources ?? []).map((entry) => {
      const { host, baseUrl } = sourceUrl(entry.url);
      return { host, url: baseUrl, tokenRemembered: this.d.sourceTokens ? this.store(host).has() : false };
    });
    const glabPath = config.glabPath ?? null;
    return {
      version: this.d.version,
      platform: process.platform,
      config: toDesktopConfig(this.configOrEmpty(), this.d.dataDir),
      configPath: this.d.configPath,
      secureStorage: await this.d.tokens.secureStorage(),
      tokenRemembered: this.d.tokens.has(),
      apiUrl: running ? this.d.child.apiUrl : null,
      serverError: this.d.child.lastError ?? this.configError,
      sources,
      glab: { path: await (this.d.findGlab ?? findGlab)(glabPath).catch(() => null), chosen: glabPath !== null },
      gitlabEnv: gitlabEnvState(config, this.env),
    };
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /**
   * At launch: decrypt the remembered token when the saved choice is 'app', and hand it to the child. Queued like a
   * mutation: a sign-out or switch made while the keychain is still answering runs after it, instead of being
   * overwritten by the restored token (or having its keychain file re-encrypted or dropped by load()).
   */
  restoreToken(): Promise<void> {
    return this.exclusive(async () => {
      const config = this.configOrEmpty();
      if (config.tokenSource === 'app' && this.d.tokens.has()) {
        this.appToken = await this.d.tokens.load();
        this.d.log(`[token] remembered token ${this.appToken ? 'restored' : 'dropped'}`);
        // If the child is already up, onChildReady ran without the token.
        if (this.appToken && this.d.child.status === 'running') this.pushToken();
      }
      // Then each GitLab source that signs in with a pasted token.
      for (const host of this.appSources(config)) {
        const store = this.store(host);
        if (!store.has()) continue;
        const token = await store.load();
        this.d.log(`[token] ${host}: remembered token ${token ? 'restored' : 'dropped'}`);
        if (!token) continue;
        this.sourceAppTokens.set(host, token);
        if (this.d.child.status === 'running') this.pushSourceToken(host);
      }
    });
  }

  /** ServerChild.onReady: runs before requests are let through, so the first page load already has the tokens. */
  onChildReady(): void {
    const config = this.configOrEmpty();
    if (this.appToken && config.tokenSource === 'app') this.pushToken();
    for (const host of this.appSources(config)) if (this.sourceAppTokens.has(host)) this.pushSourceToken(host);
  }

  /** The GitLab sources config.json signs in with a pasted token. */
  private appSources(config: ConfigFile): string[] {
    if (!this.d.sourceTokens) return [];
    return (config.sources ?? []).filter((e) => e.tokenSource === 'app').map((e) => sourceUrl(e.url).host);
  }

  private pushSourceToken(host: string) {
    this.d.child
      .sendSetSourceToken(host, this.sourceAppTokens.get(host) ?? null)
      .then((r) => this.d.log(`[token] ${host}: app token ${r.ok ? `accepted (@${r.account.login})` : `rejected: ${r.account.error}`}`))
      .catch((error: Error) => this.d.log(`[token] ${host}: could not hand over the app token: ${error.message}`));
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
  // GitLab sources (design §8). The renderer sends a URL and a method; the token file is main's picker's, the variable
  // is GITLAB_TOKEN, and a pasted token goes to the child (and the keychain) but never back.
  // -------------------------------------------------------------------------

  /** config.json for an edit: a broken one is reported, never overwritten. */
  private editableConfig(): LoadedConfigFile {
    try {
      return readConfigFile(this.d.configPath);
    } catch (error) {
      throw new ConfigInputError(`Fix or remove ${this.d.configPath} first: ${(error as Error).message}`);
    }
  }

  /** Writes `next`, has the child apply it, and puts `loaded` back if it can't (the child then keeps what it had). */
  private async applySources(loaded: LoadedConfigFile, next: ConfigFile, what: string): Promise<void> {
    writeConfigFile(this.d.configPath, next);
    const result = await this.d.child.reloadSources();
    if (result.ok) return;
    this.d.log(`[sources] ${what} failed (${result.error}); restoring config.json`);
    if (loaded.exists) writeConfigFile(this.d.configPath, loaded.data);
    else rmSync(this.d.configPath, { force: true });
    throw new ConfigInputError(`${what} failed: ${result.error}`);
  }

  /** Whether `method` can sign in the source at `host` (null: a new one): GITLAB_TOKEN only when it is set and free. */
  private checkMethod(config: ConfigFile, host: string | null, method: SourceMethod) {
    if (method !== 'env') return;
    const env = gitlabEnvState(config, this.env, host);
    if (env !== 'offered') {
      throw new ConfigInputError(env === 'in-use' ? `${GITLAB_TOKEN} is already another GitLab source's token.` : `${GITLAB_TOKEN} isn't set in the environment gh-dash was started from.`);
    }
  }

  /** The file picked for `host`; a user-facing error when none was, or it was picked for another address. */
  private fileFor(host: string): string {
    if (!this.tokenFile || this.tokenFile.host !== host) throw new ConfigInputError(`Choose the token file for ${host} first.`);
    return this.tokenFile.path;
  }

  /**
   * What the child tests. The token file and the variable are main's, and each goes only where the user said: the file
   * to the host it was picked for, GITLAB_TOKEN to a host the user agreed to in main's own dialog. (glab only ever
   * answers for the URL's own host, and a pasted token is the user's to send.)
   */
  private async testDraft(url: string, host: string, credential: CredentialDraft): Promise<SourceTestDraft> {
    switch (credential.method) {
      case 'app':
        return { url, method: 'app', token: credential.token };
      case 'file':
        return { url, method: 'file', tokenFile: this.fileFor(host) };
      case 'env':
        if (!this.envHosts.has(host)) {
          if (!(await this.d.confirmEnv?.(host))) throw new ConfigInputError(`${GITLAB_TOKEN} wasn't sent to ${host}.`);
          this.envHosts.add(host);
        }
        return { url, method: 'env', tokenEnv: GITLAB_TOKEN };
      case 'glab':
        return { url, method: 'glab' };
    }
  }

  /** A source already in config.json can't be added again. */
  private addConflict(check: SourceCheck, config: ConfigFile): SourceCheck {
    if (sourceIndex(config, check.host) < 0) return check;
    return { ...check, ok: false, conflict: `${check.host} is already a source here: change its token under it instead.` };
  }

  /** Keeps a pasted token in the keychain when asked and possible, else makes sure no older one stays there. */
  private async remember(host: string, token: string, remember: boolean): Promise<boolean> {
    const store = this.store(host);
    let remembered = false;
    if (remember) {
      try {
        remembered = await store.save(token);
      } catch (error) {
        this.d.log(`[keychain] ${host}: could not store the token: ${(error as Error).message}`);
      }
    }
    if (!remembered) store.remove();
    return remembered;
  }

  /** Forgets a source's pasted token, this session's and the keychain's; true when there was one in use. */
  private forgetSourceToken(host: string): boolean {
    const had = this.sourceAppTokens.delete(host);
    if (this.d.sourceTokens) this.store(host).remove();
    return had;
  }

  /** Test connection: the account, instance, scopes and expiry the draft would give, or why not. Saves nothing. */
  async testSource(input: unknown): Promise<SourceCheck> {
    const draft = parseSourceDraft(input);
    const config = this.editableConfig().data;
    const { baseUrl, host } = draftTarget(draft.url);
    this.checkMethod(config, null, draft.method);
    return this.addConflict(await this.d.child.testSource(await this.testDraft(baseUrl, host, draft)), config);
  }

  /**
   * Add GitLab: tests the draft again (the renderer's own test isn't trusted), then writes config.json, has the child
   * load it (no restart), hands over a pasted token (and keeps it in the keychain when asked), and starts the source's
   * first sync. Nothing is saved when the test fails.
   */
  async addSource(input: unknown): Promise<DesktopSourceResult> {
    const draft = parseSourceDraft(input);
    return this.exclusive(async () => {
      const loaded = this.editableConfig();
      const { baseUrl, host } = draftTarget(draft.url);
      this.checkMethod(loaded.data, null, draft.method);
      const check = this.addConflict(await this.d.child.testSource(await this.testDraft(baseUrl, host, draft)), loaded.data);
      if (!check.ok) return { check, saved: false, remembered: false };
      const entry = withMethod({ kind: 'gitlab', url: check.url }, draft.method, draft.method === 'file' ? this.fileFor(host) : null);
      await this.applySources(loaded, addEntry(loaded.data, entry), `Adding ${check.host}`);
      let remembered = false;
      if (draft.method === 'app') {
        this.sourceAppTokens.set(check.host, draft.token);
        remembered = await this.remember(check.host, draft.token, draft.remember);
        const r = await this.d.child.setSourceToken(check.host, draft.token);
        if (!r.ok) this.d.log(`[token] ${check.host}: app token rejected after the test passed: ${r.account.error}`);
      } else if (draft.method === 'file') {
        this.tokenFile = null;
      }
      this.d.log(`[sources] added ${check.host} (${draft.method})`);
      this.d.child
        .syncSource(check.host)
        .then((result) => this.d.log(`[sources] ${check.host}: first sync ${result}`))
        .catch((error: Error) => this.d.log(`[sources] ${check.host}: could not start its first sync: ${error.message}`));
      return { check, saved: true, remembered };
    });
  }

  /** Change token: tests the new credential, then switches the source to it. Nothing changes when the test fails. */
  async setSourceCredential(hostInput: unknown, input: unknown): Promise<DesktopSourceResult> {
    const host = parseHostInput(hostInput);
    const credential = parseCredentialDraft(input);
    return this.exclusive(async () => {
      const loaded = this.editableConfig();
      const i = this.appSource(loaded.data, host);
      const entry = loaded.data.sources![i]!;
      const locked = lockingEnv(loaded.data, i, this.env);
      if (locked && credential.method !== 'env') throw new ConfigInputError(`${locked} is set in the environment gh-dash was started from, so it is always this source's token.`);
      this.checkMethod(loaded.data, host, credential.method);
      const check = await this.d.child.testSource(await this.testDraft(sourceUrl(entry.url).baseUrl, host, credential));
      if (!check.ok) return { check, saved: false, remembered: false };
      const sources = [...loaded.data.sources!];
      sources[i] = withMethod(entry, credential.method, credential.method === 'file' ? this.fileFor(host) : null);
      const next = { ...loaded.data, sources };
      if (!isDeepStrictEqual(next, loaded.data)) await this.applySources(loaded, next, `Changing ${host}'s token`);
      let remembered = false;
      if (credential.method === 'app') {
        this.sourceAppTokens.set(host, credential.token);
        remembered = await this.remember(host, credential.token, credential.remember);
        await this.d.child.setSourceToken(host, credential.token);
      } else {
        // The server keeps a source's app token across reloads: it goes too.
        if (this.forgetSourceToken(host)) await this.d.child.setSourceToken(host, null);
        if (credential.method === 'file') this.tokenFile = null;
      }
      this.d.log(`[sources] ${host}: now signs in with ${credential.method}`);
      return { check, saved: true, remembered };
    });
  }

  /** Sign out: the source stays (with its data), without a way to get a token until one is chosen again. */
  async signOutSource(hostInput: unknown): Promise<SourceAccount> {
    const host = parseHostInput(hostInput);
    return this.exclusive(async () => {
      const loaded = this.editableConfig();
      const i = this.appSource(loaded.data, host);
      const locked = lockingEnv(loaded.data, i, this.env);
      if (locked) throw new ConfigInputError(`${locked} is set in the environment gh-dash was started from, so it is always this source's token.`);
      const sources = [...loaded.data.sources!];
      sources[i] = withMethod(sources[i]!, null, null);
      await this.applySources(loaded, { ...loaded.data, sources }, `Signing out of ${host}`);
      this.forgetSourceToken(host);
      this.d.log(`[sources] ${host}: signed out`);
      return (await this.d.child.setSourceToken(host, null)).account;
    });
  }

  /** Remove: out of config.json first (so it isn't synced again), then deleted with all its data in the child. */
  async removeSource(hostInput: unknown): Promise<DesktopState> {
    const host = parseHostInput(hostInput);
    return this.exclusive(async () => {
      const loaded = this.editableConfig();
      const i = this.appSource(loaded.data, host);
      await this.applySources(loaded, removeEntry(loaded.data, i), `Removing ${host}`);
      this.forgetSourceToken(host);
      try {
        const { repos } = await this.d.child.deleteSource(host);
        this.d.log(`[sources] removed ${host} and its ${repos} repositories`);
      } catch (error) {
        this.d.log(`[sources] ${host} is out of config.json, but deleting its data failed: ${(error as Error).message}`);
        throw new ConfigInputError(`${host} was taken out of the app's sources, but its data wasn't deleted: ${(error as Error).message}`);
      }
      return this.state();
    });
  }

  /** The index of an entry the app can change; a user-facing error for a host config.json doesn't name. */
  private appSource(config: ConfigFile, host: string): number {
    const i = sourceIndex(config, host);
    if (i < 0) throw new ConfigInputError(`${host} isn't one of this app's GitLab sources.`);
    return i;
  }

  /** The host a token file is being picked for (chooseTokenFile's argument): checked before the picker opens. */
  tokenFileHost(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) throw new ConfigInputError('Enter the address first.');
    return draftTarget(url.trim()).host;
  }

  /** "Token file…": the picker's choice for `host`, kept for that host's next `file` credential. Returned for display. */
  setTokenFile(path: string, host: string): string {
    if (!isAbsolute(path)) throw new ConfigInputError('Choose the token file.');
    let file = false;
    try {
      file = statSync(path).isFile();
    } catch {
      /* reported below */
    }
    if (!file) throw new ConfigInputError(`${basename(path)} isn't a file gh-dash can read.`);
    this.tokenFile = { path, host };
    return path;
  }

  /**
   * "Locate glab": the chosen file must be the GitLab CLI (`--version` prints "glab version 1.x" or "glab 1.x"), then
   * it becomes config.json `glabPath` and the child reloads its sources (no restart).
   */
  async setGlabPath(path: string): Promise<DesktopState> {
    if (!isAbsolute(path)) throw new ConfigInputError('Choose the glab executable.');
    let version = '';
    try {
      version = (await execFileAsync(path, ['--version'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })).stdout;
    } catch {
      /* not runnable: reported below */
    }
    if (!/^glab(?: version)? v?\d/m.test(version)) throw new ConfigInputError(`${basename(path)} isn't the GitLab CLI: it didn't answer --version like glab does.`);
    return this.exclusive(async () => {
      const loaded = this.editableConfig();
      if (loaded.data.glabPath === path) return this.state();
      await this.applySources(loaded, { ...loaded.data, glabPath: path }, 'Setting glab');
      this.d.log(`[config] glabPath set to ${path}; sources reloaded`);
      return this.state();
    });
  }

  // -------------------------------------------------------------------------
  // Agents (MCP). The child keeps them (its database) and says so to open windows; the token of a new or regenerated
  // one comes back here once, goes to the renderer to be shown, and is never logged or kept.
  // -------------------------------------------------------------------------

  addAgent(input: unknown): Promise<DesktopAgentToken> {
    if (typeof input !== 'string' || !input.trim()) throw new ConfigInputError('Give the agent a name.');
    if (input.length > 200) throw new ConfigInputError("That name is too long for an agent's.");
    return this.exclusive(async () => {
      const made = await this.agentRequest(() => this.d.child.addAgent(input));
      this.d.log(`[agents] added ${made.agent.name} (id ${made.agent.id})`);
      return made;
    });
  }

  regenerateAgentToken(input: unknown): Promise<DesktopAgentToken> {
    const id = agentId(input);
    return this.exclusive(async () => {
      const made = await this.agentRequest(() => this.d.child.regenerateAgentToken(id));
      this.d.log(`[agents] new token for ${made.agent.name} (id ${id})`);
      return made;
    });
  }

  revokeAgent(input: unknown): Promise<Agent> {
    const id = agentId(input);
    return this.exclusive(async () => {
      const agent = await this.agentRequest(() => this.d.child.revokeAgent(id));
      this.d.log(`[agents] revoked ${agent.name} (id ${id})`);
      return agent;
    });
  }

  /** The child's refusals (a name taken, no such agent) are the user's to read, not stack traces for the log. */
  private async agentRequest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new ConfigInputError((error as Error).message);
    }
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

  /**
   * "Locate gh": the chosen file must be the GitHub CLI (`--version` prints "gh version ..."), then it becomes
   * config.json `ghPath` and the server restarts to pick it up. The token choice isn't touched.
   */
  async setGhPath(path: string): Promise<DesktopState> {
    if (!isAbsolute(path)) throw new ConfigInputError('Choose the gh executable.');
    let version = '';
    try {
      version = (await execFileAsync(path, ['--version'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })).stdout;
    } catch {
      /* not runnable: reported below */
    }
    if (!/^gh version \d/m.test(version)) throw new ConfigInputError(`${basename(path)} isn't the GitHub CLI: it didn't answer --version like gh does.`);
    return this.exclusive(async () => {
      const config = this.readConfig();
      if (config.ghPath === path && this.d.child.status === 'running') return this.state();
      writeConfigFile(this.d.configPath, { ...config, ghPath: path });
      this.d.log(`[config] ghPath set to ${path}; restarting the server`);
      await this.d.restart();
      return this.state();
    });
  }

  currentDataDir(): string {
    return toDesktopConfig(this.configOrEmpty(), this.d.dataDir).dataDir;
  }
}

const execFileAsync = promisify(execFile);

/** An agent's id from the renderer: a positive integer. */
function agentId(input: unknown): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) throw new ConfigInputError('That is not an agent.');
  return input;
}

function ensureWritableDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (error) {
    throw new ConfigInputError(`Can't use ${dir} as the data folder (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`);
  }
}
