/**
 * Settings → Agents (`/settings#agents`): the coding agents that read and write comments here through MCP, each with a
 * token of its own and the sources it may reach, and how to connect one. The desktop app adds agents, makes new tokens,
 * chooses their sources, disables and enables them, and deletes them. A token is shown when it's made, with
 * ready-to-paste config, and the app keeps it (encrypted with the OS keychain, when there is one) to show it again. A
 * headless server does that with its `agents` command, showing a token once, and lists them here.
 */
import { Fragment, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router';
import { agentDeletionSentences } from '../../../shared/agents';
import type { Agent } from '../../../shared/api';
import { useAgentActions, useDesktop } from '../api/desktop';
import { useAgents, useInstance, useSources, useWorkSources } from '../api/hooks';
import { Icon } from '../components/Icon';
import { useToast } from '../workbench';
import { useUI } from '../components/ui';
import { bridgeError } from '../lib/account';
import {
  type AgentSource, agentConfig, agentNameProblem, agentReach, agentsShown, agentTokenProblem, generateAgentToken, pickedSources, pickOf, type SourcePick,
  sourceLabel,
} from '../lib/agents';
import { hostNames } from '../lib/sources';
import { fmtDateTime, relLong } from '../lib/time';
import { copyText, cx, useNow } from '../lib/util';

/**
 * A token on show: one just made ('added', 'new'), which the app kept to show again or not (`kept`), or one it kept,
 * shown again ('kept'; null when it has none). `enabled`: adding it turned MCP on (what it says then).
 */
interface Shown { agent: Agent; token: string | null; kind: 'added' | 'new' | 'kept'; kept?: boolean; enabled?: string }

function Copy({ text, what, className = 'wb-btn wb-btn--sm' }: { text: string; what: string; className?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={className} onClick={async () => toast((await copyText(text)) ? `${what} copied` : 'Copy failed')} title={`Copy ${what.toLowerCase()}`}
      aria-label={`Copy ${what.toLowerCase()}`}>
      <Icon name="copy" /><span className="lbl">Copy</span>
    </button>
  );
}

/**
 * What an agent reaches through MCP: after its status, or (the desktop app) as the button that changes it, beside its
 * other actions.
 */
function Reach({ a, known, onSources }: { a: Agent; known: readonly AgentSource[]; onSources?: (a: Agent) => void }) {
  const text = agentReach(a.sources, known);
  const title = a.sources === null
    ? 'It reaches every source through MCP, those added later too'
    : "Through MCP it reaches these sources only: to it, the others' repositories and threads don't exist";
  const className = cx('agent-reach', a.sources !== null && 'some');
  if (!onSources) return <span className={className} title={title}>{text}</span>;
  return (
    <button type="button" className={cx('wb-btn wb-btn--sm wb-btn--ghost', className)} onClick={() => onSources(a)} title={`${title}. Choose which…`}
      aria-label={`Sources of ${a.name}: ${text}. Choose which`}>
      {text}
    </button>
  );
}

/**
 * One agent: its name, token prefix, when it was added and last used (or disabled), and the sources it reaches; the
 * desktop app's actions.
 */
function AgentRow({ a, now, known, onSources, onShowToken, onNewToken, onToggle, onDelete }: {
  a: Agent;
  now: number;
  known: readonly AgentSource[];
  onSources?: (a: Agent) => void;
  onShowToken?: (a: Agent) => void;
  onNewToken?: (a: Agent) => void;
  onToggle?: (a: Agent) => void;
  onDelete?: (a: Agent) => void;
}) {
  const disabled = !!a.disabledAt;
  // The desktop app's is a button, with the other actions; a server's, text after the status.
  const reach = <Reach a={a} known={known} onSources={onSources} />;
  if (a.builtIn) {
    return (
      <li className={cx('trk-row agent-row', onSources && 'acts')}>
        <span className="trk-name" title={a.name}>{a.name}</span>
        <span className="agent-prefix" title="MCP requests without a token act as it, while agent tokens aren't required">no token</span>
        <span className="trk-st agent-st">Built in: requests without a token</span>
        {!onSources && reach}
        <span className="spacer" />
        {onSources && reach}
      </li>
    );
  }
  return (
    <li className={cx('trk-row agent-row', disabled && 'disabled', (onSources || onShowToken || onNewToken || onToggle || onDelete) && 'acts')}>
      <span className="trk-name" title={a.name}>{a.name}</span>
      {a.tokenPrefix && <code className="agent-prefix" title="The token's first characters, to tell tokens apart">{a.tokenPrefix}…</code>}
      <span className="trk-st agent-st" title={[`Added ${fmtDateTime(a.createdAt)}`, a.lastUsedAt && `last used ${fmtDateTime(a.lastUsedAt)}`, a.disabledAt && `disabled ${fmtDateTime(a.disabledAt)}`].filter(Boolean).join(', ')}>
        {disabled ? `Disabled ${relLong(a.disabledAt!, now)}` : a.lastUsedAt ? `Used ${relLong(a.lastUsedAt, now)}` : `Added ${relLong(a.createdAt, now)} · not used yet`}
      </span>
      {!onSources && reach}
      <span className="spacer" />
      {onSources && reach}
      {onShowToken && (
        <button type="button" className="wb-btn wb-btn--sm wb-btn--ghost" onClick={() => onShowToken(a)} aria-label={`Show ${a.name}'s token`}
          title="Its token again, with the lines to set it up">
          Show token
        </button>
      )}
      {onNewToken && (
        <button type="button" className="wb-btn wb-btn--sm wb-btn--ghost" onClick={() => onNewToken(a)}
          title={disabled ? 'Replace its token, and enable it: it can write here again with the new one' : 'Replace its token'}>
          New token…
        </button>
      )}
      {onToggle && (
        <button type="button" className="wb-btn wb-btn--sm wb-btn--ghost" onClick={() => onToggle(a)} aria-label={`${disabled ? 'Enable' : 'Disable'} ${a.name}`}
          title={disabled
            ? 'Accept its token again. If it may have leaked, give it a new token instead'
            : 'Refuse its token until you enable it again. Its token, sources and comments stay'}>
          {disabled ? 'Enable' : 'Disable'}
        </button>
      )}
      {onDelete && (
        <button type="button" className="wb-btn wb-btn--sm wb-btn--ghost" onClick={() => onDelete(a)} aria-label={`Delete ${a.name}…`}
          title="Delete it: its token stops working and its name is free again. What it wrote stays">
          Delete…
        </button>
      )}
    </li>
  );
}

/**
 * The token, with what to paste into Claude Code or Codex: when it's made (once, unless the app kept it), or again (Show
 * token). A token the app didn't keep can't be shown again: New token… makes one that can.
 */
function TokenPanel({ shown, url, keychain, onNewToken, onDone }: { shown: Shown; url: string; keychain: boolean; onNewToken: () => void; onDone: () => void }) {
  if (shown.token === null) {
    return (
      <div className="agent-token" role="region" aria-label={`${shown.agent.name}'s token`}>
        <p className="agent-token-h">
          <Icon name="key" />
          <span>
            <b>{shown.agent.name}</b>'s token wasn't kept (made before gh-dash kept tokens, or on this device it can't).
            New token… makes one you can see again.
          </span>
        </p>
        <div className="set-actions">
          <button type="button" className="wb-btn" onClick={onNewToken}>New token…</button>
          <button type="button" className="wb-btn" onClick={onDone}>Close</button>
        </div>
      </div>
    );
  }
  const c = agentConfig(url, shown.token);
  const what = shown.kind === 'new' ? "'s new token" : "'s token";
  const told = shown.kind === 'kept'
    ? ' · kept on this device, encrypted with the OS keychain.'
    : shown.kept ? ' · kept on this device: Show token shows it again.' : ' · shown only this once: copy it now.';
  return (
    <div className="agent-token" role="region" aria-label={`${shown.agent.name}'s token`}>
      <p className="agent-token-h">
        <Icon name="key" />
        <span><b>{shown.agent.name}</b>{what}{told}{shown.kind === 'new' && ' The old one no longer works.'}</span>
      </p>
      {shown.kind !== 'kept' && !shown.kept && !keychain && (
        <small className="muted">No OS keychain is available, so gh-dash can't keep it to show again.</small>
      )}
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
        <button type="button" className="wb-btn" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

/** The token field: pre-filled with a generated token, which Generate replaces; or the user's own. */
function TokenField({ id, value, onChange, problem }: { id: string; value: string; onChange: (v: string) => void; problem: string | null }) {
  return (
    <span className="agent-token-field">
      <label className="sr-only" htmlFor={id}>Token</label>
      <input id={id} className="wb-input agent-token-in" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false}
        autoComplete="off" aria-invalid={problem ? true : undefined} title="Generated here; or paste your own (24–256 printable characters, no spaces)" />
      <button type="button" className="wb-btn" onClick={() => onChange(generateAgentToken())} title="A new random token"><Icon name="sync" />Generate</button>
    </span>
  );
}

/**
 * Which sources an agent may reach: all of them (those added later too), or only those checked. Unchecking a source
 * while "All" is picked picks the others ("Only"), as unchecking it from all of them would.
 */
function SourcesPicker({ id, known, pick, onChange }: { id: string; known: readonly AgentSource[]; pick: SourcePick; onChange: (p: SourcePick) => void }) {
  const toggle = (host: string, on: boolean) => {
    const from = pick.all ? known.map((s) => s.host) : pick.hosts;
    onChange({ all: false, hosts: on ? [...from.filter((h) => h !== host), host] : from.filter((h) => h !== host) });
  };
  return (
    <span className="agent-src-pick" role="group" aria-labelledby={`${id}-l`}>
      <span className="agent-src-l" id={`${id}-l`}>Sources</span>
      <span className="src-methods" role="radiogroup" aria-labelledby={`${id}-l`}>
        <label className="src-method" title="Every source, those added later too">
          <input type="radio" className="repo-check" name={`${id}-reach`} checked={pick.all} onChange={() => onChange({ ...pick, all: true })} />
          All
        </label>
        <label className="src-method">
          <input type="radio" className="repo-check" name={`${id}-reach`} checked={!pick.all}
            onChange={() => onChange({ all: false, hosts: pick.hosts.length ? pick.hosts : known.map((s) => s.host) })} />
          Only:
        </label>
      </span>
      <span className="src-methods">
        {known.map((s) => {
          const { name, host } = sourceLabel(s);
          return (
            <label key={s.host} className={cx('src-method', pick.all && 'muted')}>
              <input type="checkbox" className="repo-check" checked={pick.all || pick.hosts.includes(s.host)} onChange={(e) => toggle(s.host, e.target.checked)} />
              {name}{host && <small className="muted">{host}</small>}
            </label>
          );
        })}
      </span>
    </span>
  );
}

/** Add agent: a name, its token (generated, or the user's own) and the sources it may reach. */
function AddAgent({ agents, known, portOff, onAdded, onCancel }: {
  agents: readonly Agent[];
  known: readonly AgentSource[];
  portOff: boolean;
  onAdded: (s: Shown) => void;
  onCancel: () => void;
}) {
  const { add } = useAgentActions();
  const [name, setName] = useState('');
  const [token, setToken] = useState(generateAgentToken);
  const [pick, setPick] = useState(() => pickOf(null));
  const [tried, setTried] = useState(false);
  const problem = agentNameProblem(name, agents);
  const tokenProblem = agentTokenProblem(token);
  const picked = pickedSources(pick, known);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem || tokenProblem || picked.problem || add.isPending) return;
    add.mutate({ name: name.trim(), token, sources: picked.sources }, {
      onSuccess: (r) => onAdded({
        ...r, kind: 'added',
        enabled: r.enabledMcp ? (portOff ? 'The Local API is now on, for agents only: MCP on, the REST API off.' : 'MCP is now on, on the Local API.') : undefined,
      }),
    });
  };
  const err = (tried && (problem ?? (tokenProblem && `Token: ${tokenProblem}`) ?? picked.problem)) || (add.error ? bridgeError(add.error) : null);
  const escape = (e: ReactKeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
  return (
    <form className="agent-add" onSubmit={submit} onKeyDown={escape}>
      <label className="sr-only" htmlFor="agent-name">Agent name</label>
      <input id="agent-name" className="wb-input" value={name} placeholder="Name, e.g. Claude" autoFocus autoComplete="off" maxLength={80}
        onChange={(e) => setName(e.target.value)} aria-invalid={tried && problem ? true : undefined} aria-describedby={err ? 'agent-add-err' : undefined} />
      <TokenField id="agent-token" value={token} onChange={setToken} problem={tried ? tokenProblem : null} />
      <SourcesPicker id="agent-add-src" known={known} pick={pick} onChange={setPick} />
      <button type="submit" className="wb-btn wb-btn--primary" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add'}</button>
      <button type="button" className="wb-btn" onClick={onCancel} disabled={add.isPending}>Cancel</button>
      {err && <span id="agent-add-err" className="wb-form-error" role="alert">{err}</span>}
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
        New token for <b>{agent.name}</b>. {agent.disabledAt ? `${agent.name} is enabled with it, and can write here again.` : 'The one it uses now stops working at once.'}
      </p>
      <TokenField id="agent-new-token" value={token} onChange={setToken} problem={problem} />
      <button type="submit" className="wb-btn wb-btn--primary" disabled={regenerate.isPending || !!problem}>Make new token</button>
      <button type="button" className="wb-btn" onClick={onCancel} disabled={regenerate.isPending}>Cancel</button>
      {err && <span className="wb-form-error" role="alert">{err}</span>}
    </form>
  );
}

/** An agent's sources button: which sources it (the built-in one too) may reach, from its next request. */
function AgentSources({ agent, known, onDone, onCancel }: { agent: Agent; known: readonly AgentSource[]; onDone: (a: Agent) => void; onCancel: () => void }) {
  const { setSources } = useAgentActions();
  const [pick, setPick] = useState(() => pickOf(agent.sources));
  const picked = pickedSources(pick, known);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (picked.problem || setSources.isPending) return;
    setSources.mutate({ id: agent.builtIn ? 'built-in' : agent.id, sources: picked.sources }, { onSuccess: onDone });
  };
  const err = picked.problem ?? (setSources.error ? bridgeError(setSources.error) : null);
  return (
    <form className="agent-add agent-new" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      aria-label={`Sources for ${agent.name}`}>
      <p className="agent-new-h">
        The sources <b>{agent.name}</b> may reach through MCP{agent.builtIn && ' (requests without a token)'}. To it, the others'
        repositories and threads don't exist. It applies from its next request.
      </p>
      <SourcesPicker id="agent-src" known={known} pick={pick} onChange={setPick} />
      <button type="submit" className="wb-btn wb-btn--primary" disabled={setSources.isPending || !!picked.problem}>Save</button>
      <button type="button" className="wb-btn" onClick={onCancel} disabled={setSources.isPending}>Cancel</button>
      {err && <span className="wb-form-error" role="alert">{err}</span>}
    </form>
  );
}

export function AgentsSection() {
  const agents = useAgents();
  const { bridge, state } = useDesktop();
  const instance = useInstance().data;
  const { setEnabled, footprint, remove, keptToken, enableMcp } = useAgentActions();
  const { openConfirm } = useUI();
  const toast = useToast();
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<Agent | null>(null);
  const [scoping, setScoping] = useState<Agent | null>(null);
  const known: AgentSource[] = useSources().data ?? [];
  const [shown, setShown] = useState<Shown | null>(null);
  const desktop = !!bridge;
  const cfg = state?.config;
  // The desktop app's agents reach it on this computer, at the Local API's port: a URL that doesn't change when the app
  // restarts (or while MCP is off for a while). A server: its own.
  const url = desktop ? (cfg ? `http://127.0.0.1:${cfg.port}/mcp` : null) : (instance?.mcpUrl ?? null);
  const portOff = !!cfg && !cfg.listen;
  const mcpOff = !!cfg && (!cfg.listen || !cfg.mcp);
  const tokensOptional = !!cfg && cfg.listen && cfg.mcp && !cfg.mcpRequireTokens;
  // The built-in agent too while requests without a token act as it, so its sources can be chosen before it acts.
  const list = agentsShown(agents.data ?? [], tokensOptional);

  const turnOn = () => enableMcp.mutate(undefined, {
    onSuccess: (st) => toast(st.mcpUrl ? (portOff ? 'Local API on, for agents only' : 'MCP on') : `Couldn't turn it on${st.serverError ? `: ${st.serverError}` : ''}`, { tone: st.mcpUrl ? 'default' : 'error' }),
    onError: (e) => toast(bridgeError(e), { tone: 'error' }),
  });
  // Disable / Enable: at once, nothing to confirm (it's undone the same way).
  const toggleAgent = (a: Agent) => setEnabled.mutate({ id: a.id, enabled: !!a.disabledAt }, {
    onSuccess: (x) => toast(x.disabledAt ? `${x.name} disabled` : `${x.name} enabled`),
    onError: (e) => toast(bridgeError(e), { tone: 'error' }),
  });
  // Delete…: what it wrote first (asked now: it changes with every comment), then the confirmation that says so.
  const deleteAgent = async (a: Agent) => {
    let f;
    try {
      f = await footprint(a.id);
    } catch (e) {
      toast(bridgeError(e), { tone: 'error' });
      return;
    }
    // The quoted name ("Deleted agent #4") on one line.
    const sentences = agentDeletionSentences({ id: a.id, disabled: !!a.disabledAt }, f).map((x) => ({ ...x, text: x.text.replace(/“[^”]*”/g, (q) => q.replace(/ /g, '\u00a0')) }));
    openConfirm({
      title: `Delete ${a.name}?`,
      body: sentences.map((x, i) => (
        <Fragment key={i}>{i > 0 && ' '}{x.stress ? <span className="confirm-stress">{x.text}</span> : x.text}</Fragment>
      )),
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await remove.mutateAsync(a.id).catch((e: unknown) => { throw new Error(bridgeError(e)); });
        if (shown?.agent.id === a.id) setShown(null);
        if (renewing?.id === a.id) setRenewing(null);
        if (scoping?.id === a.id) setScoping(null);
        toast(`${a.name} deleted`);
      },
    });
  };
  const show = (s: Shown) => { setAdding(false); setRenewing(null); setScoping(null); setShown(s); };
  // Show token: the one the app kept, if it still is this agent's.
  const showToken = async (a: Agent) => {
    let token: string | null;
    try {
      token = await keptToken(a.id);
    } catch (e) {
      toast(bridgeError(e), { tone: 'error' });
      return;
    }
    show({ agent: a, token, kind: 'kept' });
  };
  const scoped = (a: Agent) => { setScoping(null); toast(`${a.name}: ${agentReach(a.sources, known)}`); };

  return (
    <section className="card set-sec" id="agents">
      <h2>Agents</h2>
      <p>
        Coding agents such as Claude Code or Codex read and write comments here through MCP, each with a token of its own.
        What an agent writes is marked as its own, and stays here: nothing is posted to {hostNames(useWorkSources()).replace(' and ', ' or ') || 'GitHub'}.
        An agent reaches every source, or only those you choose: to it, the others' repositories and threads don't exist.
        The REST API isn't limited: it's yours.
      </p>
      {mcpOff && !shown && (
        <div className="set-note agent-off">
          <span>
            {portOff ? "The Local API is off, so agents can't reach gh-dash." : "MCP is off on the Local API, so agents can't reach gh-dash."}
            {' '}Adding an agent turns it on too.
          </span>
          <button type="button" className="wb-btn wb-btn--sm" onClick={turnOn} disabled={enableMcp.isPending}>
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
          <span className="set-l">Added agents<small>Disabled ones stay listed. What a deleted one wrote stays, as by “Deleted agent #…”.</small></span>
          <span className="set-c grow stack">
            {agents.isError ? <span className="muted">Couldn't load agents: {(agents.error as Error).message}</span>
              : !agents.data ? <span className="muted">Loading…</span>
                : list.length ? (
                  <ul className="trk-list agent-list">
                    {list.map((a) => (
                      <AgentRow key={a.id} a={a} now={now} known={known}
                        onSources={desktop ? (x) => { setShown(null); setAdding(false); setRenewing(null); setScoping(x); } : undefined}
                        onShowToken={desktop ? (x) => void showToken(x) : undefined}
                        onNewToken={desktop ? (x) => { setShown(null); setAdding(false); setScoping(null); setRenewing(x); } : undefined}
                        onToggle={desktop ? toggleAgent : undefined} onDelete={desktop ? (x) => void deleteAgent(x) : undefined} />
                    ))}
                  </ul>
                ) : <span className="muted">None yet.</span>}
          </span>
        </div>
      </div>
      {shown && url && (
        <TokenPanel shown={shown} url={url} keychain={state?.secureStorage === 'available'} onDone={() => setShown(null)}
          onNewToken={() => { const a = shown.agent; setShown(null); setRenewing(a); }} />
      )}
      {desktop ? (
        renewing ? <NewToken key={renewing.id} agent={renewing} onMade={show} onCancel={() => setRenewing(null)} />
          : scoping ? <AgentSources key={scoping.id} agent={scoping} known={known} onDone={scoped} onCancel={() => setScoping(null)} />
          : !shown && (adding
            ? <AddAgent agents={list} known={known} portOff={portOff} onAdded={show} onCancel={() => setAdding(false)} />
            : (
              <div className="set-actions">
                <button type="button" className="wb-btn" onClick={() => setAdding(true)}><Icon name="plus" />Add agent</button>
              </div>
            ))
      ) : (
        <p className="set-foot muted">
          Agents are added where the server runs: <code>node dist/server/index.mjs agents add &lt;name&gt;</code> prints the
          new agent's token once (<code>--token-stdin</code> takes one of yours, <code>--source &lt;host&gt;</code> limits it to
          that source); <code>agents list</code> shows them, <code>agents regenerate &lt;name&gt;</code> makes one a new
          token, <code>agents scope &lt;name&gt; --source &lt;host&gt;</code> (or <code>--all</code>) chooses its sources,{' '}
          <code>agents disable &lt;name&gt;</code> stops it until <code>agents enable &lt;name&gt;</code>, and{' '}
          <code>agents delete &lt;name&gt;</code> deletes it, keeping what it wrote.
        </p>
      )}
    </section>
  );
}
