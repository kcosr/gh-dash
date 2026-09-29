/**
 * Comment threads in the diff viewer: a thread card (inline under its lines, in a file's Outdated block, or in the
 * comments column), its comments and the composer. Small and quiet on purpose: UI type at the viewer's size, the
 * app's tokens, text buttons. Everything the cards need comes from ThreadsCtx, which DiffViewer provides.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { CommentThread, Me, ThreadComment } from '../../../shared/api';
import type { ThreadPlacement } from '../../../shared/comment-placement';
import type { useThreadActions } from '../api/hooks';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toasts';
import { useLayer } from '../lib/layers';
import { plainPreview } from '../lib/markdown';
import { fmtDateTime, plural, rel } from '../lib/time';
import { copyText, cx } from '../lib/util';
import { getDraft, loadNewDraft, setDraft, setNewDraftBody } from './drafts';
import type { DraftAnchor, DraftSpot } from './threadModel';

export type ThreadActions = ReturnType<typeof useThreadActions>;

export interface ThreadsState {
  byId: ReadonlyMap<number, CommentThread>;
  placements: ReadonlyMap<number, ThreadPlacement>;
  actions: ThreadActions;
  me: Me | undefined;
  /** The thread in focus (URL `thread`). */
  focused: number | null;
  /** Focus a thread (null: none); `scroll` also brings it into view. */
  focus: (id: number | null, opts?: { scroll?: boolean }) => void;
  /** Resolved threads the reader opened; the rest stay one line. */
  expanded: ReadonlySet<number>;
  setExpanded: (id: number, open: boolean) => void;
  /** Prefix for this diff's draft keys. */
  draftScope: string;
  /** The new thread being written, if any (one at a time): its record's key, its anchor, and where it shows now. */
  draftKey: string | null;
  draft: DraftAnchor | null;
  draftSpot: DraftSpot;
  /** Cancel: the draft goes (Esc, closeDraft, only sets it aside). */
  discardDraft: () => void;
  submitDraft: (body: string) => Promise<unknown>;
  closeDraft: () => void;
  /** Files whose Outdated block is open. */
  outdatedOpen: ReadonlySet<string>;
  setOutdatedOpen: (path: string, open: boolean) => void;
  /** `r`: the thread whose reply box should open (and take focus); its card takes it with takeReply. */
  replyRequest: number | null;
  takeReply: () => void;
}

export const ThreadsCtx = createContext<ThreadsState | null>(null);
export const useThreadsState = () => useContext(ThreadsCtx)!;

/** "path:12–14", "path" or "General": where a thread was made. */
export function threadWhere(t: CommentThread): string {
  if (t.path === null) return 'General';
  if (t.startLine === null) return t.path;
  return `${t.path}:${t.startLine === t.endLine ? t.startLine : `${t.startLine}–${t.endLine}`}`;
}

function Author({ c }: { c: ThreadComment }) {
  const { me } = useThreadsState();
  const self = c.author.kind === 'self';
  const actor = self
    ? { login: me?.login ?? null, name: me?.name ?? me?.login ?? 'You', avatarUrl: null, isMe: true }
    : { login: null, name: c.author.name, avatarUrl: null, isMe: false };
  return (
    <>
      <Avatar actor={actor} size={16} />
      <b className="dth-who">{self ? 'You' : c.author.name}</b>
      {!self && <span className="dth-agent" title="Written by an agent through the API">agent</span>}
    </>
  );
}

/** Where a composer keeps its unsent text. */
export interface TextStore {
  load: () => string;
  /** '' when there's nothing to keep. */
  save: (text: string) => void;
}

/** The default: sessionStorage under a key (drafts.ts). */
const keyStore = (key: string): TextStore => ({ load: () => getDraft(key), save: (text) => setDraft(key, text) });

/**
 * A markdown textarea with Comment / Cancel. Its text is a draft (under `draftKey`, or in `store`) until sent, so
 * scrolling the composer away (the viewer is virtualized) or reloading loses nothing. Mod+Enter sends; Esc closes
 * it and keeps the draft, Cancel discards it (`onDiscard`, when discarding is more than forgetting the text).
 */
