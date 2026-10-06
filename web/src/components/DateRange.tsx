import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Popover, Input } from '../workbench';
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
  // Closing (Esc, pick, click outside) returns focus to the button so keyboard users keep their place.
  const close = () => { setOpen(false); btn.current?.focus({ preventScroll: true }); };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="wb-btn"
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
          anchor={btn}
          current={s.range}
          from={range.from}
          to={range.to}
          onClose={close}
          onPick={(id) => { set({ range: id }); close(); }}
          onCustom={(from, to) => { set({ range: 'custom', from, to }); close(); }}
        />
      )}
    </>
  );
}

function DateRangePopover({ anchor, current, from, to, onClose, onPick, onCustom }: {
  anchor: RefObject<HTMLButtonElement | null>;
  current: RangeId;
  from: string;
  to: string;
  onClose: () => void;
  onPick: (id: RangeId) => void;
  onCustom: (from: string, to: string) => void;
}) {
  const [custom, setCustom] = useState(current === 'custom');
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The current preset (not simply the first option in the list).
    const el = custom ? pop.current?.querySelector<HTMLElement>('input') : pop.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? pop.current?.querySelector<HTMLElement>('.wb-menu-item');
    el?.focus();
  }, [custom]);

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const opts = [...(pop.current?.querySelectorAll<HTMLElement>('.wb-menu-item') ?? [])];
    const i = opts.indexOf(document.activeElement as HTMLElement);
    const next = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length];
    next?.focus();
    e.preventDefault();
  };

  const valid = isValidDateOnly(a) && isValidDateOnly(b);

  return (
    <Popover open onClose={onClose} anchorRef={anchor} label="Date range" className="date-range-popover"
      initialFocus={(root) => custom ? root.querySelector<HTMLElement>('input') : root.querySelector<HTMLElement>('[aria-pressed="true"]') ?? root.querySelector<HTMLElement>('.wb-menu-item')}
      onKeyDown={onKeyDown}>
      <div ref={pop}>
        {RANGES.map((x) => (
          <button key={x.id} type="button" className="wb-menu-item" aria-pressed={x.id === current} onClick={() => onPick(x.id)}>
            <span className="wb-menu-check">{x.id === current && <Icon name="check" />}</span>
            {x.label}
            <span className="spacer" />
            <span className="wb-menu-hint">{rangeHint(x.id)}</span>
          </button>
        ))}
        <div className="date-range-custom">
          <button type="button" className="wb-menu-item" aria-pressed={current === 'custom'} onClick={() => setCustom((c) => !c)} aria-expanded={custom}>
            <span className="wb-menu-check">{current === 'custom' ? <Icon name="check" /> : <Icon name="cal" />}</span>
            Custom range…
          </button>
          {custom && (
            <form
              className="custom-range"
              onSubmit={(e) => { e.preventDefault(); if (valid) onCustom(a <= b ? a : b, a <= b ? b : a); }}
            >
              <label>From<Input type="date" value={a} max={b || undefined} onChange={(e) => setA(e.target.value)} required /></label>
              <label>To<Input type="date" value={b} min={a || undefined} onChange={(e) => setB(e.target.value)} required /></label>
              <button type="submit" className="wb-btn wb-btn--primary" disabled={!valid}>Apply</button>
            </form>
          )}
        </div>
      </div>
    </Popover>
  );
}
