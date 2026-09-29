/**
 * Diff viewer entry point, loaded lazily by the diff view shell. Built on @pierre/diffs: one
 * virtualized CodeView for every file (smooth on PRs with thousands of files) beside a hand-rolled
 * file list, with headers, colors and type in the app's own visual language (diff.css, pierre.css).
 * Local comment threads show as Pierre annotations under their lines, and all of them in the
 * comments column (Threads.tsx, CommentsColumn.tsx; placement in shared/comment-placement.ts).
 */
import type { CodeView as CodeViewClass, CodeViewItem, CodeViewOptions, CodeViewScrollTarget, DiffLineAnnotation, FileDiffLoadedFiles, FileDiffMetadata, LineAnnotation, PostRenderPhase } from '@pierre/diffs';
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from '@pierre/diffs/react';
import HighlightWorker from '@pierre/diffs/worker/worker.js?worker';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { CommentThread, Diff, Me } from '../../../shared/api';
import { patchLines, placeThreads, type SideLines } from '../../../shared/comment-placement';
import type { useThreadActions } from '../api/hooks';
import { Icon } from '../components/Icon';
import { Seg } from '../components/Seg';
import { useToast } from '../components/Toasts';
import { isTypingTarget, useLayer } from '../lib/layers';
import { getDiffPrefs, setDiffPrefs, type DiffPrefs } from '../lib/storage';
import type { FileFilter } from '../lib/urlState';
import { cx } from '../lib/util';
import { CommentsColumn } from './CommentsColumn';
import { FileHeader, HEADER_HEIGHT } from './FileHeader';
import { getDraftAnchor, setDraftAnchor } from './drafts';
import { createCurrentFile, FileList, type CurrentFile } from './FileList';
import { buildFiles, parseFiles, type ViewerFile } from './model';
import { DraftComposer, FileNotes, LineThreads, ThreadsCtx, type ThreadsState } from './Threads';
import {
  annotationsFor, countsByFile, type DraftAnchor, draftSnippet, type Note, notesByFile, type PierreRange, pierreSide, readingOrder, selectionAnchor, stepThread,
} from './threadModel';
import unsafeCSS from './pierre.css?inline';
import { registerThemes, THEMES } from './theme';
import './diff.css';

export interface DiffViewerProps {
  diff: Diff;
  /** Full file contents at a commit, for expanding context; resolves null when unavailable. */
  loadFile: (ref: string, path: string) => Promise<string | null>;
  /** Narrow layout (≤900px). */
  compact: boolean;
  /** True while the diff view is the top layer; gate the viewer's own shortcuts on it. */
  isActive: () => boolean;
  /** File to scroll to on open (deep link); null for the first file. */
  file: string | null;
  /** Reports the file currently in view, so the shell can keep it in the URL. */
  onFileChange: (path: string) => void;
  comments: DiffComments;
}

/** The diff's comment threads, from the shell (which owns the URL and the queries). */
export interface DiffComments {
  /** The threads' key (a PR id, or a commit's with its full oid): drafts are stored under it. */
  key: string;
  /** undefined while loading. */
  threads: CommentThread[] | undefined;
  error: boolean;
  actions: ReturnType<typeof useThreadActions>;
  me: Me | undefined;
  /** Thread to show on open (deep link, URL `thread`). */
  initialThread: number | null;
  /** Reports the focused thread, for the URL. */
  onThreadFocus: (id: number | null) => void;
  /** The file list's filter (URL `only`); j/k follow it. */
  only: FileFilter | null;
  onOnlyChange: (only: FileFilter | null) => void;
}

type Item = CodeViewItem<Note>;
type CodeViewInstance = CodeViewClass<Note, undefined>;
type Annotation = DiffLineAnnotation<Note> | LineAnnotation<Note>;
const NO_THREADS: CommentThread[] = [];

/** Row metrics shared by the CSS (pierre.css, diff.css) and the virtualizer's height estimates. */
const LINE_HEIGHT = 18;
const SEPARATOR_HEIGHT = 24;
/** Compact: headers and separators hold 40px touch targets, like the shell's (--dvr-touch in diff.css). */
const TOUCH = 40;
/** Parse budgets for big PRs: before the first render, then per background slice. */
const FIRST_PARSE_MS = 40;
const SLICE_PARSE_MS = 12;
/** Context lines revealed per click on an expand control. */
const EXPAND_LINES = 20;
/** Space between files; a file whose top is within it of the top edge is the one in view. */
const GAP = 12;
/** Quiet time after a jump's last scroll event before the scroll position picks the file again. */
const SETTLE_MS = 150;
/** Keys that scroll the focused diff scroller (they end a jump's settling like a wheel does). */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

