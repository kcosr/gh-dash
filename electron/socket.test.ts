import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupStaleSocketDirs, createSocketLocation, MAX_SOCKET_BYTES } from './socket';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createSocketLocation', () => {
  it('uses a random named pipe on Windows', () => {
    const a = createSocketLocation('win32');
    const b = createSocketLocation('win32');
    expect(a.path).toMatch(/^\\\\\.\\pipe\\gh-dash-[0-9a-f]{24}$/);
    expect(a.path).not.toBe(b.path);
    expect(a.dir).toBeNull();
  });

  const posix = process.platform !== 'win32';
  it.runIf(posix)('makes a private folder with a short socket path', () => {
    const loc = createSocketLocation('linux');
    made.push(loc.dir!);
    expect(loc.path).toBe(join(loc.dir!, 's'));
    expect(loc.dir!.startsWith(join(tmpdir(), `ghd-${process.pid}-`))).toBe(true);
    expect(Buffer.byteLength(loc.path)).toBeLessThanOrEqual(MAX_SOCKET_BYTES);
    expect(statSync(loc.dir!).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)('falls back to /tmp when the temp folder is too long (macOS /var/folders/...)', () => {
    const loc = createSocketLocation('darwin', `/var/folders/${'x'.repeat(90)}/T`);
    made.push(loc.dir!);
    expect(loc.dir!.startsWith(`/tmp/ghd-${process.pid}-`)).toBe(true);
    expect(Buffer.byteLength(loc.path)).toBeLessThanOrEqual(MAX_SOCKET_BYTES);
  });
});

describe('cleanupStaleSocketDirs', () => {
  it('removes our folders whose process is gone, and nothing else', () => {
    const base = mkdtempSync(join(tmpdir(), 'ghd-test-'));
    made.push(base);
    const names = ['ghd-111-aaaaaa', 'ghd-222-bbbbbb', `ghd-${process.pid}-cccccc`, 'ghd-333-toolong1', 'other-444-dddddd'];
    for (const name of names) mkdirSync(join(base, name));
    writeFileSync(join(base, 'ghd-555-eeeeee'), 'a file, not a folder');
    const alive = new Set([222]);
    const removed = cleanupStaleSocketDirs([base], (pid) => alive.has(pid));
    expect(removed).toEqual([join(base, 'ghd-111-aaaaaa')]);
    expect(readdirSync(base).sort()).toEqual(['ghd-222-bbbbbb', 'ghd-333-toolong1', 'ghd-555-eeeeee', `ghd-${process.pid}-cccccc`, 'other-444-dddddd'].sort());
  });

  it('skips folders owned by someone else and missing bases', () => {
    const base = mkdtempSync(join(tmpdir(), 'ghd-test-'));
    made.push(base);
    mkdirSync(join(base, 'ghd-111-aaaaaa'));
    expect(cleanupStaleSocketDirs([base, join(base, 'missing')], () => false, 123456789)).toEqual([]);
    expect(readdirSync(base)).toEqual(['ghd-111-aaaaaa']);
  });
});
