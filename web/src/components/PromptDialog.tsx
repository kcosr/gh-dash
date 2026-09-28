import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useLayer } from '../lib/layers';
import { Icon } from './Icon';
import type { PromptRequest } from './ui';

/** Small name prompt (new set / save view). */
export function PromptDialog({ req, onClose }: { req: PromptRequest; onClose: () => void }) {
  const [value, setValue] = useState(req.initial ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLFormElement>(null);
  useLayer(true, onClose);
  useFocusTrap(box);

  const submit = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setErr(null);
    try {
      await req.onSubmit(v);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <form
        ref={box}
        className="modal prompt"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className="modal-h">
          <h3>{req.title}</h3>
          <span className="spacer" />
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-b">
          <label className="prompt-l">
            <span>{req.label ?? 'Name'}</span>
            <input
              autoFocus
              className="input"
              value={value}
              placeholder={req.placeholder}
              onChange={(e) => setValue(e.target.value)}
              maxLength={120}
            />
          </label>
          {req.hint && <div className="prompt-hint">{req.hint}</div>}
          {err && <div className="form-err">{err}</div>}
        </div>
        <div className="modal-f">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!value.trim() || busy}>{req.submitLabel ?? 'Save'}</button>
        </div>
      </form>
    </>,
    document.body,
  );
}
