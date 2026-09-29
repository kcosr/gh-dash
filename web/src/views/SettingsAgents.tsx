/**
 * Settings → Agents (`/settings#agents`): the coding agents that read and write comments here through MCP, each with a
 * token of its own, and how to connect one. The desktop app adds agents, makes new tokens and revokes them (a token is
 * shown once, with ready-to-paste config); a headless server does that with its `agents` command, and lists them here.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import type { Agent } from '../../../shared/api';
import { useAgentActions, useDesktop } from '../api/desktop';
import { useAgents, useApiBase, useWorkSources } from '../api/hooks';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { useUI } from '../components/ui';
import { bridgeError } from '../lib/account';
import { agentConfig, agentNameProblem, mcpUrl, sortAgents } from '../lib/agents';
import { hostNames } from '../lib/sources';
import { fmtDateTime, relLong } from '../lib/time';
import { copyText, cx, useNow } from '../lib/util';

/** A token just made: shown here once, never again. */
interface Shown { agent: Agent; token: string; kind: 'added' | 'new' }

function Copy({ text, what, className = 'btn sm' }: { text: string; what: string; className?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={className} onClick={async () => toast((await copyText(text)) ? `${what} copied` : 'Copy failed')} title={`Copy ${what.toLowerCase()}`}>
      <Icon name="copy" />Copy
    </button>
  );
}

/** One agent: its name, token prefix, when it was added and last used (or revoked); the desktop app's actions. */
function AgentRow({ a, now, onNewToken, onRevoke }: { a: Agent; now: number; onNewToken?: (a: Agent) => void; onRevoke?: (a: Agent) => void }) {
  const revoked = !!a.revokedAt;
  return (
    <li className={cx('trk-row agent-row', revoked && 'revoked')}>
      <span className="trk-name" title={a.name}>{a.name}</span>
      {a.tokenPrefix && <code className="agent-prefix" title="The token's first characters, to tell tokens apart">{a.tokenPrefix}…</code>}
      <span className="trk-st agent-st" title={[`Added ${fmtDateTime(a.createdAt)}`, a.lastUsedAt && `last used ${fmtDateTime(a.lastUsedAt)}`, a.revokedAt && `revoked ${fmtDateTime(a.revokedAt)}`].filter(Boolean).join(', ')}>
        {revoked ? `Revoked ${relLong(a.revokedAt!, now)}` : a.lastUsedAt ? `Used ${relLong(a.lastUsedAt, now)}` : `Added ${relLong(a.createdAt, now)} · not used yet`}
      </span>
      <span className="spacer" />
      {!revoked && onNewToken && <button type="button" className="btn sm ghost" onClick={() => onNewToken(a)}>New token…</button>}
      {!revoked && onRevoke && <button type="button" className="btn sm ghost" onClick={() => onRevoke(a)}>Revoke…</button>}
    </li>
  );
}

/** The token once, with what to paste into Claude Code or Codex. */
function TokenPanel({ shown, url, onDone }: { shown: Shown; url: string; onDone: () => void }) {
  const c = agentConfig(url, shown.token);
  return (
    <div className="agent-token" role="region" aria-label={`${shown.agent.name}'s token`}>
      <p className="agent-token-h">
        <Icon name="key" />
        <span><b>{shown.agent.name}</b>{shown.kind === 'new' ? "'s new token" : "'s token"} · shown only this once: copy it now.{shown.kind === 'new' && ' The old one no longer works.'}</span>
      </p>
      <div className="agent-snip">
        <code className="set-key">{shown.token}</code>
        <Copy text={shown.token} what="Token" />
      </div>
      <h3>Claude Code</h3>
      <div className="agent-snip">
        <pre className="code">{c.claude}</pre>
        <Copy text={c.claude} what="Command" />
      </div>
      <h3>Codex <small>~/.codex/config.toml</small></h3>
      <div className="agent-snip">
        <pre className="code">{c.codexToml}</pre>
        <Copy text={c.codexToml} what="Config" />
      </div>
      <small className="muted">Codex reads the token from the environment it starts in:</small>
      <div className="agent-snip">
        <pre className="code">{c.codexEnv}</pre>
        <Copy text={c.codexEnv} what="Line" />
      </div>
      <div className="set-actions">
        <button type="button" className="btn" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function AddAgent({ agents, onAdded, onCancel }: { agents: readonly Agent[]; onAdded: (s: Shown) => void; onCancel: () => void }) {
  const { add } = useAgentActions();
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const problem = agentNameProblem(name, agents);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem || add.isPending) return;
    add.mutate(name.trim(), { onSuccess: (r) => onAdded({ ...r, kind: 'added' }) });
  };
  const err = (tried && problem) || (add.error ? bridgeError(add.error) : null);
  return (
    <form className="agent-add" onSubmit={submit}>
      <label className="sr-only" htmlFor="agent-name">Agent name</label>
      <input id="agent-name" className={cx('input', tried && problem && 'bad')} value={name} placeholder="Claude" autoFocus autoComplete="off" maxLength={80}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
        aria-invalid={err ? true : undefined} aria-describedby={err ? 'agent-name-err' : undefined} />
      <button type="submit" className="btn primary" disabled={add.isPending}>Add</button>
      <button type="button" className="btn" onClick={onCancel} disabled={add.isPending}>Cancel</button>
      {err && <span id="agent-name-err" className="form-err" role="alert">{err}</span>}
    </form>
  );
}