registerThemes();

// Syntax highlighting runs in a small pool of workers: Shiki's tokenizer takes hundreds of
// milliseconds on a long Rust or C++ file, which froze scrolling on big PRs. Lines show unhighlighted
// until their file's tokens arrive; with this theme's mostly-grey syntax that is barely visible.
const POOL = {
  poolOptions: { workerFactory: () => new HighlightWorker(), poolSize: Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)) },
  highlighterOptions: { theme: THEMES, lineDiffType: 'word-alt' as const },
};

const readTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function subscribeTheme(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

const isExpandControl = (el: EventTarget | undefined): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-expand-button');

/** An expand control as a re-render can find it again: its file, its separator and its direction. */
interface ExpandControl { host: Element; index: string | null; kind: string | undefined }
const EXPAND_KINDS = ['data-expand-up', 'data-expand-down', 'data-expand-both', 'data-expand-all-button'];
const expandControl = (el: HTMLElement): ExpandControl => ({
  host: (el.getRootNode() as ShadowRoot).host,
  index: el.closest('[data-expand-index]')?.getAttribute('data-expand-index') ?? null,
  kind: EXPAND_KINDS.find((k) => el.hasAttribute(k)),
});

/**
 * Pierre's expand controls are divs with role="button" and just an icon: no name, and out of the
 * tab order. Name them like GitHub's (after the way the chevron points: Pierre's "up" shows the
 * lines below the hunk above) and make them focusable; Enter and Space click them. A click
 * re-renders the file and replaces the control, which drops focus to the page, so the file's next
 * render puts focus back on the control in its place, or on the scroller once the gap is gone.
 */
function useExpandControls(scroller: RefObject<HTMLDivElement | null>) {
  const focused = useRef<ExpandControl | null>(null);
  const track = useCallback((e: Event) => {
    // A pointer lands on the control's icon.
    const el = e.composedPath().find(isExpandControl);
    focused.current = el ? expandControl(el) : null;
  }, []);
  // pointerdown too: a click that focuses nothing (focus falls to the page) must not bring it back here.
  useEffect(() => {
    document.addEventListener('focusin', track);
    document.addEventListener('pointerdown', track);
    return () => {
      document.removeEventListener('focusin', track);
      document.removeEventListener('pointerdown', track);
    };
  }, [track]);
  // Focus moving within one file's shadow root doesn't reach the document: each root reports it too.
  const roots = useRef(new WeakSet<ShadowRoot>());
  const onPostRender = useCallback((node: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
    const root = node.shadowRoot;
    if (phase === 'unmount' || !root) return;
    if (!roots.current.has(root)) {
      roots.current.add(root);
      root.addEventListener('focusin', track);
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-expand-button]:not([tabindex])')) {
      const label = el.hasAttribute('data-expand-up') ? 'Expand down' : el.hasAttribute('data-expand-down') ? 'Expand up' : 'Expand all';
      el.tabIndex = 0;
      el.title = label;
      el.setAttribute('aria-label', label);
    }
    const f = focused.current;
    if (f?.host !== node || document.activeElement !== document.body) return;
    // Split view renders each separator in both gutters, one of them hidden.
    const controls = [...root.querySelectorAll<HTMLElement>(`[data-expand-index="${f.index}"] [data-expand-button]`)].filter((el) => el.checkVisibility());
    (controls.find((el) => f.kind != null && el.hasAttribute(f.kind)) ?? controls[0] ?? scroller.current)?.focus({ preventScroll: true });
  }, [scroller, track]);
  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const el = e.nativeEvent.composedPath()[0];
    if ((e.key === 'Enter' || e.key === ' ') && isExpandControl(el)) {
      e.preventDefault();
      el.click();
    }
  }, []);
  return { onPostRender, onKeyDown };
}

/** "3 of 21": where j/k are in the list. The shell's header has the totals. */
function Position({ current, indexOf, total }: { current: CurrentFile; indexOf: ReadonlyMap<string, number>; total: number }) {
  const i = indexOf.get(useSyncExternalStore(current.subscribe, current.get) ?? '');
  if (i == null || total < 2) return null;
  return <span className="dvr-pos">File <b>{(i + 1).toLocaleString()}</b> of {total.toLocaleString()}</span>;
}

