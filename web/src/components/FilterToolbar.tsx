import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { hasBlockingLayer, isTypingTarget } from '../workbench';
import { Icon } from './Icon';
import { SourceNotice } from './SourceNotice';

/** One compact disclosure on mobile; the full toolbar remains visible on desktop. */
export function FilterToolbar({ summary, children }: { summary: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const focusSearch = useRef(false);

  useEffect(() => {
    if (expanded && focusSearch.current) {
      focusSearch.current = false;
      const input = controls.current?.querySelector<HTMLInputElement>('#q');
      input?.focus();
      input?.select();
    }
  }, [expanded]);

  useEffect(() => {
    // Reveal the page search before the shell falls back to repository search.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || expanded || hasBlockingLayer() || isTypingTarget(document.activeElement)) return;
      const button = toggle.current;
      if (!button?.getClientRects().length || getComputedStyle(button).visibility !== 'visible' || !controls.current?.querySelector('#q')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      focusSearch.current = true;
      setExpanded(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [expanded]);

  return (
    <>
      <div className={`toolbar filter-toolbar${expanded ? ' expanded' : ''}`}>
        <button ref={toggle} type="button" className="filter-toggle" aria-expanded={expanded}
          aria-controls={id} aria-label={`${expanded ? 'Collapse' : 'Expand'} filters`} aria-describedby={`${id}-summary`}
          onClick={() => setExpanded((value) => !value)}>
          <Icon name="sliders" /><span>Filters</span>
          <span id={`${id}-summary`} className="filter-summary" title={summary}>{summary}</span>
          <Icon name="chevron" className="filter-chevron" />
        </button>
        {/* Keep focused desktop controls visible if the viewport subsequently narrows. */}
        <div ref={controls} id={id} className="filter-controls" onFocusCapture={() => setExpanded(true)}>{children}</div>
      </div>
      {/* Every list view starts with this toolbar: the context's source says here why it may show nothing. */}
      <SourceNotice />
    </>
  );
}
