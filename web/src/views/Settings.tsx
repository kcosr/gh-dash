import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Settings } from '../../../shared/api';
import { useApiBase, useClearDiffCache, useDiffCacheStats, usePatchSettings, useSettings, useSyncStatus } from '../api/hooks';
import { useSyncNow } from '../components/TopBar';
import { ChipsInput } from '../components/ChipsInput';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { ErrorNote } from '../components/EmptyState';
import { useToast } from '../components/Toasts';
import { apiLink } from '../lib/account';
import { dur, fmtBytes, fmtDateTime, fmtNum, fmtTime, plural, relFuture, relLong } from '../lib/time';
import { cx } from '../lib/util';
import { AccountSection } from './SettingsAccount';
import { InstanceSection } from './SettingsInstance';

/** A link to this API from outside the app; disabled with a hint while the Local API is off. */
function ApiButton({ href, icon, children }: { href: string | null; icon: IconName; children: string }) {
  if (href) return <a className="btn" href={href} target="_blank" rel="noopener noreferrer"><Icon name={icon} />{children}</a>;
  return <button type="button" className="btn" disabled title="Turn on the Local API below (Instance)"><Icon name={icon} />{children}</button>;
}

/** The editable part of Settings: what the form holds and what PATCH sends (never myEmailsFromEnv). */
type SettingsForm = Pick<Settings, 'syncIntervalMinutes' | 'backfillDays' | 'myEmails' | 'includeForks'>;
const editable = (x: Settings): SettingsForm => ({
  syncIntervalMinutes: x.syncIntervalMinutes,
  backfillDays: x.backfillDays,
  myEmails: x.myEmails,
  includeForks: x.includeForks,
});

/** Emails from the server's GH_DASH_MY_EMAILS: shown as read-only chips, not part of the form. */
function EnvEmails({ emails }: { emails: string[] }) {
  return (
    <div className="env-emails">
      {emails.map((em) => (
        <span key={em} className="chip ro" title="Set by the server's GH_DASH_MY_EMAILS environment variable; change it there">
          <Icon name="lock" />{em}
        </span>
      ))}
      <small>from <code>GH_DASH_MY_EMAILS</code></small>
    </div>
  );
}

const splitEmails = (text: string) => text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

/** Diffs fetched from GitHub and kept on the server: usage, the size cap, and clearing it. */
function DiffCacheSection() {
  const stats = useDiffCacheStats();
  const settings = useSettings();
  const save = usePatchSettings();
  const clear = useClearDiffCache();
  const toast = useToast();
  const [cap, setCap] = useState<number | null>(null);

  useEffect(() => { if (settings.data && cap === null) setCap(settings.data.diffCacheMb); }, [settings.data, cap]);

  const capOk = cap !== null && Number.isInteger(cap) && cap >= 10 && cap <= 10000;
  const dirty = cap !== null && !!settings.data && cap !== settings.data.diffCacheMb;
  const st = stats.data;

  const submit = () => {
    if (!capOk || !dirty) return;
    save.mutate({ diffCacheMb: cap }, {
      onSuccess: (s) => { setCap(s.diffCacheMb); toast('Diff cache size saved'); },
      onError: (e) => toast(`Couldn't save: ${(e as Error).message}`, { error: true }),
    });
  };
  const onClear = () => clear.mutate(undefined, {
    onSuccess: () => toast(st?.bytes ? `Diff cache cleared · ${fmtBytes(st.bytes)} freed` : 'Diff cache cleared'),
    onError: (e) => toast(`Couldn't clear: ${(e as Error).message}`, { error: true }),
  });

  return (
    <section className="card set-sec">
      <h2>Diff cache</h2>
      <p>Diffs and the file contents they show are fetched from GitHub when you open a diff, then kept on the server.</p>
      <form className="set-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="set-row">
          <span className="set-l">In use<small>Cached diffs and files.</small></span>
          <span className="set-c">
            {st ? <>{fmtBytes(st.bytes)} of {settings.data ? `${fmtNum(settings.data.diffCacheMb)} MB` : fmtBytes(st.maxBytes)} · {fmtNum(st.entries)} {plural(st.entries, 'entry', 'entries')}</>
              : stats.isError ? <span className="muted">Couldn't load: {(stats.error as Error).message}</span> : <span className="muted">Loading…</span>}
          </span>
        </div>
        {cap !== null && (
          <label className="set-row">
            <span className="set-l">Size limit<small>10–10000 MB. When the cache is full, the least recently viewed go first.</small></span>
            <span className="set-c">
              <input className={cx('input num-in', !capOk && 'bad')} type="number" min={10} max={10000} step={1} value={cap}
                onChange={(e) => setCap(Math.round(Number(e.target.value)))} /> MB
            </span>
          </label>
        )}
        <div className="set-actions">
          {cap !== null && <button type="submit" className="btn primary" disabled={!dirty || !capOk || save.isPending}>Save limit</button>}
          <button type="button" className="btn" disabled={!st?.entries || clear.isPending} onClick={onClear}><Icon name="trash" />Clear cache</button>
        </div>
      </form>
    </section>
  );
}

/**
 * "/settings#instance" (from the export dialog and the API section): scroll to that card and keep it there
 * while the cards above it load and grow, until the reader scrolls or after a moment.
 */
function usePinnedHash() {
  const { hash } = useLocation();
  useEffect(() => {
    const el = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    const box = el?.closest('.scroll');
    if (!el || !box?.firstElementChild) return;
    const pin = () => el.scrollIntoView({ block: 'start' });
    const ro = new ResizeObserver(pin);
    ro.observe(box.firstElementChild);
    pin();
    const stop = () => ro.disconnect();
    const t = window.setTimeout(stop, 2000);
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const e of events) window.addEventListener(e, stop, { once: true, passive: true });
    return () => { stop(); clearTimeout(t); for (const e of events) window.removeEventListener(e, stop); };
  }, [hash]);
}

