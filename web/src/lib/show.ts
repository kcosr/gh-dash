/**
 * An agent's `show` (MCP): it asks the window to open a thread, or a file of a PR's or commit's diff. The window offers
 * it as a chip (ShowChips), or opens it at once while it follows agents (a preference kept in the browser). Opening is
 * what a Comments row does: the diff over the view you're on, at the thread (or the file). Pure parts here, for tests.
 */
import { useSyncExternalStore } from 'react';
import type { Principal, ShowTarget, StreamMessage } from '../../../shared/api';
import { threadPlace } from './threadList';
import { commitDiffId } from './urlState';
import type { UrlPatch, UrlState } from './urlState';

export type ShowMessage = Extract<StreamMessage, { type: 'show' }>;

/** The diff a target opens ("<repo>#<n>" or "<repo>@<oid>"); null for a repo alone. */
export function showDiffId(t: ShowTarget): string | null {
  if (t.pr !== undefined && t.pr !== null) return `${t.repo}#${t.pr}`;
  if (t.commit) return commitDiffId(t.repo, t.commit);
  return null;
}

/**
 * The URL patch that opens a target over the view you're on, as the Comments list opens a thread: the diff at the
 * thread, or at the file. Another diff's file and file-list filter don't come along; the diff already open keeps its
 * filter. Null for a target without a diff (a repo alone: its page, see showRepoPath).
 */
export function showPatch(t: ShowTarget, cur: Pick<UrlState, 'diff' | 'only'>): UrlPatch | null {
  const diff = showDiffId(t);
  if (!diff) return null;
  return { diff, thread: t.threadId ?? null, file: t.path ?? null, only: cur.diff === diff ? cur.only : null };
}

/**
 * How the chip names what it shows: the place ("host.ts:42–44", the file's name and the thread's lines when known; "a
 * thread") and what it is on ("app#17", "app@3f2a91c", "app"). `path`: the place in full, for its title.
 */
export function showWhat(t: ShowTarget, o: { label: string; prRef: string; thread?: Parameters<typeof threadPlace>[0] | null }): { place: string | null; on: string; path: string | null } {
  const on = t.pr !== undefined && t.pr !== null ? `${o.label}${o.prRef}${t.pr}` : t.commit ? `${o.label}@${t.commit.slice(0, 7)}` : o.label;
  if (o.thread && o.thread.path === null) return { place: 'a comment', on, path: null };
  const full = o.thread ? threadPlace(o.thread) : t.path ?? null;
  const place = full ? full.slice(full.lastIndexOf('/', full.search(/:\d|$/)) + 1) : t.threadId ? 'a thread' : null;
  return { place, on, path: full };
}

/** "Claude wants to show you host.ts:42–44 on app#17" (the words after the name). */
export function showPhrase(w: { place: string | null; on: string }): string {
  return w.place ? `${w.place} on ${w.on}` : w.on;
}

// ---------------------------------------------------------------------------- following agents

export const FOLLOW_KEY = 'gh-dash:followAgents';

/** Whether this browser opens what agents show at once (default off). */
export function getFollowAgents(): boolean {
  try { return localStorage.getItem(FOLLOW_KEY) === '1'; } catch { return false; }
}

const followListeners = new Set<() => void>();

export function setFollowAgents(on: boolean): void {
  try {
    if (on) localStorage.setItem(FOLLOW_KEY, '1');
    else localStorage.removeItem(FOLLOW_KEY);
  } catch { /* private mode */ }
  for (const l of followListeners) l();
}

function subscribeFollow(onChange: () => void) {
  followListeners.add(onChange);
  // Another tab of this browser changed it.
  const onStorage = (e: StorageEvent) => { if (e.key === FOLLOW_KEY || e.key === null) onChange(); };
  window.addEventListener('storage', onStorage);
  return () => { followListeners.delete(onChange); window.removeEventListener('storage', onStorage); };
}

export function useFollowAgents(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribeFollow, getFollowAgents, () => false), setFollowAgents];
}

// ---------------------------------------------------------------------------- the chips

/** A show on screen: `opened` when the window followed it (the chip then only says so). */
export interface ShowChip {
  id: string;
  agent: Principal;
  target: ShowTarget;
  message: string | null;
  at: string;
  opened: boolean;
}

/** At most this many at once; an older one goes when another comes. */
export const MAX_CHIPS = 3;

/** The chips after one more arrives: the newest last, one per id (a repeat replaces its chip), MAX_CHIPS at most. */
export function addChip(list: readonly ShowChip[], chip: ShowChip): ShowChip[] {
  return [...list.filter((c) => c.id !== chip.id), chip].slice(-MAX_CHIPS);
}

let chips: ShowChip[] = [];
const chipListeners = new Set<() => void>();
const emit = (next: ShowChip[]) => { chips = next; for (const l of chipListeners) l(); };

export const pushChip = (chip: ShowChip) => emit(addChip(chips, chip));
export const dismissChip = (id: string) => emit(chips.filter((c) => c.id !== id));

export function useShowChips(): ShowChip[] {
  return useSyncExternalStore((l) => { chipListeners.add(l); return () => { chipListeners.delete(l); }; }, () => chips, () => chips);
}

// ---------------------------------------------------------------------------- the diff already open

let nudges = 0;
const nudgeListeners = new Set<() => void>();

/**
 * Ask the diff that's open to go to the URL's thread (or file) again: a show of the place the URL already names (the
 * reader may have scrolled away). A change of `thread` or `file` needs no nudge (DiffView notices it).
 */
export function nudgeDiff(): void {
  nudges++;
  for (const l of nudgeListeners) l();
}

export function useDiffNudge(): number {
  return useSyncExternalStore((l) => { nudgeListeners.add(l); return () => { nudgeListeners.delete(l); }; }, () => nudges, () => nudges);
}
