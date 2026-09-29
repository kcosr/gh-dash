/** react-markdown + remark-gfm (split into its own chunk; import through ./Markdown). */
import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveItemUrl } from '../../../shared/provider';
import type { LinkBase } from '../../../shared/provider';

const components: Components = {
  // react-markdown's urlTransform blanks unsafe URLs (javascript:, data:, vbscript:). Render
  // those as plain text: an <a href=""> would just open the app itself in a new tab.
  a: ({ node: _n, href, children, ...rest }) =>
    href ? <a {...rest} href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> : <span className="md-badlink">{children}</span>,
  // No external requests: images render as a link to the image instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a className="md-img" href={src} target="_blank" rel="noopener noreferrer nofollow">[image{alt ? `: ${alt}` : ''}]</a>
    ) : (
      <span className="md-img">[image{alt ? `: ${alt}` : ''}]</span>
    ),
  input: ({ node: _n, type, checked }) =>
    type === 'checkbox' ? (
      <span className={checked ? 'tb on' : 'tb'} aria-label={checked ? 'done' : 'not done'} role="img">
        {checked && (
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        )}
      </span>
    ) : null,
  table: ({ node: _n, children }) => <div className="md-table"><table>{children}</table></div>,
};

/** `linkBase`: the item's repo, which root-relative URLs resolve against (after the safety transform). */
export default function MarkdownRenderer({ source, linkBase }: { source: string; linkBase?: LinkBase }) {
  const urlTransform = useMemo(
    () => (linkBase ? (url: string) => resolveItemUrl(defaultUrlTransform(url), linkBase) : defaultUrlTransform),
    [linkBase],
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components} urlTransform={urlTransform}>
      {source}
    </ReactMarkdown>
  );
}
