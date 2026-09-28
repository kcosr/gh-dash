/**
 * A tiny stack of dismissable layers (palette, modal, popover, drawer) so a single
 * global Escape handler closes the top-most one. Blocking layers also disable
 * list shortcuts (j/k/Enter/o) while they're open.
 */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

interface Layer { id: number; close: () => void; blocking: boolean }
const stack: Layer[] = [];
let seq = 0;

export function useLayer(active: boolean, close: () => void, blocking = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { id: ++seq, close: () => ref.current(), blocking };
    stack.push(layer);
    return () => {
      const i = stack.findIndex((l) => l.id === layer.id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active, blocking]);
}

export const topLayer = (): Layer | undefined => stack[stack.length - 1];
export const hasBlockingLayer = () => stack.some((l) => l.blocking);

export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus handling: move focus into `ref` when it opens (unless something inside already has it,
 * e.g. an autoFocus input), keep Tab inside while active, and restore focus on close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true) {
  // What had focus before the dialog mounted. Captured during the first render: by the time effects
  // run, an autoFocus field inside the dialog has already taken focus.
  const [prev] = useState(() => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null));
  useEffect(() => {
    if (!active) return;
    const box = ref.current;
    // Prefer the dialog's text field (a name prompt, the palette input), else its first control.
    if (box && !box.contains(document.activeElement)) (box.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])') ?? box.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && (el.offsetParent !== null || el === document.activeElement));
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0], last = els[els.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (prev && prev !== document.body && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [ref, active, prev]);
}
