/**
 * Settings → Sources (design §7.6): github.com's account (SettingsAccount.tsx), each GitLab source's account, token,
 * scopes, expiry and sync, and, in the desktop app, adding a GitLab source and changing its token. A headless server's
 * sources come from its config.json or environment, so there the list is read-only apart from checking, syncing and
 * removing what is no longer configured.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { ConfigSource, ProviderKind, Source, SourceAccount, SourceCheck, SyncStatus } from '../../../shared/api';
import { gitlabTokenCreateUrl, gitlabWriteWarning } from '../../../shared/credentials';
import type { DesktopState, SourceMethod } from '../../../shared/desktop';
import { ApiError, isUnreachable } from '../api/client';
import { useDesktop, useSourceActions } from '../api/desktop';
import { useCheckSource, useDeleteSource, useInstance, useSources, useStartSync } from '../api/hooks';
import { Avatar } from '../components/Avatar';
import { Icon, ProviderIcon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { useUI } from '../components/ui';
import { bridgeError, tokenExpiry, tokenKindLabel } from '../lib/account';
import {
  type CredentialForm, credentialOf, draftKey, draftOf, fileFor, gitlabUrlInput, methodsFor, projectsLine, type RemoveMode, removeMode,
  sourceMethodLabel, syncLine,
} from '../lib/sources';
import { fmtNum, plural, relLong } from '../lib/time';
import { cx, useNow } from '../lib/util';
import { GitHubAccount } from './SettingsAccount';

/** A source's name line: its mark, "GitHub" / "GitLab", the host, and the instance's version when known. */
function SourceHead({ kind, name, host, version }: { kind: ProviderKind; name: string; host?: string; version?: string | null }) {
  return (
    <div className="src-head">
      <ProviderIcon kind={kind} />
      <b>{name}</b>
      {host && <span className="src-host">{host}</span>}
      {version && <span className="src-host">· {version}</span>}
    </div>
  );
}

/** GitLab's new-token page for gh-dash: the name and only the read_api scope are filled in (design, smoke v2). */
function CreateTokenLink({ baseUrl, children = 'Create a read-only token' }: { baseUrl: string; children?: string }) {
  return (
    <a className="src-link" href={gitlabTokenCreateUrl(baseUrl)} target="_blank" rel="noopener noreferrer">
      {children}<Icon name="ext" />
    </a>
  );
}

/** Within EXPIRY_WARN_DAYS of the token's expiry, or past it: say so, with a way to a new read-only token. */
function ExpiryWarning({ a, baseUrl, now }: { a: Pick<SourceAccount, 'expiresAt' | 'kind'>; baseUrl: string; now: number }) {
  const exp = tokenExpiry(a.expiresAt, a.kind, now);
  if (!exp?.warn) return null;
  return (
    <span className="src-warn">
      <span>The token {exp.text}. <CreateTokenLink baseUrl={baseUrl}>Create a new read-only token</CreateTokenLink></span>
    </span>
  );
}

/** Scopes that can change things on GitLab: gh-dash only reads (shared/credentials.ts has the words). */
function WriteWarning({ scopes, baseUrl }: { scopes: string[] | null; baseUrl: string }) {
  const write = gitlabWriteWarning(scopes);
  if (!write) return null;
  return <span className="src-warn"><span>{write} <CreateTokenLink baseUrl={baseUrl} /></span></span>;
}

/** What a test found: who, the instance, the token's kind, expiry and scopes, the warnings; or why it can't be used. */
function CheckResult({ check, now }: { check: SourceCheck; now: number }) {
  const a = check.account;
  const exp = tokenExpiry(a.expiresAt, a.kind, now);
  const problem = check.conflict ?? a.error ?? (check.ok ? null : 'GitLab did not accept this token.');
  // No account at all (no token, rejected, unreachable): just why.
  if (!a.login) return <div className="form-err" role="alert">{problem}</div>;
  return (
    <div className={cx('src-check', !check.ok && 'bad')} role="status">
      <div className="src-check-who">
        <Icon name={check.ok ? 'check' : 'alert'} />
        <span>Signed in as <b>{a.login}</b>{a.name && a.name !== a.login ? <span className="muted"> {a.name}</span> : null}</span>
        {a.instance && <span className="muted">· GitLab {a.instance.version}</span>}
      </div>
      <div className="muted">
        {tokenKindLabel(a.kind ?? 'unknown')}{exp && !exp.warn ? ` · ${exp.text}` : ''}{a.scopes ? ` · ${a.scopes.length ? a.scopes.join(', ') : 'no scopes'}` : ''}
      </div>
      <ExpiryWarning a={a} baseUrl={check.url} now={now} />
      <WriteWarning scopes={a.scopes} baseUrl={check.url} />
      {problem && <div className="form-err" role="alert">{problem}</div>}
    </div>
  );
}

