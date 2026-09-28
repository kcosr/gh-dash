import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Icon } from './Icon';

/**
 * A list of values edited as chips: type and press Enter, comma or space (or leave the field) to add,
 * Backspace on an empty field removes the last one. `parse` splits and normalizes what was typed.
 */
export function ChipsInput({ value, onChange, parse, placeholder, label, type = 'text', id }: {
  value: string[]; onChange: (v: string[]) => void; parse: (text: string) => string[];
  placeholder?: string; label: string; type?: 'text' | 'email'; id?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = parse(draft);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    if (parts.length || !draft.trim()) setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="chips-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((v) => (
        <span key={v} className="chip">
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}><Icon name="x" /></button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={value.length ? '' : placeholder}
        aria-label={label}
        type={type}
        spellCheck={false}
      />
    </div>
  );
}