export function Composer({ draftKey, store: given, initial = '', placeholder, submitLabel, onSubmit, onClose, onDiscard, autoFocus = true, focusKey = 0 }: {
  draftKey?: string;
  store?: TextStore;
  initial?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<unknown>;
  onClose: () => void;
  onDiscard?: () => void;
  autoFocus?: boolean;
  /** A change focuses the textarea again (`r` on a thread whose reply box is already open). */
  focusKey?: number;
}) {
  const [store] = useState(() => given ?? keyStore(draftKey!));
  const [text, setText] = useState(() => store.load() || initial);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  useLayer(true, onClose);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  // Inline, Pierre slots the composer into its annotation row a frame or more after React mounts it, and an element
  // that isn't rendered yet can't take focus: try until it does.
  useEffect(() => {
    if (!autoFocus) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const el = area.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (document.activeElement === el) el.setSelectionRange(el.value.length, el.value.length);
      else if (++tries < 30) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, focusKey]);
  // Back at the starting text (all of it deleted, or an edit undone) there's nothing to keep.
  const change = (v: string) => {
    setText(v);
    store.save(v === initial ? '' : v);
  };
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text);
      store.save('');
      onClose();
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, { error: true });
      setBusy(false);
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <div className="dth-composer">
      <textarea
        ref={area}
        value={text}
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="dth-composer-bar">
        <span className="dth-hint">Markdown · <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd> <kbd>Enter</kbd></span>
        <span className="spacer" />
        <button type="button" className="dth-btn" onClick={() => { if (onDiscard) onDiscard(); else { store.save(''); onClose(); } }} disabled={busy}>Cancel</button>
        <button type="button" className="dth-btn primary" onClick={() => void submit()} disabled={busy || !text.trim()}>{submitLabel}</button>
      </div>
    </div>
  );
}

