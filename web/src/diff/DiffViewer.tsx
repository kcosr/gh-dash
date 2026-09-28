/**
 * Diff viewer entry point, loaded lazily by the diff view shell. Placeholder: renders raw patches
 * until the @pierre/diffs-based viewer replaces it.
 */
import type { Diff } from '../../../shared/api';

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
}

export default function DiffViewer({ diff }: DiffViewerProps) {
  return (
    <div className="diff-viewer">
      {diff.files.map((f) => (
        <section key={f.path}>
          <h3>{f.path}</h3>
          <pre>{f.patch ?? 'No patch available'}</pre>
        </section>
      ))}
    </div>
  );
}
