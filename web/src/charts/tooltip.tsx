/**
 * Shared chart tooltip layer.
 *
 * One tooltip is visible at a time across every chart: a tiny external store records which chart
 * owns it; the owner renders it through a portal into <body>. Content is React text only (labels are
 * untrusted). Values lead, labels follow; rows are keyed with a short line in the series color.
 * The tooltip copies the owner's nearest [data-theme] so it matches light/dark sections.
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

export interface TipRow {
  /** Series color for the line key; omitted = no key (value column stays aligned). */
  color?: string;
  value: string;
  label: string;
  /** Rendered as a summary row under a hairline. */
  total?: boolean;
}

export interface TipData {
  title?: string;
  rows: TipRow[];
}

interface TipState {
  owner: string;
  data: TipData;
  x: number;
  y: number;
  theme: string | null;
}

let current: TipState | null = null;
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((f) => f());
const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => {
    subscribers.delete(f);
  };
};

/** Show (or move) the tooltip for `owner` at viewport coordinates. */
export function showTip(owner: string, data: TipData, x: number, y: number, el: Element | null) {
  const theme = el?.closest('[data-theme]')?.getAttribute('data-theme') ?? null;
  current = { owner, data, x, y, theme };
  emit();
}

export function hideTip(owner: string) {
  if (current && current.owner === owner) {
    current = null;
    emit();
  }
}

/** Plain-text version of a tooltip, for aria-live announcements. */
export function tipText(d: TipData): string {
  const rows = d.rows.filter((r) => r.value !== '' || r.label !== '').map((r) => `${r.value} ${r.label}`.trim());
  return [d.title, rows.join(', ')].filter(Boolean).join(': ');
}

export function TipPortal({ owner }: { owner: string }) {
  const s = useSyncExternalStore(
    subscribe,
    () => (current && current.owner === owner ? current : null),
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !s) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = s.x + 14;
    if (left + w > vw - 8) left = s.x - w - 14;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = s.y - h - 12;
    if (top < 8) top = s.y + 18;
    top = Math.max(8, Math.min(top, vh - h - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }, [s]);

  const visible = s !== null;
  useEffect(() => {
    if (!visible) return;
    const hide = () => hideTip(owner);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('touchmove', hide, { passive: true });
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('wheel', hide);
      window.removeEventListener('touchmove', hide);
      window.removeEventListener('resize', hide);
    };
  }, [visible, owner]);

  // Unmounting owner: make sure its tooltip doesn't linger.
  useEffect(() => () => hideTip(owner), [owner]);

  if (!s || typeof document === 'undefined') return null;
  const hasKeys = s.data.rows.some((r) => r.color);
  return createPortal(
    <div
      ref={ref}
      className={'tip gd-tip' + (hasKeys ? '' : ' gd-tip-nokeys')}
      role="tooltip"
      data-theme={s.theme ?? undefined}
      style={{ left: -9999, top: -9999 }}
    >
      {s.data.title ? <div className="tt">{s.data.title}</div> : null}
      <div className="gd-tip-rows">
        {s.data.rows.map((r, i) => (
          <div className={'tr' + (r.total ? ' gd-tip-total' : '')} key={i}>
            <i style={{ background: r.color ?? 'transparent' }} />
            <b>{r.value}</b>
            <span>{r.label}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
