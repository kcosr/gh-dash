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

type LineLocation = Pick<FileMatch, 'side' | 'lineNumber'>;
type MatchSpan = { start: number; end: number };

export interface FileMatches {
  readonly length: number;
  at(index: number): FileMatch | undefined;
  indexOf(match: FileMatch): number;
  firstNear(anchor: LineLocation | null): number;
  lineMatches(side: FileMatch['side'], lineNumber: number): MatchSpan | undefined;
}

// Small searches start with tiny arrays. Large searches append into blocks so growth never copies the accumulated offsets.
const BLOCK_SIZE = 16_384;
class PackedNumbers {
  private readonly blocks: Uint32Array[] = [];
  length = 0;

  push(value: number) {
    const blockIndex = Math.floor(this.length / BLOCK_SIZE);
    const offset = this.length % BLOCK_SIZE;
    let block = this.blocks[blockIndex];
    if (!block || offset === block.length) {
      const next = new Uint32Array(Math.min(BLOCK_SIZE, block ? block.length * 2 : 16));
      if (block) next.set(block);
      this.blocks[blockIndex] = block = next;
    }
    block[offset] = value;
    this.length++;
  }

  at(index: number): number {
    return this.blocks[Math.floor(index / BLOCK_SIZE)]![index % BLOCK_SIZE]!;
  }
}

/** First index whose element is not before the target. */
function lowerBound(start: number, end: number, before: (index: number) => boolean): number {
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (before(middle)) start = middle + 1;
    else end = middle;
  }
  return start;
}

/** The earliest line on each side still at or after a viewer position. */
function linesAtAnchor(diff: FileDiffMetadata, split: boolean, anchor: LineLocation): [old: number, next: number] {
  let old = 1, next = 1;
  const offsetFrom = () => anchor.lineNumber - (anchor.side === 'old' ? old : next);
  for (const hunk of diff.hunks) {
    old = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
    next = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
    const beforeHunk = offsetFrom();
    if (beforeHunk < 0) return [old + beforeHunk, next + beforeHunk];
    for (const block of hunk.hunkContent) {
      const oldCount = block.type === 'context' ? block.lines : block.deletions;
      const nextCount = block.type === 'context' ? block.lines : block.additions;
      const offset = offsetFrom();
      if (offset < (anchor.side === 'old' ? oldCount : nextCount)) {
        if (block.type === 'context') return [old + offset, next + offset];
        if (split) return [old + Math.min(offset, oldCount), next + Math.min(offset, nextCount)];
        // Unified layout shows all deletions before any additions in the block.
        return anchor.side === 'old' ? [old + offset, next] : [old + oldCount, next + offset];
      }
      old += oldCount;
      next += nextCount;
    }
  }
  const afterLastHunk = offsetFrom();
  return [old + afterLastHunk, next + afterLastHunk];
}

/** Store one offset per hit. Matching lines are ordered visually, with a separate sorted index for each side. */
class SearchMatches implements FileMatches {
  private readonly offsets = new PackedNumbers();
  private readonly firstOffset = new PackedNumbers();
  private readonly lineNumber = { old: new PackedNumbers(), new: new PackedNumbers() };
  private readonly sideRows = { old: new PackedNumbers(), new: new PackedNumbers() };

  constructor(private readonly diff: FileDiffMetadata, private readonly split: boolean, private readonly queryLength: number) {}

  get length() { return this.offsets.length; }

  addLine(side: FileMatch['side'], lineNumber: number, oldLineNumber?: number) {
    const row = this.firstOffset.length;
    this.firstOffset.push(this.length);
    this.lineNumber.old.push(side === 'old' ? lineNumber : oldLineNumber ?? 0);
    this.lineNumber.new.push(side === 'new' ? lineNumber : 0);
    this.sideRows[side].push(row);
    if (oldLineNumber !== undefined) this.sideRows.old.push(row);
  }

  addMatch(offset: number) { this.offsets.push(offset); }

  at(index: number): FileMatch | undefined {
    if (index < 0 || index >= this.length) return;
    const row = lowerBound(0, this.firstOffset.length, (i) => this.firstOffset.at(i) <= index) - 1;
    const next = this.lineNumber.new.at(row);
    const old = this.lineNumber.old.at(row);
    const start = this.offsets.at(index);
    return {
      side: next ? 'new' : 'old', lineNumber: next || old, start, end: start + this.queryLength,
      ...(next && old ? { oldLineNumber: old } : {}),
    };
  }

  private firstRowAtOrAfter(side: FileMatch['side'], lineNumber: number): number | undefined {
    const rows = this.sideRows[side];
    const numbers = this.lineNumber[side];
    const i = lowerBound(0, rows.length, (index) => numbers.at(rows.at(index)) < lineNumber);
    if (i < rows.length) return rows.at(i);
  }

  lineMatches(side: FileMatch['side'], lineNumber: number): MatchSpan | undefined {
    const row = this.firstRowAtOrAfter(side, lineNumber);
    if (row === undefined || this.lineNumber[side].at(row) !== lineNumber) return;
    return {
      start: this.firstOffset.at(row),
      end: row + 1 < this.firstOffset.length ? this.firstOffset.at(row + 1) : this.length,
    };
  }

