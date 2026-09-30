/**
 * Pasted tokens remembered on this device, encrypted with the OS keychain through Electron's safeStorage (only the
 * async API: the sync one is deprecated in Electron 45). github.com's is <userData>/github-token.enc, as it always was;
 * each GitLab source's is <userData>/tokens/<host>.enc (design §8). Source hosts are [a-z0-9.-], so they are safe file
 * names. The MCP agents' tokens, kept so Settings → Agents can show them again, are <userData>/agent-tokens/<id>.enc,
 * by the agent's principal id (Desktop checks one is still that agent's in the database before showing it).
 */
import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SecureStorage } from '../shared/desktop';

/** Whether safeStorage has a real keychain: asked once, and shared by every store. */
export class Keychain {
  private availability: Promise<SecureStorage> | null = null;

  constructor(private readonly log: (line: string) => void) {}

  /**
   * "available" only with a real keychain: macOS Keychain, Windows DPAPI, or libsecret/KWallet on Linux. Linux's
   * basic_text backend is a hard-coded key (obfuscation), so remembering is refused there. Call after `ready`.
   */
  secureStorage(): Promise<SecureStorage> {
    this.availability ??= (async () => {
      let available = false;
      let backend = 'n/a';
      try {
        available = await safeStorage.isAsyncEncryptionAvailable();
        if (process.platform === 'linux') {
          backend = safeStorage.getSelectedStorageBackend();
          if (backend === 'basic_text' || backend === 'unknown') available = false;
        }
      } catch (error) {
        this.log(`[keychain] unavailable: ${(error as Error).message}`);
        available = false;
      }
      this.log(`[keychain] ${available ? 'available' : 'unavailable'} (backend ${backend})`);
      return available ? 'available' : 'unavailable';
    })();
    return this.availability;
  }
}

/** One remembered token in one file. */
export class TokenStore {
  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
    private readonly keychain: Keychain = new Keychain(log),
  ) {}

  /** See Keychain.secureStorage. */
  secureStorage(): Promise<SecureStorage> {
    return this.keychain.secureStorage();
  }

  has(): boolean {
    return existsSync(this.file);
  }

  /** The remembered token, or null. A token that can't be decrypted (keychain access denied, new app signature) is dropped. */
  async load(): Promise<string | null> {
    if (!this.has()) return null;
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(this.file));
      if (!result) throw new Error('empty');
      if (shouldReEncrypt) await this.save(result).catch(() => {});
      return result;
    } catch (error) {
      this.log(`[keychain] could not decrypt the remembered token; forgetting it (${(error as Error).message})`);
      this.remove();
      return null;
    }
  }

  /** Stores the token; false (nothing written) when there is no real keychain. */
  async save(token: string): Promise<boolean> {
    if ((await this.secureStorage()) !== 'available') return false;
    const encrypted = await safeStorage.encryptStringAsync(token);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, encrypted, { mode: 0o600 });
    return true;
  }

  remove(): void {
    rmSync(this.file, { force: true });
  }
}

const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** github.com's store and one per GitLab source, in the app's userData folder, sharing one keychain check. */
export class TokenStores {
  readonly github: TokenStore;
  private readonly keychain: Keychain;
  private readonly sources = new Map<string, TokenStore>();

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void,
  ) {
    this.keychain = new Keychain(log);
    this.github = new TokenStore(join(dir, 'github-token.enc'), log, this.keychain);
  }

  /**
   * The store for the token of the agent with principal id `id`: <dir>/agent-tokens/<id>.enc. Throws for anything but a
   * positive integer.
   */
  agent(id: number): TokenStore {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Not an agent id: ${id}`);
    return new TokenStore(join(this.dir, 'agent-tokens', `${id}.enc`), this.log, this.keychain);
  }

  /** The store for the GitLab source at `host`: <dir>/tokens/<host>.enc. Throws for anything but a host name. */
  source(host: string): TokenStore {
    if (!HOST.test(host) || host.includes('..') || host.length > 253) throw new Error(`Not a source host: ${host}`);
    let store = this.sources.get(host);
    if (!store) {
      store = new TokenStore(join(this.dir, 'tokens', `${host}.enc`), this.log, this.keychain);
      this.sources.set(host, store);
    }
    return store;
  }
}
