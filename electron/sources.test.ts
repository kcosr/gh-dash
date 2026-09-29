import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigFile } from '../server/config-file';
import { addEntry, draftTarget, findGlab, gitlabEnvState, lockingEnv, parseCredentialDraft, parseHostInput, parseSourceDraft, removeEntry, sourceIndex, withMethod } from './sources';

const A = 'https://gitlab.example.com/gitlab';
const B = 'https://gitlab2.example.com';
const SET = { GITLAB_TOKEN: 'glpat-from-env' };
const config = (...entries: Array<Record<string, unknown>>): ConfigFile => ({ sources: entries.map((e) => ({ kind: 'gitlab' as const, url: A, ...e })) as ConfigFile['sources'] });

describe('what the renderer may send', () => {
  it('takes a URL and a method, and a pasted token only with the app method', () => {
    expect(parseSourceDraft({ kind: 'gitlab', url: ` ${A} `, method: 'app', token: ' glpat-abc ', remember: true })).toEqual({ kind: 'gitlab', url: A, method: 'app', token: 'glpat-abc', remember: true });
    expect(parseSourceDraft({ kind: 'gitlab', url: A, method: 'glab' })).toEqual({ kind: 'gitlab', url: A, method: 'glab' });
    expect(parseCredentialDraft({ method: 'file' })).toEqual({ method: 'file' });
    expect(parseCredentialDraft({ method: 'env' })).toEqual({ method: 'env' });
  });

  it('never takes a path or a variable name from the renderer', () => {
    expect(() => parseSourceDraft({ kind: 'gitlab', url: A, method: 'file', tokenFile: '/home/alice/.ssh/id_ed25519' })).toThrow('Unexpected tokenFile.');
    expect(() => parseSourceDraft({ kind: 'gitlab', url: A, method: 'env', tokenEnv: 'AWS_SECRET_ACCESS_KEY' })).toThrow('Unexpected tokenEnv.');
    expect(() => parseCredentialDraft({ method: 'glab', glabPath: '/tmp/evil' })).toThrow('Unexpected glabPath.');
    expect(() => parseCredentialDraft({ method: 'app', token: 'glpat-abc', remember: true, tokenFile: '/x' })).toThrow('Unexpected tokenFile.');
  });

  it('refuses what is not a draft', () => {
    expect(() => parseSourceDraft(null)).toThrow('Expected a GitLab source.');
    expect(() => parseSourceDraft({ kind: 'github', url: A, method: 'glab' })).toThrow('Only GitLab sources');
    expect(() => parseSourceDraft({ kind: 'gitlab', url: '  ', method: 'glab' })).toThrow("Enter the GitLab instance's URL.");
    expect(() => parseSourceDraft({ kind: 'gitlab', url: `${A}/${'x'.repeat(2100)}`, method: 'glab' })).toThrow('too long');
    expect(() => parseCredentialDraft({ method: 'gh' })).toThrow('Choose how to sign in');
    expect(() => parseCredentialDraft({ method: 'app', token: '  ', remember: true })).toThrow('Paste a GitLab token.');
    expect(() => parseCredentialDraft({ method: 'app', token: 'glpat abc', remember: true })).toThrow('does not look like a GitLab token');
    expect(() => parseCredentialDraft({ method: 'app', token: 'glpat-abc', remember: 'yes' })).toThrow('remember must be true or false.');
    expect(parseHostInput(' GitLab.Example.com ')).toBe('gitlab.example.com');
    for (const bad of ['', '../tokens', 'a/b', 42, 'x_y.example']) expect(() => parseHostInput(bad)).toThrow('That is not a source.');
  });

  it('saves the URL normalized, and refuses github.com and what is not a URL', () => {
    expect(draftTarget(`${A}//`)).toEqual({ baseUrl: A, host: 'gitlab.example.com' });
    expect(() => draftTarget('https://github.com')).toThrow('github.com is built in: connect it under GitHub.');
    expect(() => draftTarget('gitlab.example.com')).toThrow('Invalid GitLab URL');
    expect(() => draftTarget('https://alice:pw@gitlab.example.com')).toThrow('must not contain credentials');
  });
});

