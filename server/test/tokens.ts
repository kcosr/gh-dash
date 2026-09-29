// Token providers for tests: never run gh, read files or (unless given a fetchImpl) validate against GitHub.

import { type ResolvedToken, TokenProvider, type TokenProviderOptions, type TokenSupply } from '../token';

const noFiles = {
  async stat(path: string): Promise<never> {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  },
  async access(path: string): Promise<never> {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  },
  async readFile(path: string): Promise<never> {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  },
};

/** A real provider with a fixed token (as GITHUB_TOKEN, so source 'env') or none (nothing chosen). */
export function testTokens(token: string | null = null, opts: Partial<TokenProviderOptions> = {}): TokenProvider {
  return new TokenProvider({
    env: token ? { GITHUB_TOKEN: token } : {},
    choice: null,
    fs: noFiles,
    exec: async () => { throw new Error('gh must not run in tests'); },
    fetchImpl: async () => { throw new Error('no network in tests'); },
    log: () => {},
    ...opts,
  });
}

/** A TokenSupply over `read()`, asked on every get(); counts invalidations. */
export function supplyOf(read: () => string | null): TokenSupply & { invalidated: number } {
  const current = (): ResolvedToken => {
    const token = read();
    return { token, source: token ? 'env' : 'none', error: token ? null : 'none for this test' };
  };
  return {
    invalidated: 0,
    async get() {
      return current();
    },
    peek: current,
    invalidate() {
      this.invalidated++;
    },
    onChange: () => () => {},
  };
}
