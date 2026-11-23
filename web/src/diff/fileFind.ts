import type { FileDiffMetadata } from '@pierre/diffs';

export interface FileMatch {
  side: 'old' | 'new';
  lineNumber: number;
  /** UTF-16 offsets within the source line. */
  start: number;
  end: number;
  /** Shared context is one result. This is its line on the left of a split view. */
  oldLineNumber?: number;
}

/** A literal search in reading order, using the diff model even for unmounted rows. */
export function findFileMatches(
  diff: FileDiffMetadata,
  query: string,
  split: boolean,
  isContextVisible?: (newLine: number) => boolean,
): FileMatch[] {
  if (!query || !diff.hunks.length) return [];
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: FileMatch[] = [];
  const add = (side: FileMatch['side'], lineNumber: number, text: string | undefined, oldLineNumber?: number, inGap = false) => {
    if (text === undefined) return;
    literal.lastIndex = 0;
    let match = literal.exec(text);
    if (!match || (inGap && !isContextVisible?.(lineNumber))) return;
    do {
      matches.push({ side, lineNumber, start: match.index, end: match.index + match[0].length, oldLineNumber });
      match = literal.exec(text);
    } while (match);
  };
  const addGap = (oldStart: number, newStart: number, length: number) => {
    if (diff.isPartial || !isContextVisible) return;
    for (let i = 0; i < length; i++) {
      add('new', newStart + i, diff.additionLines[newStart + i - 1], oldStart + i, true);
    }
  };

  let old = 1, next = 1;
  for (const hunk of diff.hunks) {
    // A zero-length range names the preceding line, so it contributes no row at that number.
    old = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
    next = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
    addGap(old - hunk.collapsedBefore, next - hunk.collapsedBefore, hunk.collapsedBefore);
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        for (let i = 0; i < block.lines; i++) add('new', next + i, diff.additionLines[block.additionLineIndex + i], old + i);
        old += block.lines;
        next += block.lines;
        continue;
      }
      if (split) {
        for (let i = 0; i < Math.max(block.deletions, block.additions); i++) {
          if (i < block.deletions) add('old', old + i, diff.deletionLines[block.deletionLineIndex + i]);
          if (i < block.additions) add('new', next + i, diff.additionLines[block.additionLineIndex + i]);
        }
      } else {
        for (let i = 0; i < block.deletions; i++) add('old', old + i, diff.deletionLines[block.deletionLineIndex + i]);
        for (let i = 0; i < block.additions; i++) add('new', next + i, diff.additionLines[block.additionLineIndex + i]);
      }
      old += block.deletions;
      next += block.additions;
    }
  }
  addGap(old, next, Math.min(diff.deletionLines.length - old, diff.additionLines.length - next) + 1);
  return matches;
}

type RowMatches = Record<FileMatch['side'], Map<number, FileMatch[]>>;
const indexes = new WeakMap<readonly FileMatch[], RowMatches>();

/** Index once per search so painting a newly virtualized window only visits its own matches. */
function indexMatches(matches: readonly FileMatch[]): RowMatches {
  const cached = indexes.get(matches);
  if (cached) return cached;
  const index: RowMatches = { old: new Map(), new: new Map() };
  for (const match of matches) {
    const side = index[match.side];
    let row = side.get(match.lineNumber);
    if (!row) side.set(match.lineNumber, row = []);
    row.push(match);
    if (match.oldLineNumber !== undefined) index.old.set(match.oldLineNumber, row);
  }
  indexes.set(matches, index);
  return index;
}

/** Match offsets span any number of syntax tokens without changing Pierre's DOM or native selection. */
function* rangesForRow(row: HTMLElement, matches: readonly FileMatch[]): Generator<[FileMatch, Range]> {
  const doc = row.ownerDocument;
  const walker = doc.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let offset = 0;
  const advance = () => {
    offset += node!.length;
    node = walker.nextNode() as Text | null;
  };
  for (const match of matches) {
    while (node && offset + node.length <= match.start) advance();
    if (!node) break;
    const range = doc.createRange();
    range.setStart(node, match.start - offset);
    while (node && offset + node.length < match.end) advance();
    if (!node) break;
    range.setEnd(node, match.end - offset);
    yield [match, range];
  }
}

const ALL = 'ghd-find-match';
const CURRENT = 'ghd-find-current';
const paintedRoots = new WeakMap<Document, ShadowRoot>();

/** With a root, only clear highlights owned by that file; Pierre can unmount an older file after revealing another. */
export function clearFileMatches(root?: ShadowRoot) {
  const doc = root?.ownerDocument ?? document;
  if (root && paintedRoots.get(doc) !== root) return;
  const registry = doc.defaultView?.CSS.highlights;
  registry?.delete(ALL);
  registry?.delete(CURRENT);
  paintedRoots.delete(doc);
}

/** Paint the mounted portion of the file and return the current match's exact range for horizontal reveal. */
export function paintFileMatches(root: ShadowRoot, matches: readonly FileMatch[], active: FileMatch | null): Range | null {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const registry = win?.CSS.highlights;
  if (!registry || !win.Highlight) return null;
  if (!matches.length) {
    clearFileMatches(root);
    return null;
  }
  const lookup = indexMatches(matches);
  const all = new win.Highlight();
  const current = new win.Highlight();
  let activeRange = null;
  for (const row of root.querySelectorAll<HTMLElement>('[data-line][data-line-type]:not([data-resolved-fold])')) {
    const side = row.dataset.lineType === 'change-deletion' || row.closest('[data-deletions]') ? 'old' : 'new';
    const hits = lookup[side].get(Number(row.dataset.line));
    if (!hits) continue;
    for (const [match, range] of rangesForRow(row, hits)) {
      if (match !== active) all.add(range);
      else {
        current.add(range);
        if (!activeRange || side === match.side) activeRange = range;
      }
    }
  }
  registry.set(ALL, all);
  registry.set(CURRENT, current);
  paintedRoots.set(doc, root);
  return activeRange;
}
