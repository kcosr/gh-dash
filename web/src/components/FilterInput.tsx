import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { Icon } from './Icon';

/**
 * Text filter bound to a URL param. Local state keeps typing snappy; the URL is
 * updated (history replace) after a short pause.
 */
export function FilterInput({ id = 'q', value, onChange, placeholder, kbd = '/', ms = 250 }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  kbd?: string | null;
  ms?: number;
}) {
  const [v, setV] = useState(value);
  const location = useLocation();
  const navigationType = useNavigationType();
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // external changes (back button, saved view) win
  useEffect(() => {
    // History can return to the same prop value before our previous URL write rendered.
    // Its entry key still changes, and a pending edit must not overwrite that destination.
    if (navigationType === 'POP' || value !== last.current) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      last.current = value;
      setV(value);
    }
  }, [value, location.key, navigationType]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const push = (next: string, now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const fire = () => { timer.current = null; last.current = next; onChange(next); };
    if (now) fire(); else timer.current = setTimeout(fire, ms);
  };

  return (
    <label className="field">
      <Icon name="search" />
      <input
        id={id}
        value={v}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={placeholder}
        onChange={(e) => { setV(e.target.value); push(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') push(v, true);
          if (e.key === 'Escape' && v) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setV(''); push('', true); }
        }}
      />
      {v ? (
        <button type="button" className="field-clear" aria-label="Clear filter" onClick={() => { setV(''); push('', true); }}><Icon name="x" /></button>
      ) : kbd ? <kbd>{kbd}</kbd> : null}
    </label>
  );
}
