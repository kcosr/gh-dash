import { useState } from 'react';
import { Modal, Input, Button } from '../workbench';
import type { PromptRequest } from './ui';

/** Small name prompt (new set / save view). */
export function NamePrompt({ req, onClose }: { req: PromptRequest; onClose: () => void }) {
  const [value, setValue] = useState(req.initial ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
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

  return (
    <Modal open onClose={onClose} title={req.title} size="sm" dismissible={!busy}
      onSubmit={() => void submit()}
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!value.trim()} pending={busy}>{req.submitLabel ?? 'Save'}</Button>
      </>}>
      <label className="prompt-l">
        <span>{req.label ?? 'Name'}</span>
        <Input autoFocus value={value} placeholder={req.placeholder} onChange={(e) => setValue(e.target.value)} maxLength={120} readOnly={busy} />
      </label>
      {req.hint && <div className="prompt-hint">{req.hint}</div>}
      {err && <div className="wb-form-error" role="alert">{err}</div>}
    </Modal>
  );
}