  indexOf(match: FileMatch): number {
    const span = this.lineMatches(match.side, match.lineNumber);
    if (!span) return -1;
    const i = lowerBound(span.start, span.end, (index) => this.offsets.at(index) < match.start);
    return i < span.end && this.offsets.at(i) === match.start ? i : -1;
  }

  firstNear(anchor: LineLocation | null): number {
    if (!this.length) return -1;
    if (!anchor) return 0;
    const sameLine = this.lineMatches(anchor.side, anchor.lineNumber);
    if (sameLine) return sameLine.start;
    const [old, next] = linesAtAnchor(this.diff, this.split, anchor);
    const oldRow = this.firstRowAtOrAfter('old', old);
    const nextRow = this.firstRowAtOrAfter('new', next);
    const row = Math.min(oldRow ?? this.firstOffset.length, nextRow ?? this.firstOffset.length);
    return row < this.firstOffset.length ? this.firstOffset.at(row) : -1;
  }
}

/** A literal search in reading order, using the diff model even for unmounted rows. */
export function findFileMatches(
  diff: FileDiffMetadata,
  query: string,
  split: boolean,
  isContextVisible?: (newLine: number) => boolean,
): FileMatches {
  const matches = new SearchMatches(diff, split, query.length);
  if (!query || !diff.hunks.length) return matches;
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const add = (side: FileMatch['side'], lineNumber: number, text: string | undefined, oldLineNumber?: number, inGap = false) => {
    if (text === undefined) return;
    literal.lastIndex = 0;
    let match = literal.exec(text);
    if (!match || (inGap && !isContextVisible?.(lineNumber))) return;
    matches.addLine(side, lineNumber, oldLineNumber);
    do {
      matches.addMatch(match.index);
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

/** Match offsets span any number of syntax tokens without changing Pierre's DOM or native selection. */
function* rangesForRow(row: HTMLElement, matches: FileMatches, first: number, end: number): Generator<[number, Range]> {
  const doc = row.ownerDocument;
  const walker = doc.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let offset = 0;
  const advance = () => {
    offset += node!.length;
    node = walker.nextNode() as Text | null;
  };
  for (let index = first; index < end; index++) {
    const match = matches.at(index)!;
    while (node && offset + node.length <= match.start) advance();
    if (!node) break;
    const range = doc.createRange();
    range.setStart(node, match.start - offset);
    while (node && offset + node.length < match.end) advance();
    if (!node) break;
    range.setEnd(node, match.end - offset);
    yield [index, range];
  }
}

const ALL = 'ghd-find-match';
const CURRENT = 'ghd-find-current';
// Keep navigation exact and bound passive paint work across all the mounted files.
const MAX_PASSIVE_HIGHLIGHTS = 512;

export interface MountedMatches {
  root: ShadowRoot;
  matches: FileMatches;
  active: number;
}

/** Paint mounted matches and return their cleanup and the active range for horizontal reveal. */
export function paintFileMatches(files: MountedMatches[]) {
  const win = files[0]?.root.ownerDocument.defaultView;
  const registry = win?.CSS.highlights;
  if (!registry || !win?.Highlight) return null;
  const all = new win.Highlight();
  const current = new win.Highlight();
  const mounted = [];
  let activeRange = null;
  for (const { root, matches, active } of files) {
    const activeSide = matches.at(active)?.side;
    for (const row of root.querySelectorAll<HTMLElement>('[data-line][data-line-type]:not([data-resolved-fold])')) {
      const side = row.dataset.lineType === 'change-deletion' || row.closest('[data-deletions]') ? 'old' : 'new';
      const hits = matches.lineMatches(side, Number(row.dataset.line));
      if (!hits) continue;
      const nearest = Math.max(hits.start, Math.min(hits.end - 1, active));
      const distance = active < 0 ? Number.MAX_SAFE_INTEGER : Math.abs(nearest - active);
      mounted.push({ row, side, matches, active, activeSide, ...hits, nearest, distance });
    }
  }
  mounted.sort((a, b) => a.distance - b.distance);
  for (const { row, side, matches, active, activeSide, start, end, nearest } of mounted) {
    const includesActive = nearest === active;
    const budget = MAX_PASSIVE_HIGHLIGHTS - all.size + (includesActive ? 1 : 0);
    if (!budget) break;
    const first = Math.max(start, Math.min(end - budget, nearest - Math.floor(budget / 2)));
    for (const [index, range] of rangesForRow(row, matches, first, Math.min(end, first + budget))) {
      if (index !== active) all.add(range);
      else {
        current.add(range);
        if (!activeRange || side === activeSide) activeRange = range;
      }
    }
  }
  registry.set(ALL, all);
  registry.set(CURRENT, current);
  return {
    activeRange,
    clear() {
      if (registry.get(ALL) === all) registry.delete(ALL);
      if (registry.get(CURRENT) === current) registry.delete(CURRENT);
    },
  };
}
