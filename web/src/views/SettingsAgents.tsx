/**
 * Settings → Agents (`/settings#agents`): the coding agents that read and write comments here through MCP, each with a
 * token of its own, and how to connect one. The desktop app adds agents, makes new tokens and revokes them (a token is
 * shown once, with ready-to-paste config); a headless server does that with its `agents` command, and lists them here.
 */
import { useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { Agent } from '../../../shared/api';
import { useAgentActions, useDesktop } from '../api/desktop';
import { useAgents, useInstance, useWorkSources } from '../api/hooks';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { useUI } from '../components/ui';
import { bridgeError } from '../lib/account';
import { agentConfig, agentNameProblem, agentTokenProblem, generateAgentToken, sortAgents } from '../lib/agents';
import { hostNames } from '../lib/sources';
import { fmtDateTime, relLong } from '../lib/time';
import { copyText, cx, useNow } from '../lib/util';

/** A token just made: shown here once, never again. `enabled`: adding it turned MCP on (what it says then). */
interface Shown { agent: Agent; token: string; kind: 'added' | 'new'; enabled?: string }

function Copy({ text, what, className = 'btn sm' }: { text: string; what: string; className?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={className} onClick={async () => toast((await copyText(text)) ? `${what} copied` : 'Copy failed')} title={`Copy ${what.toLowerCase()}`}
      aria-label={`Copy ${what.toLowerCase()}`}>
      <Icon name="copy" /><span className="lbl">Copy</span>
    </button>
  );
}

/** One agent: its name, token prefix, when it was added and last used (or revoked); the desktop app's actions. */
function AgentRow({ a, now, onNewToken, onRevoke }: { a: Agent; now: number; onNewToken?: (a: Agent) => void; onRevoke?: (a: Agent) => void }) {
  const revoked = !!a.revokedAt;
  if (a.builtIn) {
    return (
      <li className="trk-row agent-row">
        <span className="trk-name" title={a.name}>{a.name}</span>
        <span className="agent-prefix" title="MCP requests without a token act as it, while agent tokens aren't required">no token</span>
        <span className="trk-st agent-st">Built in: requests without a token</span>
      </li>
    );
  }
  return (
    <li className={cx('trk-row agent-row', revoked && 'revoked')}>
      <span className="trk-name" title={a.name}>{a.name}</span>
      {a.tokenPrefix && <code className="agent-prefix" title="The token's first characters, to tell tokens apart">{a.tokenPrefix}…</code>}
      <span className="trk-st agent-st" title={[`Added ${fmtDateTime(a.createdAt)}`, a.lastUsedAt && `last used ${fmtDateTime(a.lastUsedAt)}`, a.revokedAt && `revoked ${fmtDateTime(a.revokedAt)}`].filter(Boolean).join(', ')}>
        {revoked ? `Revoked ${relLong(a.revokedAt!, now)}` : a.lastUsedAt ? `Used ${relLong(a.lastUsedAt, now)}` : `Added ${relLong(a.createdAt, now)} · not used yet`}
      </span>
      <span className="spacer" />
      {onNewToken && (
        <button type="button" className="btn sm ghost" onClick={() => onNewToken(a)} title={revoked ? 'Give it a token again: it can write here once more' : 'Replace its token'}>
          New token…
        </button>
      )}
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
      {shown.enabled && <p className="agent-enabled" role="status"><Icon name="check" />{shown.enabled}</p>}
      <div className="agent-snip">
        <code className="set-key">{shown.token}</code>
        <Copy text={shown.token} what="Token" />
      </div>
      <h3>Claude Code</h3>
      <div className="agent-snip">
        <pre className="code">{c.claude}</pre>
        <Copy text={c.claude} what="Command" />
      </div>
      <h3>Codex <small>adds it to ~/.codex/config.toml</small></h3>
      <div className="agent-snip">
        <pre className="code">{c.codex}</pre>
        <Copy text={c.codex} what="Command" />
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

/** The token field: pre-filled with a generated token, which Generate replaces; or the user's own. */
function TokenField({ id, value, onChange, problem }: { id: string; value: string; onChange: (v: string) => void; problem: string | null }) {
  return (
    <span className="agent-token-field">
      <label className="sr-only" htmlFor={id}>Token</label>
      <input id={id} className={cx('input agent-token-in', problem && 'bad')} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false}
        autoComplete="off" aria-invalid={problem ? true : undefined} title="Generated here; or paste your own (24–256 printable characters, no spaces)" />
      <button type="button" className="btn" onClick={() => onChange(generateAgentToken())} title="A new random token"><Icon name="sync" />Generate</button>
    </span>
  );
}

/** Add agent: a name and its token (generated, or the user's own). */
function AddAgent({ agents, portOff, onAdded, onCancel }: { agents: readonly Agent[]; portOff: boolean; onAdded: (s: Shown) => void; onCancel: () => void }) {
  const { add } = useAgentActions();
  const [name, setName] = useState('');
  const [token, setToken] = useState(generateAgentToken);
  const [tried, setTried] = useState(false);
  const problem = agentNameProblem(name, agents);
  const tokenProblem = agentTokenProblem(token);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem || tokenProblem || add.isPending) return;
    add.mutate({ name: name.trim(), token }, {
      onSuccess: (r) => onAdded({
        ...r, kind: 'added',
        enabled: r.enabledMcp ? (portOff ? 'The Local API is now on, for agents only: MCP on, the REST API off.' : 'MCP is now on, on the Local API.') : undefined,
      }),
    });
  };
  const err = (tried && (problem ?? (tokenProblem && `Token: ${tokenProblem}`))) || (add.error ? bridgeError(add.error) : null);
  const escape = (e: ReactKeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
  return (
    <form className="agent-add" onSubmit={submit} onKeyDown={escape}>
      <label className="sr-only" htmlFor="agent-name">Agent name</label>
      <input id="agent-name" className={cx('input', tried && problem && 'bad')} value={name} placeholder="Name, e.g. Claude" autoFocus autoComplete="off" maxLength={80}
        onChange={(e) => setName(e.target.value)} aria-invalid={tried && problem ? true : undefined} aria-describedby={err ? 'agent-add-err' : undefined} />
      <TokenField id="agent-token" value={token} onChange={setToken} problem={tried ? tokenProblem : null} />
      <button type="submit" className="btn primary" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add'}</button>
      <button type="button" className="btn" onClick={onCancel} disabled={add.isPending}>Cancel</button>
      {err && <span id="agent-add-err" className="form-err" role="alert">{err}</span>}
    </form>
  );
}

/** New token…: the old one stops at once; the new one generated, or the user's own. */
function NewToken({ agent, onMade, onCancel }: { agent: Agent; onMade: (s: Shown) => void; onCancel: () => void }) {
  const { regenerate } = useAgentActions();
  const [token, setToken] = useState(generateAgentToken);
  const problem = agentTokenProblem(token);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || regenerate.isPending) return;
    regenerate.mutate({ id: agent.id, token }, { onSuccess: (r) => onMade({ ...r, kind: 'new' }) });
  };
  const err = problem ? `Token: ${problem}` : regenerate.error ? bridgeError(regenerate.error) : null;
  return (
    <form className="agent-add agent-new" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      aria-label={`New token for ${agent.name}`}>
      <p className="agent-new-h">
        New token for <b>{agent.name}</b>. {agent.revokedAt ? `${agent.name} can write here again with it.` : 'The one it uses now stops working at once.'}
      </p>
      <TokenField id="agent-new-token" value={token} onChange={setToken} problem={problem} />
      <button type="submit" className="btn primary" disabled={regenerate.isPending || !!problem}>Make new token</button>
      <button type="button" className="btn" onClick={onCancel} disabled={regenerate.isPending}>Cancel</button>
      {err && <span className="form-err" role="alert">{err}</span>}
    </form>
  );
}

