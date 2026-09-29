import { describe, expect, it } from 'vitest';
import { accessFailure, notFound, reasonOf } from './access';

const at = ['nodes', 1];

describe('accessFailure', () => {
  it('reads the errors of the repository at a path, ignoring other entries', () => {
    const other = { type: 'NOT_FOUND', message: 'x', path: ['nodes', 0] };
    expect(accessFailure([other], at, 'o/n', 'classic')).toBeNull();
    expect(accessFailure([{ ...other, path: at }], at, 'o/n', 'classic')).toEqual(notFound('o/n', 'classic'));
    expect(accessFailure([], at, 'o/n', null)).toBeNull();
  });

  it('prefers what the token is refused over not-found, and names every section it may not read', () => {
    const refused = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.', path: at };
    expect(accessFailure([{ type: 'NOT_FOUND', message: 'x', path: at }, refused], at, 'org/n', 'oauth')).toMatchObject({ problem: 'sso', hint: 'Run `gh auth refresh` and authorize org.' });
    const sections = ['openPrs', 'latestIssue', 'defaultBranchRef', 'latestPr'].map((f) => ({ type: 'FORBIDDEN', message: 'no', path: [...at, f] }));
    expect(accessFailure(sections, at, 'o/n', 'fine-grained')).toEqual({
      problem: 'permission', message: 'The token can see o/n but not its pull requests, issues and code history.', hint: 'Grant read access to Pull requests, Issues and Contents.',
    });
  });

  it('keeps nested owners whole and gives one line for the stored reason', () => {
    const f = notFound('grp/sub/proj', 'fine-grained');
    expect(f.hint).toContain('Create one for grp/sub,');
    expect(reasonOf(f)).toBe(`${f.message} ${f.hint}`);
    expect(reasonOf({ problem: 'org-policy', message: 'Policy.', hint: null })).toBe('Policy.');
  });
});
