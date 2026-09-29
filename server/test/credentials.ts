// Stand-ins for credential tests: files (with modes and exec bits) and a CLI that never really runs.

import type { Exec, TokenFs } from '../credentials/types';

export type FakeFile = { text?: string; mode?: number; exec?: boolean };

export function fakeFs(files: Record<string, FakeFile>): TokenFs & { files: Record<string, FakeFile> } {
  const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  return {
    files,
    async stat(path) {
      const f = files[path];
      if (!f) throw missing(path);
      return { mode: f.mode ?? 0o100600, isFile: () => true };
    },
    async access(path) {
      if (!files[path]?.exec) throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: 'EACCES' });
    },
    async readFile(path) {
      const f = files[path];
      if (!f) throw missing(path);
      if (f.text === undefined) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
      return f.text;
    },
  };
}

export interface ExecCall {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: number;
}

/** A CLI stand-in: `reply(args)` gives stdout (or { stdout, stderr }), or throws a child_process-like error. */
export function fakeExec(reply: (args: string[]) => string | { stdout: string; stderr?: string } | Promise<string | { stdout: string; stderr?: string }>) {
  const calls: ExecCall[] = [];
  const exec: Exec = async (file, args, { env, timeout }) => {
    calls.push({ file, args, env, timeout });
    const out = await reply(args);
    return typeof out === 'string' ? { stdout: out, stderr: '' } : { stdout: out.stdout, stderr: out.stderr ?? '' };
  };
  return { exec, calls };
}

/** What execFile rejects with when the command exits non-zero (or, with `extra`, times out or can't start). */
export const execError = (stderr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Command failed\n${stderr}`), { code: 1, stdout: '', stderr, killed: false, signal: null, ...extra });
