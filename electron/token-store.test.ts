import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStores } from './token-store';

/** safeStorage stand-in: "encrypts" by reversing and prefixing, so a file never holds the token as is. */
const safeStorage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptStringAsync: vi.fn(async (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`)),
  decryptStringAsync: vi.fn(async (data: Buffer) => {
    const text = data.toString();
    if (!text.startsWith('enc:')) throw new Error('bad data');
    return { result: [...text.slice(4)].reverse().join(''), shouldReEncrypt: false };
  }),
}));
vi.mock('electron', () => ({ safeStorage }));

let dir: string;
const logs: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghd-tokens-'));
  logs.length = 0;
  safeStorage.isAsyncEncryptionAvailable.mockClear();
  safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('TokenStores', () => {
  it("keeps github.com's token where it always was, and each GitLab source's in its own file", async () => {
    const stores = new TokenStores(dir, (l) => logs.push(l));
    expect(await stores.github.save('ghp_one')).toBe(true);
    expect(await stores.source('gitlab.example.com').save('glpat-two')).toBe(true);
    expect(await stores.source('gitlab2.example.com').save('glpat-three')).toBe(true);
    expect(existsSync(join(dir, 'github-token.enc'))).toBe(true);
    const file = join(dir, 'tokens', 'gitlab.example.com.enc');
    expect(readFileSync(file, 'utf8')).not.toContain('glpat-two');
    expect(await stores.source('gitlab.example.com').load()).toBe('glpat-two');
    expect(await stores.source('gitlab2.example.com').load()).toBe('glpat-three');
    expect(await stores.github.load()).toBe('ghp_one');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'tokens')).mode & 0o777).toBe(0o700);
    }
    // One is forgotten, the others stay.
    stores.source('gitlab.example.com').remove();
    expect(stores.source('gitlab.example.com').has()).toBe(false);
    expect(stores.source('gitlab2.example.com').has()).toBe(true);
    expect(stores.github.has()).toBe(true);
    // The keychain was asked once for all of them.
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
  });

  it('refuses anything but a host name as a file name', () => {
    const stores = new TokenStores(dir, () => {});
    for (const bad of ['../github-token', 'a/b', 'gitlab..example.com', '', 'GitLab.example.com', 'x'.repeat(254)]) {
      expect(() => stores.source(bad)).toThrow('Not a source host');
    }
  });

  it('remembers nothing with Linux basic_text (session only), for every source', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
      const stores = new TokenStores(dir, (l) => logs.push(l));
      expect(await stores.source('gitlab.example.com').secureStorage()).toBe('unavailable');
      expect(await stores.source('gitlab.example.com').save('glpat-x')).toBe(false);
      expect(await stores.github.save('ghp_x')).toBe(false);
      expect(existsSync(join(dir, 'tokens'))).toBe(false);
      expect(logs).toContain('[keychain] unavailable (backend basic_text)');
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it("drops a token it can't decrypt", async () => {
    const stores = new TokenStores(dir, (l) => logs.push(l));
    const store = stores.source('gitlab.example.com');
    await store.save('glpat-x');
    writeFileSync(join(dir, 'tokens', 'gitlab.example.com.enc'), 'garbage');
    expect(await store.load()).toBeNull();
    expect(store.has()).toBe(false);
    expect(logs.at(-1)).toMatch(/could not decrypt the remembered token; forgetting it/);
  });
});