const METHOD_LABEL: Record<SourceMethod, string> = { app: 'Paste a token', glab: 'glab', file: 'Token file', env: 'GITLAB_TOKEN' };

/** "Sign in with": the methods as radios, and what the chosen one needs. Shared by Add GitLab and Change token. */
function MethodPicker({ form, onChange, methods, target, desk, idPrefix }: {
  form: CredentialForm;
  onChange: (f: CredentialForm) => void;
  methods: SourceMethod[];
  /** The source's URL and host, once known: the token page link and the glab login hint. */
  target: { baseUrl: string; host: string } | null;
  desk: DesktopState;
  idPrefix: string;
}) {
  const { locateGlab, chooseTokenFile } = useSourceActions();
  const toast = useToast();
  const canRemember = desk.secureStorage === 'available';
  const pickFile = () => target && chooseTokenFile.mutate(target.baseUrl, {
    onSuccess: (file) => file && onChange({ ...form, method: 'file', file, fileHost: target?.host ?? null }),
    onError: (e) => toast(bridgeError(e), { error: true }),
  });
  const locate = () => locateGlab.mutate(undefined, {
    onSuccess: (state) => state && toast('Found the GitLab CLI'),
    onError: (e) => toast(bridgeError(e), { error: true }),
  });
  return (
    <>
      {methods.length > 1 && (
        <span className="src-methods" role="radiogroup" aria-label="Sign in with">
          {methods.map((m) => (
            <label key={m} className="src-method">
              <input type="radio" className="repo-check" name={`${idPrefix}-method`} checked={form.method === m} onChange={() => onChange({ ...form, method: m })} />
              {m === 'env' ? <code>{METHOD_LABEL[m]}</code> : METHOD_LABEL[m]}
            </label>
          ))}
        </span>
      )}
      {form.method === 'app' && (
        <span className="acct-token">
          <input className="input" type="password" value={form.token} onChange={(e) => onChange({ ...form, token: e.target.value })}
            placeholder="glpat-…" aria-label="GitLab token" autoComplete="off" spellCheck={false} id={`${idPrefix}-token`} />
          <label className="acct-check">
            <input type="checkbox" className="repo-check" checked={canRemember && form.remember} disabled={!canRemember} onChange={(e) => onChange({ ...form, remember: e.target.checked })} />
            Remember on this device
          </label>
          {!canRemember && <small className="muted">No OS keychain is available, so the token is kept only until gh-dash quits.</small>}
          <small className="muted">
            {target ? <><CreateTokenLink baseUrl={target.baseUrl} /> on {target.host}: GitLab fills in the name <code>gh-dash</code> and only the <code>read_api</code> scope.</>
              : 'Enter the address to get a link to GitLab’s page for a read-only token.'}
          </small>
        </span>
      )}
      {form.method === 'glab' && (
        <small className="muted">
          {desk.glab.path ? <>glab found at <code className="path">{desk.glab.path}</code>. Sign in with <code>glab auth login --hostname {target?.host ?? '<host>'}</code> first if you haven’t.</>
            : <>glab not found. <button type="button" className="link-btn" onClick={locate} disabled={locateGlab.isPending}>{locateGlab.isPending ? 'Checking…' : 'Locate glab…'}</button> or install it first.</>}
        </small>
      )}
      {form.method === 'file' && (
        <span className="src-file">
          <button type="button" className="btn" onClick={pickFile} disabled={!target || chooseTokenFile.isPending} title={target ? undefined : 'Enter the address first'}>Choose file…</button>
          {target && fileFor(form, target.host) ? <code className="path">{form.file}</code> : <span className="muted">{target ? 'No file chosen' : 'Enter the address first'}</span>}
          <small className="muted">A file holding just the token, read again on every use. Only you should be able to read it.</small>
        </span>
      )}
      {form.method === 'env' && (
        <small className="muted">
          <code>GITLAB_TOKEN</code> is set in the environment gh-dash was started from{desk.gitlabEnv === 'locks' ? ', so it is this source’s token while it is set.' : '.'}
        </small>
      )}
    </>
  );
}

