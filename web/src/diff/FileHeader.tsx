import { useEffect, useState } from 'react';
import type { Provider } from '../../../shared/provider';
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
 * The file on the host's diff page (a PR's changed files, a commit page), anchored as the host does it
 * (`Provider.link.fileAnchor`). Falls back to the page itself where SubtleCrypto is unavailable (plain HTTP off localhost).
 */
function useFileAnchor(url: string, path: string, provider: Provider, active: boolean): string {
  const [href, setHref] = useState(url);
  useEffect(() => {
    if (!active || !crypto.subtle) return;
    let live = true;
    provider.link.fileAnchor(path).then((anchor) => { if (live) setHref(`${url}${anchor}`); }, () => { /* keep the page */ });
    return () => { live = false; };
  }, [url, path, provider, active]);
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
export function FileHeader({ vf, diffUrl, provider, collapsed, onToggle, contextFailed }: {
  vf: ViewerFile;
  diffUrl: string;
  provider: Provider;
  collapsed: boolean;
  onToggle: (id: string) => void;
  contextFailed: boolean;
}) {
  const f = vf.file;
  const href = useFileAnchor(diffUrl, f.path, provider, vf.note === 'unavailable');
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
        ? <a className="dvh-note" href={href} target="_blank" rel="noopener noreferrer"><span className="dvh-why">Diff not available from {provider.name} · </span>view on {provider.name} <Icon name="ext" /></a>
        : vf.note
          ? <span className="dvh-note">{NOTES[vf.note]}</span>
          : collapsed
            ? <button type="button" className="dvh-note link" onClick={() => onToggle(vf.id)}>{vf.folded === 'deleted' ? 'Deleted' : vf.folded === 'large' ? 'Large diff' : 'Hidden'} · show</button>
            : contextFailed && <span className="dvh-note">Context unavailable</span>}
    </div>
  );
}
