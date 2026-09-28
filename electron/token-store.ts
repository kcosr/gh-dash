/**
 * A pasted GitHub token, remembered in <userData>/github-token.enc, encrypted with the OS keychain through
 * Electron's safeStorage. Only the async API (the sync one is deprecated in Electron 45).
 */
import { safeStorage } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { SecureStorage } from '../shared/desktop';

export class TokenStore {
  private availability: Promise<SecureStorage> | null = null;

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
  ) {}

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
    writeFileSync(this.file, encrypted, { mode: 0o600 });
    return true;
  }

  remove(): void {
    rmSync(this.file, { force: true });
  }
}