export function AgentsSection() {
  const agents = useAgents();
  const { bridge, state } = useDesktop();
  const instance = useInstance().data;
  const { revoke, enableMcp } = useAgentActions();
  const { openConfirm } = useUI();
  const toast = useToast();
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<Agent | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const desktop = !!bridge;
  const cfg = state?.config;
  // The desktop app's agents reach it on this computer, at the Local API's port: a URL that doesn't change when the app
  // restarts (or while MCP is off for a while). A server: its own.
  const url = desktop ? (cfg ? `http://127.0.0.1:${cfg.port}/mcp` : null) : (instance?.mcpUrl ?? null);
  const portOff = !!cfg && !cfg.listen;
  const mcpOff = !!cfg && (!cfg.listen || !cfg.mcp);
  const tokensOptional = !!cfg && cfg.listen && cfg.mcp && !cfg.mcpRequireTokens;
  const list = sortAgents(agents.data ?? []);

  const turnOn = () => enableMcp.mutate(undefined, {
    onSuccess: (st) => toast(st.mcpUrl ? (portOff ? 'Local API on, for agents only' : 'MCP on') : `Couldn't turn it on${st.serverError ? `: ${st.serverError}` : ''}`, { error: !st.mcpUrl }),
    onError: (e) => toast(bridgeError(e), { error: true }),
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
  const show = (s: Shown) => { setAdding(false); setRenewing(null); setShown(s); };

  return (
    <section className="card set-sec" id="agents">
      <h2>Agents</h2>
      <p>
        Coding agents such as Claude Code or Codex read and write comments here through MCP, each with a token of its own.
        What an agent writes is marked as its own, and stays here: nothing is posted to {hostNames(useWorkSources()).replace(' and ', ' or ') || 'GitHub'}.
      </p>
      {mcpOff && !shown && (
        <div className="set-note agent-off">
          <span>
            {portOff ? "The Local API is off, so agents can't reach gh-dash." : "MCP is off on the Local API, so agents can't reach gh-dash."}
            {' '}Adding an agent turns it on too.
          </span>
          <button type="button" className="btn sm" onClick={turnOn} disabled={enableMcp.isPending}>
            {enableMcp.isPending ? 'Turning on…' : 'Turn on MCP'}
          </button>
        </div>
      )}
      <div className="set-form">
        <div className="set-row">
          <span className="set-l">MCP URL<small>Streamable HTTP, on this computer.</small></span>
          <span className="set-c stack">
            <span className="set-c wrap">
              {url ? <><code className={cx('set-key', mcpOff && 'muted')}>{url}</code><Copy text={url} what="MCP URL" /></> : <span className="muted">{desktop ? 'Loading…' : 'None: nothing listens on the network'}</span>}
            </span>
            {desktop && cfg && !mcpOff && (
              <small className={cx(tokensOptional ? 'set-warn' : 'muted')}>
                {tokensOptional
                  ? <>Agent tokens aren't required: a request without one writes as “Agent”. <Link to={{ hash: 'instance' }}>Change</Link></>
                  : <>Each agent sends its token (<code>Authorization: Bearer …</code>).{cfg.restApi && ' The REST API is on this port too.'}</>}
              </small>
            )}
          </span>
        </div>
        <div className="set-row top">
          <span className="set-l">Added agents<small>Revoked ones stay listed: what they wrote is still theirs.</small></span>
          <span className="set-c grow stack">
            {agents.isError ? <span className="muted">Couldn't load agents: {(agents.error as Error).message}</span>
              : !agents.data ? <span className="muted">Loading…</span>
                : list.length ? (
                  <ul className="trk-list">
                    {list.map((a) => (
                      <AgentRow key={a.id} a={a} now={now} onNewToken={desktop ? (x) => { setShown(null); setAdding(false); setRenewing(x); } : undefined}
                        onRevoke={desktop ? revokeAgent : undefined} />
                    ))}
                  </ul>
                ) : <span className="muted">None yet.</span>}
          </span>
        </div>
      </div>
      {shown && url && <TokenPanel shown={shown} url={url} onDone={() => setShown(null)} />}
      {desktop ? (
        renewing ? <NewToken key={renewing.id} agent={renewing} onMade={show} onCancel={() => setRenewing(null)} />
          : !shown && (adding
            ? <AddAgent agents={list} portOff={portOff} onAdded={show} onCancel={() => setAdding(false)} />
            : (
              <div className="set-actions">
                <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" />Add agent</button>
              </div>
            ))
      ) : (
        <p className="set-foot muted">
          Agents are added where the server runs: <code>node dist/server/index.mjs agents add &lt;name&gt;</code> prints the
          new agent's token once (<code>--token-stdin</code> takes one of yours); <code>agents list</code> shows them,{' '}
          <code>agents regenerate &lt;name&gt;</code> makes one a new token, and <code>agents revoke &lt;name&gt;</code> stops it.
        </p>
      )}
    </section>
  );
}
