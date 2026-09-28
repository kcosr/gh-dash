import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useApiBase } from '../api/hooks';
import { API_OFF_HINT, apiLink } from '../lib/account';
import { exportTarget, exportUrl } from '../lib/apiQuery';
import { useFocusTrap, useLayer } from '../lib/layers';
import { repoFromPath, useUrlState } from '../lib/urlState';
import { copyText } from '../lib/util';
import { Icon } from './Icon';
import { Seg } from './Seg';
import { useToast } from './Toasts';
import type { ExportTab } from './ui';

/** Shorten a JSON sample: first 2 items of arrays, long strings clipped. */
function trimSample(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) {
    const head = v.slice(0, depth === 0 ? 1 : 2).map((x) => trimSample(x, depth + 1));
    return v.length > head.length ? [...head, `… ${v.length - head.length} more`] : head;
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimSample(x, depth + 1)]));
  }
  if (typeof v === 'string' && v.length > 160) return `${v.slice(0, 157)}…`;
  return v;
}

export function ExportModal({ initialTab, onClose }: { initialTab: ExportTab; onClose: () => void }) {
  const { s, view, location } = useUrlState();
  const name = repoFromPath(location.pathname);
  const toast = useToast();
  const target = exportTarget(view, s, name);
  const [tab, setTab] = useState<ExportTab>(target.md ? initialTab : 'api');
  const url = exportUrl(target);
  const mdUrl = exportUrl(target, { format: 'md' });
  const sampleUrl = target.endpoint === 'stats' || target.endpoint === 'repos' || target.endpoint === 'settings' ? url : exportUrl(target, { limit: 1 });
  // Where other clients reach this API; null in the desktop app with the Local API off.
  const base = useApiBase();
  const docsUrl = apiLink(base, '/api/docs');
  const box = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);
  useFocusTrap(box);

  const md = useQuery({ queryKey: ['export-md', mdUrl], queryFn: () => api.text(mdUrl), enabled: tab === 'md' && target.md, staleTime: 30_000 });
  const sample = useQuery({ queryKey: ['export-sample', sampleUrl], queryFn: () => api.json(sampleUrl), enabled: tab === 'api', staleTime: 30_000 });

  const curl = base && `curl -s '${apiLink(base, target.md ? mdUrl : url)}'`;
  const copy = async () => {
    const text = tab === 'md' ? md.data ?? '' : apiLink(base, url);
    if (text === null) return;
    toast((await copyText(text)) ? (tab === 'md' ? 'Markdown copied' : 'API URL copied') : 'Copy failed');
  };

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Export this view" ref={box}>
        <div className="modal-h">
          <h3>Export this view</h3>
          {target.md && (
            <Seg
              className="sm"
              value={tab}
              onChange={setTab}
              ariaLabel="Export format"
              options={[
                { value: 'md', label: <><Icon name="md" />Markdown</> },
                { value: 'api', label: <><Icon name="braces" />API</> },
              ]}
            />
          )}
          <span className="spacer" />
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" /></button>
        </div>
        <div className="modal-b">
          {tab === 'md' ? (
            md.isError ? <pre className="code err">{(md.error as Error).message}</pre>
              : md.data !== undefined ? <pre className="code">{md.data || '(empty)'}</pre>
                : <pre className="code muted">Loading…</pre>
          ) : (
            <>
              <div className="api-l">Same view, as an API call</div>
              <pre className="code"><span className="k">GET</span> {url}</pre>
              <div className="api-l">curl</div>
              {curl ? <pre className="code">{curl}</pre> : (
                <p className="api-off">Turn on the Local API in <Link to="/settings#instance" onClick={onClose}>Settings</Link> to call it from curl or scripts.</p>
              )}
              <div className="api-l">JSON response{target.endpoint === 'stats' || target.endpoint === 'repos' ? ' (trimmed)' : ' (first item)'}</div>
              <pre className="code">
                {sample.isError ? (sample.error as Error).message : sample.data !== undefined ? JSON.stringify(trimSample(sample.data), null, 2) : 'Loading…'}
              </pre>
            </>
          )}
        </div>
        <div className="modal-f">
          <span className="muted">
            {tab === 'md'
              ? <>Same output as <code>?format=md</code> on the API. Paste into notes or a status update.</>
              : <>Every filter in the UI maps to a query parameter. Formats: JSON{target.md && <>, <code>md</code>, <code>csv</code></>}.{docsUrl && <> <a href={docsUrl} target="_blank" rel="noopener noreferrer">API docs</a></>}</>}
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={copy} disabled={tab === 'md' ? md.data === undefined : !base}
            title={tab === 'api' && !base ? API_OFF_HINT : undefined}>
            <Icon name="copy" />Copy
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
