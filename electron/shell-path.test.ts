import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mergePath, parseShellPath, resolveShellPath } from './shell-path';

const MARK = '__GH_DASH_ENV__';
const dir = mkdtempSync(join(tmpdir(), 'ghd-shell-path-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for $SHELL: ignores `-ilc ...` and prints `body`. */
function fakeShell(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('login shell PATH', () => {
  it('reads PATH between the markers, whatever the startup files printed', () => {
    const out = `Welcome back!\nPATH=/not/this\n${MARK}\nHOME=/Users/me\nPATH=/Users/me/bin:/opt/homebrew/bin:/usr/bin\nTERM=dumb\n${MARK}\nbye\n`;
    expect(parseShellPath(out)).toBe('/Users/me/bin:/opt/homebrew/bin:/usr/bin');
    expect(parseShellPath('no markers here')).toBeNull();
    expect(parseShellPath(`${MARK}\nHOME=/x\n${MARK}\n`)).toBeNull();
    expect(parseShellPath(`${MARK}\nPATH=/x\n`)).toBeNull(); // cut off before the closing marker
  });

  it("puts the shell's entries first and drops duplicates and empty ones", () => {
    expect(mergePath('/Users/me/bin:/usr/bin', '/usr/bin:/bin::/usr/sbin', ':')).toBe('/Users/me/bin:/usr/bin:/bin:/usr/sbin');
    expect(mergePath(null, '/usr/bin:/bin', ':')).toBe('/usr/bin:/bin');
    expect(mergePath('C:\\gh;C:\\Windows', 'C:\\Windows;C:\\tools', ';')).toBe('C:\\gh;C:\\Windows;C:\\tools');
  });

  it('is skipped on Windows', async () => {
    expect(await resolveShellPath({ platform: 'win32', shell: '/nonexistent' })).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('asks the shell and parses its answer', async () => {
    const shell = fakeShell('rc-noise', `echo "oh-my-zsh says hi"\necho ${MARK}\necho PATH=/Users/me/bin:/usr/bin\necho ${MARK}`);
    expect(await resolveShellPath({ platform: 'darwin', shell, env: { PATH: '/usr/bin:/bin' } })).toBe('/Users/me/bin:/usr/bin');
  });

  it.skipIf(process.platform === 'win32')('gives up after the timeout, and on a shell that fails or is missing', async () => {
    const slow = fakeShell('slow', 'sleep 5');
    const started = Date.now();
    expect(await resolveShellPath({ platform: 'darwin', shell: slow, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await resolveShellPath({ platform: 'linux', shell: fakeShell('fails', 'exit 1') })).toBeNull();
    expect(await resolveShellPath({ platform: 'linux', shell: join(dir, 'missing') })).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('works with a real POSIX shell', async () => {
    const path = await resolveShellPath({ platform: 'linux', shell: '/bin/sh', env: { PATH: '/usr/bin:/bin', HOME: dir } });
    expect(path).toEqual(expect.stringContaining('/bin'));
  });
});
