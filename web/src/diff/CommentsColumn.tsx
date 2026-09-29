/**
 * The comments column beside the diff (an overlay on compact screens): every thread of the diff in one place. Threads
 * with nowhere to go in the diff (PR- or commit-level ones, and those whose file left the diff) live here in full;
 * the rest are one-line entries that scroll the diff to the thread. It never covers the diff, and stays open until
 * closed (a saved preference on desktop).
 */
import { memo, useState } from 'react';
import type { CommentThread } from '../../../shared/api';
import { threadsMarkdown } from '../../../shared/comment-markdown';
import type { ThreadPlacement } from '../../../shared/comment-placement';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { plainPreview } from '../lib/markdown';
import { plural } from '../lib/time';
import { copyText, cx } from '../lib/util';
import { getDraft } from './drafts';
import { baseName } from './model';
import { Composer, ThreadCard, threadWhere, useThreadsState } from './Threads';

/** One thread as a line: where it sits now, its opening words, replies; a click scrolls the diff to it. */
function ThreadLink({ t, p, onJump }: { t: CommentThread; p: ThreadPlacement | undefined; onJump: (id: number) => void }) {
  const { focused } = useThreadsState();
  const first = t.comments[0]!;
  // Where it is now (relocated threads move); the file's name here, its path in the title.
  const lines = p?.kind === 'line' ? (p.startLine === p.endLine ? `${p.startLine}` : `${p.startLine}–${p.endLine}`) : t.startLine === null ? null : `${t.startLine}`;
  const where = p?.kind === 'line' ? `${p.path}:${lines}` : threadWhere(t);
  return (
    <button type="button" className={cx('dcc-link', t.status === 'resolved' && 'resolved', focused === t.id && 'on')} data-link={t.id} onClick={() => onJump(t.id)}
      aria-current={focused === t.id ? 'true' : undefined} title={`${where}${t.status === 'resolved' ? ' · resolved' : ''}`}>
      <Icon name={t.status === 'resolved' ? 'check' : 'comment'} />
      <span className="dcc-where">
        <span className="name">{t.path === null ? 'General' : baseName(p?.kind === 'line' ? p.path : t.path)}</span>
        {lines && <span className="ln">:{lines}</span>}
      </span>
      <span className="dcc-text">{plainPreview(first.body, 120)}</span>
      {t.comments.length > 1 && <span className="dth-n">+{t.comments.length - 1}</span>}
    </button>
  );
}

export const CommentsColumn = memo(function CommentsColumn({ threads, order, title, kind, error, onRetry, onJump, onClose, onCreateGeneral }: {
  /** In n/p order: general, then by file (file-list order) and line. */
  threads: CommentThread[];
  /** File ids in file-list order, to group the in-diff entries. */
  order: ReadonlyMap<string, number>;
  /** "repo#12" or "repo@abc1234", the Markdown heading. */
  title: string;
  kind: 'pr' | 'commit';
  /** The threads couldn't be loaded. */
  error: boolean;
  onRetry: () => void;
  onJump: (id: number) => void;
  onClose: () => void;
  onCreateGeneral: (body: string) => Promise<unknown>;
}) {
  const s = useThreadsState();
  const toast = useToast();
  const generalKey = `${s.draftScope}|general`;
  // A draft left in it (reload, closed column) opens the composer again.
  const [composing, setComposing] = useState(() => getDraft(generalKey) !== '');
  const general: CommentThread[] = [];
  const placed: CommentThread[] = [];
  const outdated: CommentThread[] = [];
  const gone: CommentThread[] = [];
  for (const t of threads) {
    const p = s.placements.get(t.id);
    if (!p || p.kind === 'target') general.push(t);
    else if (p.kind === 'outdated') (p.reason === 'file' ? gone : outdated).push(t);
    else placed.push(t);
  }
  const open = threads.filter((t) => t.status === 'open').length;
  const copy = async (unresolvedOnly: boolean) => {
    const list = unresolvedOnly ? threads.filter((t) => t.status === 'open') : threads;
    const ok = await copyText(threadsMarkdown(list, { title, placements: s.placements }));
    toast(ok ? `Copied ${list.length} ${plural(list.length, 'thread')} as Markdown` : 'Copy failed');
  };
  const what = kind === 'pr' ? 'pull request' : 'commit';

  return (
    <aside className="dcc" aria-label="Comments">
      <div className="dcc-head">
        <b>Comments</b>
        <span className="dcc-count">{threads.length ? `${open} open · ${threads.length - open} resolved` : 'None yet'}</span>
        <span className="spacer" />
        <button type="button" className="btn icon ghost" onClick={onClose} title="Close comments (c)" aria-label="Close comments"><Icon name="x" /></button>
      </div>
      <div className="dcc-body">
        {error && (
          <p className="dcc-error">Couldn't load the comments. <button type="button" className="dth-btn" onClick={onRetry}>Retry</button></p>
        )}
        <section className="dcc-sec">
          <h4>Conversation</h4>
          {general.map((t) => <ThreadCard key={t.id} thread={t} />)}
          {composing
            ? (
              <div className="dth dcc-new">
                <Composer draftKey={generalKey} placeholder={`Comment on this ${what}`} submitLabel="Comment" onSubmit={onCreateGeneral} onClose={() => setComposing(false)} />
              </div>
            )
            : <button type="button" className="dth-reply dcc-start" onClick={() => setComposing(true)}>Comment on this {what}…</button>}
        </section>
        {placed.length > 0 && (
          <section className="dcc-sec">
            <h4>In this diff <span className="n">{placed.length}</span></h4>
            {[...placed].sort((a, b) => (order.get(a.path!) ?? 0) - (order.get(b.path!) ?? 0)).map((t) => <ThreadLink key={t.id} t={t} p={s.placements.get(t.id)} onJump={onJump} />)}
          </section>
        )}
        {outdated.length > 0 && (
          <section className="dcc-sec">
            <h4 title="Made on an earlier push; their lines are no longer in the diff">Outdated <span className="n">{outdated.length}</span></h4>
            {outdated.map((t) => <ThreadLink key={t.id} t={t} p={s.placements.get(t.id)} onJump={onJump} />)}
          </section>
        )}
        {gone.length > 0 && (
          <section className="dcc-sec">
            <h4 title="Their file is no longer part of this diff">Not in this diff <span className="n">{gone.length}</span></h4>
            {gone.map((t) => <ThreadCard key={t.id} thread={t} snippet note={<span className="dth-where" title={threadWhere(t)}>{threadWhere(t)}</span>} />)}
          </section>
        )}
      </div>
      {threads.length > 0 && (
        <div className="dcc-foot">
          <Icon name="md" />
          <span>Copy as Markdown:</span>
          <button type="button" className="dth-btn" onClick={() => void copy(false)}>All</button>
          <button type="button" className="dth-btn" onClick={() => void copy(true)} disabled={!open}>Unresolved</button>
        </div>
      )}
    </aside>
  );
});
