import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { cx } from '../lib/util';
import { baseName, renameParts, type ViewerFile } from './model';

// One formatter for thousands of rows (toLocaleString builds a new one per call).
const fmt = new Intl.NumberFormat();

/** `.diffstat` without the zero side: a new file reads "+21", not "+21 −0". */
export function Counts({ add, del }: { add: number; del: number }) {
  return (
    <span className="diffstat">
      {add > 0 && <span className="a">+{fmt.format(add)}</span>}
      {add > 0 && del > 0 && ' '}
      {del > 0 && <span className="d">−{fmt.format(del)}</span>}
    </span>
  );
}

/** Fixed: the virtualizer estimates file heights from it (overflow: scroll never measures headers). */
export const HEADER_HEIGHT = 34;

const NOTES = {
  binary: 'Binary file not shown',
  renamed: 'Renamed without changes',
} as const;

/**
 * GitHub anchors each file on a PR's "Files changed" tab and a commit page as #diff-<sha256(path)>.
 * Falls back to the page itself where SubtleCrypto is unavailable (plain HTTP off localhost).
 */
function useFileAnchor(url: string, path: string, active: boolean): string {
  const [href, setHref] = useState(url);
  useEffect(() => {
    if (!active || !crypto.subtle) return;
    let live = true;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)).then((buf) => {
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (live) setHref(`${url}#diff-${hex}`);
    });
    return () => { live = false; };
  }, [url, path, active]);
  return href;
}

function Path({ vf }: { vf: ViewerFile }) {
  const { path, previousPath } = vf.file;
  if (previousPath && previousPath !== path) {
    const r = renameParts(previousPath, path);
    return (
      <span className="dvh-path" title={`${previousPath} → ${path}`}>
        <bdi><span className="dir">{r.head}{r.head || r.tail ? '{' : ''}</span>{r.from}<span className="dir"> → </span>{r.to}<span className="dir">{r.head || r.tail ? '}' : ''}{r.tail}</span></bdi>
      </span>
    );
  }
  return (
    <span className="dvh-path" title={path}>
      <bdi><span className="dir">{vf.dir}</span>{baseName(path)}</bdi>
    </span>
  );
}

/** A file's sticky header: fold toggle, path (renames as old → new), line counts, and a note when there's no diff to show. */
export function FileHeader({ vf, diffUrl, collapsed, onToggle, contextFailed }: {
  vf: ViewerFile;
  diffUrl: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  contextFailed: boolean;
}) {
  const f = vf.file;
  const href = useFileAnchor(diffUrl, f.path, vf.note === 'unavailable');
  const foldable = (vf.fileDiff?.hunks.length ?? 0) > 0;
  return (
    <div className={cx('dvh', `st-${f.status}`, (!foldable || collapsed) && 'flat')} data-path={f.path}>
      {foldable
        ? (
          <button type="button" className="dvh-fold" onClick={() => onToggle(vf.id)} aria-expanded={!collapsed} aria-label={collapsed ? 'Show diff' : 'Hide diff'}>
            <Icon name={collapsed ? 'chevronRight' : 'chevron'} />
          </button>
        )
        : <span className="dvh-fold" />}
      <Path vf={vf} />
      {f.additions + f.deletions > 0 && <Counts add={f.additions} del={f.deletions} />}
      <span className="spacer" />
      {vf.note === 'unavailable'
        ? <a className="dvh-note" href={href} target="_blank" rel="noopener noreferrer"><span className="dvh-why">Diff not available from GitHub · </span>view on GitHub <Icon name="ext" /></a>
        : vf.note
          ? <span className="dvh-note">{NOTES[vf.note]}</span>
          : collapsed
            ? <button type="button" className="dvh-note link" onClick={() => onToggle(vf.id)}>{vf.folded === 'deleted' ? 'Deleted' : vf.folded === 'large' ? 'Large diff' : 'Hidden'} · show</button>
            : contextFailed && <span className="dvh-note">Context unavailable</span>}
    </div>
  );
}
