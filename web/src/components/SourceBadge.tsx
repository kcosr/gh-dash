import { GITHUB_HOST } from '../../../shared/api';
import type { SourceInfo } from '../lib/contexts';
import { cx } from '../lib/util';
import { ProviderIcon } from './Icon';
import { useSourceCtx } from './repoMapContext';

/** "GitLab · gitlab.example.com"; just the host when that is the source's name. */
export const sourceTitle = (s: Pick<SourceInfo, 'host' | 'name'>) => (s.name === s.host ? s.host : `${s.name} · ${s.host}`);

/** A repo's source as a small muted glyph, named in its tooltip. Callers show it only when `useSourceCtx().badges`. */
export function SourceBadge({ host, className }: { host: string; className?: string }) {
  const { byHost } = useSourceCtx();
  const src = byHost.get(host) ?? { host, kind: host === GITHUB_HOST ? 'github' : 'gitlab', name: host === GITHUB_HOST ? 'GitHub' : host };
  const label = sourceTitle(src);
  return (
    <span className={cx('src-badge', className)} title={label} role="img" aria-label={label}>
      <ProviderIcon kind={src.kind} />
    </span>
  );
}