const newForm = (methods: SourceMethod[]): CredentialForm => ({ method: methods[0]!, token: '', remember: true, file: null, fileHost: null });

/** Desktop: "Add GitLab", inline under the sources. Adding is enabled after a successful test of the same inputs. */
function AddGitLab({ desk, open, onOpen, onClose }: { desk: DesktopState; open: boolean; onOpen: () => void; onClose: () => void }) {
  const { testSource, addSource } = useSourceActions();
  const toast = useToast();
  const now = useNow(60_000);
  const methods = methodsFor(desk.gitlabEnv);
  const [url, setUrl] = useState('');
  const [picked, setForm] = useState<CredentialForm>(() => newForm(methods));
  // GITLAB_TOKEN's state can change under the form (a first source added): keep to a method still offered.
  const form = methods.includes(picked.method) ? picked : { ...picked, method: methods[0]! };
  const [tested, setTested] = useState<{ key: string; check: SourceCheck } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();

  useEffect(() => {
    if (!open || hash !== '#add-gitlab') return;
    box.current?.scrollIntoView({ block: 'nearest' });
    box.current?.querySelector('input')?.focus();
  }, [open, hash]);

  const input = gitlabUrlInput(url);
  const target = input && !('error' in input) ? input : null;
  const draft = draftOf(url, form);
  const key = 'missing' in draft ? null : draftKey(draft, form.file);
  const current = tested && tested.key === key ? tested.check : null;
  const busy = testSource.isPending || addSource.isPending;

  const reset = () => { setUrl(''); setForm(newForm(methods)); setTested(null); setError(null); };
  const change = (f: CredentialForm) => { setForm(f); setError(null); };
  const test = () => {
    if ('missing' in draft) { setError(draft.missing); return; }
    setError(null);
    testSource.mutate(draft, {
      onSuccess: (check) => setTested({ key: key!, check }),
      onError: (e) => setError(bridgeError(e)),
    });
  };
  const add = () => {
    if ('missing' in draft || !current?.ok) return;
    addSource.mutate(draft, {
      onSuccess: (r) => {
        if (!r.saved) { setTested({ key: key!, check: r.check }); return; }
        toast(`Added ${r.check.host} · first sync started${r.remembered ? ' · token saved in the OS keychain' : ''}`);
        reset();
        onClose();
      },
      onError: (e) => setError(bridgeError(e)),
    });
  };

  if (!open) {
    return (
      <div className="src-add-btn">
        <button type="button" className="btn" onClick={onOpen}><Icon name="plus" />Add GitLab</button>
      </div>
    );
  }
  return (
    <div ref={box} className="src-block src-add" id="add-gitlab">
      <SourceHead kind="gitlab" name="Add GitLab" host={target?.host} />
      <form className="set-form" onSubmit={(e) => { e.preventDefault(); if (current?.ok) add(); else test(); }}>
        <label className="set-row">
          <span className="set-l">Address<small>With its path if GitLab is served under one, like https://example.com/gitlab.</small></span>
          <span className="set-c grow">
            <input className={cx('input src-url', input && 'error' in input && 'bad')} value={url} onChange={(e) => { setUrl(e.target.value); setError(null); }}
              placeholder="https://gitlab.example.com" aria-label="GitLab address" autoComplete="off" spellCheck={false} inputMode="url" />
          </span>
        </label>
        <div className="set-row top">
          <span className="set-l">Sign in with<small>gh-dash only reads: a token with the read_api scope is enough.</small></span>
          <span className="set-c grow stack">
            <MethodPicker form={form} onChange={change} methods={methods} target={target} desk={desk} idPrefix="add-gl" />
            {current && <CheckResult check={current} now={now} />}
            {error && <div className="form-err" role="alert">{error}</div>}
          </span>
        </div>
      </form>
      <div className="set-actions">
        <button type="button" className="btn" onClick={test} disabled={busy}>
          {testSource.isPending ? <><span className="spin"><Icon name="sync" /></span>Testing…</> : 'Test connection'}
        </button>
        <button type="button" className="btn primary" onClick={add} disabled={!current?.ok || busy} title={current?.ok ? undefined : 'Test the connection first'}>
          {addSource.isPending ? 'Adding…' : 'Add GitLab'}
        </button>
        <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={addSource.isPending}>Cancel</button>
      </div>
    </div>
  );
}

