import { describe, expect, it } from 'vitest';
import { reasonOf } from '../provider/access';
import { codeHidden, notFound, unavailable, unreadable } from './access';

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

  it('names the code as what the token cannot read of a project it sees', () => {
    expect(codeHidden('alice/app')).toEqual({
      problem: 'permission',
      message: 'The token can see alice/app but not its code.',
      hint: "Guests can't read a private project's code; ask for Reporter access.",
    });
  });

  it('refuses a project only for its code, and takes a permission GitLab did not report as readable', () => {
    expect(unreadable('alice/app', { userPermissions: { downloadCode: true, readMergeRequest: true } })).toBeNull();
    expect(unreadable('alice/app', { userPermissions: null })).toBeNull();
    expect(unreadable('alice/app', { userPermissions: { downloadCode: null, readMergeRequest: null } })).toBeNull();
    expect(unreadable('alice/app', { userPermissions: { downloadCode: false, readMergeRequest: true } })).toEqual(codeHidden('alice/app'));
    // Merge requests and issues out of reach are not a reason to refuse.
    expect(unreadable('alice/app', { userPermissions: { downloadCode: true, readMergeRequest: false } })).toBeNull();
  });

  it('reports the merge requests and issues the token gets nothing of, in the order of the counts', () => {
    const all = { userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: true };
    expect(unavailable(all)).toEqual([]);
    expect(unavailable({ userPermissions: null, issuesEnabled: null })).toEqual([]);
    expect(unavailable({ ...all, issuesEnabled: false })).toEqual(['issues']);
    expect(unavailable({ ...all, userPermissions: { downloadCode: true, readMergeRequest: false } })).toEqual(['prs']);
    expect(unavailable({ userPermissions: { downloadCode: false, readMergeRequest: false }, issuesEnabled: false })).toEqual(['prs', 'issues']);
  });
});
