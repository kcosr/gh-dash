// A repository's status in words: the reason in titles, the Inactive badge, the Add dialog's note and the toast.
import { describe, expect, it } from 'vitest';
import type { Repo } from './api';
import { activeReasonText, inactiveBadge, inactiveNote, statusToast } from '../web/src/lib/repoStatus';

const now = new Date('2026-10-11T12:00:00Z');
const repo = (over: Partial<Repo> = {}) => ({
  provider: 'github' as const, url: 'https://github.com/alice/app', nameWithOwner: 'alice/app',
  status: 'auto' as const, active: true, activeReason: 'recent' as const, autoActive: true, lastActivityAt: '2026-09-01T12:00:00Z', ...over,
});
const gitlab = { provider: 'gitlab' as const, url: 'https://gitlab.example.com/alice/app', nameWithOwner: 'alice/app' };

describe('why a repository is active or not', () => {
  it('says what decided it, short', () => {
    expect(activeReasonText(repo({ status: 'active', activeReason: 'set' }), now)).toBe('Marked active');
    expect(activeReasonText(repo({ status: 'inactive', active: false, activeReason: 'set' }), now)).toBe('Marked inactive');
    expect(activeReasonText(repo({ active: false, activeReason: 'archived' }), now)).toBe('Archived');
    expect(activeReasonText(repo({ active: false, activeReason: 'fork' }), now)).toBe('Fork (forks are off in Settings)');
    expect(activeReasonText(repo({ activeReason: 'pinned' }), now)).toBe('Pinned');
    expect(activeReasonText(repo({ activeReason: 'recent' }), now)).toBe('Activity in the last 6 months');
  });

  it("names open work in the host's words", () => {
    expect(activeReasonText(repo({ activeReason: 'open' }), now)).toBe('Open pull requests, issues or comment threads');
    expect(activeReasonText(repo({ ...gitlab, activeReason: 'open' }), now)).toBe('Open merge requests, issues or comment threads');
  });

  it('dates a quiet one by its last activity, with the year when it is another', () => {
    expect(activeReasonText(repo({ active: false, activeReason: 'quiet', lastActivityAt: '2025-03-03T12:00:00Z' }), now)).toBe('No activity since Mar 3, 2025');
    expect(activeReasonText(repo({ active: false, activeReason: 'quiet', lastActivityAt: '2026-01-15T12:00:00Z' }), now)).toBe('No activity since Jan 15');
    expect(activeReasonText(repo({ active: false, activeReason: 'quiet', lastActivityAt: null }), now)).toBe('No activity yet');
  });
});

describe('the Inactive badge', () => {
  it('shows for an inactive repo unless its Archived or Fork badge says why already', () => {
    expect(inactiveBadge(repo())).toBe(false);
    expect(inactiveBadge(repo({ active: false, activeReason: 'quiet' }))).toBe(true);
    expect(inactiveBadge(repo({ active: false, activeReason: 'set' }))).toBe(true);
    expect(inactiveBadge(repo({ active: false, activeReason: 'archived' }))).toBe(false);
    expect(inactiveBadge(repo({ active: false, activeReason: 'fork' }))).toBe(false);
  });
});

describe("the Add dialog's note on a tracked repo", () => {
  it('says an inactive one is, and why; nothing for an active one', () => {
    expect(inactiveNote(repo(), now)).toBeNull();
    expect(inactiveNote(repo({ status: 'active', activeReason: 'set' }), now)).toBeNull();
    expect(inactiveNote(repo({ status: 'inactive', active: false, activeReason: 'set' }), now)).toBe("It's marked inactive.");
    expect(inactiveNote(repo({ active: false, activeReason: 'archived' }), now)).toBe("It's inactive: archived.");
    expect(inactiveNote(repo({ active: false, activeReason: 'quiet', lastActivityAt: '2025-03-03T12:00:00Z' }), now))
      .toBe("It's inactive: no activity since Mar 3, 2025.");
  });

  it("goes by the status alone for a lookup's preview", () => {
    expect(inactiveNote({ status: 'inactive' })).toBe("It's marked inactive.");
    expect(inactiveNote({ status: 'auto' })).toBeNull();
    expect(inactiveNote({ status: null })).toBeNull();
  });
});

describe('the toast after a status change', () => {
  it("says what the server made of it", () => {
    expect(statusToast('app', { status: 'inactive', active: false })).toBe('app marked inactive');
    expect(statusToast('app', { status: 'active', active: true })).toBe('app marked active');
    expect(statusToast('app', { status: 'auto', active: true })).toBe('app set to automatic (active)');
    expect(statusToast('app', { status: 'auto', active: false })).toBe('app set to automatic (inactive)');
  });
});
