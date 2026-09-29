import { describe, expect, it } from 'vitest';
import { decideLink, isAppUrl } from './navigation';

describe('decideLink', () => {
  it('sends web links to the browser', () => {
    expect(decideLink('https://github.com/kcosr/gh-dash/pull/5', null)).toEqual({ action: 'external', url: 'https://github.com/kcosr/gh-dash/pull/5' });
    expect(decideLink('http://example.com', 'http://127.0.0.1:4780')).toEqual({ action: 'external', url: 'http://example.com/' });
  });

  it('keeps app pages in the window', () => {
    expect(decideLink('app://gh-dash/prs?pr=sedes%237', null)).toEqual({ action: 'app' });
    expect(decideLink('app://gh-dash/', null)).toEqual({ action: 'app' });
    expect(decideLink('app://gh-dash/apis-are-not-api', null)).toEqual({ action: 'app' });
  });

  it('opens the API through the Local API, or not at all', () => {
    expect(decideLink('app://gh-dash/api/docs', null)).toMatchObject({ action: 'ignore' });
    expect(decideLink('app://gh-dash/api/docs', 'http://127.0.0.1:4780')).toEqual({ action: 'external', url: 'http://127.0.0.1:4780/api/docs' });
    expect(decideLink('app://gh-dash/api/v1/prs?format=md#top', 'http://127.0.0.1:4780/')).toEqual({ action: 'external', url: 'http://127.0.0.1:4780/api/v1/prs?format=md#top' });
    expect(decideLink('app://gh-dash/api', 'http://127.0.0.1:4780')).toEqual({ action: 'external', url: 'http://127.0.0.1:4780/api' });
    expect(decideLink('app://gh-dash/api/docs', 'file:///etc')).toMatchObject({ action: 'ignore' });
  });

  it('drops every other scheme and host', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:me@example.com', 'app://evil/prs', 'ftp://example.com', 'devtools://devtools', 'not a url', 'chrome://gpu']) {
      expect(decideLink(url, 'http://127.0.0.1:4780')).toMatchObject({ action: 'ignore' });
    }
  });
});

describe('isAppUrl', () => {
  it('matches app://gh-dash only', () => {
    expect(isAppUrl('app://gh-dash/prs')).toBe(true);
    expect(isAppUrl('app://gh-dash')).toBe(true);
    expect(isAppUrl('app://gh-dash.evil/prs')).toBe(false);
    expect(isAppUrl('https://gh-dash/prs')).toBe(false);
    expect(isAppUrl('')).toBe(false);
  });
});
