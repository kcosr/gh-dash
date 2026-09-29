import { repoParts } from '../../../shared/repos';
import { cx } from '../lib/util';
import { useRepoMapCtx } from './repoMapContext';

/**
 * A repo's display name: the bare name for a repo you own, a muted `owner/` before the name for any other. In a
 * narrow space the owner gives way first ("dlv…/gh-dash"); the name stays whole until it alone is wider than the row.
 * `repoLabel` gives the same text as a plain string.
 */
export function RepoName({ repo, className }: { repo: string; className?: string }) {
  const { repos } = useRepoMapCtx();
  const { owner, name } = repoParts(repo, repos);
  return (
    <span className={cx('rn', className)}>
      {owner !== null && <span className="rn-o"><span className="rn-ot">{owner}</span>/</span>}
      <span className="rn-n">{name}</span>
    </span>
  );
}
