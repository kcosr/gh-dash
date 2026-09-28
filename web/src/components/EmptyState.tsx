import type { ReactNode } from 'react';
import { cx } from '../lib/util';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="ic"><Icon name={icon} /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="empty">
      <span className="ic err"><Icon name="alert" /></span>
      <h3>Couldn't load this view</h3>
      <p>{msg}</p>
      {onRetry && <button className="btn" onClick={onRetry}><Icon name="sync" />Retry</button>}
    </div>
  );
}

/** Thin indeterminate bar pinned to the top of a scroll area while refetching. */
export function ProgressBar({ active }: { active: boolean }) {
  return <div className={cx('progress', active && 'on')} aria-hidden="true"><i /></div>;
}
