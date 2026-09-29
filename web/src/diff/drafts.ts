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

const ANCHOR = 'gh-dash:draft-anchor:';

/** Where the new-thread composer is open in a diff (its text is a draft like any other). */
export function getDraftAnchor(scope: string): DraftAnchor | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(ANCHOR + scope) ?? 'null') as DraftAnchor | null;
    const oid = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{40}$/.test(x);
    const ok = v && typeof v.path === 'string' && (v.side === 'old' || v.side === 'new') && Number.isInteger(v.startLine) && Number.isInteger(v.endLine)
      && v.startLine >= 1 && v.endLine >= v.startLine && oid(v.commitOid) && (v.baseOid === null || oid(v.baseOid))
      && typeof v.snippet === 'string' && v.snippet.split('\n').length === v.endLine - v.startLine + 1;
    return ok ? v : null;
  } catch {
    return null;
  }
}

export function setDraftAnchor(scope: string, anchor: DraftAnchor | null): void {
  try {
    if (anchor) sessionStorage.setItem(ANCHOR + scope, JSON.stringify(anchor));
    else sessionStorage.removeItem(ANCHOR + scope);
  } catch {
    // As for drafts.
  }
}
