/**
 * A tiny stack of dismissable layers (palette, modal, popover, drawer) so a single
 * global Escape handler closes the top-most one. Blocking layers also disable
 * list shortcuts (j/k/Enter/o) while they're open.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

interface Layer { id: number; close: () => void; blocking: boolean; ancestors: readonly number[] }
const stack: Layer[] = [];
let seq = 0;

/**
 * The layers a subtree opens inside, outermost first (e.g. the diff view, then its compact comments column). Layers
 * opened inside them (a composer) stay above them whatever order they register in: an outer layer and an inner one
 * mounting in the same render register inner first (effects run child to parent), which would otherwise leave the
 * outer one on top. The whole chain is kept, so a layer that isn't open (the desktop column, not an overlay) doesn't
 * cut the inner ones off from those around it.
 */
export const LayerParent = createContext<readonly number[]>([]);

/**
 * A layer while `active`: `scope`, the LayerParent value for what opens inside it, and a stable `isTop()` check, for
 * layers with their own shortcuts (true only while nothing is open above).
 */
export function useLayerHandle(active: boolean, close: () => void, blocking = true): { scope: readonly number[]; isTop: () => boolean } {
  const ref = useRef(close);
  ref.current = close;
  const [id] = useState(() => ++seq);
  const ancestors = useContext(LayerParent);
  const scope = useMemo(() => [...ancestors, id], [ancestors, id]);
  const on = useRef(false);
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { id, close: () => ref.current(), blocking, ancestors };
    // Below the layers already open inside it, else on top.
    const firstInner = stack.findIndex((l) => l.ancestors.includes(id));
    if (firstInner >= 0) stack.splice(firstInner, 0, layer);
    else stack.push(layer);
    on.current = true;
    return () => {
      const i = stack.findIndex((l) => l.id === id);
      if (i >= 0) stack.splice(i, 1);
      on.current = false;
    };
  }, [active, blocking, id, ancestors]);
  const isTop = useCallback(() => on.current && topLayer()?.id === id, [id]);
  return { scope, isTop };
}

/** Returns a stable `isTop()` check, for layers with their own shortcuts (true only while nothing is open above). */
export function useLayer(active: boolean, close: () => void, blocking = true): () => boolean {
  return useLayerHandle(active, close, blocking).isTop;
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