/** Desktop: "Change token…" for a source the app added. Tested first; nothing changes when the test fails. */
function ChangeToken({ s, desk, onDone }: { s: Source; desk: DesktopState; onDone: () => void }) {
  const { setCredential } = useSourceActions();
  const toast = useToast();
  const now = useNow(60_000);
  const methods = methodsFor(desk.gitlabEnv === 'locks' ? 'unset' : desk.gitlabEnv);
  const [form, setForm] = useState<CredentialForm>(() => newForm(methods));
  const [failed, setFailed] = useState<SourceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = (f: CredentialForm) => { setForm(f); setFailed(null); setError(null); };
  const save = () => {
    const credential = credentialOf(form);
    if ('missing' in credential) { setError(credential.missing); return; }
    setError(null);
    setCredential.mutate({ host: s.host, credential }, {
      onSuccess: (r) => {
        if (!r.saved) { setFailed(r.check); return; }
        toast(`${s.host} · signed in as ${r.check.account.login}${r.remembered ? ' · saved in the OS keychain' : ''}`);
        onDone();
      },
      onError: (e) => setError(bridgeError(e)),
    });
  };
  return (
    <form className="set-form set-sub" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="set-row top">
        <span className="set-l">Sign in with<small>Tested first: the token in use stays until the new one works.</small></span>
        <span className="set-c grow stack">
          <MethodPicker form={form} onChange={change} methods={methods} target={{ baseUrl: s.url, host: s.host }} desk={desk} idPrefix={`chg-${s.host}`} />
          {failed && <CheckResult check={failed} now={now} />}
          {error && <div className="form-err" role="alert">{error}</div>}
          <span className="src-row-actions">
            <button type="submit" className="btn primary" disabled={setCredential.isPending}>{setCredential.isPending ? 'Checking…' : 'Use this'}</button>
            <button type="button" className="btn ghost" onClick={onDone} disabled={setCredential.isPending}>Cancel</button>
          </span>
        </span>
      </div>
    </form>
  );
}

/** How a configured source is managed when it can't be here. */
function ManagedElsewhere({ mode }: { mode: RemoveMode }) {
  if (mode === 'file') return <p className="set-foot muted">Set up in this server’s <code>config.json</code>: change its token or remove it there, then restart the server.</p>;
  if (mode === 'env') return <p className="set-foot muted">Set up by <code>GH_DASH_GITLAB_URL</code> on this server: change or unset it there, then restart the server.</p>;
  if (mode === 'desktop') return <p className="set-foot muted">This server is run by the gh-dash desktop app: manage its sources in the app’s Settings.</p>;
  return null;
}

