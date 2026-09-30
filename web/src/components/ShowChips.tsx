/**
 * What agents ask the window to look at (MCP `show`), as quiet chips in the bottom-right corner: "Claude wants to show
 * you host.ts:42–44 on app#17", the agent's message, Open and Dismiss, and the Follow agents switch. A chip never takes
 * focus (it is announced), hides after half a minute unless the pointer or focus is on it, and a few stack. Following
 * agents, the window opens what they show at once, unless you're typing or in a dialog; its chip only says so.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ShowTarget } from '../../../shared/api';
import { repoPath } from '../../../shared/repos';
import { qk, useThreads } from '../api/hooks';
import { isTypingTarget } from '../lib/layers';
import { dismissChip, pushChip, showDiffId, showPatch, showPhrase, showWhat, useFollowAgents, useShowChips } from '../lib/show';
import type { ShowChip, ShowMessage } from '../lib/show';
import { contextSearch, useUrlState } from '../lib/urlState';
import { cx } from '../lib/util';
import { Avatar } from './Avatar';
import { AgentMark } from './bits';
import { Icon } from './Icon';
import { useProviderOf, useRepoLabel } from './repoMapContext';

/** A chip stays this long, and one that says the window followed, less. */
const CHIP_MS = 30_000;
const OPENED_MS = 10_000;

/** Open a target over the view you're on (or a repo's page), and hand focus to the diff when the chip had it. */
export function useOpenShown(): (target: ShowTarget) => Promise<void> {
  const { s, set, navigate, location } = useUrlState();
  const qc = useQueryClient();
  const latest = useRef({ s, set, navigate, search: location.search });
  latest.current = { s, set, navigate, search: location.search };
  return useCallback(async (target: ShowTarget) => {
    const patch = showPatch(target, latest.current.s);
    if (!patch) {
      latest.current.navigate(repoPath(target.repo) + contextSearch(latest.current.search));
      return;
    }
    // The diff already open goes to the thread in place, once its threads are in (the agent may have just made it).
    if (target.threadId && latest.current.s.diff === patch.diff) await qc.refetchQueries({ queryKey: qk.threads(patch.diff!), type: 'active' });
    latest.current.set(patch);
  }, [qc]);
}

/** Whether following may open something now: not while you type, and not over a dialog. */
const mayFollow = () => !isTypingTarget(document.activeElement) && !document.querySelector('[aria-modal="true"], .modal, .palette');

/** The stream's `show` messages: a chip, or (following agents) the place opened at once with a chip saying so. */
export function useShowHandler(): (msg: ShowMessage) => void {
  const open = useOpenShown();
  const [follow] = useFollowAgents();
  const latest = useRef({ open, follow });
  latest.current = { open, follow };
  return useCallback((msg: ShowMessage) => {
    const opened = latest.current.follow && mayFollow();
    if (opened) void latest.current.open(msg.target);
    pushChip({ id: msg.id, agent: msg.agent, target: msg.target, message: msg.message, at: msg.at, opened });
  }, []);
}

export function ShowChips() {
  const chips = useShowChips();
  const [said, setSaid] = useState('');
  return (
    <>
      {chips.length > 0 && (
        <section className="show-host" aria-label="Agents">
          {chips.map((c, i) => <Chip key={c.id} chip={c} last={i === chips.length - 1} onSay={setSaid} />)}
        </section>
      )}
      {/* Announced, not focused: the newest chip's sentence (a live region must be there before what it announces). */}
      <div className="sr-only" aria-live="polite">{said}</div>
    </>
  );
}

/** `last`: the newest, which carries the Follow agents switch (once for the stack). */
function Chip({ chip, last, onSay }: { chip: ShowChip; last: boolean; onSay: (text: string) => void }) {
  const t = chip.target;
  const label = useRepoLabel();
  const providerOf = useProviderOf();
  const open = useOpenShown();
  const [follow, setFollow] = useFollowAgents();
  const box = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  // The thread's lines, from its target's threads (a local read; the diff would load them anyway).
  const diff = showDiffId(t);
  const threads = useThreads(t.threadId ? diff : null);
  const thread = t.threadId ? threads.data?.find((x) => x.id === t.threadId) : null;
  const w = showWhat(t, { label: label(t.repo), prRef: providerOf(t.repo).prRef, thread });
  const what = showPhrase(w);
  const dismiss = useCallback(() => dismissChip(chip.id), [chip.id]);
  const sentence = `${chip.agent.name} ${chip.opened ? 'showed you' : 'wants to show you'} ${what}${chip.message ? `: ${chip.message}` : ''}`;
  const said = useRef(false);
  useEffect(() => {
    if (said.current) return;
    said.current = true;
    onSay(sentence);
  }, [sentence, onSay]);

  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(dismiss, chip.opened ? OPENED_MS : CHIP_MS);
    return () => clearTimeout(timer);
  }, [held, chip.opened, dismiss]);

  const hadFocus = () => !!box.current?.contains(document.activeElement);
  const onOpen = () => {
    const focus = hadFocus();
    dismiss();
    void open(t).then(() => {
      // The chip is gone: hand focus to the diff (or the page) rather than to nothing.
      if (focus) requestAnimationFrame(() => (document.querySelector<HTMLElement>('.diff-view .dv-body') ?? document.querySelector<HTMLElement>('main .scroll'))?.focus({ preventScroll: true }));
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };

  const name = chip.agent.name;
  return (
    <div ref={box} className={cx('show-chip', chip.opened && 'opened')} onKeyDown={onKey}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(hadFocus())}
      onFocus={() => setHeld(true)} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) setHeld(false); }}>
      <div className="show-l">
        <Avatar actor={{ login: null, name, avatarUrl: null, isMe: false }} size={18} />
        <p className="show-t">
          <b>{name}</b><AgentMark />{' '}
          {chip.opened ? 'showed you' : 'wants to show you'}{' '}
          {w.place && <><span className="show-where" title={w.path ?? undefined}>{w.place}</span> on </>}
          <span className="show-on">{w.on}</span>
        </p>
      </div>
      {chip.message && <p className="show-msg">{chip.message}</p>}
      <div className="show-acts">
        {!chip.opened && <button type="button" className="btn sm" onClick={onOpen}><Icon name="diff" />Open</button>}
        <button type="button" className="btn sm ghost" onClick={dismiss}>Dismiss</button>
        <span className="spacer" />
        {last && (
          <label className="show-follow" title="Open what agents show at once, in this browser">
            <input type="checkbox" className="switch sm" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow agents
          </label>
        )}
      </div>
    </div>
  );
}
