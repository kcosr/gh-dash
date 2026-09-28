import { memo } from 'react';
import type { PullRequest, Release } from '../../../shared/api';
import { plainPreview } from '../lib/markdown';
import { isNewSinceLastVisit } from '../lib/storage';
import { fmtDate, fmtDateTime, rel } from '../lib/time';
import type { Density } from '../lib/urlState';
import { actorName, cx } from '../lib/util';
import { Avatar } from './Avatar';
import { Diffstat, prIconClass, prIconName } from './bits';
import { Icon } from './Icon';
import { Labels } from './Label';
import { Markdown } from './Markdown';
import { RepoChip } from './RepoChip';

interface PrRowProps {
  pr: PullRequest;
  density: Density;
  cursor?: boolean;
  active?: boolean;
  onOpen: (pr: PullRequest) => void;
}

const GhLink = ({ url }: { url: string }) => (
  <a className="gh" href={url} target="_blank" rel="noopener noreferrer" title="Open on GitHub (o)" onClick={(e) => e.stopPropagation()}>
    <Icon name="ext" />
  </a>
);

/**
 * One PR in the list, in any of the three densities. Memoized: keep every prop stable (no inline
 * callbacks or refs) so only the rows whose cursor/active state changed re-render.
 */
export const PrRow = memo(function PrRow({ pr, density, cursor, active, onOpen }: PrRowProps) {
  const at = pr.activityAt;
  const cls = cx('pr', density === 'titles' && 't', cursor && 'cursor', active && 'active');
  const open = () => onOpen(pr);
  // Enter is handled by the list (it opens the row under the j/k cursor, which follows clicks).
  const time = <time dateTime={at} title={fmtDateTime(at)}>{fmtDate(at)}</time>;

  if (density === 'titles') {
    return (
      <article className={cls} onClick={open} tabIndex={-1} aria-label={pr.title} data-id={pr.id}>
        <span className={`pr-ic ${prIconClass(pr)}`}><Icon name={prIconName(pr)} /></span>
        <span className="t-repo"><RepoChip name={pr.repo} /><span className="num">#{pr.number}</span></span>
        <span className="t-title">{pr.title}{pr.isDraft && <span className="draft-tag">Draft</span>}<Labels labels={pr.labels} /></span>
        <Avatar actor={pr.author} size={18} />
        {time}
        <GhLink url={pr.url} />
      </article>
    );
  }

  const verb = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'opened';
  const isNew = isNewSinceLastVisit(at);
  return (
    <article className={cls} onClick={open} tabIndex={-1} aria-label={pr.title} data-id={pr.id}>
      <span className={`pr-ic ${prIconClass(pr)}`}><Icon name={prIconName(pr)} /></span>
      <div className="pr-main">
        <div className="pr-title">
          {pr.title}
          {pr.isDraft && <span className="draft-tag">Draft</span>}
          <Labels labels={pr.labels} />
        </div>
        <div className="pr-meta">
          <RepoChip name={pr.repo} />
          <span className="num">#{pr.number}</span>
          <span className="sep">·</span>
          <span>{verb} {rel(at)} by</span>
          <span className="author">
            <Avatar actor={pr.author} />
            <b>{pr.author.isMe ? 'you' : actorName(pr.author)}</b>
          </span>
          <span className="sep">·</span>
          <Diffstat add={pr.additions} del={pr.deletions} />
        </div>
        {density === 'full'
          ? <Markdown source={pr.body} />
          : pr.body.trim() && <p className="pr-desc">{plainPreview(pr.body)}</p>}
      </div>
      <div className="pr-side">
        <span className="when">
          {isNew && <span className="new-dot" title="New since your last visit" />}
          {time}
        </span>
        <GhLink url={pr.url} />
      </div>
    </article>
  );
});

/** A release interleaved in the PR list. */
export const ReleaseRow = memo(function ReleaseRow({ release: r, density }: { release: Release; density: Density }) {
  const title = r.name && r.name !== r.tag ? `${r.tag} · ${r.name}` : r.tag;
  const time = <time dateTime={r.publishedAt} title={fmtDateTime(r.publishedAt)}>{fmtDate(r.publishedAt)}</time>;
  const releaseLabel = <Labels labels={[{ name: r.isPrerelease ? 'pre-release' : 'release', color: r.isPrerelease ? 'c98500' : '1a7f37' }]} />;
  if (density === 'titles') {
    return (
      <article className="pr t rel">
        <span className="pr-ic release"><Icon name="tag" /></span>
        <span className="t-repo"><RepoChip name={r.repo} /></span>
        <span className="t-title"><a href={r.url} target="_blank" rel="noopener noreferrer">{title}</a></span>
        <span />
        {time}
        <span />
      </article>
    );
  }
  return (
    <article className="pr rel">
      <span className="pr-ic release"><Icon name="tag" /></span>
      <div className="pr-main">
        <div className="pr-title"><a href={r.url} target="_blank" rel="noopener noreferrer">{title}</a> {releaseLabel}</div>
        <div className="pr-meta">
          <RepoChip name={r.repo} />
          <span className="sep">·</span>
          <span>released {rel(r.publishedAt)}</span>
        </div>
        {density === 'full'
          ? r.body.trim() && <Markdown source={r.body} />
          : r.body.trim() && <p className="pr-desc">{plainPreview(r.body)}</p>}
      </div>
      <div className="pr-side">
        <span className="when">{isNewSinceLastVisit(r.publishedAt) && <span className="new-dot" title="New since your last visit" />}{time}</span>
        <a className="gh" href={r.url} target="_blank" rel="noopener noreferrer" title="Open on GitHub"><Icon name="ext" /></a>
      </div>
    </article>
  );
});