/** One GitLab source: its account, how its token is found, the token's kind, expiry and scopes, its projects and sync. */
function GitLabSource({ s, app, desk, desktopServer, from }: {
  s: Source;
  /** In the desktop app (its state may still be loading). */
  app: boolean;
  desk: DesktopState | undefined;
  desktopServer: boolean;
  from: ConfigSource | null;
}) {
  const check = useCheckSource();
  const del = useDeleteSource();
  const start = useStartSync();
  const { signOut, remove } = useSourceActions();
  const { openConfirm } = useUI();
  const toast = useToast();
  const now = useNow(60_000);
  const [changing, setChanging] = useState(false);
  const a = s.account;
  const inApp = desk?.sources.find((x) => x.host === s.host) ?? null;
  const mode = removeMode(s, { desktopHosts: desk ? desk.sources.map((x) => x.host) : null, desktopServer, from });
  const who = a?.login ? { login: a.login, name: a.name } : s.viewer;
  const exp = a ? tokenExpiry(a.expiresAt, a.kind, now) : null;
  // An unconfigured source's problem is that it isn't configured, which the note above says already.
  const problem = s.configured ? (a?.error ?? s.sync.problem) : null;
  const canChange = !!desk && !!inApp && !a?.locked;
  const projects = s.repos.owned + s.repos.added;

  const recheck = () => check.mutate(s.host, {
    onSuccess: (x) => toast(x.account?.error ?? (x.account?.login ? `Token checked · ${x.account.login}` : 'Token checked'), { error: !!x.account?.error }),
    onError: (e) => toast(e instanceof ApiError && e.status === 503 && !isUnreachable(e) ? e.message : `Couldn't check: ${(e as Error).message}`, { error: true, ms: 6000 }),
  });
  const syncNow = () => start.mutate({ source: s.host }, {
    onSuccess: () => toast(`Syncing ${s.host}`),
    onError: (e) => toast((e as { status?: number }).status === 409 ? 'A sync is already running' : `Sync failed: ${(e as Error).message}`, { error: true }),
  });
  const confirmSignOut = () => openConfirm({
    title: `Sign out of ${s.host}?`,
    body: `gh-dash forgets the pasted token${inApp?.tokenRemembered ? ' and removes it from the OS keychain' : ''}. The source and its data stay; sign in again to sync it.`,
    confirmLabel: 'Sign out',
    onConfirm: async () => {
      try { await signOut.mutateAsync(s.host); } catch (e) { throw new Error(bridgeError(e)); }
      toast(`Signed out of ${s.host}`);
    },
  });
  const confirmRemove = () => openConfirm({
    title: `Remove ${s.host}?`,
    body: projects
      ? `gh-dash deletes its ${fmtNum(projects)} ${plural(projects, 'project')} and everything synced from them from this dashboard. Nothing changes on GitLab.`
      : 'gh-dash forgets it. Nothing changes on GitLab.',
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: async () => {
      try {
        if (mode === 'app') await remove.mutateAsync(s.host);
        else await del.mutateAsync(s.host);
      } catch (e) {
        throw new Error(bridgeError(e));
      }
      toast(`Removed ${s.host}`);
    },
  });

  return (
    <div className="src-block" id={`source-${s.host}`}>
      <SourceHead kind="gitlab" name="GitLab" host={s.host} version={a?.instance?.version} />
      {!s.configured && (
        <p className="set-note" role="status">
          <span>Not configured on this {desk ? 'app' : 'server'}, so it isn’t synced. Its projects stay here until you remove it{desk ? ', or add it again to sync it' : ''}.</span>
        </p>
      )}
      {a?.mismatch && (
        <p className="set-note" role="status">
          <span>This dashboard’s data from {s.host} belongs to <b>{a.dbLogin ?? 'another account'}</b>, but the token is for <b>{a.login ?? 'another account'}</b>. Syncing it is paused: sign in as {a.dbLogin ? <b>{a.dbLogin}</b> : 'that account'} again.</span>
        </p>
      )}
      <dl className="kv">
        {who && (
          <>
            <dt>Account</dt>
            <dd><span className="acct-who"><Avatar actor={{ login: who.login, name: who.name, avatarUrl: null, isMe: true }} size={20} /><b>{who.login}</b>{who.name && who.name !== who.login ? <span className="muted">{who.name}</span> : null}</span></dd>
          </>
        )}
        {a && (
          <>
            <dt>Source</dt>
            <dd>
              <span className={cx('dot-lbl', (a.source === 'none' || !!a.error) && 'warn')}>{sourceMethodLabel(a, { desktop: !!desk, remembered: inApp?.tokenRemembered })}</span>
              {a.source === 'file' && a.tokenFile && <code className="path">{a.tokenFile}</code>}
              {a.source === 'glab' && a.cli?.path && <span className="muted">at <code className="path">{a.cli.path}</code></span>}
            </dd>
          </>
        )}
        {a?.kind && (
          <>
            <dt>Token</dt>
            <dd className="src-dd">
              <span>{tokenKindLabel(a.kind)}{exp && !exp.warn && <span className="muted"> · {exp.text}</span>}</span>
              <ExpiryWarning a={a} baseUrl={s.url} now={now} />
            </dd>
          </>
        )}
        {a?.scopes && (
          <>
            <dt>Scopes</dt>
            <dd className="src-dd">
              {a.scopes.length ? <span className="acct-scopes">{a.scopes.join(', ')}</span> : <span className="muted">none</span>}
              <WriteWarning scopes={a.scopes} baseUrl={s.url} />
            </dd>
          </>
        )}
        <dt>Projects</dt>
        <dd>{projectsLine(s)}</dd>
        <dt>Last sync</dt>
        <dd>{syncLine(s.sync, now)}</dd>
        {problem && <><dt>Problem</dt><dd className="acct-err">{problem}</dd></>}
      </dl>
      <div className="set-actions">
        {s.configured && (
          <button type="button" className="btn" onClick={recheck} disabled={check.isPending} title="Read the token again and check it with GitLab">
            <Icon name="sync" />{check.isPending ? 'Checking…' : 'Check again'}
          </button>
        )}
        {s.configured && a?.source !== 'none' && (
          <button type="button" className="btn" onClick={syncNow} disabled={start.isPending || s.sync.running} title={`Fetch what changed on ${s.host}`}>Sync now</button>
        )}
        {canChange && !changing && <button type="button" className="btn" onClick={() => setChanging(true)}><Icon name="key" />Change token…</button>}
        {canChange && a?.source === 'app' && <button type="button" className="btn" onClick={confirmSignOut}>Sign out</button>}
        {(mode === 'app' || mode === 'delete') && <button type="button" className="btn" onClick={confirmRemove}><Icon name="trash" />Remove…</button>}
        {a?.checkedAt && <span className="set-when">Checked {relLong(a.checkedAt, now)}</span>}
      </div>
      {changing && desk && <ChangeToken s={s} desk={desk} onDone={() => setChanging(false)} />}
      {desk && a?.locked && (
        <p className="set-foot with-ic"><Icon name="lock" />
          <span><code>{a.env ?? 'GITLAB_TOKEN'}</code> is set in the environment gh-dash was started from, so it is always used. To sign in another way,
          quit gh-dash, unset <code>{a.env ?? 'GITLAB_TOKEN'}</code> and start it again.</span>
        </p>
      )}
      {s.configured && !app && <ManagedElsewhere mode={mode} />}
    </div>
  );
}

