import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useLayer } from '../lib/layers';
import { cx } from '../lib/util';
import { Icon } from './Icon';
import type { ConfirmRequest } from './ui';

/** A small confirmation (ui.openConfirm): the prompt's modal shell without an input. Cancel has focus. */
export function ConfirmDialog({ req, onClose }: { req: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);
  useFocusTrap(box);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await req.onConfirm();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div ref={box} className="modal prompt confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <div className="modal-h">
          <h3 id="confirm-title">{req.title}</h3>
          <span className="spacer" />
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-b">
          <p id="confirm-body" className="confirm-body">{req.body}</p>
          {err && <div className="form-err" role="alert">{err}</div>}
        </div>
        <div className="modal-f">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} autoFocus>Cancel</button>
          <button type="button" className={cx('btn', req.danger ? 'danger' : 'primary')} disabled={busy} onClick={() => void confirm()}>
            {busy && <span className="spin"><Icon name="sync" /></span>}{req.confirmLabel}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
