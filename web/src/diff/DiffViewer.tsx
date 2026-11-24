/**
 * Diff viewer entry point, loaded lazily by the diff view shell. Built on @pierre/diffs: one
 * virtualized CodeView for every file (smooth on PRs with thousands of files) beside a hand-rolled
 * file list, with headers, colors and type in the app's own visual language (diff.css, pierre.css).
 * Local comment threads show as Pierre annotations under their lines, and all of them in the
 * comments column (Threads.tsx, CommentsColumn.tsx; placement in shared/comment-placement.ts).
 */
import type { CodeView as CodeViewClass, CodeViewItem, CodeViewOptions, CodeViewScrollTarget, DiffLineAnnotation, FileDiffLoadedFiles, FileDiffMetadata, LineAnnotation, PostRenderPhase, VirtualizedFileDiff } from '@pierre/diffs';
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from '@pierre/diffs/react';
import HighlightWorker from '@pierre/diffs/worker/worker.js?worker';
import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type Ref, type RefObject } from 'react';
import type { CommentThread, Diff, Me } from '../../../shared/api';
import { branchRef } from '../../../shared/comment-markdown';
import { createPlacer, patchLines, placeThreads, type SideLines } from '../../../shared/comment-placement';
import { PROVIDERS, type Provider } from '../../../shared/provider';
import type { useThreadActions } from '../api/hooks';
import { Icon } from '../components/Icon';
import { Seg, useToast, isTypingTarget, OverlayScope, useLayerHandle, useOverlayOwner, useFocusTrap } from '../workbench';
import { getDiffPrefs, setDiffPrefs, type DiffPrefs } from '../lib/storage';
import type { FileFilter } from '../lib/urlState';
import { cx } from '../lib/util';
import { CommentsColumn } from './CommentsColumn';
import { changeHunks, nearestChange, stepChange, type ChangeDirection, type ChangeHunk, type DiffLine } from './changeNavigation';
import { FileFindBar, type FileFindHandle, type FindSource } from './FileFindBar';
import { FileHeader, HEADER_HEIGHT } from './FileHeader';
import {
  getOpenNewDraft, isSendingDraft, listNewDrafts, loadNewDraft, newDraftsVersion, type NewThreadDraft, openNewDraft, removeNewDraft, sendingDrafts,
  setOpenNewDraft, setSendingDraft, subscribeNewDrafts,
} from './drafts';
import { createCurrentFile, FileList, type CurrentFile } from './FileList';
import { contextScrollTarget, readTextSelection, readViewport, readViewportAnchor, type DiffViewContext, type RenderedDiff } from './currentView';
import { fullContextDiff, waitForContextHighlight } from './fullContext';
import { buildFiles, parseFiles, toFileDiff, type ViewerFile } from './model';
import { hasFoldedCode, paintResolvedFolds, resolvedFolds, type FileFolds } from './resolvedFolds';
import { DraftComposer, FileNotes, LineThreads, ThreadsCtx, type ThreadsState } from './Threads';
import {
  annotationsFor, countsByFile, type DraftAnchor, draftSnippet, draftSpot, type Note, notesByFile, type PierreRange, pierreSide, readingOrder, selectionAnchor,
  stepThread,
} from './threadModel';
import unsafeCSS from './pierre.css?inline';
import { registerThemes, THEMES } from './theme';
import './diff.css';

export interface DiffViewerProps {
  diff: Diff;
  /** The diff's host, for the links to its files there; GitHub by default. */
  provider?: Provider;
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
  /** Reads the mounted viewport and selection when an agent asks the shell for its current view. */
  readView?: Ref<() => DiffViewContext>;
  comments: DiffComments;
}

/**
 * A thread or file asked for while the diff is open (the URL's `thread` or `file` changed from outside the viewer: an
 * agent's `show` for this diff). `n` counts them, so asking for the same place again goes there again.
 */
export interface DiffRequest { thread: number | null; file: string | null; n: number }

/** The diff's comment threads, from the shell (which owns the URL and the queries). */
export interface DiffComments {
  /** The threads' key (a PR's or branch's diff id, or a commit's with its full oid): drafts are stored under it. */
  key: string;
  /** undefined while loading. */
  threads: CommentThread[] | undefined;
  error: boolean;
  /** Load the threads again (after an error). */
  retry: () => void;
  actions: ReturnType<typeof useThreadActions>;
  me: Me | undefined;
  /** Thread to show on open (deep link, URL `thread`). */
  initialThread: number | null;
  /** A place asked for while open (see DiffRequest). */
  request?: DiffRequest | null;
  /** Reports the focused thread, for the URL. */
  onThreadFocus: (id: number | null) => void;
  /** The file list's filter (URL `only`); j/k follow it. */
  only: FileFilter | null;
  onOnlyChange: (only: FileFilter | null) => void;
}

type Item = CodeViewItem<Note>;
type CodeViewInstance = CodeViewClass<Note, undefined>;
type Annotation = DiffLineAnnotation<Note> | LineAnnotation<Note>;
type FullContext = 'loading' | FileDiffMetadata;
type FileScrollTarget = Exclude<CodeViewScrollTarget, { type: 'position' }>;
type LineScrollTarget = Extract<FileScrollTarget, { type: 'line' }>;
type LineJump = { path: string; target: LineScrollTarget; change?: ChangeHunk | undefined };
type RevealedFolds = { rev: string; path: string; ranges: FileFolds['hide']; find: boolean };
type ContextRestoration = {
  files: ViewerFile[];
  path: string;
  model: FileDiffMetadata | null;
  target: FileScrollTarget;
  navigation: number;
  change?: ChangeHunk | undefined;
};
const NO_THREADS: CommentThread[] = [];
const pathForItem = (id: string) => id.split('\0', 1)[0]!;

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
/**
 * "Comment on new line 17": the gutter "+" for the line it sits on. A line is old when it's a deleted one or sits in
 * a split view's left column; a unified view's context lines are numbered (and commented) on the new side.
 */
function namePlus(button: Element) {
  const cell = button.closest('[data-column-number]');
  if (!cell) return;
  const type = cell.getAttribute('data-line-type');
  const old = type === 'change-deletion' || (type !== 'change-addition' && cell.closest('[data-deletions]') !== null);
  const label = `Comment on ${old ? 'old' : 'new'} line ${cell.getAttribute('data-column-number')}`;
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

/** Keys that act while the compact comments column is open over the diff. */
const COLUMN_KEYS = new Set(['c', 'n', 'p', 'r', 'e']);
/** Keys that scroll the focused diff scroller (they end a jump's settling like a wheel does). */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/** An explicit Resolve can close an editor that regained focus while the save was pending. */
function focusResolvedSummary(summary: HTMLButtonElement) {
  summary.focus({ preventScroll: true });
  if (document.activeElement !== summary) return;
  const ignoreTyping = (event: KeyboardEvent) => {
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || summary.getAttribute('aria-expanded') !== 'false') return;
    event.preventDefault();
    event.stopPropagation();
  };
  const release = () => {
    summary.removeEventListener('keydown', ignoreTyping);
    summary.removeEventListener('blur', release);
    summary.removeEventListener('click', release);
  };
  summary.addEventListener('keydown', ignoreTyping);
  summary.addEventListener('blur', release);
  summary.addEventListener('click', release);
}

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
      const label = el.hasAttribute('data-expand-up')
        ? el.closest('[data-separator-last]') ? 'Expand toward end of file' : 'Expand down'
        : el.hasAttribute('data-expand-down') ? 'Expand up' : 'Expand all';
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

