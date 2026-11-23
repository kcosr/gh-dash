import type { FileDiffMetadata } from '@pierre/diffs';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { Icon } from '../components/Icon';
import type { DiffLine } from './changeNavigation';
import type { CurrentFile } from './FileList';
import { findFileMatches, paintFileMatches, type FileMatch, type FileMatches } from './fileFind';
import './fileFindBar.css';

export interface FindSource {
  model: FileDiffMetadata;
  /** Changes when the renderer reveals more context in a hydrated patch. */
  expansionVersion?: number;
  isContextVisible?: (lineNumber: number) => boolean;
}

export interface FileFindHandle {
  rendered: (path: string) => void;
}

interface FindResults {
  model: FileDiffMetadata;
  partial: boolean;
  expansionVersion: number | undefined;
  matches: FileMatches;
}

interface FindSelection { path: string; match: FileMatch }

interface FindSearch {
  paths: readonly string[];
  query: string;
  split: boolean;
  files: Map<string, FindResults>;
  next: number;
  total: number;
  viewed: string | null;
  selection: FindSelection | null;
  revealX: boolean;
  moves: (-1 | 1)[];
}

const SEARCH_SLICE_MS = 8;

function resultAt(path: string, matches: FileMatches, index: number): FindSelection | null {
  const match = matches.at(index);
  return match ? { path, match } : null;
}

function nextFileMatch(search: FindSearch, path: string | null, direction: -1 | 1): FindSelection | null {
  const { paths, files } = search;
  const start = path === null ? -1 : paths.indexOf(path);
  let index = start === -1 && direction === -1 ? 0 : start;
  for (let visited = 0; visited < paths.length; visited++) {
    index = (index + direction + paths.length) % paths.length;
    const nextPath = paths[index]!;
    const matches = files.get(nextPath)?.matches;
    if (matches?.length) return resultAt(nextPath, matches, direction === 1 ? 0 : matches.length - 1);
  }
  return null;
}

function stepMatch(search: FindSearch, direction: -1 | 1) {
  const { selection } = search;
  const path = selection?.path ?? search.viewed;
  const matches = path === null ? undefined : search.files.get(path)?.matches;
  if (path !== null && matches?.length) {
    const index = selection ? matches.indexOf(selection.match) + direction : direction === -1 ? matches.length - 1 : matches.length;
    const local = resultAt(path, matches, index);
    if (local) return local;
  }
  return nextFileMatch(search, path, direction);
}

