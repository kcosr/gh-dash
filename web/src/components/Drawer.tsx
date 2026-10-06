import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PullRequest, PullRequestDetail } from '../../../shared/api';
import { capitalize, refText } from '../../../shared/provider';
import { findCachedPr, splitPrId, usePrDetail, useThreads } from '../api/hooks';
import { Drawer, DrawerSection, hasBlockingLayer, isTypingTarget } from '../workbench';
import { dur, fmtDate, fmtDateTime, plural, rel } from '../lib/time';
import { sortThreads } from '../lib/threadList';
import { commitDiffId, useUrlState } from '../lib/urlState';
import { actorName, actorSubject, copyText, isPlainClick } from '../lib/util';
import { Avatar } from './Avatar';
import { Diffstat, prIconName } from './bits';
import { Icon } from './Icon';
import { Labels } from './Label';
import { Markdown } from './Markdown';
import { RepoChip } from './RepoChip';
import { useProviderOf, useRepoLabel } from './repoMapContext';
import { ThreadRow } from './ThreadRow';
import { useToast } from '../workbench';

/**
 * PR details: a right column on desktop, the content pane on narrow screens. `resize` is the
 * column's width separator: kept beside the column (so it doesn't scroll with it) but mounted with it.
 */
export function PrDrawer({ id, compact, resize }: { id: string; compact: boolean; resize?: ReactNode }) {
  const { set } = useUrlState();
  const qc = useQueryClient();
  const toast = useToast();
  const label = useRepoLabel();
  const providerOf = useProviderOf();
  const detail = usePrDetail(id);
  const threads = useThreads(id);
  const cached = useMemo(() => findCachedPr(qc, id), [qc, id, detail.dataUpdatedAt]);
  const pr: PullRequest | undefined = detail.data ?? cached;
  const full: PullRequestDetail | undefined = detail.data;
  const scroller = useRef<HTMLElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  const close = () => set({ pr: null });
  // Diffs come from GitHub on demand: nothing is fetched until one is opened. A PR's diff id is its id.
  const openDiff = useCallback((diffId: string, thread?: number) => set({ diff: diffId, thread: thread ?? null }), [set]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'd' || hasBlockingLayer() || isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      openDiff(id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, openDiff]);

  useEffect(() => {
    // The list is hidden in compact mode: focus Close, including when the viewport
    // narrows after opening. Generic drawer autofocus is disabled so it cannot
    // claim focus on the container before this product-specific target is chosen.
    if (compact && !hasBlockingLayer() && !scroller.current?.contains(document.activeElement)) {
      scroller.current?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.focus({ preventScroll: true });
    }
  }, [compact]);
  const returnFocus = () => document.querySelector<HTMLElement>(`article.pr[data-id="${CSS.escape(id)}"]`) ?? opener;
  useLayoutEffect(() => () => {
    // The separator is a sibling of the drawer, outside its overlay ownership.
    if (document.activeElement?.getAttribute('aria-controls') !== 'pr-drawer') return;
    requestAnimationFrame(() => {
      const target = returnFocus();
      if (document.activeElement === document.body && target?.isConnected && target.getClientRects().length) {
        target.focus({ preventScroll: true });
      }
    });
  }, [id, opener]);

  const copy = async (text: string, msg: string) => toast((await copyText(text)) ? msg : 'Copy failed');

  const withResize = (aside: ReactNode) => <>{resize}{aside}</>;

  if (!pr) {
    const [idRepo, idNumber] = splitPrId(id);
    const ip = providerOf(idRepo ?? '');
    const loadingId = idRepo && idNumber ? refText(ip.kind, label(idRepo), idNumber, 'pr') : id;
    return withResize(
      <Drawer className="pr-drawer" id="pr-drawer" ref={scroller} title={loadingId}
        label={`${capitalize(ip.pr.one)} details`} onClose={close} autoFocus={false}
        returnFocus={returnFocus} resetKey={id}>
        {detail.isError
          ? <p className="dr-missing">{(detail.error as { status?: number }).status === 404 ? `This ${ip.pr.one} is not in the local cache.` : `Couldn't load: ${(detail.error as Error).message}`}</p>
          : <div className="wb-skel-block" aria-busy="true"><i style={{ width: '70%', height: 22 }} /><i style={{ width: '45%' }} /><i style={{ width: '90%' }} /><i style={{ width: '80%' }} /></div>}
      </Drawer>,
    );
  }

  const p = providerOf(pr.repo);
  const pill = pr.state === 'merged' ? ['Merged', 'merged'] : pr.state === 'closed' ? ['Closed', 'closed'] : pr.isDraft ? ['Draft', 'draft'] : ['Open', 'open'];
  const n = pr.commitCount;
  const when = pr.activityAt;
  const base = <code>{pr.baseRef || 'main'}</code>;
  const verb = pr.state === 'merged'
    ? <>merged {n} {plural(n, 'commit')} into {base}</>
    : pr.state === 'closed'
      ? <>closed this without merging</>
      : <>wants to merge {n} {plural(n, 'commit')} into {base}</>;
  const mdCopy = `**${pr.title}** ([${refText(p.kind, label(pr.repo), pr.number, 'pr')}](${pr.url}))${pr.body.trim() ? `\n\n${pr.body.trim()}` : ''}`;

  return withResize(
    <Drawer className="pr-drawer" id="pr-drawer" ref={scroller} title={pr.title}
      label={`${capitalize(p.pr.one)} details`} onClose={close} autoFocus={false}
      returnFocus={returnFocus} resetKey={id}
      kicker={<><RepoChip repo={pr.repo} /><span className="num">{p.prRef}{pr.number}</span></>}
      meta={<>
          <span className={`state-pill ${pill[1]}`}><Icon name={prIconName(pr)} />{pill[0]}</span>
          <Avatar actor={pr.author} size={18} />
          <b>{actorSubject(pr.author)}</b> {verb} · <span title={fmtDateTime(when)}>{rel(when)}</span>
      </>}
      actions={<>
          <a className="wb-btn wb-btn--primary" href={pr.url} target="_blank" rel="noopener noreferrer"><Icon name="ext" />Open on {p.name}</a>
          <button type="button" className="wb-btn" data-diff={id} onClick={() => openDiff(id)} title="View the diff (d)">
            <Icon name="diff" />Files changed<span className="n">{pr.changedFiles.toLocaleString()}</span>
          </button>
          <button type="button" className="wb-btn" onClick={() => copy(pr.url, 'Link copied')}><Icon name="copy" />Copy link</button>
          <button type="button" className="wb-btn" onClick={() => copy(mdCopy, 'Copied as Markdown')}><Icon name="md" />Copy as Markdown</button>
      </>}>

      {!!threads.data?.length && (
        <DrawerSection title="Comments" count={threads.data.length}>
          {sortThreads(threads.data).map((t) => <ThreadRow key={t.id} thread={t} onOpen={() => openDiff(id, t.id)} />)}
        </DrawerSection>
      )}

      <DrawerSection title="Description">
        <Markdown source={pr.body} repo={pr.repo} />
      </DrawerSection>


      {full ? (
        full.closingIssues.length > 0 && (
          <DrawerSection title="Linked issues">
            {full.closingIssues.map((i) => (
              <a key={i.number} className="iss-li" href={i.url} target="_blank" rel="noopener noreferrer">
                <Icon name={i.state === 'closed' ? 'issueClosed' : 'issue'} className={i.state === 'open' ? 'open' : undefined} />
                <span className="num">#{i.number}</span>
                <span className="iss-t">{i.title}</span>
                <span className="st">{i.state === 'closed' ? (pr.state === 'merged' ? `closed by this ${p.pr.short}` : 'closed') : pr.state === 'open' ? 'closes on merge' : 'open'}</span>
              </a>
            ))}
          </DrawerSection>
        )
      ) : null}

      <DrawerSection title="Commits" count={full ? full.commits.length : n}>
        {full ? (
          full.commits.length ? full.commits.map((c) => (
            <div key={c.oid} className="c-li">
              <a className="sha" href={c.url} target="_blank" rel="noopener noreferrer" data-diff={commitDiffId(pr.repo, c.oid)} title="View the commit's diff"
                onClick={(e) => { if (isPlainClick(e)) { e.preventDefault(); openDiff(commitDiffId(pr.repo, c.oid)); } }}>{c.oid.slice(0, 7)}</a>
              <span title={actorName(c.author)}>{c.headline}</span>
              <time dateTime={c.committedAt} title={fmtDateTime(c.committedAt)}>{fmtDate(c.committedAt)}</time>
            </div>
          )) : <div className="muted small">No commits recorded.</div>
        ) : detail.isError ? (
          <div className="muted small">Couldn't load commits.</div>
        ) : (
          <div className="wb-skel-block" aria-busy="true">{Array.from({ length: Math.min(4, Math.max(1, n)) }, (_, i) => <i key={i} style={{ width: `${88 - i * 9}%` }} />)}</div>
        )}
        {full && full.commits.length < pr.commitCount && (
          <div className="muted small">Showing {full.commits.length} of {pr.commitCount} commits · <a href={p.link.prCommits(pr.url)} target="_blank" rel="noopener noreferrer">all on {p.name}</a></div>
        )}
      </DrawerSection>

      <DrawerSection title="Details">
        <dl className="wb-kv">
          <dt>Opened</dt><dd>{fmtDateTime(pr.createdAt)} by {actorName(pr.author)}</dd>
          {pr.mergedAt && <>
            <dt>Merged</dt><dd>{fmtDateTime(pr.mergedAt)}{pr.mergedBy ? ` by ${pr.mergedBy}` : ''}</dd>
            <dt>Time to merge</dt><dd>{dur(Date.parse(pr.mergedAt) - Date.parse(pr.createdAt))}</dd>
          </>}
          {pr.state === 'closed' && pr.closedAt && <><dt>Closed</dt><dd>{fmtDateTime(pr.closedAt)}</dd></>}
          <dt>Changes</dt><dd><Diffstat add={pr.additions} del={pr.deletions} />&nbsp;in {pr.changedFiles} {plural(pr.changedFiles, 'file')}</dd>
          <dt>Branch</dt><dd><code>{pr.baseRef}</code> ← <code>{pr.headRef}</code></dd>
          <dt>Labels</dt><dd>{pr.labels.length ? <Labels labels={pr.labels} /> : <span className="muted">None</span>}</dd>
        </dl>
      </DrawerSection>
    </Drawer>,
  );
}
