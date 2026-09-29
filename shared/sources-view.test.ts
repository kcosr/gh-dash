import { describe, expect, it } from 'vitest';
import type { Source } from './api';
import { credentialOf, draftKey, draftOf, fileFor, gitlabUrlInput, methodsFor, projectsLine, removeMode, sourceMethodLabel, syncLine } from '../web/src/lib/sources';

const now = new Date(2026, 8, 29, 15, 0).getTime();
const form = (over = {}) => ({ method: 'app' as const, token: '', remember: true, file: null, ...over });

describe('the GitLab address', () => {
  it('is saved the way the server saves it, with https:// when no scheme is typed', () => {
    expect(gitlabUrlInput('')).toBeNull();
    expect(gitlabUrlInput('  gitlab.example.com ')).toEqual({ baseUrl: 'https://gitlab.example.com', host: 'gitlab.example.com' });
    expect(gitlabUrlInput('https://Example.com/gitlab//')).toEqual({ baseUrl: 'https://example.com/gitlab', host: 'example.com' });
    expect(gitlabUrlInput('http://127.0.0.1:8080/gl')).toEqual({ baseUrl: 'http://127.0.0.1:8080/gl', host: '127.0.0.1' });
  });

  it('says what is wrong with one that cannot be a source', () => {
    expect(gitlabUrlInput('ftp://gitlab.example.com')).toEqual({ error: 'The address starts with https:// (or http://).' });
    expect(gitlabUrlInput('https://alice:pw@gitlab.example.com')).toEqual({ error: 'Leave out any user name, password, ? or #.' });
    expect(gitlabUrlInput('https://gitlab.example.com/?x=1')).toEqual({ error: 'Leave out any user name, password, ? or #.' });
    expect(gitlabUrlInput('https://github.com')).toEqual({ error: 'github.com is built in: it is the GitHub source above.' });
    expect(gitlabUrlInput('https://[::1]/')).toEqual({ error: 'That is not a host name.' });
    expect(gitlabUrlInput('http://')).toMatchObject({ error: expect.any(String) });
  });
});

describe('drafts', () => {
  it('are sent only when complete, never with a path or a variable name', () => {
    expect(draftOf('', form())).toEqual({ missing: "Enter your GitLab's address." });
    expect(draftOf('gitlab.example.com', form())).toEqual({ missing: 'Paste a token.' });
    expect(draftOf('gitlab.example.com', form({ token: ' glpat-x ', remember: false }))).toEqual({ kind: 'gitlab', url: 'https://gitlab.example.com', method: 'app', token: 'glpat-x', remember: false });
    expect(draftOf('gitlab.example.com', form({ method: 'file' }))).toEqual({ missing: 'Choose the token file.' });
    expect(draftOf('gitlab.example.com', form({ method: 'file', file: '/home/alice/gl-token' }))).toEqual({ kind: 'gitlab', url: 'https://gitlab.example.com', method: 'file' });
    // A file picked for one address isn't used for another (main refuses it too).
    expect(draftOf('gitlab.example.com', form({ method: 'file', file: '/a', fileHost: 'gitlab.example.com' }))).toMatchObject({ method: 'file' });
    expect(draftOf('gitlab2.example.com', form({ method: 'file', file: '/a', fileHost: 'gitlab.example.com' }))).toEqual({ missing: 'Choose the token file.' });
    expect(fileFor({ file: '/a', fileHost: 'gitlab.example.com' }, 'gitlab2.example.com')).toBeNull();
    expect(credentialOf(form({ method: 'env' }))).toEqual({ method: 'env' });
    expect(credentialOf(form({ method: 'glab', token: 'left over' }))).toEqual({ method: 'glab' });
  });

  it('are tested again when anything that decides the test changes', () => {
    const a = draftOf('gitlab.example.com', form({ token: 'glpat-a' }));
    const b = draftOf('gitlab.example.com', form({ token: 'glpat-a', remember: false }));
    const c = draftOf('gitlab.example.com', form({ token: 'glpat-b' }));
    const key = (d: ReturnType<typeof draftOf>, file: string | null = null) => ('missing' in d ? null : draftKey(d, file));
    expect(key(a)).toBe(key(b));
    expect(key(a)).not.toBe(key(c));
    const f1 = draftOf('gitlab.example.com', form({ method: 'file', file: '/a' }));
    expect(key(f1, '/a')).not.toBe(key(f1, '/b'));
  });

  it('offer GITLAB_TOKEN only as the environment allows', () => {
    expect(methodsFor(undefined)).toEqual(['app', 'glab', 'file']);
    expect(methodsFor('unset')).toEqual(['app', 'glab', 'file']);
    expect(methodsFor('in-use')).toEqual(['app', 'glab', 'file']);
    expect(methodsFor('offered')).toEqual(['app', 'glab', 'file', 'env']);
    expect(methodsFor('locks')).toEqual(['env']);
  });
});