export default function DiffViewer({ diff, provider = PROVIDERS.github, loadFile, compact, isActive, file, onFileChange, comments, readView }: DiffViewerProps) {
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
  const findPaths = useMemo(() => files.map((f) => f.id), [files]);
  const [fullContext, setFullContext] = useState(() => ({ files, byFile: new Map<string, FullContext>(), resets: new Map<string, number>() }));
  if (fullContext.files !== files) setFullContext({ files, byFile: new Map(), resets: new Map() });
  const { byFile: fullByFile, resets } = fullContext;
  // A fresh item drops Pierre's existing and queued gap expansions when returning to the patch.
  const itemIdFor = useCallback((path: string) => {
    const reset = resets.get(path);
    return reset ? `${path}\0${reset}` : path;
  }, [resets]);
  const setFullFile = useCallback((id: string, value: FullContext | null, options?: { reset?: boolean; expected?: FullContext }) => {
    setFullContext((current) => {
      if (current.files !== files || (options?.expected !== undefined && current.byFile.get(id) !== options.expected)) return current;
      const byFile = new Map(current.byFile);
      if (value === null) byFile.delete(id);
      else byFile.set(id, value);
      const resets = options?.reset ? new Map(current.resets).set(id, (current.resets.get(id) ?? 0) + 1) : current.resets;
      return { files, byFile, resets };
    });
  }, [files]);
  const toast = useToast();

  // Comment threads: placed in this diff (shared/comment-placement.ts), then per file as Pierre annotations.
  const threads = comments.threads ?? NO_THREADS;
  const { files: diffFiles, headOid, baseOid } = diff;
  const placements = useMemo(() => placeThreads(threads, { files: diffFiles, headOid, baseOid }), [threads, diffFiles, headOid, baseOid]);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  // The compact diff anchors annotations to its patch. A full file can place them on any line of either revision.
  const shownLines = useMemo(() => new Map<string, { old: SideLines; new: SideLines }>(), [byId]);
  const patchShows = useCallback((path: string, side: 'old' | 'new', line: number) => {
    let sides = shownLines.get(path);
    if (!sides) {
      const patch = byId.get(path)?.file.patch;
      sides = patch ? patchLines(patch) : { old: new Map(), new: new Map() };
      shownLines.set(path, sides);
    }
    return sides[side].has(line);
  }, [byId, shownLines]);
  const shown = useCallback((path: string, side: 'old' | 'new', line: number) => {
    const full = fullByFile.get(path);
    if (!full || full === 'loading') return patchShows(path, side, line);
    return line > 0 && line <= (side === 'old' ? full.deletionLines.length : full.additionLines.length);
  }, [fullByFile, patchShows]);
  const notes = useMemo(() => notesByFile(threads, placements, shown), [threads, placements, shown]);
  const counts = useMemo(() => (threads.length ? countsByFile(threads, placements) : null), [threads, placements]);
  const ordered = useMemo(() => readingOrder(threads, placements, indexOf), [threads, placements, indexOf]);
  const openCount = useMemo(() => threads.filter((t) => t.status === 'open').length, [threads]);
  // The file list narrowed by its filter; j/k follow it.
  const only = comments.only;
  const navFiles = useMemo(() => (only
    ? files.filter((f) => { const c = counts?.get(f.id); return !!c && (only === 'commented' || c.unresolved > 0); })
    : files), [files, counts, only]);

  const [revealedFolds, setRevealedFolds] = useState<RevealedFolds | null>(null);
  const [focused, setFocused] = useState<number | null>(comments.initialThread);
  const [expanded, setExpandedIds] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [threadComposers, setThreadComposers] = useState<ReadonlyMap<number, number>>(new Map());
  const trackComposer = useCallback((id: number) => {
    const update = (delta: number) => setThreadComposers((counts) => {
      const next = new Map(counts);
      const count = (counts.get(id) ?? 0) + delta;
      if (count > 0) next.set(id, count);
      else next.delete(id);
      return next;
    });
    update(1);
    return () => update(-1);
  }, []);
  const setExpanded = useCallback((id: number, open: boolean) => {
    setRevealedFolds((folds) => folds?.find ? folds : null);
    setExpandedIds((s) => s.get(id) === open ? s : new Map(s).set(id, open));
  }, []);
  const isExpanded = useCallback((t: CommentThread) => expanded.get(t.id) ?? (t.status === 'open' || focused === t.id || threadComposers.has(t.id)),
    [expanded, focused, threadComposers]);
  const [outdatedOpen, setOutdatedPaths] = useState<ReadonlySet<string>>(new Set());
  const setOutdatedOpen = useCallback((path: string, open: boolean) => setOutdatedPaths((s) => {
    if (s.has(path) === open) return s;
    const next = new Set(s);
    if (open) next.add(path);
    else next.delete(path);
    return next;
  }), []);
  // The new thread being written: its record (drafts.ts: anchor and text together), open again after a reload like the
  // rest of the reader's place. It shows where placement puts it in the diff on screen, which may have moved on since
  // it was started. A draft opened on expanded context shows under its lines while the context stays expanded: Pierre
  // keeps it for this revision until the viewer goes (a reload folds it away again).
  const rev = `${diff.baseOid}..${diff.headOid}`;
  const scope = comments.key;
  const [open, setOpen] = useState<{ key: string; anchor: DraftAnchor } | null>(() => {
    const d = getOpenNewDraft(scope);
    return d && { key: d.key, anchor: d.anchor };
  });
  const draft = open?.anchor ?? null;
  const [draftOpenedAt, setDraftOpenedAt] = useState<string | null>(null);
  const showDraft = useCallback((d: NewThreadDraft | null, openedAt: string | null = null) => {
    setOpen(d && { key: d.key, anchor: d.anchor });
    setDraftOpenedAt(openedAt);
    setOpenNewDraft(scope, d?.key ?? null);
  }, [scope]);
  const openRef = useRef(open);
  openRef.current = open;
  /** The open draft steps aside (Esc, another one opening): kept, with its text, unless it has none. */
  const setAside = useCallback(() => {
    const cur = openRef.current;
    if (cur && !loadNewDraft(cur.key)?.body.trim()) removeNewDraft(cur.key);
  }, []);
  // The drafts set aside (on this revision or an earlier one): the comments column lists them to resume or discard.
  const draftsVersion = useSyncExternalStore(subscribeNewDrafts, newDraftsVersion);
  const openKey = open?.key;
  // draftsVersion: storage, read here, changed.
  const unsent = useMemo(() => listNewDrafts(scope).filter((d) => d.key !== openKey && d.body.trim() !== ''), [scope, openKey, draftsVersion]);
  const spot = useMemo(() => {
    if (!draft) return null;
    const visible = (side: 'old' | 'new', line: number) => draftOpenedAt === rev || shown(draft.path, side, line);
    return draftSpot(draft, diff.kind, createPlacer({ files: diffFiles, headOid, baseOid }), visible);
  }, [draft, draftOpenedAt, rev, shown, diff.kind, diffFiles, headOid, baseOid]);
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const [prefs, setPrefs] = useState(getDiffPrefs);
  const updatePrefs = useCallback((patch: Partial<DiffPrefs>) => {
    if (patch.foldResolved !== undefined) setRevealedFolds(null);
    setPrefs((p) => ({ ...p, ...patch }));
  }, []);
  useEffect(() => setDiffPrefs(prefs), [prefs]);
  const baseFoldPlan = useMemo(() => prefs.foldResolved ? resolvedFolds(threads, placements, isExpanded, shown,
    draft && spot?.at === 'line' ? { path: draft.path, ...spot } : null) : null, [prefs.foldResolved, threads, placements, isExpanded, shown, draft, spot]);
  const foldPlan = useMemo(() => {
    if (!baseFoldPlan || revealedFolds?.rev !== rev) return baseFoldPlan;
    const folds = baseFoldPlan.files.get(revealedFolds.path);
    if (!folds) return baseFoldPlan;
    return { ...baseFoldPlan, files: new Map(baseFoldPlan.files).set(revealedFolds.path, { ...folds, keep: [...folds.keep, ...revealedFolds.ranges] }) };
  }, [baseFoldPlan, revealedFolds, rev]);
  const foldPlanRef = useRef(foldPlan);
  foldPlanRef.current = foldPlan;
  const split = prefs.split && !compact;
  // Compact always wraps (code would run off a phone's screen); the saved preference is the desktop's.
  const wrap = prefs.wrap || compact;
  // The file list is a column on desktop (a saved preference) and an overlay toggled per visit on compact.
  const [listOpen, setListOpen] = useState(false);
  const showList = compact ? listOpen : prefs.files;
  // Esc closes the overlay before the diff view.
  const fileSurface = useRef<HTMLDivElement>(null);
  const fileOwner = useOverlayOwner(fileSurface);
  const fileLayer = useLayerHandle(compact && listOpen, () => setListOpen(false), true, fileSurface);
  useFocusTrap(fileSurface, compact && listOpen, { owner: fileOwner, layers: fileLayer.scope });
  const toggleList = () => (compact ? setListOpen((o) => !o) : updatePrefs({ files: !prefs.files }));
  // The comments column likewise: a saved preference beside the diff, an overlay per visit on compact.
  const [columnOpen, setColumnOpen] = useState(false);
  const showColumn = compact ? columnOpen : prefs.comments;
  // The compact column is a layer of its own (Esc closes it first); the comment keys still work while it's on top.
  // Composers inside it are layers above it (OverlayScope below).
  const columnSurface = useRef<HTMLDivElement>(null);
  const columnOwner = useOverlayOwner(columnSurface);
  const columnLayer = useLayerHandle(compact && columnOpen, () => setColumnOpen(false), true, columnSurface);
  useFocusTrap(columnSurface, compact && columnOpen, { owner: columnOwner, layers: columnLayer.scope });
  const columnIsTop = columnLayer.isTop;
  const setColumn = useCallback((open: boolean) => (compact ? setColumnOpen(open) : updatePrefs({ comments: open })), [compact, updatePrefs]);

  const [findOpen, setFindOpen] = useState(false);
  const findId = useId();
  const findButton = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findBar = useRef<FileFindHandle>(null);
  const findOpener = useRef<HTMLElement | null>(null);
  const openFind = useCallback((opener: HTMLElement | null) => {
    findOpener.current = opener;
    setFindOpen(true);
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setRevealedFolds((folds) => folds?.find ? null : folds);
    if (findInput.current?.parentElement?.contains(document.activeElement)) {
      const opener = findOpener.current;
      (opener?.isConnected && opener.checkVisibility({ visibilityProperty: true }) ? opener : findButton.current)?.focus({ preventScroll: true });
    }
    findOpener.current = null;
  }, []);
  const focusFind = useCallback(() => {
    findInput.current?.focus({ preventScroll: true });
    findInput.current?.select();
  }, []);
  useLayoutEffect(() => { if (findOpen) focusFind(); }, [findOpen, focusFind]);
  useEffect(() => {
    if (!findOpen || !files.length) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !isActive()) return;
      event.preventDefault();
      closeFind();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [closeFind, files.length, findOpen, isActive]);

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
    const d = draft?.path === vf.id ? spot : null;
    const folds = foldPlan?.files.get(vf.id);
    const sig = n || d || folds ? JSON.stringify([n, d, folds]) : '';
    const full = fullByFile.get(vf.id);
    const fileDiff = full && full !== 'loading' ? full : vf.fileDiff!;
    const id = itemIdFor(vf.id);
    const cached = itemCache.current.get(vf.id);
    if (cached && cached.flip === flip && cached.notes === sig && cached.item.id === id && cached.item.type === 'diff' && cached.item.fileDiff === fileDiff) return cached.item;
    const item: Item = {
      id, type: 'diff', fileDiff, version: (cached?.item.version ?? -1) + 1, collapsed: isCollapsed(vf),
      annotations: annotationsFor(n, d, vf.file.status === 'removed' ? 'deletions' : 'additions'),
    };
    itemCache.current.set(vf.id, { item, flip, notes: sig });
    return item;
  }), [files, count, flips, isCollapsed, notes, draft, spot, fullByFile, itemIdFor, foldPlan]);
  const folded = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, p] of foldPlan?.ranges ?? []) {
      const i = indexOf.get(p.path);
      const item = i === undefined ? undefined : items[i];
      const folds = foldPlan?.files.get(p.path);
      if (item?.type === 'diff' && folds && hasFoldedCode(item.fileDiff, folds, p)) ids.add(id);
    }
    return ids;
  }, [foldPlan, indexOf, items]);

  // Full contents Pierre loaded, per path: a new thread on expanded context takes its snippet from them. Keyed on
  // the revision, so a refreshed diff starts empty.
  const contents = useMemo(() => new Map<string, { old: string[] | null; new: string[] | null }>(), [rev]);
  // Both the gutter expander and the full-file action load the same two immutable revisions.
  // A failure leaves the hunks as they are and says so in the header. loadFile resolves null for
  // files the server can't serve (missing, binary, too large): those aren't asked for again. It
  // rejects on transient failures (network, rate limit), which the next click retries.
  // Both sets are keyed by revision and path: a refreshed diff (new head or merge base) asks again,
  // and a load still pending from the previous revision can't mark a file of the new one.
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
  const expansionVersions = useMemo(() => new Map<string, number>(), [files]);
  // Pierre keeps a hydrated patch and its expansions when the file scrolls out of view.
  const expandedPatches = useMemo(() => new Map<string, { id: string; instance: VirtualizedFileDiff<Note, undefined> }>(), [files]);
  const noteExpansion = useCallback((event: ReactMouseEvent) => {
    const control = event.nativeEvent.composedPath().find((element): element is HTMLElement => element instanceof HTMLElement &&
      (element.hasAttribute('data-expand-button') || element.hasAttribute('data-unmodified-lines')));
    if (!control?.closest('[data-expand-index]')) return;
    const root = control.getRootNode();
    if (!(root instanceof ShadowRoot)) return;
    const path = root.host.querySelector<HTMLElement>('.dvh')?.dataset.path;
    if (path) expansionVersions.set(path, (expansionVersions.get(path) ?? 0) + 1);
  }, [expansionVersions]);

  // A comment starts, as on GitHub, from the gutter's "+" (one line, or drag it over several) or from a range of
  // line numbers (drag, shift-click). A plain click on a number only selects that line.
  const openDraftRef = useRef((_id: string, _range: PierreRange) => {});
  openDraftRef.current = (id, range) => {
    const vf = byId.get(id);
    if (!vf) return;
    const lines = selectionAnchor(id, vf.file.patch, range);
    const snippet = draftSnippet(vf.file.patch, contents.get(id), lines);
    if (snippet === null) {
      toast("Couldn't read these lines: expand the context around them and select them again", { tone: 'error' });
      return;
    }
    // The draft for these lines at this revision: the one set aside earlier, or a new one.
    const d = openNewDraft(scope, { ...lines, commitOid: diff.headOid, baseOid: diff.baseOid, snippet });
    if (d.key !== openRef.current?.key) setAside();
    showDraft(d, rev);
  };
  // A plain click's line is let go at once (while any selection stands, Pierre parks the "+" at its end instead of
  // following the pointer; an open composer keeps its own lines selected). It's remembered instead, marked on its
  // number, as where a shift-click extends a range from.
  const dropClickRef = useRef(() => {});
  const clickAnchor = useRef<{ id: string; line: number; side: 'deletions' | 'additions' } | null>(null);
  const shiftClick = useRef(false);
  const onLineSelected = useCallback((range: PierreRange | null, context: { item?: { id: string } }) => {
    if (!range || !context.item) return;
    const id = pathForItem(context.item.id);
    const several = range.start !== range.end || (range.endSide !== undefined && range.endSide !== range.side);
    const a = clickAnchor.current;
    if (several) openDraftRef.current(id, range);
    else if (shiftClick.current && a?.id === id) openDraftRef.current(id, { start: a.line, side: a.side, end: range.end, endSide: range.side ?? 'additions' });
    else {
      clickAnchor.current = { id, line: range.start, side: range.side ?? 'additions' };
      requestAnimationFrame(() => dropClickRef.current());
      return;
    }
    clickAnchor.current = null;
    requestAnimationFrame(() => dropClickRef.current());
  }, []);
  const onGutterPlus = useCallback((range: PierreRange | null, context: { item?: { id: string } }) => {
    if (range && context.item) openDraftRef.current(pathForItem(context.item.id), range);
  }, []);

  // The focused thread's lines get a quiet tint: marked in Pierre's shadow DOM ([data-thread-line], styled in
  // pierre.css) after every render of their file, and again whenever focus moves. Not Pierre's selection: that
  // belongs to the reader, and while there is one Pierre parks the "+" at its end instead of following the pointer.
  const threadLines = useRef<{ path: string; side: 'old' | 'new'; start: number; end: number } | null>(null);
  const paintThreadLines = useCallback((host: HTMLElement) => {
    const root = host.shadowRoot;
    if (!root) return;
    for (const el of root.querySelectorAll('[data-thread-line], [data-anchor-line]')) {
      el.removeAttribute('data-thread-line');
      el.removeAttribute('data-anchor-line');
    }
    const path = host.querySelector('[data-path]')?.getAttribute('data-path');
    const a = clickAnchor.current;
    if (a && a.id === path) {
      const column = root.querySelector(a.side === 'deletions' ? '[data-deletions]' : '[data-additions]') ?? root;
      for (const cell of column.querySelectorAll(`[data-column-number="${a.line}"]`)) {
        if (cell.getAttribute('data-line-type') !== (a.side === 'deletions' ? 'change-addition' : 'change-deletion')) cell.setAttribute('data-anchor-line', '');
      }
    }
    const t = threadLines.current;
    if (!t || path !== t.path) return;
    // Split: the side's own column, where every row's number is that side's. Unified: a context row's number is the
    // new side's, its old one data-alt-line.
    const column = root.querySelector(t.side === 'old' ? '[data-deletions]' : '[data-additions]');
    const scope: ParentNode = column ?? root;
    for (const line of scope.querySelectorAll('[data-line][data-line-type]')) {
      const type = line.getAttribute('data-line-type');
      if (type === (t.side === 'new' ? 'change-deletion' : 'change-addition')) continue;
      const n = Number(line.getAttribute(!column && type === 'context' && t.side === 'old' ? 'data-alt-line' : 'data-line'));
      if (n < t.start || n > t.end) continue;
      line.setAttribute('data-thread-line', '');
      for (const cell of scope.querySelectorAll(`[data-column-number][data-line-index="${line.getAttribute('data-line-index')}"]`)) cell.setAttribute('data-thread-line', '');
    }
  }, []);
  // Pierre's gutter "+" is a bare icon button, created (or moved) under the pointer: it's named for its line as it
  // lands, by an observer on each file's shadow root.
  const namedRoots = useRef(new WeakSet<ShadowRoot>());
  const scheduleChanges = useRef(() => {});
  const onPostRender = useCallback((node: HTMLElement, instance: unknown, phase: PostRenderPhase,
    context: { item: Item } & ({ type: 'diff'; instance: VirtualizedFileDiff<Note, undefined> } | { type: 'file' })) => {
    expandControls.onPostRender(node, instance, phase);
    const path = pathForItem(context.item.id);
    if (phase !== 'unmount' && context.type === 'diff' && context.instance.fileDiff?.isPartial === false && expansionVersions.has(path)) {
      expandedPatches.set(path, { id: context.item.id, instance: context.instance });
    }
    findBar.current?.rendered(path);
    scheduleChanges.current();
    if (phase === 'unmount') return;
    paintThreadLines(node);
    const root = node.shadowRoot;
    if (root && paintResolvedFolds(root, foldPlanRef.current?.files.get(path))) {
      // Once Pierre measures the compacted rows, fill in the newly exposed viewport on the next frame.
      view.current?.getInstance()?.render();
    }
    if (root && !namedRoots.current.has(root)) {
      namedRoots.current.add(root);
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (!(n instanceof Element)) continue;
            const button = n.matches('[data-utility-button]') ? n : n.querySelector('[data-utility-button]');
            if (button) namePlus(button);
          }
        }
      }).observe(root, { childList: true, subtree: true });
    }
  }, [expandControls.onPostRender, expandedPatches, expansionVersions, paintThreadLines]);

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
    onPostRender,
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelected: onLineSelected as CodeViewOptions<Note, undefined>['onLineSelected'],
    onGutterUtilityClick: onGutterPlus as CodeViewOptions<Note, undefined>['onGutterUtilityClick'],
  }), [theme, split, wrap, compact, diff.baseOid, loadDiffFiles, onPostRender, onLineSelected, onGutterPlus]);

  // The file in view: the last file whose top has scrolled past the top edge. After a jump to a
  // file that can't reach the top (the end of the diff), that file stays current until the user
  // scrolls. Kept outside React state: a change re-renders two file list rows, not the viewer.
  const view = useRef<CodeViewHandle<Note, undefined>>(null);
  // Starts on the first file without reporting it: nothing to put in the URL until the reader moves.
  const [current] = useState(() => createCurrentFile(files[0]?.id ?? null));
  const pinned = useRef<string | null>(null);
  const changeJump = useRef<{ path: string; change: ChangeHunk } | null>(null);
  const navigation = useRef(0);
  // A jump to a thread centers its line, often with its file's top still below the viewport's: the file stays the
  // one in view (and in the URL) until the reader scrolls.
  const holdPin = useRef(false);
  const reported = useRef<string | null>(current.get());
  const onFileChangeRef = useRef(onFileChange);
  onFileChangeRef.current = onFileChange;
  useEffect(() => current.subscribe(() => {
    const id = current.get();
    setRevealedFolds((folds) => folds?.path === id ? folds : null);
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
      if ((cv.getTopForItem(itemIdFor(files[mid].id)) ?? 0) <= scrollTop + GAP + 1) lo = mid;
      else hi = mid - 1;
    }
    let id = files[lo].id;
    const el = scroller.current;
    const atEnd = el != null && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (pinned.current && (atEnd || holdPin.current) && indexOf.get(pinned.current)! > lo) id = pinned.current;
    else pinned.current = null;
    current.set(id);
  }, [files, count, indexOf, current, itemIdFor]);
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
    else {
      changeJump.current = null;
      follow(scrollTop, cv);
    }
    scheduleChanges.current();
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
      navigation.current++;
      changeJump.current = null;
      scheduleChanges.current();
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.addEventListener(type, release, { passive: true });
    // Whether the click Pierre reports as a line selection had Shift held (it extends from the last clicked line).
    const noteShift = (e: PointerEvent) => { shiftClick.current = e.shiftKey; };
    el.addEventListener('pointerdown', noteShift, { capture: true, passive: true });
    return () => {
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.removeEventListener(type, release);
      el.removeEventListener('pointerdown', noteShift, { capture: true });
      clearTimeout(settling.current);
    };
  }, [hasFiles]);

  // A jump to a file not parsed yet parses up to it right away and scrolls once the CodeView has it. `target`
  // scrolls to a place in the file (a thread's line) instead of its top.
  const countRef = useRef(count);
  countRef.current = count;
  const jumpTo = useRef<{ id: string; target: FileScrollTarget } | null>(null);
  const goTo = useCallback((id: string, target: FileScrollTarget = { type: 'item', id, align: 'start' }, change?: ChangeHunk) => {
    navigation.current++;
    changeJump.current = change ? { path: id, change } : null;
    pinned.current = id;
    holdPin.current = target.type === 'line';
    current.set(id);
    settle();
    const i = indexOf.get(id) ?? 0;
    if (i < countRef.current) view.current?.scrollTo({ ...target, id: itemIdFor(id) });
    else {
      jumpTo.current = { id, target };
      setParsed((p) => (p.files === files ? { files, count: parseFiles(files, p.count, Infinity, i + 1) } : p));
    }
    if (compact) setListOpen(false);
    scheduleChanges.current();
  }, [current, compact, files, indexOf, itemIdFor, settle]);
  useEffect(() => {
    const j = jumpTo.current;
    if (j == null || (indexOf.get(j.id) ?? Infinity) >= count) return;
    jumpTo.current = null;
    settle();
    view.current?.scrollTo({ ...j.target, id: itemIdFor(j.id) });
  }, [count, indexOf, itemIdFor, settle]);

  const getRenderedFile = useCallback((path: string) => view.current?.getInstance()?.getRenderedItems()
    .find((item) => item.type === 'diff' && item.id === itemIdFor(path)), [itemIdFor]);
  const readAnchor = useCallback((path: string, pick?: (line: DiffLine) => boolean) => {
    const host = getRenderedFile(path)?.element;
    return host && scroller.current ? readViewportAnchor(host, scroller.current, pick) : null;
  }, [getRenderedFile]);

  const readFindSource = useCallback((path: string): FindSource | null => {
    const full = fullByFile.get(path);
    if (full && full !== 'loading') return { model: full };
    const file = byId.get(path);
    if (!file?.file.patch) return null;
    const expanded = expandedPatches.get(path);
    const instance = expanded?.id === itemIdFor(path) ? expanded.instance : undefined;
    if (instance?.fileDiff && !instance.fileDiff.isPartial) {
      return {
        model: instance.fileDiff, expansionVersion: expansionVersions.get(path),
        isContextVisible: (line) => instance.isLineRenderable(line),
      };
    }
    return { model: file.fileDiff ??= toFileDiff(file.file, file.cacheKey) };
  }, [byId, expandedPatches, expansionVersions, fullByFile, itemIdFor]);
  const readFindRoots = useCallback(() => (view.current?.getInstance()?.getRenderedItems() ?? []).flatMap((item) => {
    const path = pathForItem(item.id);
    const root = item.element.shadowRoot;
    return root && item.id === itemIdFor(path) ? [{ path, root }] : [];
  }), [itemIdFor]);

  const pendingLine = useRef<LineJump | null>(null);
  const seekLine = useCallback((path: string, line: DiffLine, source: 'find' | 'change', change?: ChangeHunk) => {
    const vf = byId.get(path);
    if (!vf) return;
    const target: LineScrollTarget = { type: 'line', id: path, lineNumber: line.lineNumber, side: pierreSide(line.side),
      ...(source === 'find' ? { align: 'nearest', offset: 24 } as const : { align: 'start', offset: LINE_HEIGHT } as const) };
    const folds = baseFoldPlan?.files.get(path);
    const full = fullByFile.get(path);
    const model = full && full !== 'loading' ? full : vf.fileDiff;
    const at = { side: line.side, startLine: line.lineNumber, endLine: line.lineNumber };
    // Reveal the enclosing range. A single row in a long run of zero-height rows can stay outside
    // Pierre's rendered window even after it is made visible.
    const hidden = folds && model ? folds.hide.filter((range) => hasFoldedCode(model, { hide: [range], keep: folds.keep }, at)) : [];
    const opensFile = isCollapsed(vf);
    const nextReveal = hidden.length ? { path, rev, ranges: hidden, find: source === 'find' } : null;
    const sameReveal = revealedFolds === nextReveal || (nextReveal && revealedFolds?.path === path && revealedFolds.rev === rev &&
      revealedFolds.find === nextReveal.find && revealedFolds.ranges.length === hidden.length && hidden.every((range, index) => range === revealedFolds.ranges[index]));
    if (sameReveal && !opensFile) {
      goTo(path, target, change);
      return;
    }
    pendingLine.current = { path, target, change };
    if (!sameReveal) setRevealedFolds(nextReveal);
    if (opensFile) toggleCollapsed(path);
  }, [baseFoldPlan, byId, fullByFile, goTo, isCollapsed, revealedFolds, rev, toggleCollapsed]);
  const previousFolds = useRef<RevealedFolds | null>(null);
  useLayoutEffect(() => {
    if (previousFolds.current !== revealedFolds) {
      const cv = view.current?.getInstance();
      const paths = new Set([previousFolds.current, revealedFolds].flatMap((entry) => entry?.rev === rev ? [entry.path] : []));
      previousFolds.current = revealedFolds;
      for (const path of paths) {
        const rendered = getRenderedFile(path);
        if (rendered?.type !== 'diff') continue;
        // Clear measured zero-height rows before asking Pierre for a target inside a restored fold.
        rendered.instance.invalidateEditSessionLayout();
        cv?.instanceChanged(rendered.instance, true);
      }
    }
    const pending = pendingLine.current;
    if (!pending) return;
    pendingLine.current = null;
    goTo(pending.path, pending.target, pending.change);
  }, [getRenderedFile, items, goTo, revealedFolds, rev]);
  const seekMatch = useCallback((path: string, line: DiffLine) => seekLine(path, line, 'find'), [seekLine]);

  const changesByPatch = useRef(new WeakMap<FileDiffMetadata['hunks'], readonly ChangeHunk[]>());
  const stopsFor = useCallback((path: string) => {
    const hunks = byId.get(path)?.fileDiff?.hunks;
    if (!hunks) return [];
    const found = changesByPatch.current.get(hunks);
    if (found) return found;
    const changes = changeHunks(hunks);
    changesByPatch.current.set(hunks, changes);
    return changes;
  }, [byId]);
  const changeFiles = useMemo(() => navFiles.filter((file) => file.file.patch), [navFiles]);
  const localChangeAt = useCallback((path: string, anchor: DiffLine | null, direction: ChangeDirection) => {
    const pin = changeJump.current;
    return stepChange(stopsFor(path), anchor, direction, pin?.path === path ? pin.change : undefined, split);
  }, [split, stopsFor]);
  const changeFocus = useRef<{ path: string; direction: ChangeDirection; opener: HTMLButtonElement; navigation: number } | null>(null);
  const onStepChange = useCallback((path: string, direction: ChangeDirection, button: HTMLButtonElement) => {
    const local = localChangeAt(path, readAnchor(path), direction);
    if (local) {
      seekLine(path, local.target, 'change', local);
      return;
    }
    const here = indexOf.get(path);
    if (here === undefined) return;
    for (let i = direction === 1 ? 0 : changeFiles.length - 1; i >= 0 && i < changeFiles.length; i += direction) {
      const file = changeFiles[i]!;
      if (direction * (indexOf.get(file.id)! - here) <= 0) continue;
      // The background parse may not have reached this file yet. Go through the normal jump
      // path, which mounts up to the destination, after parsing just enough to pick its stop.
      file.fileDiff ??= toFileDiff(file.file, file.cacheKey);
      const stops = stopsFor(file.id);
      const change = direction === 1 ? stops[0] : stops.at(-1);
      if (!change) continue;
      if (document.activeElement === button) changeFocus.current = { path: file.id, direction, opener: button, navigation: navigation.current + 1 };
      seekLine(file.id, change.target, 'change', change);
      return;
    }
    scheduleChanges.current();
  }, [changeFiles, indexOf, localChangeAt, readAnchor, seekLine, stopsFor]);

  const [changeAvailability, setChangeAvailability] = useState<ReadonlyMap<string, number>>(new Map());
  // The tail may finish parsing without touching any rendered header.
  useLayoutEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const cv = view.current?.getInstance();
        if (!cv) return;
        const rendered = cv.getRenderedItems();
        const canVisit = (file: ViewerFile) => !file.fileDiff || stopsFor(file.id).length > 0;
        const earliest = indexOf.get(changeFiles.find(canVisit)?.id ?? '') ?? Infinity;
        const latest = indexOf.get(changeFiles.findLast(canVisit)?.id ?? '') ?? -Infinity;
        const next = new Map<string, number>();
        for (const item of rendered) {
          const path = pathForItem(item.id);
          if (!stopsFor(path).length) continue;
          const index = indexOf.get(path)!;
          const earlier = earliest < index;
          const later = latest > index;
          if (earlier && later) {
            next.set(path, 3);
            continue;
          }
          const anchor = scroller.current ? readViewportAnchor(item.element, scroller.current) : null;
          next.set(path, Number(earlier || !!localChangeAt(path, anchor, -1)) + 2 * Number(later || !!localChangeAt(path, anchor, 1)));
        }
        setChangeAvailability((previous) => next.size === previous.size && [...next].every(([path, state]) => previous.get(path) === state) ? previous : next);

        const focus = changeFocus.current;
        if (!focus || navigation.current < focus.navigation) return;
        const active = document.activeElement;
        // When Pierre virtualizes the focused header away, it returns focus to the scroller.
        const lostOpener = !focus.opener.isConnected && (active === document.body || active === scroller.current);
        if (navigation.current !== focus.navigation || (active !== focus.opener && !lostOpener)) {
          changeFocus.current = null;
          return;
        }
        const host = rendered.find((item) => pathForItem(item.id) === focus.path)?.element;
        const viewport = scroller.current?.getBoundingClientRect();
        const bounds = host?.getBoundingClientRect();
        if (!host || !viewport || !bounds || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return;
        const arrow = host.querySelector<HTMLButtonElement>(`[data-change-direction="${focus.direction}"]`);
        changeFocus.current = null;
        (arrow ?? scroller.current)?.focus({ preventScroll: true });
      });
    };
    scheduleChanges.current = schedule;
    schedule();
    return () => { scheduleChanges.current = () => {}; cancelAnimationFrame(frame); };
  }, [changeFiles, count, indexOf, localChangeAt, stopsFor]);

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
    setExpanded(id, true);
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
  }, [goTo, setColumn, setExpanded, setOutdatedOpen, toggleCollapsed]);
  const focusThread = useCallback((id: number | null, opts: { scroll?: boolean } = {}) => {
    setFocused(id);
    onThreadFocusRef.current(id);
    if (id !== null && opts.scroll) jumpToThread(id);
  }, [jumpToThread]);

  // The composer's lines (where they are now) stay selected, also when it comes back after a reload (Pierre keeps the
  // selection of a file that isn't rendered yet and paints it when it is).
  const draftLines = draft && spot?.at === 'line' ? { path: draft.path, ...spot } : null;
  useImperativeHandle(readView, () => () => {
    const file = byId.get(current.get() ?? '');
    const rendered = view.current?.getInstance()?.getRenderedItems() ?? [];
    const scroll = scroller.current?.getBoundingClientRect();
    const top = Math.max(scroll?.top ?? 0, 0);
    const bottom = Math.min(scroll?.bottom ?? 0, window.innerHeight);
    const sources: RenderedDiff[] = [];
    const visibleRoots = new Map<string, ShadowRoot>();
    let viewport: DiffViewContext['viewport'] = null;
    for (const item of rendered) {
      const root = item.element.shadowRoot;
      if (!root) continue;
      const path = pathForItem(item.id);
      sources.push({ path, root });
      const bounds = item.element.getBoundingClientRect();
      if (bounds.height === 0 || bounds.bottom <= top || bounds.top >= bottom) continue;
      visibleRoots.set(path, root);
      if (path === file?.id) {
        const headerBottom = item.element.querySelector('.dvh')?.getBoundingClientRect().bottom ?? top;
        viewport = readViewport(root, Math.max(top, headerBottom), bottom, file.fileDiff?.hunks ?? []);
      }
    }

    let selection: DiffViewContext['selection'] = readTextSelection(sources);
    if (!selection) {
      const selected = view.current?.getSelectedLines();
      const selectedFile = selected ? byId.get(pathForItem(selected.id)) : undefined;
      if (selected && selectedFile && visibleRoots.has(selectedFile.id)) {
        selection = { kind: 'lines', ...selectionAnchor(selectedFile.id, selectedFile.file.patch, selected.range) };
      } else {
        const anchor = clickAnchor.current;
        if (anchor && visibleRoots.get(anchor.id)?.querySelector('[data-anchor-line]')?.checkVisibility({ visibilityProperty: true })) {
          const side = anchor.side === 'deletions' ? 'old' : 'new';
          selection = { kind: 'lines', path: anchor.id, side, startLine: anchor.line, endLine: anchor.line };
        }
      }
    }
    return { file: file ? { path: file.id, previousPath: file.file.previousPath } : null, viewport, selection, threadId: focused };
  }, [byId, current, focused]);
  const draftSel = draftLines ? `${draftLines.path}\0${draftLines.side}\0${draftLines.startLine}\0${draftLines.endLine}` : '';
  const selectDraft = useCallback((sel: string) => {
    const [path, side, start, end] = sel.split('\0');
    const cv = view.current;
    if (!sel) return;
    const id = itemIdFor(path!);
    const cur = cv?.getSelectedLines();
    if (cur?.id === id && Math.min(cur.range.start, cur.range.end) === Number(start) && Math.max(cur.range.start, cur.range.end) === Number(end)) return;
    cv?.setSelectedLines({ id, range: { start: Number(start), end: Number(end), side: pierreSide(side as 'old' | 'new') } });
  }, [itemIdFor]);
  useEffect(() => {
    const path = draftSel.split('\0')[0]!;
    if (draftSel && (indexOf.get(path) ?? Infinity) < count) selectDraft(draftSel);
  }, [draftSel, count, indexOf, selectDraft]);
  // A draft whose file left the diff waits in the comments column: open it when that's where the open draft is.
  const draftGone = spot?.at === 'gone';
  useEffect(() => { if (draftGone) setColumn(true); }, [draftGone, setColumn]);
  const closeDraft = useCallback(() => {
    setAside();
    showDraft(null);
    view.current?.clearSelectedLines();
  }, [setAside, showDraft]);
  const discardDraft = useCallback(() => {
    if (openRef.current) removeNewDraft(openRef.current.key);
    showDraft(null);
    view.current?.clearSelectedLines();
  }, [showDraft]);
  // Focus moved (or its thread moved): repaint the files on screen; the rest paint as they render.
  const focusedPlace = focused === null ? undefined : placements.get(focused);
  const tint = focusedPlace?.kind === 'line' ? `${focusedPlace.path}\0${focusedPlace.side}\0${focusedPlace.startLine}\0${focusedPlace.endLine}` : '';
  useEffect(() => {
    const [path, side, start, end] = tint.split('\0');
    threadLines.current = tint ? { path: path!, side: side as 'old' | 'new', start: Number(start), end: Number(end) } : null;
    for (const host of scroller.current?.querySelectorAll<HTMLElement>('diffs-container') ?? []) paintThreadLines(host);
  }, [tint, paintThreadLines]);
  dropClickRef.current = () => {
    view.current?.clearSelectedLines();
    selectDraft(draftSel);
    for (const host of scroller.current?.querySelectorAll<HTMLElement>('diffs-container') ?? []) paintThreadLines(host);
  };
  const { actions } = comments;
  // Drafts being sent (drafts.ts, by key): the composer that sent one may be set aside (Esc), or this viewer replaced
  // (Back, Forward), and the draft reopened meanwhile; it stays read-only until the answer, which removes the version
  // sent and closes only a composer still showing that draft.
  const sending = useMemo(() => sendingDrafts(), [draftsVersion]);
  // A draft sent (or discarded) by another viewer, one this one replaced, goes from here too.
  useEffect(() => {
    if (open && !loadNewDraft(open.key)) {
      showDraft(null);
      view.current?.clearSelectedLines();
    }
  }, [open, draftsVersion, showDraft]);
  // A send can finish after the reader has left this diff (Back, another diff): the draft and the cached threads are
  // settled all the same, but only a viewer still showing the diff focuses the new thread (its URL setter would
  // otherwise take the reader back). The same for a general comment (createGeneral).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // As it was started (see DraftAnchor), whatever the diff shows now.
  const submitDraft = useCallback(async (body: string) => {
    const cur = openRef.current;
    if (!cur || isSendingDraft(cur.key)) return;
    setSendingDraft(cur.key, true);
    try {
      const { path, side, startLine, endLine, commitOid, baseOid: base, snippet } = cur.anchor;
      const t = await actions.create({ commitOid, baseOid: base, path, side, startLine, endLine, snippet, body });
      removeNewDraft(cur.key, body);
      if (!mounted.current) return;
      if (openRef.current?.key === cur.key) {
        showDraft(null);
        view.current?.clearSelectedLines();
      }
      focusThread(t.id);
    } finally {
      setSendingDraft(cur.key, false);
    }
  }, [actions, focusThread, showDraft]);
  // A draft set aside, open again where it shows now.
  const resumeDraft = useCallback((key: string) => {
    const d = loadNewDraft(key);
    if (!d) return;
    if (key !== openRef.current?.key) setAside();
    showDraft(d);
    const l = live.current;
    const at = draftSpot(d.anchor, diff.kind, createPlacer({ files: diffFiles, headOid, baseOid }), (side, line) => l.shown(d.anchor.path, side, line));
    const vf = l.byId.get(d.anchor.path);
    if (!vf || at.at === 'gone') return;
    if (l.compact) setColumnOpen(false);
    if (l.isCollapsed(vf)) toggleCollapsed(vf.id);
    goTo(vf.id, at.at === 'line' ? { type: 'line', id: vf.id, lineNumber: at.endLine, side: pierreSide(at.side), align: 'center' } : { type: 'item', id: vf.id, align: 'start' });
  }, [setAside, showDraft, diff.kind, diffFiles, headOid, baseOid, goTo, toggleCollapsed]);
  const createGeneral = useCallback(async (body: string) => {
    const t = await actions.create({ commitOid: diff.headOid, baseOid: diff.baseOid, body });
    if (mounted.current) focusThread(t.id);
  }, [actions, diff.headOid, diff.baseOid, focusThread]);

  // r: the focused thread's reply box (brought into view first if its card isn't on screen); e: resolve or reopen it.
  const [replyRequest, setReplyRequest] = useState<number | null>(null);
  const takeReply = useCallback(() => setReplyRequest(null), []);
  const replyToFocused = useCallback((id: number) => {
    const el = document.querySelector(`.dth[data-thread="${id}"]`);
    const box = scroller.current?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    const inColumn = el?.closest('.dcc') != null;
    // On compact, the open column covers the diff: an inline thread has to come out from under it.
    const covered = live.current.compact && columnIsTop() && !inColumn;
    const onScreen = !!r && r.height > 0 && !covered && (inColumn || (!!box && r.bottom > box.top && r.top < box.bottom));
    if (onScreen) setExpanded(id, true);
    else jumpToThread(id);
    setReplyRequest(id);
  }, [jumpToThread, columnIsTop, setExpanded]);
  // Both mutations in this view and streamed updates replace the thread data. Apply the same
  // expansion change only when a status changes, so a resolved thread can still be opened by hand.
  const previousThreads = useRef(threadById);
  const pendingCollapse = useRef(new Set<number>());
  const focusAfterCollapse = useRef<HTMLButtonElement | null>(null);
  // Focus can move while Resolve is saving. Keep the user's intent until the resolved data arrives.
  const resolveRequests = useRef(new Map<number, symbol>());
  useLayoutEffect(() => {
    const previous = previousThreads.current;
    const expansion = new Map<number, boolean>();
    if (previous !== threadById) {
      previousThreads.current = threadById;
      const active = document.activeElement;
      const editor = active instanceof HTMLTextAreaElement ? active : null;
      const editing = editor?.closest<HTMLElement>('.dth')?.dataset.thread;
      for (const thread of threads) {
        const before = previous.get(thread.id);
        const resolvedHere = thread.status === 'resolved' && resolveRequests.current.delete(thread.id);
        if (!resolvedHere && (!before || before.status === thread.status)) continue;
        if (thread.status === 'resolved' && !resolvedHere && editing === String(thread.id) && threadComposers.has(thread.id)) {
          pendingCollapse.current.add(thread.id);
        } else {
          if (resolvedHere && editing === String(thread.id)) {
            focusAfterCollapse.current = editor?.closest('.dth')?.querySelector<HTMLButtonElement>('.dth-sum') ?? null;
          }
          pendingCollapse.current.delete(thread.id);
          expansion.set(thread.id, thread.status === 'open');
        }
      }
    }
    // Let a reader continue typing until their reply or edit closes.
    for (const id of pendingCollapse.current) {
      if (threadById.get(id)?.status !== 'resolved') pendingCollapse.current.delete(id);
      else if (!threadComposers.has(id)) {
        pendingCollapse.current.delete(id);
        expansion.set(id, false);
      }
    }
    if (!expansion.size) return;
    setRevealedFolds((folds) => {
      if (!folds || folds.find) return folds;
      for (const id of expansion.keys()) {
        const placement = placements.get(id);
        if (placement && 'path' in placement && placement.path === folds.path) return null;
      }
      return folds;
    });
    setExpandedIds((expanded) => {
      const next = new Map(expanded);
      for (const [id, open] of expansion) next.set(id, open);
      return next;
    });
    if (focused !== null && expansion.get(focused) === false) focusThread(null);
  }, [focused, focusThread, placements, threadById, threadComposers, threads]);
  useLayoutEffect(() => {
    const summary = focusAfterCollapse.current;
    if (summary?.isConnected && summary.getAttribute('aria-expanded') !== 'false') return;
    focusAfterCollapse.current = null;
    if (summary?.isConnected && document.activeElement === document.body) focusResolvedSummary(summary);
  }, [expanded]);
  const setStatus = useCallback(async (id: number, status: CommentThread['status']) => {
    const request = Symbol();
    if (status === 'resolved') resolveRequests.current.set(id, request);
    else resolveRequests.current.delete(id);
    let resolved = false;
    try {
      resolved = (await actions.setStatus(id, status)).status === 'resolved';
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, { tone: 'error' });
    } finally {
      if (!resolved && resolveRequests.current.get(id) === request) resolveRequests.current.delete(id);
    }
  }, [actions, toast]);
  const toggleResolved = useCallback((t: CommentThread) => { void setStatus(t.id, t.status === 'open' ? 'resolved' : 'open'); }, [setStatus]);

  const threadsState = useMemo((): ThreadsState => ({
    byId: threadById, placements, actions, me: comments.me, focused, focus: focusThread, isExpanded, setExpanded, setStatus, folded, trackComposer,
    draftScope: comments.key, draftKey: openKey ?? null, draft, draftSpot: spot, submitDraft, closeDraft, discardDraft,
    draftSending: openKey !== undefined && sending.has(openKey), outdatedOpen, setOutdatedOpen, replyRequest, takeReply,
  }), [
    threadById, placements, actions, comments.me, focused, focusThread, isExpanded, setExpanded, setStatus, folded, trackComposer, comments.key, openKey, draft, spot, submitDraft, closeDraft,
    discardDraft, sending, outdatedOpen, setOutdatedOpen, replyRequest, takeReply,
  ]);

  // Threads render from ThreadsCtx: this stays the same function, so Pierre doesn't re-render every file for them.
  const renderAnnotation = useCallback((a: Annotation, item: Item) => {
    const note = a.metadata;
    if (!note) return null;
    if (note.kind === 'draft') return <DraftComposer />;
    if (note.kind === 'threads') return <LineThreads ids={note.ids} />;
    return <FileNotes path={pathForItem(item.id)} ids={note.ids} outdated={note.outdated} draft={note.draft} />;
  }, []);

  // Deep link: the shell's URL as of opening; after that the URL only follows the viewer. Its thread wins (its line
  // can be anywhere in its file, and its file is in the URL too); the file is the fallback, for a thread that's gone
  // (it leaves the URL) or threads that couldn't be loaded. Each is restored once per mount: the file at once when
  // there's no thread, else when the threads are in, never again after (the reader may have moved on). Per mount: in
  // development StrictMode remounts the CodeView, dropping a first scroll.
  const [initial] = useState(() => ({
    thread: comments.initialThread,
    file: file != null && byId.has(file) && file !== current.get() ? file : null,
  }));
  const threadsSettled = comments.threads !== undefined || comments.error;
  const restore = useRef({ goTo, jumpToThread, focusThread, threadById, error: comments.error });
  restore.current = { goTo, jumpToThread, focusThread, threadById, error: comments.error };
  useEffect(() => {
    if (initial.thread === null && initial.file) restore.current.goTo(initial.file);
  }, [initial]);
  useEffect(() => {
    if (initial.thread === null || !threadsSettled) return;
    const l = restore.current;
    if (l.threadById.has(initial.thread)) l.jumpToThread(initial.thread);
    else {
      if (!l.error) l.focusThread(null);
      if (initial.file) l.goTo(initial.file);
    }
  }, [initial, threadsSettled]);

  // A place asked for while open: its thread (the shell refetched the threads first), else its file.
  const request = comments.request ?? null;
  const hasFile = useRef((path: string) => byId.has(path));
  hasFile.current = (path) => byId.has(path);
  useEffect(() => {
    if (!request) return;
    const l = restore.current;
    if (request.thread !== null && l.threadById.has(request.thread)) l.focusThread(request.thread, { scroll: true });
    else if (request.file !== null && hasFile.current(request.file)) l.goTo(request.file);
  }, [request]);

  // Keyboard scrolling (arrows, Page Down, Space) needs focus in the scroller, not the shell's body.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || (a !== root.current && a.contains(root.current))) scroller.current?.focus({ preventScroll: true });
  }, []);

  // j/k: next/previous file (of those the file list shows); n/p: next/previous unresolved thread; r/e: reply to /
  // resolve or reopen the focused thread; c: comments column; s: split/unified; w: wrap long lines (desktop only for
  // both). Never while typing (a composer).
  const keyState = useRef({ navFiles, prefs, compact, ordered, focused, placements, showColumn, threadById });
  keyState.current = { navFiles, prefs, compact, ordered, focused, placements, showColumn, threadById };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = isActive();
      if (active && hasFiles && !e.defaultPrevented && !e.isComposing && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        const focused = document.activeElement;
        const surface = root.current?.closest('.diff-view') ?? root.current;
        if (focused && focused !== document.body && !surface?.contains(focused)) return;
        if (isTypingTarget(focused) && focused !== findInput.current) return;
        e.preventDefault();
        if (findOpen) focusFind();
        else {
          const opener = focused?.shadowRoot?.activeElement ?? focused;
          openFind(opener instanceof HTMLElement && opener !== document.body ? opener : scroller.current);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(document.activeElement)) return;
      // The diff view on top, or the compact comments column over it (only the comment keys then). Under anything
      // else (a composer, a dialog, the compact file list) the keys are its own.
      if (!active && !(columnIsTop() && COLUMN_KEYS.has(e.key))) return;
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
      } else if (e.key === 'r' || e.key === 'e') {
        const t = s.focused === null ? undefined : s.threadById.get(s.focused);
        if (!t) return;
        e.preventDefault();
        if (e.key === 'r') replyToFocused(t.id);
        else toggleResolved(t);
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
  }, [isActive, hasFiles, findOpen, focusFind, openFind, columnIsTop, indexOf, current, goTo, updatePrefs, focusThread, setColumn, replyToFocused, toggleResolved]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const contextRestore = useRef<ContextRestoration | null>(null);
  const resetPath = useRef<string | null>(null);
  const resetFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const restore = contextRestore.current;
    if (restore && (restore.files !== files || restore.navigation !== navigation.current)) contextRestore.current = null;
    else if (restore && (fullByFile.get(restore.path) ?? null) === restore.model) {
      contextRestore.current = null;
      goTo(restore.path, restore.target, restore.change);
    }
    const path = resetPath.current;
    if (path === null) return;
    resetPath.current = null;
    const cv = view.current?.getInstance();
    if (!cv) return;
    const id = itemIdFor(path);
    const top = cv.getTopForItem(id);
    // After a deep scroll in the full file, the reset can leave its header above the viewport.
    if (top !== undefined && top < cv.getScrollTop()) cv.scrollTo({ type: 'item', id, align: 'start' });
  }, [files, fullByFile, goTo, itemIdFor]);
  const restoreContextFocus = useCallback((button: HTMLButtonElement | null) => {
    if (!button || resetFocus.current !== button.closest<HTMLElement>('[data-path]')?.dataset.path) return;
    resetFocus.current = null;
    if (document.activeElement === document.body || document.activeElement === scroller.current) button.focus({ preventScroll: true });
  }, []);
  const readChangeAnchor = useCallback((path: string, change: ChangeHunk) => readAnchor(path, ({ side, lineNumber }) => {
    return lineNumber >= change[side].first && lineNumber <= change[side].last;
  }), [readAnchor]);
  const toggleFullFile = useCallback(async (vf: ViewerFile, button: HTMLButtonElement) => {
    const patch = vf.fileDiff;
    const full = fullByFile.get(vf.id);
    if (!patch || full === 'loading') return;
    const generation = ++navigation.current;
    const change = changeJump.current?.path === vf.id ? changeJump.current.change : undefined;
    // A jump near the end can leave its hunk well below the topmost visible line.
    const anchor = (change && readChangeAnchor(vf.id, change)) || readAnchor(vf.id);
    if (isCollapsed(vf)) toggleCollapsed(vf.id);
    if (full) {
      // Move a draft anchored in newly visible context to its file-level composer when those lines fold away.
      if (draft?.path === vf.id && spot?.at === 'line' && !patchShows(vf.id, spot.side, spot.endLine)) {
        setDraftOpenedAt(null);
        view.current?.clearSelectedLines();
      }
      if (anchor) {
        let target = contextScrollTarget(vf.id, anchor, patch.hunks);
        // A nearby hunk can already be visible when the leading row is in unchanged context.
        // Preserve the first visible line of that hunk, including its position on either side.
        if (!patchShows(vf.id, anchor.side, anchor.lineNumber)) {
          const nearby = nearestChange(stopsFor(vf.id), anchor);
          const visible = nearby && readChangeAnchor(vf.id, nearby);
          if (visible) target = contextScrollTarget(vf.id, visible);
        }
        contextRestore.current = { files, path: vf.id, model: null, target, navigation: generation, change };
      } else resetPath.current = vf.id;
      // The gutter may already have hydrated this model. Return to the original patch and its folded context.
      if (!patch.isPartial) vf.fileDiff = toFileDiff(vf.file, vf.cacheKey);
      resetFocus.current = document.activeElement === button ? vf.id : null;
      setFullFile(vf.id, null, { reset: true });
      return;
    }
    const scrollTop = scroller.current?.scrollTop;
    const first = stopsFor(vf.id)[0]?.target;
    const target = contextScrollTarget(vf.id, anchor ?? (first ? { ...first, offset: 0 } : null));
    setFullFile(vf.id, 'loading');
    try {
      const highlighted = fullContextDiff(patch, await loadDiffFiles(patch));
      if (filesRef.current !== files) return;
      const rendered = getRenderedFile(vf.id);
      const priming = rendered?.type === 'diff' ? rendered.instance.primeHighlightCache(highlighted) : undefined;
      // Keep the item and its annotation controls mounted. A plain-text model lets Pierre switch
      // layout immediately if its worker still has the previous highlighted model cached.
      const model = priming && !(await waitForContextHighlight(priming))
        ? { ...highlighted, lang: 'text' as const, cacheKey: `${highlighted.cacheKey}:plain` }
        : highlighted;
      if (filesRef.current !== files) return;
      const unchanged = generation === navigation.current && scrollTop === scroller.current?.scrollTop;
      const liveChange = changeJump.current?.path === vf.id ? changeJump.current.change : undefined;
      const liveAnchor = !unchanged && current.get() === vf.id
        ? (liveChange && readChangeAnchor(vf.id, liveChange)) || readAnchor(vf.id)
        : null;
      if (unchanged || liveAnchor) {
        // If the reader scrolled within this patch during the fetch, carry their newer source line across.
        contextRestore.current = {
          files, path: vf.id, model, target: liveAnchor ? contextScrollTarget(vf.id, liveAnchor) : target,
          navigation: navigation.current, change: unchanged ? change : liveChange,
        };
      }
      setFullFile(vf.id, model);
      if (model !== highlighted) void priming?.then(() => setFullFile(vf.id, highlighted, { expected: model }));
    } catch {
      setFullFile(vf.id, null);
      setFailed((s) => new Set(s).add(rev + '\0' + vf.id));
    }
  }, [current, draft, files, fullByFile, getRenderedFile, isCollapsed, loadDiffFiles, patchShows, readAnchor, readChangeAnchor, rev, setFullFile, spot, stopsFor, toggleCollapsed]);

  const renderHeader = useCallback((item: Item) => {
    const vf = byId.get(pathForItem(item.id));
    if (!vf) return null;
    const patch = vf.fileDiff;
    const canShowFull = !!baseOid && !!patch?.hunks.length && (patch.type === 'change' || patch.type === 'rename-changed');
    const full = fullByFile.get(vf.id);
    const available = changeAvailability.get(vf.id) ?? 2;
    return (
      <FileHeader
        vf={vf}
        diffUrl={diff.url}
        provider={provider}
        collapsed={item.collapsed === true}
        onToggle={toggleCollapsed}
        fullContext={full === 'loading' ? 'loading' : full ? 'full' : 'changes'}
        onToggleContext={canShowFull ? (button) => void toggleFullFile(vf, button) : undefined}
        contextButtonRef={restoreContextFocus}
        contextFailed={failed.has(`${rev}\0${vf.id}`)}
        changeNavigation={stopsFor(vf.id).length ? {
          previous: (available & 1) !== 0,
          next: (available & 2) !== 0,
          onStep: (direction, button) => onStepChange(vf.id, direction, button),
        } : undefined}
      />
    );
  }, [baseOid, byId, diff.url, provider, rev, failed, fullByFile, toggleCollapsed, toggleFullFile, restoreContextFocus, changeAvailability, stopsFor, onStepChange]);

  // Desktop only (the compact list is a touch overlay); memoized so the file list doesn't re-render.
  const hints = useMemo(() => (compact ? undefined : (
    <div className="dvr-hints">
      <span><kbd>j</kbd> <kbd>k</kbd> files</span>
      <span><kbd>n</kbd> <kbd>p</kbd> threads</span>
      <span><kbd>r</kbd> reply</span>
      <span><kbd>e</kbd> resolve</span>
      <span><kbd>c</kbd> comments</span>
      <span><kbd>s</kbd> split</span>
      <span><kbd>w</kbd> wrap</span>
    </div>
  )), [compact]);
  const onOnly = comments.onOnlyChange;
  const title = diff.kind === 'pr' ? `${diff.repo}${provider.prRef}${diff.number}`
    : diff.kind === 'branch' ? branchRef(diff.repo, diff.branch ?? diff.title) : `${diff.repo}@${diff.headOid.slice(0, 7)}`;

  return (
    <div className={cx('diff-viewer', compact && 'compact')} ref={root} onClickCapture={noteExpansion} onKeyDown={expandControls.onKeyDown}>
      <div className="dvr-bar">
        <button type="button" className={cx('wb-btn wb-btn--icon wb-btn--ghost dvr-list-btn', showList && 'on')} onClick={toggleList} aria-pressed={showList} title={showList ? 'Hide file list' : 'Show file list'} aria-label="File list">
          <Icon name="list" />
        </button>
        <Position current={current} indexOf={indexOf} total={files.length} />
        <span className="spacer" />
        {!compact && (
          <>
            <Seg
              size="sm"
              label="Layout"
              value={split ? 'split' : 'unified'}
              onChange={(v) => updatePrefs({ split: v === 'split' })}
              options={[{ value: 'unified', label: 'Unified', title: 'Unified (s)' }, { value: 'split', label: 'Split', title: 'Split (s)' }]}
            />
            <button type="button" className={cx('tbl-btn', prefs.wrap && 'on')} aria-pressed={prefs.wrap} onClick={() => updatePrefs({ wrap: !prefs.wrap })} title="Wrap long lines (w)">Wrap</button>
          </>
        )}
        <button type="button" className={cx('tbl-btn', prefs.foldResolved && 'on')} aria-pressed={prefs.foldResolved}
          onClick={() => updatePrefs({ foldResolved: !prefs.foldResolved })} aria-label="Fold resolved code" title="Fold code linked to resolved threads">Fold resolved</button>
        {hasFiles && (
          <button type="button" ref={findButton} className={cx('wb-btn wb-btn--icon wb-btn--ghost dvr-find-btn', findOpen && 'on')}
            title="Find in files" aria-label="Find in files" aria-expanded={findOpen} aria-controls={findId} aria-keyshortcuts="Control+F Meta+F"
            onClick={(event) => { if (findOpen) closeFind(); else openFind(event.currentTarget); }}>
            <Icon name="search" />
          </button>
        )}
        <button type="button" className={cx('wb-btn wb-btn--ghost dvr-cm-btn', showColumn && 'on')} onClick={() => setColumn(!showColumn)} aria-pressed={showColumn}
          title={`${showColumn ? 'Hide' : 'Show'} comments (c)${comments.error ? " · couldn't load them" : ''}`} aria-label="Comments">
          <Icon name="comment" />
          {threads.length > 0 && <span className={cx('n', openCount > 0 && 'open')}>{openCount || threads.length}</span>}
          {comments.error && <span className="n err">!</span>}
        </button>
      </div>
      <ThreadsCtx.Provider value={threadsState}>
        <div className="dvr-main">
          {showList && (
            <OverlayScope layers={fileLayer.scope} owner={fileOwner}>
              <div ref={fileSurface} className="dvr-overlay" tabIndex={compact ? -1 : undefined}>
                <FileList files={navFiles} current={current} onPick={goTo} footer={hints} comments={counts} only={only} onOnly={onOnly} />
                {compact && listOpen && <div className="dvr-scrim" onClick={() => setListOpen(false)} />}
              </div>
            </OverlayScope>
          )}
          <div className="dvr-code">
            {hasFiles ? (
              <>
                <FileFindBar ref={findBar} id={findId} input={findInput} open={findOpen} close={closeFind} current={current} split={split}
                  paths={findPaths} readSource={readFindSource} readRoots={readFindRoots} readAnchor={readAnchor} seek={seekMatch} />
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
              </>
            ) : <div className="dvr-scroll dvr-empty">No changed files.</div>}
          </div>
          {showColumn && (
            <OverlayScope layers={columnLayer.scope} owner={columnOwner}>
              <div ref={columnSurface} className="dvr-overlay" tabIndex={compact ? -1 : undefined}>
                <CommentsColumn threads={ordered} order={indexOf} title={title} kind={diff.kind} number={diff.number} provider={provider} error={comments.error} onRetry={comments.retry}
                  onJump={(id) => focusThread(id, { scroll: true })} onClose={() => setColumn(false)} onCreateGeneral={createGeneral}
                  unsent={unsent} sending={sending} headOid={diff.headOid} onResume={resumeDraft} onDiscardDraft={removeNewDraft} />
                {compact && columnOpen && <div className="dvr-scrim" onClick={() => setColumnOpen(false)} />}
              </div>
            </OverlayScope>
          )}
        </div>
      </ThreadsCtx.Provider>
    </div>
  );
}
