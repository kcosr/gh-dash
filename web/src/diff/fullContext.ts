import type { FileDiffLoadedFiles, FileDiffMetadata, Hunk } from '@pierre/diffs';

/** Keep line endings, as Pierre's file contents do. An empty file has no lines. */
const linesOf = (text: string): string[] => text === '' ? [] : text.split(/(?<=\n)/);

/** Let a downloaded file open promptly even if its syntax highlighting is still queued. */
export async function waitForContextHighlight(priming: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      priming.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 200); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One hunk spanning both files, using the host's original change blocks. */
export function fullContextDiff(patch: FileDiffMetadata, { oldFile, newFile }: FileDiffLoadedFiles): FileDiffMetadata {
  if (!oldFile || !newFile) throw new Error('Both revisions are needed for full context');
  const deletionLines = linesOf(oldFile.contents);
  const additionLines = linesOf(newFile.contents);
  const hunkContent: Hunk['hunkContent'] = [];
  let oldIndex = 0, newIndex = 0;
  let deletions = 0, additions = 0, splitLineCount = 0;
  const mismatch = () => new Error('The full files do not match the patch');

  const context = (lines: number) => {
    if (lines < 0 || oldIndex + lines > deletionLines.length || newIndex + lines > additionLines.length) throw mismatch();
    if (lines === 0) return;
    // A host can cap a patch. A gap may be shown as context only if both files agree.
    for (let i = 0; i < lines; i++) {
      if (deletionLines[oldIndex + i] !== additionLines[newIndex + i]) throw mismatch();
    }
    hunkContent.push({ type: 'context', lines, deletionLineIndex: oldIndex, additionLineIndex: newIndex });
    oldIndex += lines;
    newIndex += lines;
    splitLineCount += lines;
  };

  for (const hunk of patch.hunks) {
    // In a zero-length hunk range, the start names the preceding line.
    const oldStart = hunk.deletionStart - (hunk.deletionCount === 0 ? 0 : 1);
    const newStart = hunk.additionStart - (hunk.additionCount === 0 ? 0 : 1);
    if (oldStart - oldIndex !== newStart - newIndex) throw mismatch();
    context(oldStart - oldIndex);
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        context(block.lines);
      } else {
        hunkContent.push({ ...block, deletionLineIndex: oldIndex, additionLineIndex: newIndex });
        oldIndex += block.deletions;
        newIndex += block.additions;
        deletions += block.deletions;
        additions += block.additions;
        splitLineCount += Math.max(block.deletions, block.additions);
      }
    }
    if (oldIndex !== oldStart + hunk.deletionCount || newIndex !== newStart + hunk.additionCount) throw mismatch();
  }
  if (deletionLines.length - oldIndex !== additionLines.length - newIndex) throw mismatch();
  context(deletionLines.length - oldIndex);
  const unifiedLineCount = additionLines.length + deletions;
  const hunk: Hunk = {
    collapsedBefore: 0, hunkContent,
    deletionStart: deletionLines.length ? 1 : 0, deletionCount: deletionLines.length, deletionLineIndex: 0, deletionLines: deletions,
    additionStart: additionLines.length ? 1 : 0, additionCount: additionLines.length, additionLineIndex: 0, additionLines: additions,
    splitLineStart: 0, splitLineCount, unifiedLineStart: 0, unifiedLineCount,
    noEOFCRDeletions: !!oldFile.contents && !oldFile.contents.endsWith('\n'),
    noEOFCRAdditions: !!newFile.contents && !newFile.contents.endsWith('\n'),
  };
  return {
    ...patch, isPartial: false, deletionLines, additionLines, splitLineCount, unifiedLineCount, hunks: [hunk],
    ...(patch.cacheKey && { cacheKey: patch.cacheKey + ':full-context' }),
  };
}
