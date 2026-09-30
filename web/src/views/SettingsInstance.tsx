/**
 * Settings → Instance: how this server runs. Read-only on a headless server (config.json or the environment
 * set it); in the desktop app, the data folder and the Local API are edited here and saved to config.json.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ConfigSource, InstanceInfo } from '../../../shared/api';
import type { DesktopState } from '../../../shared/desktop';
import { useDesktop, useDesktopActions } from '../api/desktop';
import { useInstance } from '../api/hooks';
import { ChipsInput } from '../components/ChipsInput';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import {
  SETTING_ENV, authLabel, bridgeError, instanceForm, instancePatch, instanceProblems, parseHosts, settingSource, tokensOptionalProblem, willHavePassword,
} from '../lib/account';
import type { InstanceForm, SettingKey } from '../lib/account';
import { copyText, cx } from '../lib/util';

type Key = SettingKey;

function Src({ k, source }: { k: Key; source: ConfigSource }) {
  const title = source === 'default' ? 'Default value' : source === 'file' ? 'Set in config.json' : `Set by the ${SETTING_ENV[k]} environment variable`;
  return <small className="set-src" title={title}>{settingSource(k, source)}</small>;
}

function Row({ label, k, i, children }: { label: string; k: Key; i: InstanceInfo; children: ReactNode }) {
  return <><dt>{label}</dt><dd>{children}<Src k={k} source={i.settings[k].source} /></dd></>;
}

/** Headless (or a browser tab of the desktop app's Local API): what the server runs with, and where each value came from. */
function InstanceInfoList({ i }: { i: InstanceInfo }) {
  const s = i.settings;
  return (
    <>
      <dl className="kv">
        <dt>Version</dt><dd>{i.version}{i.desktop && <span className="muted"> · desktop app</span>}</dd>
        <dt>API URL</dt><dd>{i.apiUrl ? <a href={i.apiUrl} target="_blank" rel="noopener noreferrer">{i.apiUrl}</a> : <span className="muted">none</span>}</dd>
        <dt>MCP URL</dt><dd>{i.mcpUrl ? <code className="path">{i.mcpUrl}</code> : <span className="muted">none</span>}</dd>
        <Row label="Address" k="host" i={i}>{s.host.value}</Row>
        <Row label="Port" k="port" i={i}>{s.port.value}</Row>
        <Row label="Allowed hosts" k="allowedHosts" i={i}>
          {s.allowedHosts.value.length ? s.allowedHosts.value.map((h) => <code key={h}>{h}</code>) : <span className="muted">localhost and IP addresses only</span>}
        </Row>
        <dt>Authentication</dt><dd>{authLabel(i.auth)}</dd>
        <Row label="Database" k="dbPath" i={i}><code className="path">{s.dbPath.value}</code></Row>
        <Row label="Diff cache" k="cacheDbPath" i={i}><code className="path">{s.cacheDbPath.value}</code></Row>
        <Row label="Background sync" k="sync" i={i}>{s.sync.value ? 'On' : 'Off'}</Row>
        <Row label="Token file" k="tokenFile" i={i}>{s.tokenFile.value ? <code className="path">{s.tokenFile.value}</code> : <span className="muted">none</span>}</Row>
        <Row label="Time zone" k="defaultTz" i={i}>{s.defaultTz.value}</Row>
        <dt>Config file</dt><dd>{i.configPath ? <code className="path">{i.configPath}</code> : <span className="muted">not used</span>}</dd>
      </dl>
      {!i.desktop && (
        <p className="set-foot muted">
          Change these in <code>config.json</code> or the server's environment (the environment wins), then restart the server.
        </p>
      )}
    </>
  );
}

/** The API key: set or not, or removed when the form is saved. */
function KeyState({ set, pending, onUndo }: { set: boolean; pending: string | null | undefined; onUndo: () => void }) {
  if (pending === null) return <><span className="muted">Removed when you save</span><button type="button" className="btn" onClick={onUndo}>Undo</button></>;
  return <span className="muted">{set ? 'A key is set' : 'No key'}</span>;
}

