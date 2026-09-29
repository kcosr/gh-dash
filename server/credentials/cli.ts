// Finding and running a provider's CLI (gh, glab): shared by every CliSpec.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import type { CliIo, CliSpec, Exec } from './types';

/**
 * execFile with stdin closed, so a CLI that would wait for input gets end-of-file at once instead of hanging until the
 * timeout. Rejects with the child_process error, carrying `stdout` and `stderr`.
 */
export const defaultExec: Exec = (file, args, { env, timeout }) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });

/** The CLI's location: its configured path if that is executable, else PATH, then where installers put it. */
export async function findCli(cli: CliSpec, io: CliIo): Promise<string | null> {
  if (cli.path) return (await isExecutable(cli.path, io)) ? cli.path : null;
  const exe = io.win ? `${cli.name}.exe` : cli.name;
  const pathDirs = (io.envVar('PATH') ?? '').split(io.path.delimiter).filter((dir) => dir && io.path.isAbsolute(dir));
  for (const dir of new Set([...pathDirs, ...standardDirs(cli, io)])) {
    const candidate = io.path.join(dir, exe);
    if (await isExecutable(candidate, io)) return candidate;
  }
  return null;
}

/** The user's home folder, as the CLIs see it. */
export function homeDir(io: CliIo): string {
  return (io.win ? io.envVar('USERPROFILE') : io.envVar('HOME')) || homedir();
}

/** Install locations to try when PATH is minimal (apps started from a desktop launcher, systemd units). */
function standardDirs(cli: CliSpec, io: CliIo): string[] {
  const home = homeDir(io);
  const j = io.path.join;
  if (io.win) {
    const dirs: string[] = [];
    for (const name of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const dir = io.envVar(name);
      if (dir) dirs.push(j(dir, cli.windowsFolder));
    }
    const local = io.envVar('LOCALAPPDATA');
    if (local) dirs.push(j(local, 'Microsoft', 'WinGet', 'Links'));
    dirs.push(j(io.envVar('SCOOP') || j(home, 'scoop'), 'shims'));
    dirs.push(j(io.envVar('ChocolateyInstall') || 'C:\\ProgramData\\chocolatey', 'bin'));
    return dirs;
  }
  const nix = [j(home, '.nix-profile/bin'), '/run/current-system/sw/bin'];
  if (io.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', ...nix, j(home, '.local/bin'), j(home, 'bin')];
  }
  return ['/usr/bin', '/usr/local/bin', j(home, '.local/bin'), j(home, 'bin'), '/home/linuxbrew/.linuxbrew/bin', j(home, '.linuxbrew/bin'), ...nix, '/snap/bin'];
}

async function isExecutable(path: string, io: CliIo): Promise<boolean> {
  try {
    if (!(await io.fs.stat(path)).isFile()) return false;
    if (!io.win) await io.fs.access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * An environment variable's name as the platform tells names apart: on Windows TEAM_TOKEN and team_token are the same
 * variable. Credential resolution looks variables up by it, and the checks that two sources don't share one compare by
 * it, so the two agree.
 */
export function envKey(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/**
 * The CLI's environment: ours minus `drop` (variables it would just hand back as the token), plus `set`. Keys match
 * case-insensitively on Windows.
 */
export function cliEnv(env: NodeJS.ProcessEnv, win: boolean, drop: readonly string[], set: Record<string, string>): NodeJS.ProcessEnv {
  const gone = new Set(drop);
  const kept = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !gone.has(win ? key.toUpperCase() : key)));
  return { ...kept, ...set };
}

/** A child_process error from Exec, as far as the resolvers read it. */
export type ExecError = NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null };

/** The first line of a failed command's stderr (or of the error), cut to 200 characters. */
export function firstLine(err: ExecError): string {
  return ((err.stderr ?? '').trim().split('\n')[0]!.trim() || err.message.split('\n')[0]!).slice(0, 200);
}
