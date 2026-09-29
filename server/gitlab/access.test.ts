import { describe, expect, it } from 'vitest';
import { reasonOf } from '../provider/access';
import { notFound, permissionDenied, unreadable } from './access';

describe('GitLab access wording', () => {
  it('says GitLab does not show a project, without claiming to know why', () => {
    expect(notFound('team/platform/api')).toEqual({
      problem: 'not-found',
      message: "GitLab doesn't show team/platform/api to this token: it doesn't exist, or you aren't a member.",
      hint: 'Private projects need membership (Reporter or higher). Check the path, or ask a maintainer.',
    });
    expect(reasonOf(notFound('bob/tool'))).toBe(
      "GitLab doesn't show bob/tool to this token: it doesn't exist, or you aren't a member. Private projects need membership (Reporter or higher). Check the path, or ask a maintainer.",
    );
  });

  it('names what the token cannot read of a project it sees', () => {
    expect(permissionDenied('alice/app', ['code'])).toEqual({
      problem: 'permission',
      message: 'The token can see alice/app but not its code.',
      hint: "Guests can't read a private project's code; ask for Reporter access.",
    });
    expect(permissionDenied('alice/app', ['code', 'merge requests', 'issues']).message).toBe('The token can see alice/app but not its code, merge requests and issues.');
    expect(permissionDenied('alice/app', ['merge requests', 'issues']).message).toBe('The token can see alice/app but not its merge requests and issues.');
  });

  it('finds what is unreadable from the permissions GitLab reports, and takes what it did not report as readable', () => {
    const all = { userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: true };
    expect(unreadable('alice/app', all)).toBeNull();
    expect(unreadable('alice/app', { userPermissions: null, issuesEnabled: null })).toBeNull();
    expect(unreadable('alice/app', { ...all, userPermissions: { downloadCode: false, readMergeRequest: true } })?.message).toContain('not its code.');
    expect(unreadable('alice/app', { ...all, userPermissions: { downloadCode: true, readMergeRequest: false } })?.message).toContain('not its merge requests.');
    expect(unreadable('alice/app', { ...all, issuesEnabled: false })?.message).toContain('not its issues.');
    const none = unreadable('alice/app', { userPermissions: { downloadCode: false, readMergeRequest: false }, issuesEnabled: false });
    expect(none).toMatchObject({ problem: 'permission', message: 'The token can see alice/app but not its code, merge requests and issues.' });
  });
});
