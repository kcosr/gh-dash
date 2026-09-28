import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../lib/layers';
import { RANGES, rangeHint } from '../lib/range';
import type { RangeId } from '../lib/range';
import { isValidDateOnly } from '../lib/time';
import { useUrlState } from '../lib/urlState';
import { Icon } from './Icon';

/** Toolbar button showing the current range; opens the preset popover. */
export function DateRangeButton() {
  const { s, set, range } = useUrlState();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={range.text}
      >
        <Icon name="cal" />
        {range.label}
        <Icon name="chevron" />
      </button>
      {open && (
        <DateRangePopover
          anchor={btn.current}
          current={s.range}
          from={range.from}
          to={range.to}
          onClose={() => setOpen(false)}
          onPick={(id) => { set({ range: id }); setOpen(false); }}
          onCustom={(from, to) => { set({ range: 'custom', from, to }); setOpen(false); }}
        />
      )}
    </>
  );
}

function DateRangePopover({ anchor, current, from, to, onClose, onPick, onCustom }: {
  anchor: HTMLElement | null;
  current: RangeId;
  from: string;
  to: string;
  onClose: () => void;
  onPick: (id: RangeId) => void;
  onCustom: (from: string, to: string) => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [custom, setCustom] = useState(current === 'custom');
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const pop = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const w = pop.current?.offsetWidth ?? 280;
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, custom]);

  useEffect(() => {
    const el = pop.current?.querySelector<HTMLElement>(custom ? 'input' : '.opt.on, .opt');
    el?.focus();
  }, [custom]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const opts = [...(pop.current?.querySelectorAll<HTMLElement>('.opt') ?? [])];
    const i = opts.indexOf(document.activeElement as HTMLElement);
    const next = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length];
    next?.focus();
    e.preventDefault();
  };

  const valid = isValidDateOnly(a) && isValidDateOnly(b);

  return createPortal(
    <>
      <div className="pop-scrim" onClick={onClose} />
      <div
        ref={pop}
        className="pop"
        role="dialog"
        aria-label="Date range"
        style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
        onKeyDown={onKeyDown}
      >
        {RANGES.map((x) => (
          <button key={x.id} type="button" className={`opt${x.id === current ? ' on' : ''}`} onClick={() => onPick(x.id)}>
            <span className="ck">{x.id === current && <Icon name="check" />}</span>
            {x.label}
            <span className="spacer" />
            <span className="hint">{rangeHint(x.id)}</span>
          </button>
        ))}
        <div className="pop-foot">
          <button type="button" className={`opt${current === 'custom' ? ' on' : ''}`} onClick={() => setCustom((c) => !c)} aria-expanded={custom}>
            <span className="ck">{current === 'custom' ? <Icon name="check" /> : <Icon name="cal" />}</span>
            Custom range…
          </button>
          {custom && (
            <form
              className="custom-range"
              onSubmit={(e) => { e.preventDefault(); if (valid) onCustom(a <= b ? a : b, a <= b ? b : a); }}
            >
              <label>From<input type="date" value={a} max={b || undefined} onChange={(e) => setA(e.target.value)} required /></label>
              <label>To<input type="date" value={b} min={a || undefined} onChange={(e) => setB(e.target.value)} required /></label>
              <button type="submit" className="btn primary" disabled={!valid}>Apply</button>
            </form>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
