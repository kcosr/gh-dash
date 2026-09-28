import { useEffect, useState } from 'react';
import type { Actor } from '../../../shared/api';

/** Clipboard with a fallback for insecure (plain-HTTP, non-localhost) contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Re-render periodically so relative times stay fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function actorName(a: Actor | null | undefined): string {
  if (!a) return 'someone';
  return a.login ?? a.name ?? 'someone';
}

/** "You" / "alice" as the subject of a sentence. */
export function actorSubject(a: Actor | null | undefined): string {
  return a?.isMe ? 'You' : actorName(a);
}

/**
 * Grouping key for a person. Every "me" identity (the viewer login and any commit email that
 * counts as me, which may have no linked account) shares one key, so they group together.
 */
export function actorKey(a: Actor | null | undefined): string {
  if (!a) return '?';
  if (a.isMe) return 'me';
  return (a.login ?? a.name ?? '?').toLowerCase();
}

/** A plain left click: in-app links handle it and leave modifier/middle clicks to the browser (their real href). */
export const isPlainClick = (e: { button: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; defaultPrevented: boolean }) =>
  !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

/** A lazy chunk failed to load (e.g. the app was redeployed, or the server is down). */
export const isChunkLoadError = (e: unknown) =>
  e instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(e.message);

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