/** Headless: where GitLab sources come from (the README names every key). `#add-gitlab` opens it (links to adding one). */
function HeadlessHelp() {
  const { hash } = useLocation();
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (hash === '#add-gitlab' && box.current) box.current.open = true; }, [hash]);
  return (
    <details ref={box} className="help" id="add-gitlab">
      <summary>How to add a GitLab source</summary>
      <p>Add it to this server’s <code>config.json</code> and restart the server:</p>
      <pre className="code">{`"sources": [
  { "kind": "gitlab", "url": "https://gitlab.example.com",
    "tokenSource": "file", "tokenFile": "/home/you/.config/gh-dash/gitlab-token" }
]`}</pre>
      <p>
        Or declare one in the environment with <code>GH_DASH_GITLAB_URL</code>, and give it <code>GITLAB_TOKEN</code>,
        a <code>GITLAB_TOKEN_FILE</code>, or <code>GH_DASH_GITLAB_TOKEN_SOURCE=glab</code> for the GitLab CLI’s token.
        A token with the <code>read_api</code> scope is enough.
      </p>
      <p className="muted">Tokens are never stored in the database or shown here.</p>
    </details>
  );
}

export function SourcesSection({ rateLimit }: { rateLimit: SyncStatus['rateLimit'] | undefined }) {
  const sources = useSources();
  const instance = useInstance();
  const { bridge, state: desk } = useDesktop();
  const { hash } = useLocation();
  const [adding, setAdding] = useState(hash === '#add-gitlab');
  useEffect(() => { if (hash === '#add-gitlab') setAdding(true); }, [hash]);
  const gitlab = (sources.data ?? []).filter((s) => s.kind !== 'github');
  const desktopServer = !bridge && !!instance.data?.desktop;
  const fromOf = (host: string) => instance.data?.settings.sources.find((x) => x.host === host)?.from ?? null;

  return (
    <section className="card set-sec" id="sources">
      <h2>Sources</h2>
      <div className="src-block" id="account">
        <SourceHead kind="github" name="GitHub" host="github.com" />
        <GitHubAccount rateLimit={rateLimit} />
      </div>
      {sources.isError && <p className="src-block muted">Couldn’t load the other sources: {(sources.error as Error).message}</p>}
      {gitlab.map((s) => <GitLabSource key={s.host} s={s} app={!!bridge} desk={desk} desktopServer={desktopServer} from={fromOf(s.host)} />)}
      {bridge ? (desk && <AddGitLab desk={desk} open={adding} onOpen={() => setAdding(true)} onClose={() => setAdding(false)} />)
        : desktopServer ? <p className="set-foot muted" id="add-gitlab">This server is run by the gh-dash desktop app: add GitLab in the app’s Settings.</p>
          : <HeadlessHelp />}
    </section>
  );
}
