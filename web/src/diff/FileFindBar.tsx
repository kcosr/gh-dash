import type { FileDiffMetadata } from '@pierre/diffs';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { Icon } from '../components/Icon';
import type { DiffLine } from './changeNavigation';
import type { CurrentFile } from './FileList';
import { clearFileMatches, findFileMatches, paintFileMatches, type FileMatch, type FileMatches } from './fileFind';
import './fileFindBar.css';

export interface FindSource {
  model: FileDiffMetadata;
  root: ShadowRoot | undefined;
  /** Changes when the renderer reveals more context in a hydrated patch. */
  expansionVersion?: number;
  isContextVisible?: (lineNumber: number) => boolean;
}

export interface FileFindHandle {
  rendered: (path: string) => void;
}

interface FindResults {
  path: string;
  model: FileDiffMetadata;
  partial: boolean;
  expansionVersion: number | undefined;
  query: string;
  split: boolean;
  matches: FileMatches;
  active: number;
}

function revealHorizontally(range: Range) {
  const column = range.startContainer.parentElement?.closest<HTMLElement>('[data-code]');
  if (!column || column.scrollWidth <= column.clientWidth) return;
  const clip = column.getBoundingClientRect();
  const gutter = column.querySelector('[data-gutter]')?.getBoundingClientRect().width ?? 0;
  const rect = range.getBoundingClientRect();
  const left = clip.left + gutter;
  if (rect.left < left || rect.right > clip.right) column.scrollLeft += rect.left - left - 12;
}

export function FileFindBar({ ref, id, input, open, close, current, split, readSource, readAnchor, seek }: {
  ref: Ref<FileFindHandle>;
  id: string;
  input: RefObject<HTMLInputElement | null>;
  open: boolean;
  close: () => void;
  current: CurrentFile;
  split: boolean;
  readSource: (path: string) => FindSource | null;
  readAnchor: (path: string) => DiffLine | null;
  seek: (path: string, match: FileMatch) => void;
}) {
  const [query, setQuery] = useState('');
  const queryRef = useRef(query);
  const results = useRef<FindResults | null>(null);
  const painted = useRef<ShadowRoot | null>(null);
  const revealX = useRef<number | null>(null);
  const frame = useRef(0);
  const [status, setStatus] = useState({ active: -1, total: 0 });

  const paint = useCallback((root: ShadowRoot | undefined) => {
    if (painted.current && painted.current !== root) clearFileMatches(painted.current);
    painted.current = root ?? null;
    const r = results.current;
    if (!root || !r) return;
    const range = paintFileMatches(root, r.matches, r.active);
    if (range && revealX.current === r.active) {
      revealHorizontally(range);
      revealX.current = null;
    }
  }, []);

  const updateStatus = useCallback(() => {
    const active = results.current?.active ?? -1;
    const total = results.current?.matches.length ?? 0;
    setStatus((previous) => previous.active === active && previous.total === total ? previous : { active, total });
  }, []);

  const refresh = useCallback(() => {
    if (!open) return;
    const path = current.get();
    const source = path === null ? null : readSource(path);
    const query = queryRef.current;
    const previous = results.current;
    if (source && path !== null) {
      const { model, expansionVersion } = source;
      if (previous?.path !== path || previous.model !== model || previous.partial !== model.isPartial ||
        previous.expansionVersion !== expansionVersion || previous.query !== query || previous.split !== split) {
        const matches = findFileMatches(model, query, split, source.isContextVisible);
        const selected = previous?.path === path && previous.query === query ? previous.matches.at(previous.active) : undefined;
        const retained = selected ? matches.indexOf(selected) : -1;
        const active = retained >= 0 ? retained : matches.firstNear(readAnchor(path));
        revealX.current = selected && previous?.active === revealX.current && active >= 0 ? active : null;
        results.current = { path, model, partial: model.isPartial, expansionVersion, query, split, matches, active };
      }
    } else {
      results.current = null;
      revealX.current = null;
    }
    paint(source?.root);
    updateStatus();
  }, [current, open, paint, readAnchor, readSource, split, updateStatus]);

  const latest = useRef({ open, refresh });
  latest.current = { open, refresh };
  const scheduleRefresh = useCallback(() => {
    if (!latest.current.open || frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      latest.current.refresh();
    });
  }, []);

  useImperativeHandle(ref, () => ({ rendered(path) { if (current.get() === path) scheduleRefresh(); } }), [current, scheduleRefresh]);
  useLayoutEffect(refresh, [refresh]);
  useEffect(() => {
    if (!open) return;
    const unsubscribe = current.subscribe(scheduleRefresh);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [current, open, scheduleRefresh]);
  useLayoutEffect(() => {
    if (!open) return;
    return () => {
      if (painted.current) clearFileMatches(painted.current);
      painted.current = null;
      revealX.current = null;
    };
  }, [open]);

  const seekActive = () => {
    const r = results.current;
    const match = r?.matches.at(r.active);
    if (!r || !match) return;
    revealX.current = r.active;
    seek(r.path, match);
    paint(readSource(r.path)?.root);
  };
  const move = (direction: -1 | 1) => {
    refresh();
    const r = results.current;
    if (!r?.matches.length) return;
    r.active = (r.active + direction + r.matches.length) % r.matches.length;
    seekActive();
    updateStatus();
  };

  return (
    <div id={id} role="search" aria-label="Find in file" className="dvr-find" hidden={!open} onKeyDown={(event) => {
      // An inline composer may be open behind the bar. Escape belongs to the control being used.
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      close();
    }}>
      <input ref={input} className="wb-input" type="search" aria-label="Find in file" placeholder="Find…" autoComplete="off" spellCheck={false}
        value={query} onChange={(event) => {
          const value = event.currentTarget.value;
          queryRef.current = value;
          setQuery(value);
          refresh();
          seekActive();
        }} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }} />
      <span className="dvr-find-count" role="status">{query && (status.total ? `${status.active + 1} of ${status.total}` : 'No matches')}</span>
      <button type="button" className="wb-btn wb-btn--icon wb-btn--ghost dvr-find-prev" title="Previous match" aria-label="Previous match"
        disabled={!status.total} onClick={() => move(-1)}><Icon name="chevron" /></button>
      <button type="button" className="wb-btn wb-btn--icon wb-btn--ghost" title="Next match" aria-label="Next match"
        disabled={!status.total} onClick={() => move(1)}><Icon name="chevron" /></button>
      <button type="button" className="wb-btn wb-btn--icon wb-btn--ghost" title="Close find" aria-label="Close find" onClick={close}><Icon name="x" /></button>
    </div>
  );
}
