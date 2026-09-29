import { memo, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { CommentCounts } from '../../../shared/api';
import { Icon } from '../components/Icon';
import type { FileFilter } from '../lib/urlState';
import { cx } from '../lib/util';
import { Counts } from './FileHeader';
import { baseName, type ViewerFile } from './model';

const MARK: Record<string, string> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: '·' };
const STATUS_TITLE: Record<string, string> = { added: 'Added', removed: 'Deleted', modified: 'Modified', renamed: 'Renamed', copied: 'Copied', changed: 'Changed', unchanged: 'Unchanged' };

/**
 * The file in view as a tiny store: each row subscribes to "am I current", so a change re-renders
 * two rows instead of the whole list (thousands of rows on big PRs).
 */
export interface CurrentFile {
  get: () => string | null;
  set: (id: string | null) => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createCurrentFile(initial: string | null): CurrentFile {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(id) {
      if (id === value) return;
      value = id;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}

const Row = memo(function Row({ vf, current, onPick, comments }: { vf: ViewerFile; current: CurrentFile; onPick: (id: string) => void; comments?: CommentCounts }) {
  const on = useSyncExternalStore(current.subscribe, () => current.get() === vf.id);
  const f = vf.file;
  return (
    <button
      type="button"
      className={cx('dvf-row', `st-${f.status}`, on && 'on')}
      data-id={vf.id}
      aria-current={on ? 'true' : undefined}
      title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
      onClick={() => onPick(vf.id)}
    >
      <span className="dvf-mark" aria-label={STATUS_TITLE[f.status]}>{MARK[f.status]}</span>
      <span className="dvf-name">{baseName(f.path)}</span>
      {comments && (
        <span className={cx('dvf-cm', comments.unresolved > 0 && 'open')} title={`${comments.threads} comment ${comments.threads === 1 ? 'thread' : 'threads'}${comments.unresolved ? `, ${comments.unresolved} unresolved` : ''}`}>
          <Icon name="comment" />{comments.unresolved || comments.threads}
        </span>
      )}
      {f.additions + f.deletions > 0 && <Counts add={f.additions} del={f.deletions} />}
    </button>
  );
});

/**
 * Keeps `el` visible inside `box` (its offset parent) without scrolling anything else, which
 * scrollIntoView would.
 */
function scrollNearest(box: HTMLElement, el: HTMLElement) {
  const top = el.offsetTop;
  if (top < box.scrollTop) box.scrollTop = top - 24;
  else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight + 24;
}

const FILTERS: { value: FileFilter | null; label: string; title: string }[] = [
  { value: null, label: 'All', title: 'Every changed file' },
  { value: 'commented', label: 'Commented', title: 'Files with comment threads (j/k visit only these)' },
  { value: 'unresolved', label: 'Unresolved', title: 'Files with unresolved threads (j/k visit only these)' },
];

/**
 * Changed files grouped by directory; the file in view is highlighted and kept visible. With comment threads, rows
 * show their counts and the list can be narrowed to files with threads (`files` is the narrowed list).
 */
export const FileList = memo(function FileList({ files, current, onPick, footer, comments, only, onOnly }: {
  files: ViewerFile[];
  current: CurrentFile;
  onPick: (id: string) => void;
  footer?: ReactNode;
  /** Thread counts per file id; null when the diff has no threads (no filter then). */
  comments: ReadonlyMap<string, CommentCounts> | null;
  only: FileFilter | null;
  onOnly: (only: FileFilter | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      // After the diffs have rendered for this scroll position, so the layout read is not forced early.
      frame = requestAnimationFrame(() => {
        const id = current.get();
        const el = id == null ? null : box.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        if (box.current && el) scrollNearest(box.current, el);
      });
    };
    follow();
    const off = current.subscribe(follow);
    return () => { off(); cancelAnimationFrame(frame); };
  }, [current]);

  const out: ReactNode[] = [];
  let dir: string | null = null;
  for (const vf of files) {
    if (vf.dir !== dir) {
      dir = vf.dir;
      // Root files come first and need no heading.
      if (dir) out.push(<div key={`d:${dir}`} className="dvf-dir" title={dir}><bdi>{dir}</bdi></div>);
    }
    out.push(<Row key={vf.id} vf={vf} current={current} onPick={onPick} comments={comments?.get(vf.id)} />);
  }
  return (
    <nav className="dvr-files" aria-label="Changed files">
      {(comments || only) && (
        <div className="dvf-filter" role="group" aria-label="Show files">
          {FILTERS.map((f) => (
            <button key={f.label} type="button" className={cx(only === f.value && 'on')} aria-pressed={only === f.value} title={f.title} onClick={() => onOnly(f.value)}>{f.label}</button>
          ))}
        </div>
      )}
      <div className="dvf-list" ref={box}>{out.length ? out : <p className="dvf-none">No files with {only === 'unresolved' ? 'unresolved threads' : 'comments'}.</p>}</div>
      {footer}
    </nav>
  );
});
