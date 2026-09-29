/**
 * Unsent comment text, per composer. The viewer is virtualized: a thread scrolled far enough away unmounts, and
 * with it any reply being typed. Keeping drafts here (and in sessionStorage, so a reload keeps them too) means
 * nothing typed is lost to scrolling, closing the comments column or reopening the diff.
 */
import type { DraftAnchor } from './threadModel';

const PREFIX = 'gh-dash:draft:';

export function getDraft(key: string): string {
  try {
    return sessionStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function setDraft(key: string, text: string): void {
  try {
    if (text.trim()) sessionStorage.setItem(PREFIX + key, text);
    else sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Private mode or a full quota: the draft lives as long as its composer.
  }
}

export const clearDraft = (key: string) => setDraft(key, '');

// ---------------------------------------------------------------- new threads

/**
 * A new thread's draft: its anchor (the lines, the revision they were read at, their text) and its text, kept as one
 * record under a key that names the revision and the lines. So the text always goes with the anchor it was written
 * against: the same lines on a later revision are another draft, and set-aside drafts can be listed and resumed.
 */
export interface NewThreadDraft {
  key: string;
  anchor: DraftAnchor;
  body: string;
}

const NEW = 'gh-dash:new-thread:';
const OPEN = 'gh-dash:new-thread-open:';

export const newDraftKey = (scope: string, a: DraftAnchor) =>
  `${scope}|${a.commitOid}|${a.baseOid ?? '-'}|${a.path}|${a.side}|${a.startLine}-${a.endLine}`;

function validAnchor(v: DraftAnchor | undefined): v is DraftAnchor {
  const oid = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{40}$/.test(x);
  return !!v && typeof v.path === 'string' && (v.side === 'old' || v.side === 'new') && Number.isInteger(v.startLine) && Number.isInteger(v.endLine)
    && v.startLine >= 1 && v.endLine >= v.startLine && oid(v.commitOid) && (v.baseOid === null || oid(v.baseOid))
    && typeof v.snippet === 'string' && v.snippet.split('\n').length === v.endLine - v.startLine + 1;
}

// Which drafts exist changes rarely (one opens, is sent or discarded): the viewer lists them, and listens for that.
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const fn of listeners) fn();
};
export const subscribeNewDrafts = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const newDraftsVersion = () => version;

export function loadNewDraft(key: string): NewThreadDraft | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(NEW + key) ?? 'null') as { anchor?: DraftAnchor; body?: unknown } | null;
    return v && validAnchor(v.anchor) && typeof v.body === 'string' ? { key, anchor: v.anchor, body: v.body } : null;
  } catch {
    return null;
  }
}

function store(d: NewThreadDraft): void {
  try {
    sessionStorage.setItem(NEW + d.key, JSON.stringify({ anchor: d.anchor, body: d.body }));
  } catch {
    // As for drafts.
  }
}

/** The draft for these lines at this revision: the one set aside earlier, or a new, empty one. */
export function openNewDraft(scope: string, anchor: DraftAnchor): NewThreadDraft {
  const key = newDraftKey(scope, anchor);
  const found = loadNewDraft(key);
  if (found) return found;
  const d = { key, anchor, body: '' };
  store(d);
  changed();
  return d;
}

/** The text of an existing draft (a sent or discarded one isn't brought back). */
export function setNewDraftBody(key: string, body: string): void {
  const d = loadNewDraft(key);
  if (d && d.body !== body) store({ ...d, body });
}

export function removeNewDraft(key: string): void {
  try {
    if (sessionStorage.getItem(NEW + key) === null) return;
    sessionStorage.removeItem(NEW + key);
  } catch {
    return;
  }
  changed();
}

/** A diff's drafts, oldest key first. */
export function listNewDrafts(scope: string): NewThreadDraft[] {
  const out: NewThreadDraft[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith(`${NEW}${scope}|`)) continue;
      const d = loadNewDraft(k.slice(NEW.length));
      if (d) out.push(d);
    }
  } catch {
    // Nothing to list.
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** The draft whose composer is open in a diff (at most one), so a reload opens it again. */
export function getOpenNewDraft(scope: string): NewThreadDraft | null {
  try {
    const key = sessionStorage.getItem(OPEN + scope);
    return key === null ? null : loadNewDraft(key);
  } catch {
    return null;
  }
}

export function setOpenNewDraft(scope: string, key: string | null): void {
  try {
    if (key === null) sessionStorage.removeItem(OPEN + scope);
    else sessionStorage.setItem(OPEN + scope, key);
  } catch {
    // As for drafts.
  }
}
