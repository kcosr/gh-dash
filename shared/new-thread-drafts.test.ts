import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenNewDraft, isSendingDraft, listNewDrafts, loadNewDraft, newDraftKey, newDraftsVersion, openNewDraft, removeNewDraft, sendingDrafts, setNewDraftBody,
  setOpenNewDraft, setSendingDraft,
} from '../web/src/diff/drafts';

/** sessionStorage, in memory. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

const anchor = (commitOid: string) => ({ path: 'a.ts', side: 'new' as const, startLine: 3, endLine: 4, commitOid, baseOid: null, snippet: 'x\ny' });
const R1 = '1'.repeat(40);
const R2 = '2'.repeat(40);

describe('new-thread drafts', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', memoryStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps a draft with its anchor, apart from the same lines on another revision', () => {
    const first = openNewDraft('app#2', anchor(R1));
    setNewDraftBody(first.key, 'On the first revision.');
    const second = openNewDraft('app#2', anchor(R2));
    expect(second.key).not.toBe(first.key);
    expect(second.body).toBe('');
    // Opening the first one's lines again resumes it, text and anchor.
    expect(openNewDraft('app#2', anchor(R1))).toEqual({ key: first.key, anchor: anchor(R1), body: 'On the first revision.', scope: 'app#2' });
    expect(listNewDrafts('app#2').map((d) => d.anchor.commitOid)).toEqual([R1, R2]);
    expect(listNewDrafts('app#20')).toEqual([]);
  });

  it("keeps a branch's drafts apart from those of a branch whose name starts with its name and a '|'", () => {
    openNewDraft('app~fix', anchor(R1));
    openNewDraft('app~fix|more', anchor(R2));
    // A name can go on with a '|' and a whole SHA, which looks like the revision after the shorter branch's scope.
    const R3 = '3'.repeat(40);
    openNewDraft(`app~fix|${R3}`, anchor(R2));
    expect(listNewDrafts('app~fix').map((d) => d.anchor.commitOid)).toEqual([R1]);
    expect(listNewDrafts('app~fix|more').map((d) => d.anchor.commitOid)).toEqual([R2]);
    expect(listNewDrafts(`app~fix|${R3}`).map((d) => d.key)).toEqual([newDraftKey(`app~fix|${R3}`, anchor(R2))]);
  });

  it('still lists a draft stored before drafts kept their scope (PRs and commits, whose scopes hold no pipe)', () => {
    const key = newDraftKey('app#2', anchor(R1));
    sessionStorage.setItem(`gh-dash:new-thread:${key}`, JSON.stringify({ anchor: anchor(R1), body: 'from before' }));
    expect(listNewDrafts('app#2')).toEqual([{ key, anchor: anchor(R1), body: 'from before' }]);
    expect(openNewDraft('app#2', anchor(R1)).body).toBe('from before');
    // Its text, edited, keeps it where it was.
    setNewDraftBody(key, 'edited');
    expect(listNewDrafts('app#2').map((d) => d.body)).toEqual(['edited']);
  });

  it("doesn't bring back a draft that was sent or discarded", () => {
    const d = openNewDraft('app#2', anchor(R1));
    const before = newDraftsVersion();
    removeNewDraft(d.key);
    expect(newDraftsVersion()).toBe(before + 1);
    setNewDraftBody(d.key, 'late keystroke');
    expect(loadNewDraft(d.key)).toBeNull();
  });

  it('removes only the version that was sent', () => {
    const d = openNewDraft('app#2', anchor(R1));
    setNewDraftBody(d.key, 'newer edits');
    removeNewDraft(d.key, 'what was sent');
    expect(loadNewDraft(d.key)?.body).toBe('newer edits');
    removeNewDraft(d.key, 'newer edits');
    expect(loadNewDraft(d.key)).toBeNull();
  });

  it('knows which drafts are being sent, for any viewer, and says when that changes', () => {
    const before = newDraftsVersion();
    setSendingDraft('k', true);
    setSendingDraft('k', true);
    expect(isSendingDraft('k')).toBe(true);
    expect([...sendingDrafts()]).toEqual(['k']);
    setSendingDraft('k', false);
    expect(isSendingDraft('k')).toBe(false);
    expect(newDraftsVersion()).toBe(before + 2);
  });

  it('remembers which draft is open, and drops records that are not whole', () => {
    const d = openNewDraft('app#2', anchor(R1));
    setOpenNewDraft('app#2', d.key);
    expect(getOpenNewDraft('app#2')?.key).toBe(d.key);
    setOpenNewDraft('app#2', null);
    expect(getOpenNewDraft('app#2')).toBeNull();
    sessionStorage.setItem(`gh-dash:new-thread:${newDraftKey('app#2', anchor(R2))}`, JSON.stringify({ anchor: { ...anchor(R2), snippet: 'one line' }, body: 'x' }));
    expect(listNewDrafts('app#2').map((x) => x.key)).toEqual([d.key]);
  });
});
