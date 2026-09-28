import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Settings } from '../../../shared/api';
import { useClearDiffCache, useDiffCacheStats, useMe, usePatchSettings, useSettings, useSyncStatus } from '../api/hooks';
import { useSyncNow } from '../components/TopBar';
import { Icon } from '../components/Icon';
import { ErrorNote } from '../components/EmptyState';
import { useToast } from '../components/Toasts';
import { dur, fmtBytes, fmtDateTime, fmtNum, fmtTime, plural, relFuture, relLong } from '../lib/time';
import { cx } from '../lib/util';

const TOKEN_TEXT = {
  env: 'GITHUB_TOKEN (environment or config file)',
  file: 'Token file',
  'gh-cli': 'GitHub CLI (gh auth token)',
  app: 'Token entered in the app',
  none: 'No token found',
} as const;

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

function EmailChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...new Set([...value, ...parts])]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="chips-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((em) => (
        <span key={em} className="chip">
          {em}
          <button type="button" aria-label={`Remove ${em}`} onClick={() => onChange(value.filter((x) => x !== em))}><Icon name="x" /></button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={value.length ? '' : 'you@example.com'}
        aria-label="Add commit email"
        type="email"
      />
    </div>
  );
}

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

export function SettingsView() {
  const settings = useSettings();
  const me = useMe();
  const status = useSyncStatus();
  const save = usePatchSettings();
  const sync = useSyncNow();
  const toast = useToast();
  const [form, setForm] = useState<SettingsForm | null>(null);

  useEffect(() => { if (settings.data && !form) setForm(editable(settings.data)); }, [settings.data, form]);

  const st = status.data;
  // null = unknown (server unreachable): don't claim "No token found" / "Never synced".
  const tokenSource = me.data?.tokenSource ?? st?.tokenSource ?? null;
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
          <a className="btn" href="/api/docs" target="_blank" rel="noopener noreferrer"><Icon name="doc" />API docs</a>
          <a className="btn" href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer"><Icon name="braces" />OpenAPI</a>
        </div>
      </div>
      <div className="scroll">
        <div className="settings">
          {unreachable && (
            <section className="card set-sec">
              <ErrorNote error={status.error} onRetry={() => { void status.refetch(); void settings.refetch(); void me.refetch(); }} />
            </section>
          )}
          <section className="card set-sec">
            <h2>GitHub connection</h2>
            <dl className="kv">
              <dt>Token source</dt>
              <dd>{tokenSource ? <span className={cx('dot-lbl', tokenSource === 'none' && 'warn')}>{TOKEN_TEXT[tokenSource]}</span> : <span className="muted">unknown</span>}</dd>
              <dt>Signed in as</dt>
              <dd>{me.data?.login ? <><b>{me.data.login}</b>{me.data.name ? <span className="muted"> · {me.data.name}</span> : null}</> : st?.viewer ?? <span className="muted">—</span>}</dd>
              <dt>Rate limit</dt>
              <dd>{st?.rateLimit ? <>{fmtNum(st.rateLimit.remaining)} / {fmtNum(st.rateLimit.limit)} remaining · resets {fmtTime(st.rateLimit.resetAt)}</> : <span className="muted">unknown</span>}</dd>
            </dl>
            <details className="help" open={tokenSource === 'none'}>
              <summary>How to set a token</summary>
              <p>
                gh-dash uses <code>GITHUB_TOKEN</code> from the server's environment or XDG config file, else the output of <code>gh auth token</code>.
                For a dedicated token, create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained personal access token</a> with
                access to <b>All repositories</b> and these repository permissions set to <b>Read-only</b>: <b>Metadata</b>, <b>Contents</b>, <b>Pull requests</b>, <b>Issues</b>.
              </p>
              <pre className="code">GITHUB_TOKEN=github_pat_… npm start</pre>
              <p className="muted">The token is only read from the environment; it is never stored in the database or shown here.</p>
            </details>
          </section>

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
              <button type="button" className="btn" disabled={!st || st.running || tokenSource === 'none'} onClick={() => sync.run()}><Icon name="sync" />Sync now</button>
              <button
                type="button"
                className="btn"
                disabled={!st || st.running || tokenSource === 'none'}
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
                    <EmailChips value={form.myEmails} onChange={(myEmails) => setForm({ ...form, myEmails })} />
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

          <section className="card set-sec">
            <h2>API</h2>
            <p>Everything in the UI is available as JSON with the same filters. Lists also export as Markdown (<code>format=md</code>) and CSV (<code>format=csv</code>).</p>
            <ul className="links">
              <li><a href="/api/docs" target="_blank" rel="noopener noreferrer">/api/docs</a> · endpoint reference with curl examples</li>
              <li><a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">/api/v1/openapi.json</a> · OpenAPI 3.1 document</li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
