import type { Plugin } from 'vite';

// Pierre 1.5.1 centers a nominal row budget on the viewport. Measured zero-height rows can
// exhaust that budget in the middle of a visible file, so CodeView places the next file too early.
// Keep its normal range and extend it to cover both edges of the measured window.
export function pierreFoldWindow(): Plugin {
  const windowReplacements = [
    ['let firstVisibleHunk;', 'let firstVisibleHunk, lastVisibleHunk;'],
    [
      'if (absoluteLineTop > top - lineHeight && absoluteLineTop < bottom) firstVisibleHunk ??= currentHunk;',
      `if (absoluteLineTop + lineHeight > top && absoluteLineTop - gapAdjustment < bottom) {
        firstVisibleHunk ??= currentHunk;
        lastVisibleHunk = currentHunk;
      }`,
    ],
    [
      'if (absoluteLineTop < bottom && absoluteLineTop + trailingSeparator.totalHeight > top) firstVisibleHunk ??= currentHunk;',
      `if (absoluteLineTop < bottom && absoluteLineTop + trailingSeparator.totalHeight > top) {
        firstVisibleHunk ??= currentHunk;
        lastVisibleHunk = currentHunk;
      }`,
    ],
    [
      'const startHunk = Math.max(0, Math.min(idealStartHunk, maxStartHunk));',
      `const centeredStartHunk = Math.max(0, Math.min(idealStartHunk, maxStartHunk));
      const startHunk = Math.min(centeredStartHunk, firstVisibleHunk);`,
    ],
    [
      'const finalHunkIndex = startHunk + clampedTotalLines / hunkLineCount;',
      `const finalHunkIndex = Math.max(
        centeredStartHunk + clampedTotalLines / hunkLineCount,
        (lastVisibleHunk ?? firstVisibleHunk) + 1,
      );`,
    ],
    ['totalLines: clampedTotalLines,', 'totalLines: (finalHunkIndex - startHunk) * hunkLineCount,'],
  ] as const;
  // The line index has already advanced when its metadata row is visited. Keep the annotation
  // and EOF marker attached to the last retained line when trimming an overlapping window.
  const metadataReplacements = [
    'gutterElement.dataset.gutterBuffer === "annotation" && "lineAnnotation" in contentElement.dataset',
    'gutterElement.dataset.gutterBuffer === "metadata" && "noNewline" in contentElement.dataset',
  ].map((part) => {
    const original = `if (${part}) {\n\t\t\t\tif (preTrimCount > 0 || hasPostTrim && visibleLineIndex >= postTrimStart) {`;
    return [original, original.replace('>= postTrimStart', '> postTrimStart')] as const;
  });
  return {
    name: 'gh-dash:pierre-fold-window',
    enforce: 'pre',
    transform(code, id) {
      const file = /[/\\]@pierre[/\\]diffs[/\\]dist[/\\]components[/\\](VirtualizedFileDiff|FileDiff)\.js$/.exec(id)?.[1];
      if (!file) return;
      const replacements = file === 'VirtualizedFileDiff' ? windowReplacements : metadataReplacements;
      for (const [original, replacement] of replacements) {
        const offset = code.indexOf(original);
        if (offset === -1 || code.indexOf(original, offset + original.length) !== -1) {
          this.error(`Check whether Pierre's ${file} still needs the folded-row patch.`);
        }
        code = code.replace(original, replacement);
      }
      return { code, map: null };
    },
  };
}
