import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Chip, Input } from '../workbench';

/**
 * Application email/host token lists; parsing is provided by the owning settings form.
 * A list of values edited as chips: type and press Enter, comma or space (or leave the field) to add,
 * Backspace on an empty field removes the last one. `parse` splits and normalizes what was typed.
 */
export function TokenListInput({ value, onChange, parse, placeholder, label, type = 'text', id }: {
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
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="token-list-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((v) => (
        <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>{v}</Chip>
      ))}
      <Input
        className="token-list-draft"
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
