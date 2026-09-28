import { Suspense, lazy, memo } from 'react';

// The markdown stack (react-markdown, remark-gfm, micromark…) is the biggest dependency and is
// only needed for the drawer, "Full" density and release notes. It loads on first use and is
// preloaded when the browser is idle after startup (see App.tsx).
const loadRenderer = () => import('./MarkdownRenderer');
const Renderer = lazy(loadRenderer);

export function preloadMarkdown() {
  loadRenderer().catch(() => { /* retried on first render */ });
}

/** GitHub-flavored markdown, no raw HTML. */
export const Markdown = memo(function Markdown({ source, className = 'md' }: { source: string; className?: string }) {
  if (!source.trim()) return <div className={className}><p className="muted">No description provided.</p></div>;
  return (
    <div className={className}>
      {/* Until the renderer arrives (normally already preloaded), show the raw text in place. */}
      <Suspense fallback={<p className="md-plain">{source}</p>}>
        <Renderer source={source} />
      </Suspense>
    </div>
  );
});