function CommentRow({ thread, c, first }: { thread: CommentThread; c: ThreadComment; first: boolean }) {
  const { actions, draftScope } = useThreadsState();
  const toast = useToast();
  const editKey = `${draftScope}|edit|${c.id}`;
  const [editing, setEditing] = useState(() => getDraft(editKey) !== '');
  const [confirm, setConfirm] = useState(false);
  const replies = thread.comments.length - 1;
  const remove = async () => {
    try {
      await actions.deleteComment(thread.id, c.id);
    } catch (e) {
      toast(`Couldn't delete: ${(e as Error).message}`, { error: true });
    }
  };
  return (
    <div className="dth-c" data-comment={c.id}>
      <div className="dth-c-head">
        <Author c={c} />
        <time dateTime={c.createdAt} title={fmtDateTime(c.createdAt)}>{rel(c.createdAt)}</time>
        {c.editedAt && <span className="dth-edited" title={`Edited ${fmtDateTime(c.editedAt)}`}>edited</span>}
        <span className="spacer" />
        {!editing && !confirm && (
          <span className="dth-c-acts">
            {c.author.kind === 'self' && <button type="button" className="dth-btn" onClick={() => setEditing(true)}>Edit</button>}
            <button type="button" className="dth-btn" onClick={() => (first && replies > 0 ? setConfirm(true) : void remove())}>Delete</button>
          </span>
        )}
      </div>
      {confirm && (
        <div className="dth-confirm" role="alert">
          <span>Delete this thread and its {replies} {plural(replies, 'reply', 'replies')}?</span>
          <button type="button" className="dth-btn danger" onClick={() => void remove()}>Delete thread</button>
          <button type="button" className="dth-btn" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
      {editing
        ? <Composer draftKey={editKey} initial={c.body} placeholder="Edit comment" submitLabel="Save" onSubmit={(body) => actions.edit(c.id, body)} onClose={() => setEditing(false)} />
        : <Markdown source={c.body} className="md dth-md" />}
    </div>
  );
}

/**
 * One thread: its comments, then Reply and Resolve. A resolved thread is one line until opened (or focused).
 * `snippet` shows the lines it was made on, for threads whose lines aren't on screen (outdated, or in the column).
 */
export function ThreadCard({ thread, snippet = false, note }: { thread: CommentThread; snippet?: boolean; note?: ReactNode }) {
  const s = useThreadsState();
  const toast = useToast();
  const replyKey = `${s.draftScope}|reply|${thread.id}`;
  const [replying, setReplying] = useState(() => getDraft(replyKey) !== '');
  const [replyFocus, setReplyFocus] = useState(0);
  const { replyRequest, takeReply } = s;
  useEffect(() => {
    if (replyRequest !== thread.id) return;
    takeReply();
    setReplying(true);
    setReplyFocus((n) => n + 1);
  }, [replyRequest, takeReply, thread.id]);
  const resolved = thread.status === 'resolved';
  const focused = s.focused === thread.id;
  const open = !resolved || s.expanded.has(thread.id) || focused;
  const first = thread.comments[0]!;
  const setStatus = async (status: 'open' | 'resolved') => {
    try {
      await s.actions.setStatus(thread.id, status);
      if (status === 'resolved') s.setExpanded(thread.id, false);
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, { error: true });
    }
  };
  if (!open) {
    return (
      <div className="dth resolved" data-thread={thread.id}>
        <button type="button" className="dth-sum" onClick={() => { s.setExpanded(thread.id, true); s.focus(thread.id); }} title="Show the resolved thread">
          <Icon name="check" />
          <span className="dth-sum-t"><b>{first.author.kind === 'self' ? 'You' : first.author.name}</b>: {plainPreview(first.body, 160)}</span>
          {thread.comments.length > 1 && <span className="dth-n">{thread.comments.length - 1} {plural(thread.comments.length - 1, 'reply', 'replies')}</span>}
        </button>
      </div>
    );
  }
  return (
    <div className={cx('dth', resolved && 'resolved', focused && 'focus')} data-thread={thread.id} onFocusCapture={() => s.focused !== thread.id && s.focus(thread.id)}>
      {(resolved || note) && (
        <div className="dth-top">
          {resolved && (
            <button type="button" className="dth-state" onClick={() => { s.setExpanded(thread.id, false); if (focused) s.focus(null); }} title="Collapse">
              <Icon name="check" />Resolved
            </button>
          )}
          {note}
        </div>
      )}
      {snippet && thread.snippet !== null && <pre className="dth-snippet">{thread.snippet}</pre>}
      {thread.comments.map((c, i) => <CommentRow key={c.id} thread={thread} c={c} first={i === 0} />)}
      {replying
        ? <Composer draftKey={replyKey} placeholder="Reply" submitLabel="Reply" focusKey={replyFocus} onSubmit={(body) => s.actions.reply(thread.id, body)} onClose={() => setReplying(false)} />
        : (
          <div className="dth-foot">
            <button type="button" className="dth-reply" onClick={() => setReplying(true)} title="Reply (r)">Reply…</button>
            <button type="button" className="dth-btn" onClick={() => void setStatus(resolved ? 'open' : 'resolved')} title={`${resolved ? 'Reopen' : 'Resolve'} (e)`}>{resolved ? 'Reopen' : 'Resolve'}</button>
            <button type="button" className="dth-btn icon" onClick={() => void copyLink(thread.id).then((ok) => toast(ok ? 'Link to the thread copied' : 'Copy failed'))}
              title="Copy a link to this thread" aria-label="Copy a link to this thread"><Icon name="copy" /></button>
          </div>
        )}
    </div>
  );
}

/** This page's address with the thread in focus: it reopens the diff at the thread. */
const copyLink = (id: number) => {
  const url = new URL(location.href);
  url.searchParams.set('thread', String(id));
  return copyText(url.toString());
};

const lineRange = (a: number, b: number) => (a === b ? `line ${a}` : `lines ${a}–${b}`);

/** "moved from line 12 · made on abc1234" for a thread found again in a later push. */
function movedNote(t: CommentThread, p: ThreadPlacement | undefined): ReactNode {
  if (p?.kind !== 'line' || !p.relocated) return undefined;
  return (
    <span className="dth-moved" title="Made on an earlier push; found again by its lines">
      {p.startLine !== t.startLine && `moved from line ${t.startLine} · `}made on {t.commitOid.slice(0, 7)}
    </span>
  );
}

/** The threads ending on one line, stacked (an annotation under that line). */
export function LineThreads({ ids }: { ids: number[] }) {
  const s = useThreadsState();
  return (
    <div className="dth-stack">
      {ids.map((id) => {
        const t = s.byId.get(id);
        return t && <ThreadCard key={id} thread={t} note={movedNote(t, s.placements.get(id))} />;
      })}
    </div>
  );
}

/**
 * A file's top (a file-level annotation): threads on the file itself, threads on lines the diff doesn't show, and
 * the Outdated block, collapsed until opened. Hidden and outdated threads show the lines they were made on.
 */
export function FileNotes({ path, ids, outdated, draft }: { path: string; ids: number[]; outdated: number[]; draft: boolean }) {
  const s = useThreadsState();
  const open = s.outdatedOpen.has(path) || outdated.includes(s.focused ?? -1);
  const unresolved = outdated.filter((id) => s.byId.get(id)?.status === 'open').length;
  return (
    <div className="dth-stack dth-file">
      {draft && <DraftComposer />}
      {ids.map((id) => {
        const t = s.byId.get(id);
        if (!t) return null;
        const hidden = s.placements.get(id)?.kind === 'line';
        const note = hidden && t.startLine !== null ? <span className="dth-moved">{lineRange(t.startLine, t.endLine!)} · not in the diff's context</span> : <span className="dth-moved">On the file</span>;
        return <ThreadCard key={id} thread={t} snippet={hidden} note={note} />;
      })}
      {outdated.length > 0 && (
        <div className={cx('dth-outdated', open && 'open')}>
          <button type="button" className="dth-outdated-head" aria-expanded={open} onClick={() => s.setOutdatedOpen(path, !open)}>
            <Icon name={open ? 'chevron' : 'chevronRight'} />
            Outdated · {outdated.length} {plural(outdated.length, 'thread')}{unresolved ? ` · ${unresolved} unresolved` : ''}
            <span className="dth-hint">Their lines changed in a later push</span>
          </button>
          {open && outdated.map((id) => {
            const t = s.byId.get(id);
            return t && (
              <ThreadCard key={id} thread={t} snippet
                note={<span className="dth-moved">{t.startLine !== null && `was ${lineRange(t.startLine, t.endLine!)} (${t.side}) · `}made on {t.commitOid.slice(0, 7)}</span>} />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The composer for a new thread: under its lines, or at its file's top (with the lines it was started on) when they
 * changed since. It keeps the key of the lines it was started on, so its text follows it.
 */
export function DraftComposer() {
  const s = useThreadsState();
  const d = s.draft;
  const at = s.draftSpot;
  const key = s.draftKey;
  if (!d || !at || key === null) return null;
  const lines = at.at === 'line' ? lineRange(at.startLine, at.endLine) : lineRange(d.startLine, d.endLine);
  return (
    <div className="dth dth-new">
      <div className="dth-top">
        {at.at === 'line'
          ? <span>New comment · {lines} ({at.side}){at.relocated && <span className="dth-moved"> · moved since you started it</span>}</span>
          : at.why === 'outdated'
            ? <span>New comment · was {lines} ({d.side}) <span className="dth-moved">· its lines changed since you started it</span></span>
            : <span>New comment · {lines} ({d.side}) <span className="dth-moved">· not in the diff's context: expand it to see them</span></span>}
      </div>
      {at.at === 'file' && <pre className="dth-snippet">{d.snippet}</pre>}
      <Composer
        key={key}
        store={{ load: () => loadNewDraft(key)?.body ?? '', save: (text) => setNewDraftBody(key, text) }}
        placeholder={`Comment on ${lines}`}
        submitLabel="Comment"
        onSubmit={s.submitDraft}
        onClose={s.closeDraft}
        onDiscard={s.discardDraft}
      />
    </div>
  );
}
