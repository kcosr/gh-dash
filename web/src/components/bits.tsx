/** Tiny shared bits that don't warrant their own file. */
import type { ReactNode } from 'react';
import type { PullRequest } from '../../../shared/api';
import type { IconName } from './Icon';

export function Diffstat({ add, del }: { add: number; del: number }) {
  return (
    <span className="diffstat"><span className="a">+{add.toLocaleString()}</span> <span className="d">−{del.toLocaleString()}</span></span>
  );
}

export function prIconName(p: Pick<PullRequest, 'state' | 'isDraft'>): IconName {
  if (p.state === 'merged') return 'merge';
  if (p.state === 'closed') return 'prClosed';
  return p.isDraft ? 'prDraft' : 'prOpen';
}

export function prIconClass(p: Pick<PullRequest, 'state' | 'isDraft'>): string {
  return p.state === 'open' && p.isDraft ? 'draft' : p.state;
}

/**
 * After an agent's name wherever an author is shown: small and muted, so agents and you tell apart at a glance. Read
 * out as "Claude (agent)".
 */
export function AgentMark() {
  return <span className="agent-mark" title="An agent, writing through MCP"><span className="sr-only"> (</span>agent<span className="sr-only">)</span></span>;
}

/** Keep a toolbar label and its control together when the row wraps. */
export function Ctl({ label, children }: { label: string; children: ReactNode }) {
  return <span className="ctl"><span className="lbl">{label}</span>{children}</span>;
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_K = IS_MAC ? '⌘K' : 'Ctrl K';