describe('a GitLab source, in words', () => {
  it('names where its token comes from', () => {
    expect(sourceMethodLabel({ source: 'glab', choice: 'glab', env: 'GITLAB_TOKEN' })).toBe('GitLab CLI (glab config get token)');
    expect(sourceMethodLabel({ source: 'env', choice: null, env: 'WORK_TOKEN' }, { desktop: true })).toBe('WORK_TOKEN environment variable');
    expect(sourceMethodLabel({ source: 'env', choice: 'auto', env: 'GITLAB_TOKEN' })).toBe('GITLAB_TOKEN (environment)');
    expect(sourceMethodLabel({ source: 'app', choice: 'app', env: null }, { desktop: true, remembered: true })).toBe('Pasted token, saved in the OS keychain');
    expect(sourceMethodLabel({ source: 'app', choice: 'app', env: null }, { desktop: true })).toBe('Pasted token, kept until gh-dash quits');
    expect(sourceMethodLabel({ source: 'file', choice: 'file', env: null })).toBe('Token file');
    expect(sourceMethodLabel({ source: 'none', choice: null, env: null })).toBe('Not connected');
    expect(sourceMethodLabel({ source: 'none', choice: 'auto', env: null })).toBe('No token found');
  });

  it('counts its projects and says how its sync went', () => {
    expect(projectsLine({ repos: { owned: 2, added: 3, hidden: 1 }, account: { repos: { total: 56, private: null } } })).toBe('56 personal · 3 added · 1 hidden');
    expect(projectsLine({ repos: { owned: 2, added: 0, hidden: 0 }, account: null })).toBe('2 personal');
    const base = { running: false, progress: null, lastSyncAt: null, lastResult: null };
    expect(syncLine(base, now)).toBe('Never synced');
    expect(syncLine({ ...base, running: true, progress: { done: 3, total: 10, current: null } }, now)).toBe('Syncing 3/10');
    expect(syncLine({ ...base, lastSyncAt: new Date(now - 5 * 60e3).toISOString(), lastResult: { newItems: 1, errors: ['a', 'b'] } }, now)).toBe('5 min ago · 1 new item · 2 errors');
  });

  it('is removed here only when this app added it or nothing configures it any more', () => {
    const s = (over: Partial<Source>) => ({ host: 'gitlab.example.com', kind: 'gitlab' as const, configured: true, removable: false, ...over });
    const ctx = { desktopHosts: null, desktopServer: false, from: 'file' as const };
    expect(removeMode(s({ kind: 'github', host: 'github.com' }), ctx)).toBeNull();
    expect(removeMode(s({}), { ...ctx, desktopHosts: ['gitlab.example.com'] })).toBe('app');
    expect(removeMode(s({ configured: false, removable: true }), ctx)).toBe('delete');
    expect(removeMode(s({ configured: false, removable: true }), { ...ctx, desktopHosts: [] })).toBe('delete');
    expect(removeMode(s({}), ctx)).toBe('file');
    expect(removeMode(s({}), { ...ctx, from: 'env' })).toBe('env');
    expect(removeMode(s({}), { ...ctx, desktopServer: true })).toBe('desktop');
  });
});