export function AgentsSection() {
  const agents = useAgents();
  const { bridge, state } = useDesktop();
  const apiBase = useApiBase();
  const { regenerate, revoke } = useAgentActions();
  const { openConfirm } = useUI();
  const toast = useToast();
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const desktop = !!bridge;
  // The desktop app's agents always reach it on this computer, at the Local API's port: a URL that doesn't change when
  // the app restarts (or when the Local API is off for a while). A server: its own URL.
  const url = desktop ? (state ? `http://127.0.0.1:${state.config.port}/mcp` : null) : mcpUrl(apiBase);
  const off = desktop && !!state && !state.config.listen;
  const list = sortAgents(agents.data ?? []);

  const newToken = (a: Agent) => openConfirm({
    title: `New token for ${a.name}?`,
    body: `The token ${a.name} uses now stops working at once; configure it with the new one.`,
    confirmLabel: 'Make a new token',
    onConfirm: async () => {
      const r = await regenerate.mutateAsync(a.id).catch((e: unknown) => { throw new Error(bridgeError(e)); });
      setShown({ ...r, kind: 'new' });
    },
  });
  const revokeAgent = (a: Agent) => openConfirm({
    title: `Revoke ${a.name}?`,
    body: `Its token stops working at once. What ${a.name} wrote stays, under its name.`,
    confirmLabel: 'Revoke',
    danger: true,
    onConfirm: async () => {
      await revoke.mutateAsync(a.id).catch((e: unknown) => { throw new Error(bridgeError(e)); });
      if (shown?.agent.id === a.id) setShown(null);
      toast(`${a.name} revoked`);
    },
  });

  return (
    <section className="card set-sec" id="agents">
      <h2>Agents</h2>
      <p>
        Coding agents such as Claude Code or Codex read and write comments here through MCP, each with a token of its own.
        What an agent writes is marked as its own, and stays here: nothing is posted to {hostNames(useWorkSources()).replace(' and ', ' or ') || 'GitHub'}.
      </p>
      {off && (
        <p className="set-note">
          <span>The Local API is off, so agents can't reach gh-dash. Turn it on under <Link to={{ hash: 'instance' }}>Instance</Link>.</span>
        </p>
      )}
      <div className="set-form">
        <div className="set-row">
          <span className="set-l">MCP URL<small>Streamable HTTP. An agent sends its token as a Bearer token.</small></span>
          <span className="set-c wrap">
            {url ? <><code className={cx('set-key', off && 'muted')}>{url}</code><Copy text={url} what="MCP URL" /></> : <span className="muted">{desktop ? 'Loading…' : 'None: nothing listens on the network'}</span>}
          </span>
        </div>
        <div className="set-row top">
          <span className="set-l">Added agents<small>Revoked ones stay listed: what they wrote is still theirs.</small></span>
          <span className="set-c grow stack">
            {agents.isError ? <span className="muted">Couldn't load agents: {(agents.error as Error).message}</span>
              : !agents.data ? <span className="muted">Loading…</span>
                : list.length ? (
                  <ul className="trk-list">
                    {list.map((a) => <AgentRow key={a.id} a={a} now={now} onNewToken={desktop ? newToken : undefined} onRevoke={desktop ? revokeAgent : undefined} />)}
                  </ul>
                ) : <span className="muted">None yet.</span>}
          </span>
        </div>
      </div>
      {shown && url && <TokenPanel shown={shown} url={url} onDone={() => setShown(null)} />}
      {desktop ? (
        !shown && (adding
          ? <AddAgent agents={list} onAdded={(s) => { setAdding(false); setShown(s); }} onCancel={() => setAdding(false)} />
          : (
            <div className="set-actions">
              <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" />Add agent</button>
            </div>
          ))
      ) : (
        <p className="set-foot muted">
          Agents are added where the server runs: <code>node dist/server/index.mjs agents add &lt;name&gt;</code> prints the
          new agent's token once. <code>agents list</code> shows them, <code>agents revoke &lt;name&gt;</code> stops a token.
        </p>
      )}
    </section>
  );
}
