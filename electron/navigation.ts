/**
 * Where a link or navigation from the app window may go. Pure, so the rules are unit-tested:
 *  - app://gh-dash/... stays in the window, except the API (/api/...), which only makes sense in a browser: it opens
 *    there through the Local API when that is on, and is ignored otherwise;
 *  - http(s) opens in the system browser;
 *  - anything else (file:, javascript:, other app hosts, custom schemes) is dropped.
 */
import { DESKTOP_HOST, DESKTOP_SCHEME } from '../shared/desktop';

export type LinkDecision =
  | { action: 'app' }
  | { action: 'external'; url: string }
  | { action: 'ignore'; reason: string };

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// NB: Node treats app: as a non-special scheme (URL.origin is "null"), so compare the parts.
export const isAppUrl = (raw: string): boolean => {
  const url = parse(raw);
  return !!url && url.protocol === `${DESKTOP_SCHEME}:` && url.host === DESKTOP_HOST;
};

const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/');

export function decideLink(raw: string, apiUrl: string | null): LinkDecision {
  const url = parse(raw);
  if (!url) return { action: 'ignore', reason: 'invalid URL' };
  if (url.protocol === 'http:' || url.protocol === 'https:') return { action: 'external', url: url.href };
  if (url.protocol !== `${DESKTOP_SCHEME}:` || url.host !== DESKTOP_HOST) return { action: 'ignore', reason: `scheme ${url.protocol}` };
  if (!isApiPath(url.pathname)) return { action: 'app' };
  if (!apiUrl) return { action: 'ignore', reason: 'the Local API is off' };
  const base = parse(apiUrl);
  if (!base || (base.protocol !== 'http:' && base.protocol !== 'https:')) return { action: 'ignore', reason: 'invalid Local API URL' };
  return { action: 'external', url: new URL(url.pathname + url.search + url.hash, base).href };
}
