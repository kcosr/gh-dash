/**
 * Apps started from Finder, the Dock or a desktop launcher get launchd's (or the session's) minimal PATH, not the one
 * the user's shell builds in ~/.zshrc and friends, so a gh in ~/bin or behind a version manager isn't found. Like VS
 * Code, ask the login shell once for its PATH, bounded by a timeout, and put its entries in front of ours.
 */
import { spawn } from 'node:child_process';
import { delimiter as pathDelimiter } from 'node:path';

const MARK = '__GH_DASH_ENV__';
export const SHELL_PATH_TIMEOUT_MS = 3000;

/** The PATH between the markers of `echo MARK; env; echo MARK`, whatever the shell's startup files printed around it. */
export function parseShellPath(stdout: string): string | null {
  const start = stdout.indexOf(`${MARK}\n`);
  const end = stdout.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  const line = stdout.slice(start + MARK.length + 1, end).split('\n').find((l) => l.startsWith('PATH='));
  const value = line?.slice('PATH='.length).trim();
  return value ? value : null;
}

/** The shell's entries first, then ours that it lacks; empty entries and duplicates dropped. */
export function mergePath(shellPath: string | null, current: string | undefined, delimiter = pathDelimiter): string {
  const entries = [...(shellPath ?? '').split(delimiter), ...(current ?? '').split(delimiter)].filter(Boolean);
  return [...new Set(entries)].join(delimiter);
}

export interface ShellPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  timeoutMs?: number;
}

/**
 * The login shell's PATH on macOS and Linux (null on Windows, where GUI apps get the user's PATH, or when the shell
 * fails, prints nothing usable or takes longer than the timeout). Runs `$SHELL -ilc` so both login and interactive
 * startup files apply, with stdin closed so nothing can wait for input. `env` rather than `echo $PATH`: fish prints
 * list variables space-separated, while `env` shows the exported, colon-separated form in every shell.
 */
export function resolveShellPath(opts: ShellPathOptions = {}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return Promise.resolve(null);
  const env = opts.env ?? process.env;
  const shell = opts.shell ?? (env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'));
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(shell, ['-ilc', `echo ${MARK}; env; echo ${MARK}`], {
      // Lets startup files skip slow or interactive work; oh-my-zsh's update check is the usual culprit.
      env: { ...env, GH_DASH_RESOLVING_ENVIRONMENT: '1', DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true, // its own process group, so a timeout kills whatever the startup files started
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(null);
    }, opts.timeoutMs ?? SHELL_PATH_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < 1024 * 1024) out += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseShellPath(out)));
  });
}