describe('config.json entries', () => {
  it('finds a source by host, whatever the URL looks like', () => {
    const c = config({ url: 'https://GitLab.Example.com:8443/gitlab/' }, { url: B });
    expect(sourceIndex(c, 'gitlab.example.com')).toBe(0);
    expect(sourceIndex(c, 'gitlab2.example.com')).toBe(1);
    expect(sourceIndex(c, 'gitlab3.example.com')).toBe(-1);
    expect(sourceIndex({}, 'gitlab.example.com')).toBe(-1);
  });

  it('writes what each method stands for, keeping the rest of the entry', () => {
    const entry = { kind: 'gitlab' as const, url: A, tokenSource: 'file' as const, tokenFile: '/secure/gitlab-token' };
    expect(withMethod(entry, 'glab', null)).toEqual({ kind: 'gitlab', url: A, tokenSource: 'glab' });
    expect(withMethod(entry, 'app', null)).toEqual({ kind: 'gitlab', url: A, tokenSource: 'app' });
    expect(withMethod({ kind: 'gitlab', url: A }, 'file', '/home/alice/gl-token')).toEqual({ kind: 'gitlab', url: A, tokenSource: 'file', tokenFile: '/home/alice/gl-token' });
    expect(() => withMethod(entry, 'file', null)).toThrow('Choose the token file first.');
    expect(withMethod(entry, 'env', null)).toEqual({ kind: 'gitlab', url: A, tokenEnv: 'GITLAB_TOKEN' });
    // Signing out: no method; GITLAB_TOKEN named by the app goes, a variable named by hand stays.
    expect(withMethod({ kind: 'gitlab', url: A, tokenEnv: 'GITLAB_TOKEN' }, null, null)).toEqual({ kind: 'gitlab', url: A, tokenSource: null });
    expect(withMethod({ kind: 'gitlab', url: A, tokenEnv: 'WORK_GITLAB_TOKEN', tokenSource: 'app' }, 'glab', null)).toEqual({ kind: 'gitlab', url: A, tokenEnv: 'WORK_GITLAB_TOKEN', tokenSource: 'glab' });
  });

  it('adds and removes entries; the only source keeps GITLAB_TOKEN when a second one comes', () => {
    const one = config({ tokenSource: 'glab' });
    expect(addEntry(one, { kind: 'gitlab', url: B, tokenSource: 'app' }, {})).toEqual({ sources: [{ kind: 'gitlab', url: A, tokenSource: 'glab' }, { kind: 'gitlab', url: B, tokenSource: 'app' }] });
    expect(addEntry(one, { kind: 'gitlab', url: B, tokenSource: 'app' }, SET).sources![0]).toEqual({ kind: 'gitlab', url: A, tokenSource: 'glab', tokenEnv: 'GITLAB_TOKEN' });
    expect(addEntry({ port: 4800 }, { kind: 'gitlab', url: B }, SET)).toEqual({ port: 4800, sources: [{ kind: 'gitlab', url: B }] });
    const two = config({}, { url: B });
    expect(removeEntry(two, 0)).toEqual({ sources: [{ kind: 'gitlab', url: B }] });
    expect(removeEntry({ glabPath: '/x', sources: [{ kind: 'gitlab', url: A }] }, 0)).toEqual({ glabPath: '/x' });
  });
});

describe('GITLAB_TOKEN', () => {
  it('is unset, or locks the only source', () => {
    expect(gitlabEnvState({}, {})).toBe('unset');
    expect(gitlabEnvState({}, { GITLAB_TOKEN: '  ' })).toBe('unset');
    expect(gitlabEnvState({}, SET)).toBe('locks');
    expect(gitlabEnvState(config({ tokenSource: 'glab' }), SET, 'gitlab.example.com')).toBe('locks');
    expect(lockingEnv(config({ tokenSource: 'glab' }), 0, SET)).toBe('GITLAB_TOKEN');
    expect(lockingEnv(config({ tokenSource: 'glab' }), 0, {})).toBeNull();
  });

  it('is taken by the only source when a second one is added, and offered when free', () => {
    expect(gitlabEnvState(config({ tokenSource: 'glab' }), SET)).toBe('in-use');
    expect(gitlabEnvState(config({ tokenEnv: 'WORK_TOKEN' }), SET)).toBe('offered');
    const two = config({ tokenSource: 'glab' }, { url: B, tokenSource: 'app' });
    expect(gitlabEnvState(two, SET)).toBe('offered');
    expect(gitlabEnvState(two, SET, 'gitlab2.example.com')).toBe('offered');
    expect(lockingEnv(two, 0, SET)).toBeNull();
    const named = config({ tokenEnv: 'GITLAB_TOKEN' }, { url: B, tokenSource: 'app' });
    expect(gitlabEnvState(named, SET)).toBe('in-use');
    expect(gitlabEnvState(named, SET, 'gitlab2.example.com')).toBe('in-use');
    expect(lockingEnv(named, 0, SET)).toBe('GITLAB_TOKEN');
  });
});

describe.skipIf(process.platform === 'win32')('findGlab', () => {
  it('finds glabPath, else glab on PATH; null when there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghd-glab-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'glab'), '#!/bin/sh\n');
      chmodSync(join(bin, 'glab'), 0o755);
      const env = { PATH: bin, HOME: dir };
      expect(await findGlab(null, env, 'linux')).toBe(join(bin, 'glab'));
      expect(await findGlab(join(bin, 'glab'), { HOME: dir }, 'linux')).toBe(join(bin, 'glab'));
      expect(await findGlab(join(dir, 'missing'), env, 'linux')).toBeNull();
      // ~/bin is one of the usual folders: found there without PATH too, but not with another home.
      expect(await findGlab(null, { PATH: join(dir, 'empty'), HOME: dir }, 'linux')).toBe(join(bin, 'glab'));
      expect(await findGlab(null, { PATH: join(dir, 'empty'), HOME: join(dir, 'elsewhere') }, 'linux')).not.toBe(join(bin, 'glab'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
