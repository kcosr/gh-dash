import { Suspense, lazy, memo, useContext, useMemo } from 'react';
import { linkBase } from '../../../shared/provider';
import { ReposCtx } from './repoMapContext';

// The markdown stack (react-markdown, remark-gfm, micromark…) is the biggest dependency and is
// only needed for the drawer, "Full" density and release notes. It loads on first use and is
// preloaded when the browser is idle after startup (see App.tsx).
const loadRenderer = () => import('./MarkdownRenderer');
const Renderer = lazy(loadRenderer);

export function preloadMarkdown() {
  loadRenderer().catch(() => { /* retried on first render */ });
}

/**
 * GitHub-flavored markdown, no raw HTML. `repo` is the key of the item's repo: root-relative links (`/uploads/…`,
 * `/owner/name/pull/3`) then open on its host, as they would there, instead of in gh-dash.
 */
export const Markdown = memo(function Markdown({ source, repo, className = 'md' }: { source: string; repo?: string; className?: string }) {
  const known = useContext(ReposCtx).get(repo ?? '');
  const base = useMemo(() => (known ? linkBase(known) : undefined), [known]);
  if (!source.trim()) return <div className={className}><p className="muted">No description provided.</p></div>;
  return (
    <div className={className}>
      {/* Until the renderer arrives (normally already preloaded), show the raw text in place. */}
      <Suspense fallback={<p className="md-plain">{source}</p>}>
        <Renderer source={source} linkBase={base} />
      </Suspense>
    </div>
  );
});
