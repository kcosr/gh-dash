/**
 * The local transport between main and the server child: a Unix socket in a private temp folder, or a named pipe
 * on Windows. No Electron imports, so it is unit-tested.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** sun_path is 104 bytes on macOS (108 on Linux), including the terminator; stay clear of both. */
export const MAX_SOCKET_BYTES = 100;
const PREFIX = 'ghd-';
// ghd-<pid>-<6 chars from mkdtemp>
const DIR_NAME = /^ghd-(\d+)-[A-Za-z0-9]{6}$/;

export interface SocketLocation {
  /** What the server listens on and main connects to. */
  path: string;
  /** Private folder holding the socket (removed on quit); null for a Windows pipe. */
  dir: string | null;
}

/**
 * Creates the socket location for this launch. The folder comes from mkdtemp (mode 0700), so only this user can
 * reach the socket; its name carries our pid so later launches can tell when it's stale. Long temp dirs (macOS's
 * /var/folders/... can be) fall back to /tmp to stay under the sun_path limit.
 */
export function createSocketLocation(platform: NodeJS.Platform = process.platform, base = tmpdir(), pid = process.pid): SocketLocation {
  if (platform === 'win32') return { path: `\\\\.\\pipe\\gh-dash-${randomBytes(12).toString('hex')}`, dir: null };
  const candidates = [base, '/tmp'];
  for (const root of candidates) {
    // mkdtemp appends 6 characters.
    if (Buffer.byteLength(join(root, `${PREFIX}${pid}-XXXXXX`, 's')) > MAX_SOCKET_BYTES) continue;
    const dir = mkdtempSync(join(root, `${PREFIX}${pid}-`));
    return { path: join(dir, 's'), dir };
  }
  throw new Error(`No temp folder short enough for a socket path (${base})`);
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Where createSocketLocation makes its folders: none on Windows, whose named pipes go away with their process. */
export const socketBases = (platform: NodeJS.Platform = process.platform): string[] => (platform === 'win32' ? [] : [tmpdir(), '/tmp']);

/**
 * Removes socket folders left by launches that crashed or were killed (a clean quit removes its own). Only our
 * own folders, by name and owner, whose process is gone. Returns the removed paths.
 */
export function cleanupStaleSocketDirs(bases: string[] = socketBases(), isAlive = pidAlive, uid = process.getuid?.()): string[] {
  const removed: string[] = [];
  for (const base of new Set(bases)) {
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const pid = Number(DIR_NAME.exec(name)?.[1]);
      if (!pid || pid === process.pid || isAlive(pid)) continue;
      const dir = join(base, name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        /* raced with another launch, or not ours */
      }
    }
  }
  return removed;
}
