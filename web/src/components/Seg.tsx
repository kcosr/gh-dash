import type { ReactNode } from 'react';
import { cx } from '../lib/util';

export interface SegOption<T extends string> { value: T; label: ReactNode; title?: string }

/** Segmented control (`.seg`). */
export function Seg<T extends string>({ value, options, onChange, className, ariaLabel }: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cx('seg', className)} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'on' : undefined}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const WHO_OPTIONS: SegOption<'me' | 'others' | 'everyone'>[] = [
  { value: 'me', label: 'Me' },
  { value: 'others', label: 'Others' },
  { value: 'everyone', label: 'Everyone' },
];