function matchNumber(search: FindSearch, path: string, index: number): number {
  let number = index + 1;
  for (const earlier of search.paths) {
    if (earlier === path) break;
    number += search.files.get(earlier)?.matches.length ?? 0;
  }
  return number;
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

export function FileFindBar({ ref, id, input, open, close, current, split, paths, readSource, readRoots, readAnchor, seek }: {
  ref: Ref<FileFindHandle>;
  id: string;
  input: RefObject<HTMLInputElement | null>;
  open: boolean;
  close: () => void;
  current: CurrentFile;
  split: boolean;
  paths: readonly string[];
  readSource: (path: string) => FindSource | null;
  readRoots: () => { path: string; root: ShadowRoot }[];
  readAnchor: (path: string) => DiffLine | null;
  seek: (path: string, match: FileMatch) => void;
}) {
  const [query, setQuery] = useState('');
  const requestedQuery = useRef<string | null>(null);
  const search = useRef<FindSearch | null>(null);
  const dirty = useRef(new Set<string>());
  const clearPainted = useRef<(() => void) | undefined>(undefined);
  const frame = useRef(0);
  const [status, setStatus] = useState({ active: 0, total: 0, searching: false });

  const clearHighlights = useCallback(() => {
    clearPainted.current?.();
    clearPainted.current = undefined;
  }, []);

  const updateStatus = useCallback((active: number, total: number, searching = false) => {
    setStatus((previous) => previous.active === active && previous.total === total && previous.searching === searching
      ? previous : { active, total, searching });
  }, []);

  const paintSelection = useCallback((search: FindSearch) => {
    const selection = search.selection;
    const matches = selection && search.files.get(selection.path)?.matches;
    const index = matches && selection ? matches.indexOf(selection.match) : -1;
    const mounted = readRoots().flatMap(({ path, root }) => {
      const matches = search.files.get(path)?.matches;
      return matches?.length ? [{ root, matches, active: selection?.path === path ? index : -1 }] : [];
    });
    clearHighlights();
    const highlights = paintFileMatches(mounted);
    clearPainted.current = highlights?.clear;
    if (highlights?.activeRange && search.revealX) {
      revealHorizontally(highlights.activeRange);
      search.revealX = false;
    }
    updateStatus(selection && index >= 0 ? matchNumber(search, selection.path, index) : 0, search.total);
  }, [clearHighlights, readRoots, updateStatus]);

  const seekSelection = useCallback((search: FindSearch) => {
    if (!search.selection) return;
    search.revealX = true;
    seek(search.selection.path, search.selection.match);
  }, [seek]);

  const refresh = useCallback(() => {
    const r = search.current;
    if (!r) return false;
    const readFile = (path: string) => {
      const previous = r.files.get(path);
      const source = readSource(path);
      if (source && previous?.model === source.model && previous.partial === source.model.isPartial &&
        previous.expansionVersion === source.expansionVersion) return;
      r.total -= previous?.matches.length ?? 0;
      if (source) {
        const { model, expansionVersion } = source;
        const matches = findFileMatches(model, r.query, r.split, source.isContextVisible);
        r.files.set(path, { model, partial: model.isPartial, expansionVersion, matches });
        r.total += matches.length;
      } else {
        r.files.delete(path);
      }
    };
    // Yield between files during large searches so input and background parsing can continue.
    const deadline = performance.now() + SEARCH_SLICE_MS;
    while (r.next < r.paths.length) {
      const path = r.paths[r.next++]!;
      readFile(path);
      dirty.current.delete(path);
      if (performance.now() >= deadline && r.next < r.paths.length) return true;
    }
    for (const path of dirty.current) readFile(path);
    dirty.current.clear();

    const path = current.get();
    const selection = r.selection;
    // Keep a match selected by Find as its file becomes current. A manual file change re-anchors Find.
    if ((path !== r.viewed && selection?.path !== path) ||
      (selection && (r.files.get(selection.path)?.matches.indexOf(selection.match) ?? -1) < 0)) {
      r.selection = null;
      r.revealX = false;
    }
    r.viewed = path;
    if (!r.selection && path !== null) {
      const matches = r.files.get(path)?.matches;
      if (matches?.length) r.selection = resultAt(path, matches, matches.firstNear(readAnchor(path)));
    }
    const seekFirst = requestedQuery.current === r.query;
    if (seekFirst) {
      requestedQuery.current = null;
      r.selection ??= nextFileMatch(r, path, 1);
    }
    const moves = r.moves.splice(0);
    if (r.total) for (const direction of moves) r.selection = stepMatch(r, direction);
    if (seekFirst || moves.length) seekSelection(r);
    paintSelection(r);
    return false;
  }, [current, paintSelection, readAnchor, readSource, seekSelection]);

  const latest = useRef(refresh);
  latest.current = refresh;
  const scheduleRefresh = useCallback(function schedule() {
    if (!search.current || frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (latest.current()) schedule();
    });
  }, []);

  useImperativeHandle(ref, () => ({ rendered(path) {
    if (!search.current) return;
    dirty.current.add(path);
    scheduleRefresh();
  } }), [scheduleRefresh]);
  useLayoutEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    dirty.current.clear();
    const previous = search.current;
    if (!open || !query) {
      search.current = null;
      requestedQuery.current = null;
      clearHighlights();
      updateStatus(0, 0);
      return;
    }
    const sameQuery = previous?.query === query;
    const reuse = sameQuery && previous.split === split && previous.paths === paths;
    search.current = {
      paths, query, split, files: reuse ? previous.files : new Map(), next: 0, total: reuse ? previous.total : 0,
      viewed: sameQuery ? previous.viewed : current.get(), selection: sameQuery ? previous.selection : null,
      revealX: sameQuery && previous.revealX, moves: sameQuery ? previous.moves : [],
    };
    if (!reuse) {
      clearHighlights();
      updateStatus(0, 0, true);
    }
    scheduleRefresh();
  }, [clearHighlights, current, open, paths, query, readSource, scheduleRefresh, split, updateStatus]);
  useEffect(() => current.subscribe(scheduleRefresh), [current, scheduleRefresh]);
  useLayoutEffect(() => () => {
    cancelAnimationFrame(frame.current);
    clearHighlights();
  }, [clearHighlights]);

  const move = (direction: -1 | 1) => {
    search.current?.moves.push(direction);
    scheduleRefresh();
  };

  return (
    <div id={id} role="search" aria-label="Find in files" className="dvr-find" hidden={!open} onKeyDown={(event) => {
      // An inline composer may be open behind the bar. Escape belongs to the control being used.
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      close();
    }}>
      <input ref={input} className="wb-input" type="search" aria-label="Find in files" placeholder="Find…" autoComplete="off" spellCheck={false}
        value={query} onChange={(event) => {
          const value = event.currentTarget.value;
          requestedQuery.current = value;
          setQuery(value);
        }} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }} />
      <span className="dvr-find-count" role="status">{query && (status.searching ? 'Searching…' : status.active
        ? `${status.active} of ${status.total}` : status.total ? `${status.total} ${status.total === 1 ? 'match' : 'matches'}` : 'No matches')}</span>
      <button type="button" className="wb-btn wb-btn--icon wb-btn--ghost dvr-find-prev" title="Previous match" aria-label="Previous match"
        disabled={!status.total} onClick={() => move(-1)}><Icon name="chevron" /></button>
      <button type="button" className="wb-btn wb-btn--icon wb-btn--ghost" title="Next match" aria-label="Next match"
        disabled={!status.total} onClick={() => move(1)}><Icon name="chevron" /></button>
      <button type="button" className="wb-btn wb-btn--icon wb-btn--ghost" title="Close find" aria-label="Close find" onClick={close}><Icon name="x" /></button>
    </div>
  );
}