export default function DiffViewer({ diff, loadFile, compact, isActive, file, onFileChange, comments }: DiffViewerProps) {
  // Keyed by what buildFiles reads, not the diff object: a PR diff revalidated on reopen comes back
  // as a new object (fetchedAt moved) with structurally shared, unchanged files, and must not re-render.
  const files = useMemo(() => buildFiles(diff), [diff.files, diff.baseOid, diff.headOid]);
  // Big PRs parse in slices so the view opens at once: what fits a small budget now, the rest in
  // the background, appended to the CodeView as it's ready (its append-only fast path).
  const [parsed, setParsed] = useState(() => ({ files, count: parseFiles(files, 0, FIRST_PARSE_MS) }));
  if (parsed.files !== files) setParsed({ files, count: parseFiles(files, 0, FIRST_PARSE_MS) });
  const count = parsed.files === files ? parsed.count : 0;
  useEffect(() => {
    if (count >= files.length) return;
    const t = setTimeout(() => setParsed((p) => (p.files === files ? { files, count: parseFiles(files, p.count, SLICE_PARSE_MS) } : p)), 0);
    return () => clearTimeout(t);
  }, [files, count]);
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const indexOf = useMemo(() => new Map(files.map((f, i) => [f.id, i])), [files]);
  const toast = useToast();

  // Comment threads: placed in this diff (shared/comment-placement.ts), then per file as Pierre annotations.
  const threads = comments.threads ?? NO_THREADS;
  const { files: diffFiles, headOid, baseOid } = diff;
  const placements = useMemo(() => placeThreads(threads, { files: diffFiles, headOid, baseOid }), [threads, diffFiles, headOid, baseOid]);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  // Pierre renders (and annotates) only the lines a file's patch shows, until its context is expanded.
  const shownLines = useMemo(() => new Map<string, { old: SideLines; new: SideLines }>(), [byId]);
  const shown = useCallback((path: string, side: 'old' | 'new', line: number) => {
    let sides = shownLines.get(path);
    if (!sides) {
      const patch = byId.get(path)?.file.patch;
      sides = patch ? patchLines(patch) : { old: new Map(), new: new Map() };
      shownLines.set(path, sides);
    }
    return sides[side].has(line);
  }, [byId, shownLines]);
  const notes = useMemo(() => notesByFile(threads, placements, shown), [threads, placements, shown]);
  const counts = useMemo(() => (threads.length ? countsByFile(threads, placements) : null), [threads, placements]);
  const ordered = useMemo(() => readingOrder(threads, placements, indexOf), [threads, placements, indexOf]);
  const openCount = useMemo(() => threads.filter((t) => t.status === 'open').length, [threads]);
  // The file list narrowed by its filter; j/k follow it.
  const only = comments.only;
  const navFiles = useMemo(() => (only
    ? files.filter((f) => { const c = counts?.get(f.id); return !!c && (only === 'commented' || c.unresolved > 0); })
    : files), [files, counts, only]);

  const [focused, setFocused] = useState<number | null>(comments.initialThread);
  const [expanded, setExpandedIds] = useState<ReadonlySet<number>>(new Set());
  const setExpanded = useCallback((id: number, open: boolean) => setExpandedIds((s) => {
    if (s.has(id) === open) return s;
    const next = new Set(s);
    if (open) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const [outdatedOpen, setOutdatedPaths] = useState<ReadonlySet<string>>(new Set());
  const setOutdatedOpen = useCallback((path: string, open: boolean) => setOutdatedPaths((s) => {
    if (s.has(path) === open) return s;
    const next = new Set(s);
    if (open) next.add(path);
    else next.delete(path);
    return next;
  }), []);
  // The new thread being written survives a reload (with its text: drafts.ts), like the rest of the reader's place.
  const [draft, setDraftState] = useState<DraftAnchor | null>(() => {
    const d = getDraftAnchor(comments.key);
    return d && byId.has(d.path) ? d : null;
  });
  const setDraft = useCallback((d: DraftAnchor | null) => {
    setDraftState(d);
    setDraftAnchor(comments.key, d);
  }, [comments.key]);
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const [prefs, setPrefs] = useState(getDiffPrefs);
  const updatePrefs = useCallback((patch: Partial<DiffPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  useEffect(() => setDiffPrefs(prefs), [prefs]);
  const split = prefs.split && !compact;
  // Compact always wraps (code would run off a phone's screen); the saved preference is the desktop's.
  const wrap = prefs.wrap || compact;
  // The file list is a column on desktop (a saved preference) and an overlay toggled per visit on compact.
  const [listOpen, setListOpen] = useState(false);
  const showList = compact ? listOpen : prefs.files;
  // Esc closes the overlay before the diff view.
  useLayer(compact && listOpen, () => setListOpen(false));
  const toggleList = () => (compact ? setListOpen((o) => !o) : updatePrefs({ files: !prefs.files }));
  // The comments column likewise: a saved preference beside the diff, an overlay per visit on compact.
  const [columnOpen, setColumnOpen] = useState(false);
  const showColumn = compact ? columnOpen : prefs.comments;
  useLayer(compact && columnOpen, () => setColumnOpen(false));
  const setColumn = useCallback((open: boolean) => (compact ? setColumnOpen(open) : updatePrefs({ comments: open })), [compact, updatePrefs]);

  // Collapsing: some files start folded (model.ts); each click flips a file and bumps its item version.
  const [flips, setFlips] = useState<ReadonlyMap<string, number>>(new Map());
  const isCollapsed = useCallback((vf: ViewerFile) => (vf.folded != null) !== ((flips.get(vf.id) ?? 0) % 2 === 1), [flips]);
  const toggleCollapsed = useCallback((id: string) => setFlips((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1)), []);
  // Item objects are cached so unchanged files keep their identity (CodeView diffs the list by identity). A
  // changed item needs a new object and a new version (CodeView ignores an item whose version it has seen): a
  // fold, or a change in where its annotations go. Thread contents aren't in the item: the cards read them from
  // ThreadsCtx, so a reply re-renders its card without re-laying out the file.
  const itemCache = useRef(new Map<string, { item: Item; flip: number; notes: string }>());
  const items = useMemo(() => files.slice(0, count).map((vf): Item => {
    const flip = flips.get(vf.id) ?? 0;
    const n = notes.get(vf.id);
    const d = draft?.path === vf.id ? draft : null;
    const sig = n || d ? JSON.stringify([n, d]) : '';
    const cached = itemCache.current.get(vf.id);
    if (cached && cached.flip === flip && cached.notes === sig && cached.item.type === 'diff' && cached.item.fileDiff === vf.fileDiff) return cached.item;
    const item: Item = {
      id: vf.id, type: 'diff', fileDiff: vf.fileDiff!, version: (cached?.item.version ?? -1) + 1, collapsed: isCollapsed(vf),
      annotations: annotationsFor(n, d, vf.file.status === 'removed' ? 'deletions' : 'additions'),
    };
    itemCache.current.set(vf.id, { item, flip, notes: sig });
    return item;
  }), [files, count, flips, isCollapsed, notes, draft]);

  // Context expansion: Pierre asks for both sides of a partial (patch-only) diff on the first expand.
  // A failure leaves the hunks as they are and says so in the header. loadFile resolves null for
  // files the server can't serve (missing, binary, too large): those aren't asked for again. It
  // rejects on transient failures (network, rate limit), which the next click retries.
  // Both sets are keyed by revision and path: a refreshed diff (new head or merge base) asks again,
  // and a load still pending from the previous revision can't mark a file of the new one.
  const rev = `${diff.baseOid}..${diff.headOid}`;
  // Full contents Pierre loaded, per path: a new thread on expanded context takes its snippet from them. Keyed on
  // the revision, so a refreshed diff starts empty.
  const contents = useMemo(() => new Map<string, { old: string[] | null; new: string[] | null }>(), [rev]);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const unavailable = useRef(new Set<string>());
  const loadDiffFiles = useCallback(async (fd: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const f = byId.get(fd.name)?.file;
    const key = `${rev}\0${fd.name}`;
    if (!f || !diff.baseOid || unavailable.current.has(key)) throw new Error(`No context for ${fd.name}`);
    const oldPath = f.previousPath ?? f.path;
    const texts = await Promise.all([loadFile(diff.baseOid, oldPath), loadFile(diff.headOid, f.path)]).catch(() => null);
    if (texts?.[0] == null || texts[1] == null) {
      if (texts) unavailable.current.add(key);
      setFailed((s) => new Set(s).add(key));
      throw new Error(`Couldn't load ${f.path} for context`);
    }
    setFailed((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : s));
    contents.set(f.path, { old: texts[0].split('\n'), new: texts[1].split('\n') });
    return { oldFile: { name: oldPath, contents: texts[0] }, newFile: { name: f.path, contents: texts[1] } };
  }, [byId, rev, diff.baseOid, diff.headOid, loadFile, contents]);

  const scroller = useRef<HTMLDivElement>(null);
  const expandControls = useExpandControls(scroller);

  // Selecting lines (their numbers: click, drag, shift-click) or the gutter's "+" opens the composer under them.
  const openDraftRef = useRef((_id: string, _range: PierreRange) => {});
  openDraftRef.current = (id, range) => {
    const vf = byId.get(id);
    if (vf) setDraft(selectionAnchor(id, vf.file.patch, range));
  };
  const onLinesPicked = useCallback((range: PierreRange | null, context: { item?: { id: string } }) => {
    if (range && context.item) openDraftRef.current(context.item.id, range);
  }, []);

  const options = useMemo((): CodeViewOptions<Note, undefined> => ({
    theme: THEMES,
    themeType: theme,
    diffStyle: split ? 'split' : 'unified',
    overflow: wrap ? 'wrap' : 'scroll',
    diffIndicators: 'classic',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info-basic',
    expansionLineCount: EXPAND_LINES,
    stickyHeaders: true,
    // Root commits have no old side (and only added files).
    loadDiffFiles: diff.baseOid ? loadDiffFiles : undefined,
    itemMetrics: {
      lineHeight: LINE_HEIGHT,
      diffHeaderHeight: compact ? TOUCH : HEADER_HEIGHT,
      hunkSeparatorHeight: compact ? TOUCH : SEPARATOR_HEIGHT,
      spacing: 0,
      paddingTop: 0,
      paddingBottom: 0,
    },
    // Compact files run edge to edge from the toolbar down.
    layout: { paddingTop: compact ? 0 : GAP, paddingBottom: 2 * GAP, gap: GAP },
    unsafeCSS,
    onPostRender: expandControls.onPostRender,
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelected: onLinesPicked as CodeViewOptions<Note, undefined>['onLineSelected'],
    onGutterUtilityClick: onLinesPicked as CodeViewOptions<Note, undefined>['onGutterUtilityClick'],
  }), [theme, split, wrap, compact, diff.baseOid, loadDiffFiles, expandControls.onPostRender, onLinesPicked]);

  // The file in view: the last file whose top has scrolled past the top edge. After a jump to a
  // file that can't reach the top (the end of the diff), that file stays current until the user
  // scrolls. Kept outside React state: a change re-renders two file list rows, not the viewer.
  const view = useRef<CodeViewHandle<Note, undefined>>(null);
  // Starts on the first file without reporting it: nothing to put in the URL until the reader moves.
  const [current] = useState(() => createCurrentFile(files[0]?.id ?? null));
  const pinned = useRef<string | null>(null);
  // A jump to a thread centers its line, often with its file's top still below the viewport's: the file stays the
  // one in view (and in the URL) until the reader scrolls.
  const holdPin = useRef(false);
  const reported = useRef<string | null>(current.get());
  const onFileChangeRef = useRef(onFileChange);
  onFileChangeRef.current = onFileChange;
  useEffect(() => current.subscribe(() => {
    const id = current.get();
    if (id != null && id !== reported.current) {
      reported.current = id;
      onFileChangeRef.current(id);
    }
  }), [current]);
  useEffect(() => {
    // A refreshed diff may have lost the file.
    if (!byId.has(current.get() ?? '')) current.set(files[0]?.id ?? null);
  }, [current, byId, files]);

  const follow = useCallback((scrollTop: number, cv: CodeViewInstance) => {
    if (!count) return;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((cv.getTopForItem(files[mid].id) ?? 0) <= scrollTop + GAP + 1) lo = mid;
      else hi = mid - 1;
    }
    let id = files[lo].id;
    const el = scroller.current;
    const atEnd = el != null && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (pinned.current && (atEnd || holdPin.current) && indexOf.get(pinned.current)! > lo) id = pinned.current;
    else pinned.current = null;
    current.set(id);
  }, [files, count, indexOf, current]);
  const followRef = useRef(follow);
  followRef.current = follow;

  // A jump (j/k, the file list, a deep link) scrolls programmatically, and its scroll events arrive a
  // frame or more later, when a quick next j may already have set another file. So while a jump is
  // in flight, `current` stays its target (j/k step from it) and scroll events don't move it; the
  // scroll position takes over once scrolling has been quiet for SETTLE_MS, or at once when the
  // reader scrolls (wheel, touch, scrollbar, scrolling keys).
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useCallback(() => {
    clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = undefined;
      const cv = view.current?.getInstance();
      if (cv) followRef.current(cv.getScrollTop(), cv);
    }, SETTLE_MS);
  }, []);
  const onScroll = useCallback((scrollTop: number, cv: CodeViewInstance) => {
    if (settling.current !== undefined) settle();
    else follow(scrollTop, cv);
  }, [follow, settle]);
  const hasFiles = files.length > 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const release = (e: Event) => {
      // A pointer on the scroller itself is on its scrollbar; anything else is a click in the diff.
      if (e.type === 'pointerdown' && e.target !== el) return;
      // Keys that scroll the diff; Space only where it isn't pressing a focused expand control.
      if (e instanceof KeyboardEvent && !(SCROLL_KEYS.has(e.key) || (e.key === ' ' && e.target === el))) return;
      clearTimeout(settling.current);
      settling.current = undefined;
      holdPin.current = false;
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.addEventListener(type, release, { passive: true });
    return () => {
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.removeEventListener(type, release);
      clearTimeout(settling.current);
    };
  }, [hasFiles]);

  // A jump to a file not parsed yet parses up to it right away and scrolls once the CodeView has it. `target`
  // scrolls to a place in the file (a thread's line) instead of its top.
  const countRef = useRef(count);
  countRef.current = count;
  const jumpTo = useRef<{ id: string; target: CodeViewScrollTarget } | null>(null);
  const goTo = useCallback((id: string, target: CodeViewScrollTarget = { type: 'item', id, align: 'start' }) => {
    pinned.current = id;
    holdPin.current = target.type === 'line';
    current.set(id);
    settle();
    const i = indexOf.get(id) ?? 0;
    if (i < countRef.current) view.current?.scrollTo(target);
    else {
      jumpTo.current = { id, target };
      setParsed((p) => (p.files === files ? { files, count: parseFiles(files, p.count, Infinity, i + 1) } : p));
    }
    if (compact) setListOpen(false);
  }, [current, compact, files, indexOf, settle]);
  useEffect(() => {
    const j = jumpTo.current;
    if (j == null || (indexOf.get(j.id) ?? Infinity) >= count) return;
    jumpTo.current = null;
    settle();
    view.current?.scrollTo(j.target);
  }, [count, indexOf, settle]);

  // ---------------------------------------------------------------- threads: focus, jumps, the composer
  const onThreadFocusRef = useRef(comments.onThreadFocus);
  onThreadFocusRef.current = comments.onThreadFocus;
  const live = useRef({ placements, threadById, byId, isCollapsed, shown, compact });
  live.current = { placements, threadById, byId, isCollapsed, shown, compact };
  /** Brings a thread into view: its line (unfolding its file, opening its file's Outdated block), or the column. */
  const jumpToThread = useCallback((id: number) => {
    const l = live.current;
    const p = l.placements.get(id);
    if (!p) return;
    const inColumn = p.kind === 'target' || (p.kind === 'outdated' && p.reason === 'file');
    if (inColumn) setColumn(true);
    // The column's entry too, when it's open (or just opened), so both show where the reader is.
    requestAnimationFrame(() => document.querySelector(`.dcc [data-thread="${id}"], .dcc [data-link="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
    if (inColumn) return;
    // On compact the column covers the diff: step aside for the thread.
    if (l.compact) setColumnOpen(false);
    const vf = l.byId.get(p.path);
    if (!vf) return;
    if (l.isCollapsed(vf)) toggleCollapsed(vf.id);
    if (p.kind === 'outdated') setOutdatedOpen(p.path, true);
    const onLine = p.kind === 'line' && l.shown(p.path, p.side, p.endLine);
    goTo(vf.id, onLine ? { type: 'line', id: vf.id, lineNumber: p.endLine, side: pierreSide(p.side), align: 'center' } : { type: 'item', id: vf.id, align: 'start' });
  }, [goTo, setColumn, setOutdatedOpen, toggleCollapsed]);
  const focusThread = useCallback((id: number | null, opts: { scroll?: boolean } = {}) => {
    setFocused(id);
    onThreadFocusRef.current(id);
    if (id !== null && opts.scroll) jumpToThread(id);
  }, [jumpToThread]);

  // Deep link: the URL's thread as of opening, once the threads are in (one that's gone just leaves the URL). Like
  // the deep-linked file, on every mount: in development StrictMode remounts the CodeView, dropping a first scroll.
  const [initialThread] = useState(comments.initialThread);
  const threadsReady = comments.threads !== undefined;
  const liveThreads = useRef({ jumpToThread, focusThread, threadById });
  liveThreads.current = { jumpToThread, focusThread, threadById };
  useEffect(() => {
    if (initialThread === null || !threadsReady) return;
    const l = liveThreads.current;
    if (l.threadById.has(initialThread)) l.jumpToThread(initialThread);
    else l.focusThread(null);
  }, [initialThread, threadsReady]);

  // The composer's lines stay selected, also when it comes back after a reload (Pierre keeps the selection of a file
  // that isn't rendered yet and paints it when it is).
  useEffect(() => {
    if (!draft || indexOf.get(draft.path) === undefined || (indexOf.get(draft.path) ?? Infinity) >= count) return;
    const side = pierreSide(draft.side);
    const cur = view.current?.getSelectedLines();
    if (cur?.id === draft.path && Math.min(cur.range.start, cur.range.end) === draft.startLine && Math.max(cur.range.start, cur.range.end) === draft.endLine) return;
    view.current?.setSelectedLines({ id: draft.path, range: { start: draft.startLine, end: draft.endLine, side } });
  }, [draft, count, indexOf]);
  const closeDraft = useCallback(() => {
    setDraft(null);
    view.current?.clearSelectedLines();
  }, [setDraft]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const { actions } = comments;
  const submitDraft = useCallback(async (body: string) => {
    const d = draftRef.current;
    const vf = d && byId.get(d.path);
    if (!d || !vf) return;
    const snippet = draftSnippet(vf.file.patch, contents.get(d.path), d);
    if (snippet === null) throw new Error("these lines aren't loaded: expand the context and select them again");
    const t = await actions.create({ commitOid: diff.headOid, baseOid: diff.baseOid, path: d.path, side: d.side, startLine: d.startLine, endLine: d.endLine, snippet, body });
    focusThread(t.id);
  }, [byId, contents, actions, diff.headOid, diff.baseOid, focusThread]);
  const createGeneral = useCallback(async (body: string) => {
    const t = await actions.create({ commitOid: diff.headOid, baseOid: diff.baseOid, body });
    focusThread(t.id);
  }, [actions, diff.headOid, diff.baseOid, focusThread]);

  const threadsState = useMemo((): ThreadsState => ({
    byId: threadById, placements, actions, me: comments.me, focused, focus: focusThread, expanded, setExpanded,
    draftScope: comments.key, draft, submitDraft, closeDraft, outdatedOpen, setOutdatedOpen,
  }), [threadById, placements, actions, comments.me, focused, focusThread, expanded, setExpanded, comments.key, draft, submitDraft, closeDraft, outdatedOpen, setOutdatedOpen]);

  // Threads render from ThreadsCtx: this stays the same function, so Pierre doesn't re-render every file for them.
  const renderAnnotation = useCallback((a: Annotation, item: Item) => {
    const note = a.metadata;
    if (!note) return null;
    if (note.kind === 'draft') return <DraftComposer />;
    if (note.kind === 'threads') return <LineThreads ids={note.ids} />;
    return <FileNotes path={item.id} ids={note.ids} outdated={note.outdated} />;
  }, []);

  // Deep link: `file` is the shell's URL as of opening; after that the URL only follows the viewer.
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const [initialFile] = useState(() => (file != null && byId.has(file) && file !== current.get() ? file : null));
  useEffect(() => { if (initialFile) goToRef.current(initialFile); }, [initialFile]);

  // Keyboard scrolling (arrows, Page Down, Space) needs focus in the scroller, not the shell's body.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || (a !== root.current && a.contains(root.current))) scroller.current?.focus({ preventScroll: true });
  }, []);

  // j/k: next/previous file (of those the file list shows); n/p: next/previous unresolved thread; c: comments
  // column; s: split/unified; w: wrap long lines (desktop only for both). Never while typing (a composer).
  const keyState = useRef({ navFiles, prefs, compact, ordered, focused, placements, showColumn });
  keyState.current = { navFiles, prefs, compact, ordered, focused, placements, showColumn };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive() || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(document.activeElement)) return;
      const s = keyState.current;
      if (e.key === 'j' || e.key === 'k') {
        const i = indexOf.get(current.get() ?? '') ?? -1;
        const next = e.key === 'j'
          ? s.navFiles.find((f) => indexOf.get(f.id)! > i)
          : s.navFiles.findLast((f) => indexOf.get(f.id)! < i);
        // At either end, j/k stay on the file (the list's first or last).
        if (next) { e.preventDefault(); goTo(next.id); }
      } else if (e.key === 'n' || e.key === 'p') {
        // Threads rank by file: the column's general ones before every file, those outside the diff after them all.
        const rankOf = (id: number) => {
          const p = s.placements.get(id);
          if (!p || p.kind === 'target') return -1;
          return p.kind === 'outdated' && p.reason === 'file' ? Infinity : indexOf.get(p.path) ?? Infinity;
        };
        const order = s.ordered.map((t) => ({ id: t.id, open: t.status === 'open' }));
        const next = stepThread(order, s.focused, e.key === 'n' ? 1 : -1, rankOf, indexOf.get(current.get() ?? '') ?? 0);
        if (next !== null) { e.preventDefault(); focusThread(next, { scroll: true }); }
      } else if (e.key === 'c') {
        e.preventDefault();
        setColumn(!s.showColumn);
      } else if (e.key === 's' && !s.compact) {
        e.preventDefault();
        updatePrefs({ split: !s.prefs.split });
      } else if (e.key === 'w' && !s.compact) {
        e.preventDefault();
        updatePrefs({ wrap: !s.prefs.wrap });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isActive, indexOf, current, goTo, updatePrefs, focusThread, setColumn]);

  const renderHeader = useCallback((item: Item) => {
    const vf = byId.get(item.id);
    if (!vf) return null;
    return (
      <FileHeader
        vf={vf}
        diffUrl={diff.url}
        collapsed={item.collapsed === true}
        onToggle={toggleCollapsed}
        contextFailed={failed.has(`${rev}\0${vf.id}`)}
      />
    );
  }, [byId, diff.url, rev, failed, toggleCollapsed]);

  // Desktop only (the compact list is a touch overlay); memoized so the file list doesn't re-render.
  const hints = useMemo(() => (compact ? undefined : (
    <div className="dvr-hints">
      <span><kbd>j</kbd> <kbd>k</kbd> files</span>
      <span><kbd>n</kbd> <kbd>p</kbd> threads</span>
      <span><kbd>c</kbd> comments</span>
      <span><kbd>s</kbd> split</span>
      <span><kbd>w</kbd> wrap</span>
    </div>
  )), [compact]);
  const onOnly = comments.onOnlyChange;
  const title = diff.kind === 'pr' ? `${diff.repo}#${diff.number}` : `${diff.repo}@${diff.headOid.slice(0, 7)}`;

  return (
    <div className={cx('diff-viewer', compact && 'compact')} ref={root} onKeyDown={expandControls.onKeyDown}>
      <div className="dvr-bar">
        <button type="button" className={cx('btn icon ghost dvr-list-btn', showList && 'on')} onClick={toggleList} aria-pressed={showList} title={showList ? 'Hide file list' : 'Show file list'} aria-label="File list">
          <Icon name="list" />
        </button>
        <Position current={current} indexOf={indexOf} total={files.length} />
        <span className="spacer" />
        {!compact && (
          <>
            <Seg
              className="sm"
              ariaLabel="Layout"
              value={split ? 'split' : 'unified'}
              onChange={(v) => updatePrefs({ split: v === 'split' })}
              options={[{ value: 'unified', label: 'Unified', title: 'Unified (s)' }, { value: 'split', label: 'Split', title: 'Split (s)' }]}
            />
            <button type="button" className={cx('tbl-btn', prefs.wrap && 'on')} aria-pressed={prefs.wrap} onClick={() => updatePrefs({ wrap: !prefs.wrap })} title="Wrap long lines (w)">Wrap</button>
          </>
        )}
        <button type="button" className={cx('btn ghost dvr-cm-btn', showColumn && 'on')} onClick={() => setColumn(!showColumn)} aria-pressed={showColumn}
          title={`${showColumn ? 'Hide' : 'Show'} comments (c)${comments.error ? " · couldn't load them" : ''}`} aria-label="Comments">
          <Icon name="comment" />
          {threads.length > 0 && <span className={cx('n', openCount > 0 && 'open')}>{openCount || threads.length}</span>}
          {comments.error && <span className="n err">!</span>}
        </button>
      </div>
      <ThreadsCtx.Provider value={threadsState}>
        <div className="dvr-main">
          {showList && <FileList files={navFiles} current={current} onPick={goTo} footer={hints} comments={counts} only={only} onOnly={onOnly} />}
          {compact && listOpen && <div className="dvr-scrim" onClick={() => setListOpen(false)} />}
          {files.length ? (
            <WorkerPoolContextProvider {...POOL}>
              <CodeView
                ref={view}
                containerRef={scroller}
                className="dvr-scroll"
                items={items}
                options={options}
                onScroll={onScroll}
                renderCustomHeader={renderHeader}
                renderAnnotation={renderAnnotation}
              />
            </WorkerPoolContextProvider>
          ) : (
            <div className="dvr-scroll dvr-empty">No changed files.</div>
          )}
          {showColumn && (
            <CommentsColumn threads={ordered} order={indexOf} title={title} kind={diff.kind}
              onJump={(id) => focusThread(id, { scroll: true })} onClose={() => setColumn(false)} onCreateGeneral={createGeneral} />
          )}
          {compact && columnOpen && <div className="dvr-scrim" onClick={() => setColumnOpen(false)} />}
        </div>
      </ThreadsCtx.Provider>
    </div>
  );
}