/** Desktop app: data folder and Local API, saved to config.json (the background server restarts). */
function DesktopInstance({ state, apiUrl, mcpUrl }: { state: DesktopState; apiUrl: string | null; mcpUrl: string | null }) {
  const { updateConfig, chooseDataDir, generateApiKey } = useDesktopActions();
  const toast = useToast();
  const cfg = state.config;
  const [form, setForm] = useState<InstanceForm>(() => instanceForm(cfg));
  const [newKey, setNewKey] = useState<string | null>(null);
  // Take the saved config again when it changes underneath (saved here, or elsewhere).
  const cfgKey = JSON.stringify(cfg);
  const [seen, setSeen] = useState(cfgKey);
  if (seen !== cfgKey) { setSeen(cfgKey); setForm(instanceForm(cfg)); setNewKey(null); }

  const patch = instancePatch(cfg, form);
  const dirty = Object.keys(patch).length > 0;
  const problems = instanceProblems(cfg, form);
  const ok = Object.keys(problems).length === 0;
  const busy = updateConfig.isPending;
  const set = (p: Partial<InstanceForm>) => setForm((f) => ({ ...f, ...p }));

  const save = () => {
    if (!dirty || !ok || busy) return;
    updateConfig.mutate(patch, {
      onSuccess: (st) => {
        setForm(instanceForm(st.config));
        setNewKey(null);
        if (st.serverError) toast(`Saved, but the server didn't start: ${st.serverError}`, { error: true, ms: 6000 });
        else toast('Saved · background server restarted');
      },
      onError: (e) => toast(`Couldn't save: ${bridgeError(e)}`, { error: true }),
    });
  };
  const reset = () => { setForm(instanceForm(cfg)); setNewKey(null); };
  const choose = () => chooseDataDir.mutate(undefined, {
    onSuccess: (dir) => { if (dir) set({ dataDir: dir }); },
    onError: (e) => toast(bridgeError(e), { error: true }),
  });
  const generate = () => generateApiKey.mutate(undefined, {
    onSuccess: (key) => { setNewKey(key); set({ apiKey: key }); },
    onError: (e) => toast(bridgeError(e), { error: true }),
  });
  const copyKey = async () => { if (newKey) toast((await copyText(newKey)) ? 'API key copied' : 'Copy failed'); };
  const showHosts = form.network || form.allowedHosts.length > 0;
  const tokensLocked = tokensOptionalProblem(form);
  // The port as it runs now: the REST API's URL, or MCP's without it.
  const running = cfg.listen ? (apiUrl ?? mcpUrl?.replace(/\/mcp$/, '') ?? null) : null;

  return (
    <form className="set-form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-busy={busy || undefined}>
      {state.serverError && (
        <p className="set-note err" role="alert"><span>The background server couldn't start with the saved settings: {state.serverError}</span></p>
      )}
      <fieldset className="set-fields" disabled={busy}>
        <div className="set-row">
          <span className="set-l">Data folder<small>Where the database and the diff cache are kept.</small></span>
          <span className="set-c grow">
            <code className="path set-path" title={form.dataDir}>{form.dataDir || '—'}</code>
            <button type="button" className="btn" onClick={choose} disabled={chooseDataDir.isPending}>Change…</button>
          </span>
        </div>
        <div className="set-row">
          <label className="set-l" htmlFor="local-api">Local API<small>A port on this computer for browsers, scripts and agents: the REST API and MCP below. Off: nothing listens.</small></label>
          <span className="set-c wrap">
            <input id="local-api" type="checkbox" className="switch" checked={form.listen} onChange={(e) => set({ listen: e.target.checked })} />
            {running && <small className="muted">Listening on {apiUrl ? <a href={apiUrl} target="_blank" rel="noopener noreferrer">{running}</a> : running}</small>}
          </span>
        </div>
        {form.listen && (
          <>
            <label className="set-row">
              <span className="set-l">Port<small>1–65535.</small></span>
              <span className="set-c stack">
                <input className={cx('input num-in', problems.port && 'bad')} type="number" min={1} max={65535} step={1} value={Number.isFinite(form.port) ? form.port : ''}
                  onChange={(e) => set({ port: Math.round(Number(e.target.value)) })} aria-invalid={problems.port ? true : undefined} />
                {problems.port && <span className="form-err">{problems.port}</span>}
              </span>
            </label>
            <div className="set-row">
              <label className="set-l" htmlFor="local-rest">REST API<small>The dashboard in a browser and its JSON API, for curl and scripts.</small></label>
              <span className="set-c stack">
                <input id="local-rest" type="checkbox" className="switch" checked={form.restApi} onChange={(e) => set({ restApi: e.target.checked })}
                  aria-describedby={form.restApi && !willHavePassword(cfg, form) ? 'rest-warn' : undefined} />
                {form.restApi && !willHavePassword(cfg, form) && (
                  <small id="rest-warn" className="set-warn">Any program on this computer can use the API. Set a password to require a sign-in.</small>
                )}
                {!form.restApi && form.mcp && <small className="muted">Off: the port serves agents alone, on this computer only.</small>}
              </span>
            </div>
            {form.restApi && (
              <>
                <label className="set-row sub">
                  <span className="set-l">Allow other devices<small>Listen on all network interfaces. Needs a password.</small></span>
                  <span className="set-c stack">
                    <input type="checkbox" className="switch" checked={form.network} onChange={(e) => set({ network: e.target.checked, ...(e.target.checked ? { mcpRequireTokens: true } : {}) })}
                      aria-invalid={problems.network ? true : undefined} aria-describedby={problems.network ? 'net-err' : undefined} />
                    {problems.network && <span id="net-err" className="form-err">{problems.network}</span>}
                  </span>
                </label>
                {showHosts && (
                  <div className="set-row sub">
                    <span className="set-l">Host names<small>Names other devices use for this computer, e.g. <code>mybox.local</code>. localhost and IP addresses always work.</small></span>
                    <span className="set-c grow">
                      <ChipsInput value={form.allowedHosts} onChange={(allowedHosts) => set({ allowedHosts })} parse={parseHosts} placeholder="mybox.local" label="Add host name" />
                    </span>
                  </div>
                )}
                <div className="set-row sub">
                  <span className="set-l">Password<small>Browsers ask for it before showing the dashboard.</small></span>
                  <span className="set-c grow wrap">
                    <input className={cx('input set-secret', problems.password && 'bad')} type="password" autoComplete="new-password" aria-label={cfg.passwordSet ? 'New password' : 'Password'}
                      placeholder={form.password === null ? 'Removed when you save' : cfg.passwordSet ? 'Set · type to replace' : 'Not set'} value={form.password ?? ''}
                      onChange={(e) => set({ password: e.target.value || undefined })} disabled={form.password === null}
                      aria-invalid={problems.password ? true : undefined} aria-describedby={problems.password ? 'pw-err' : undefined} />
                    {problems.password && <span id="pw-err" className="form-err">{problems.password}</span>}
                    {form.password === null && <button type="button" className="btn" onClick={() => set({ password: undefined })}>Undo</button>}
                    {cfg.passwordSet && form.password === undefined && (
                      <button type="button" className="btn" onClick={() => set({ password: null })}>Remove</button>
                    )}
                  </span>
                </div>
                <div className="set-row sub">
                  <span className="set-l">API key<small>For scripts, sent as a Bearer token. It doesn't protect the dashboard.</small></span>
                  <span className="set-c grow stack">
                    {newKey && form.apiKey === newKey ? (
                      <>
                        <span className="set-c">
                          <code className="set-key">{newKey}</code>
                          <button type="button" className="btn" onClick={copyKey}><Icon name="copy" />Copy</button>
                        </span>
                        <small className="muted">Shown only once: copy it now. Click Save to keep it.</small>
                      </>
                    ) : (
                      <span className="set-c wrap">
                        <KeyState set={cfg.apiKeySet} pending={form.apiKey} onUndo={() => set({ apiKey: undefined })} />
                        {form.apiKey !== null && (
                          <button type="button" className="btn" onClick={generate} disabled={generateApiKey.isPending}><Icon name="key" />{cfg.apiKeySet ? 'Generate new' : 'Generate'}</button>
                        )}
                        {cfg.apiKeySet && form.apiKey === undefined && <button type="button" className="btn" onClick={() => set({ apiKey: null })}>Remove</button>}
                      </span>
                    )}
                  </span>
                </div>
              </>
            )}
            <div className="set-row">
              <label className="set-l" htmlFor="local-mcp">MCP for agents<small><code>/mcp</code> for coding agents (see Agents below).</small></label>
              <span className="set-c"><input id="local-mcp" type="checkbox" className="switch" checked={form.mcp} onChange={(e) => set({ mcp: e.target.checked })} /></span>
            </div>
            {form.mcp && (
              <div className="set-row sub">
                <label className="set-l" htmlFor="local-mcp-tokens">Require agent tokens<small>Each agent sends its own. Off: a request without one writes as “Agent”.</small></label>
                <span className="set-c stack">
                  <input id="local-mcp-tokens" type="checkbox" className="switch" checked={form.mcpRequireTokens || !!tokensLocked} disabled={!!tokensLocked}
                    onChange={(e) => set({ mcpRequireTokens: e.target.checked })} aria-describedby={tokensLocked || !form.mcpRequireTokens ? 'tokens-note' : undefined} />
                  {tokensLocked
                    ? <small id="tokens-note" className="muted">{tokensLocked}</small>
                    : !form.mcpRequireTokens && <small id="tokens-note" className="set-warn">Any program on this computer can write comments as “Agent”.</small>}
                </span>
              </div>
            )}
            {!form.restApi && !form.mcp && (
              <p className="set-foot muted">With both off, the port answers nothing but <code>/api/health</code>.</p>
            )}
          </>
        )}
      </fieldset>
      <div className="set-actions">
        <button type="submit" className="btn primary" disabled={!dirty || !ok || busy}>{busy ? 'Restarting…' : 'Save'}</button>
        <button type="button" className="btn" disabled={!dirty || busy} onClick={reset}>Reset</button>
        <span className="set-when">{busy ? 'Restarting the background server…' : 'Saving restarts the background server.'}</span>
      </div>
      <p className="set-foot muted">
        gh-dash {state.version} · settings are kept in <code className="path">{state.configPath}</code>
      </p>
    </form>
  );
}

export function InstanceSection() {
  const inst = useInstance();
  const { bridge, state, loading } = useDesktop();
  const i = inst.data;
  return (
    <section className="card set-sec" id="instance">
      <h2>Instance</h2>
      {bridge ? (
        state ? <DesktopInstance state={state} apiUrl={state.apiUrl} mcpUrl={state.mcpUrl} />
          : <p className="muted">{loading ? 'Loading…' : "Couldn't read the app's settings."}</p>
      ) : i ? <InstanceInfoList i={i} />
        : inst.isError ? <p className="muted">Couldn't load: {(inst.error as Error).message}</p> : <p className="muted">Loading…</p>}
    </section>
  );
}