export function SettingsView() {
  const settings = useSettings();
  const status = useSyncStatus();
  const save = usePatchSettings();
  const sync = useSyncNow();
  const toast = useToast();
  const [form, setForm] = useState<SettingsForm | null>(null);

  useEffect(() => { if (settings.data && !form) setForm(editable(settings.data)); }, [settings.data, form]);
  usePinnedHash();

  const st = status.data;
  const apiBase = useApiBase();
  const docsUrl = apiLink(apiBase, '/api/docs');
  const openapiUrl = apiLink(apiBase, '/api/v1/openapi.json');
  const unreachable = !st && status.isError;
  const envEmails = settings.data?.myEmailsFromEnv ?? [];
  const dirty = !!form && !!settings.data && JSON.stringify(form) !== JSON.stringify(editable(settings.data));
  const intervalOk = !!form && Number.isInteger(form.syncIntervalMinutes) && form.syncIntervalMinutes >= 5 && form.syncIntervalMinutes <= 1440;
  const backfillOk = !!form && Number.isInteger(form.backfillDays) && form.backfillDays >= 1;

  const submit = () => {
    if (!form || !intervalOk || !backfillOk) return;
    save.mutate(form, {
      onSuccess: (s) => { setForm(editable(s)); toast('Settings saved'); },
      onError: (e) => toast(`Couldn't save: ${(e as Error).message}`, { error: true }),
    });
  };

  return (
    <main className="main tint">
      <div className="toolbar">
        <div className="row">
          <h1 className="page-title">Settings</h1>
          <span className="spacer" />
          <ApiButton href={docsUrl} icon="doc">API docs</ApiButton>
          <ApiButton href={openapiUrl} icon="braces">OpenAPI</ApiButton>
        </div>
      </div>
      <div className="scroll">
        <div className="settings">
          {unreachable && (
            <section className="card set-sec">
              <ErrorNote error={status.error} onRetry={() => { void status.refetch(); void settings.refetch(); }} />
            </section>
          )}
          <AccountSection rateLimit={st?.rateLimit} />

          <section className="card set-sec">
            <h2>Sync</h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                {!st ? <span className="muted">unknown</span> : st.running
                  ? <>Syncing{st.progress ? ` ${st.progress.done}/${st.progress.total} repos` : ''}{st.progress?.current ? <> · <code>{st.progress.current}</code></> : null}</>
                  : st.lastSyncAt ? <>Last synced {relLong(st.lastSyncAt)} ({fmtDateTime(st.lastSyncAt)}){st.lastSyncDurationMs != null ? ` in ${dur(st.lastSyncDurationMs)}` : ''}</> : 'Never synced'}
              </dd>
              <dt>Next sync</dt>
              <dd>{!st ? <span className="muted">unknown</span> : st.nextSyncAt ? <>{relFuture(st.nextSyncAt)} ({fmtTime(st.nextSyncAt)})</> : <span className="muted">Scheduler off</span>}</dd>
              {st?.lastResult && <>
                <dt>Last result</dt>
                <dd>{st.lastResult.newItems.toLocaleString()} new items{st.lastResult.errors.length ? `, ${st.lastResult.errors.length} errors` : ''}</dd>
              </>}
            </dl>
            {!!st?.lastResult?.errors.length && <pre className="code err">{st.lastResult.errors.slice(0, 10).join('\n')}</pre>}
            <div className="set-actions">
              <button type="button" className="btn" disabled={!st || st.running} onClick={() => sync.run()}><Icon name="sync" />Sync now</button>
              <button
                type="button"
                className="btn"
                disabled={!st || st.running}
                onClick={() => { if (window.confirm('Re-fetch everything in the backfill window and re-check stars? This uses more API quota.')) sync.run({ full: true }); }}
              >
                <Icon name="sync" />Full resync
              </button>
            </div>
          </section>

          <section className="card set-sec">
            <h2>Preferences</h2>
            {!form ? (settings.isError ? <div className="muted">Couldn't load settings: {(settings.error as Error).message}</div> : <div className="muted">Loading…</div>) : (
              <form className="set-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <label className="set-row">
                  <span className="set-l">Sync interval<small>Minutes between background syncs (5–1440).</small></span>
                  <span className="set-c">
                    <input className={cx('input num-in', !intervalOk && 'bad')} type="number" min={5} max={1440} step={1} value={form.syncIntervalMinutes}
                      onChange={(e) => setForm({ ...form, syncIntervalMinutes: Math.round(Number(e.target.value)) })} /> min
                  </span>
                </label>
                <label className="set-row">
                  <span className="set-l">Backfill<small>How far back the first sync of a repo reaches.</small></span>
                  <span className="set-c">
                    <input className={cx('input num-in', !backfillOk && 'bad')} type="number" min={1} step={1} value={form.backfillDays}
                      onChange={(e) => setForm({ ...form, backfillDays: Math.round(Number(e.target.value)) })} /> days
                  </span>
                </label>
                <div className="set-row">
                  <span className="set-l">My commit emails<small>Commits with these author emails count as “me”, even without a linked GitHub account.</small></span>
                  <span className="set-c grow stack">
                    <ChipsInput value={form.myEmails} onChange={(myEmails) => setForm({ ...form, myEmails })} parse={splitEmails}
                      placeholder="you@example.com" label="Add commit email" type="email" />
                    {envEmails.length > 0 && <EnvEmails emails={envEmails} />}
                  </span>
                </div>
                <label className="set-row">
                  <span className="set-l">Include forks<small>Forks are always synced; this adds them to the default scope.</small></span>
                  <span className="set-c"><input type="checkbox" className="switch" checked={form.includeForks} onChange={(e) => setForm({ ...form, includeForks: e.target.checked })} /></span>
                </label>
                <div className="set-actions">
                  <button type="submit" className="btn primary" disabled={!dirty || !intervalOk || !backfillOk || save.isPending}>Save changes</button>
                  <button type="button" className="btn" disabled={!dirty} onClick={() => setForm(settings.data ? editable(settings.data) : null)}>Reset</button>
                </div>
              </form>
            )}
          </section>

          <DiffCacheSection />

          <InstanceSection />

          <section className="card set-sec">
            <h2>API</h2>
            <p>Everything in the UI is available as JSON with the same filters. Lists also export as Markdown (<code>format=md</code>) and CSV (<code>format=csv</code>).</p>
            {docsUrl && openapiUrl ? (
              <ul className="links">
                <li><a href={docsUrl} target="_blank" rel="noopener noreferrer">{docsUrl}</a> · endpoint reference with curl examples</li>
                <li><a href={openapiUrl} target="_blank" rel="noopener noreferrer">{openapiUrl}</a> · OpenAPI 3.1 document</li>
              </ul>
            ) : (
              <p className="muted">The Local API is off, so browsers, curl and scripts can't reach it. Turn it on under <Link to={{ hash: 'instance' }}>Instance</Link>.</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
