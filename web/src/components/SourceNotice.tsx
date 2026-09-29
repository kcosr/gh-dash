import { Link } from 'react-router';
import { useWorkSources } from '../api/hooks';
import { noticeText, sourceSettingsLink } from '../lib/sources';
import { useSourceCtx } from './repoMapContext';

/**
 * One quiet line at the top of a list view when the context's source can't show anything yet (design §7.9): no
 * token, not configured on this server, another account's token, or its first sync still to come. Links to its
 * block in Settings → Sources. Nothing in All (the top bar names the first problem there) or when all is well.
 */
export function SourceNotice() {
  const { current } = useSourceCtx();
  const sources = useWorkSources();
  const w = current ? sources.find((s) => s.host === current.host) : undefined;
  const notice = w && noticeText(w);
  if (!w || !notice) return null;
  return (
    <div className={`src-notice${w.trouble ? ' warn' : ''}`} role="status">
      <span>{notice.text}</span>
      <span aria-hidden="true">·</span>
      <Link to={sourceSettingsLink(w.host)}>{notice.setUp ? 'Set up in Settings → Sources' : 'Settings → Sources'}</Link>
    </div>
  );
}
