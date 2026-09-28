import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, RefObject } from 'react';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { clearTextCache } from './util';
import { hideTip, showTip, tipText, type TipData } from './tooltip';

/**
 * Width of an element via ResizeObserver. Measured synchronously on mount (before paint), then
 * coalesced to one update per frame. Returns 0 until measured: callers must not draw at 0.
 */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[entries.length - 1].contentRect.width);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(w));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, width];
}

// Re-measure text once web fonts land (label widths/truncation depend on the real font).
let fontsVersion = 0;
const fontSubs = new Set<() => void>();
if (typeof document !== 'undefined' && document.fonts) {
  const bump = () => {
    clearTextCache();
    fontsVersion++;
    fontSubs.forEach((f) => f());
  };
  document.fonts.addEventListener?.('loadingdone', bump);
  document.fonts.ready.then(bump, () => {});
}
export function useFontsVersion(): number {
  return useSyncExternalStore(
    (f) => {
      fontSubs.add(f);
      return () => {
        fontSubs.delete(f);
      };
    },
    () => fontsVersion,
    () => 0,
  );
}

export type StepFn = (key: string, i: number, n: number) => number | null;

/** Left/Right (and Up/Down) move by one; Home/End jump; PageUp/PageDown move by 7. */
export const linearStep: StepFn = (key, i, n) => {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return Math.max(0, i - 1);
    case 'ArrowRight':
    case 'ArrowDown':
      return Math.min(n - 1, i + 1);
    case 'PageUp':
      return Math.max(0, i - 7);
    case 'PageDown':
      return Math.min(n - 1, i + 7);
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return null;
  }
};

export interface IndexInteractionOptions {
  n: number;
  /** Index under a point in SVG-local coordinates, or null. */
  indexAt: (px: number, py: number) => number | null;
  tip: (i: number) => TipData;
  /** SVG-local point the keyboard tooltip anchors to. */
  anchor: (i: number) => { x: number; y: number };
  onActivate?: ((i: number) => void) | null;
  /** Index to start from when focus arrives by keyboard. */
  initial: () => number;
  step?: StepFn;
}

/**
 * Hover + roving keyboard focus for a chart with n addressable marks. The chart's <svg> is a single
 * tab stop; arrows move the active mark, Enter/Space activates it, Esc dismisses the tooltip.
 * Keyboard focus shows the same tooltip as hover and announces it through `live`.
 */
export function useIndexInteraction(o: IndexInteractionOptions) {
  const owner = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const opts = useRef(o);
  useLayoutEffect(() => {
    opts.current = o;
  });
  const [hover, setHover] = useState<number | null>(null);
  const [kbd, setKbdState] = useState<number | null>(null);
  const kbdRef = useRef<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  const setKbd = useCallback((v: number | null) => {
    kbdRef.current = v;
    setKbdState(v);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const showAt = useCallback(
    (i: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const a = opts.current.anchor(i);
      showTip(owner, opts.current.tip(i), r.left + a.x, r.top + a.y, svg);
    },
    [owner],
  );

  const handlers = useMemo(
    () => ({
      onPointerMove(e: PointerEvent<SVGSVGElement>) {
        if (!svgRef.current || opts.current.n === 0) return;
        const [px, py] = local(e);
        const i = opts.current.indexAt(px, py);
        hoverRef.current = i;
        setHover(i);
        if (i == null) hideTip(owner);
        else showTip(owner, opts.current.tip(i), e.clientX, e.clientY, svgRef.current);
      },
      onPointerLeave() {
        hoverRef.current = null;
        setHover(null);
        hideTip(owner);
      },
      onClick(e: MouseEvent<SVGSVGElement>) {
        const act = opts.current.onActivate;
        if (!act || !svgRef.current) return;
        const [px, py] = local(e);
        const i = opts.current.indexAt(px, py);
        if (i != null) act(i);
      },
      onFocus(e: FocusEvent<SVGSVGElement>) {
        if (opts.current.n === 0 || !e.currentTarget.matches(':focus-visible')) return;
        const i = opts.current.initial();
        setKbd(i);
        showAt(i);
      },
      onBlur() {
        setKbd(null);
        hideTip(owner);
      },
      onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
        const { n, onActivate, step = linearStep } = opts.current;
        if (n === 0) return;
        const cur = kbdRef.current != null && kbdRef.current < n ? kbdRef.current : null;
        const from = cur ?? hoverRef.current ?? opts.current.initial();
        if (e.key === 'Escape') {
          // Dismissing a keyboard tooltip consumes the key (so it doesn't also close the drawer or
          // a dialog underneath); with no tooltip up, Esc goes on to the app's handler.
          if (cur != null) e.stopPropagation();
          hideTip(owner);
          setKbd(null);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          if (!onActivate) return;
          e.preventDefault();
          onActivate(from);
          return;
        }
        const next = step(e.key, from, n);
        if (next == null) return;
        e.preventDefault();
        setKbd(next);
        showAt(next);
      },
    }),
    [owner, showAt, setKbd],
  );

  const kbdIndex = kbd != null && kbd < o.n ? kbd : null;
  const hoverIndex = hover != null && hover < o.n ? hover : null;
  const live = kbdIndex != null ? tipText(o.tip(kbdIndex)) : '';
  return { owner, svgRef, hover: hoverIndex, kbd: kbdIndex, active: hoverIndex ?? kbdIndex, handlers, live };
}
