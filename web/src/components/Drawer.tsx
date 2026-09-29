import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommentThread, PullRequest, PullRequestDetail } from '../../../shared/api';
import { findCachedPr, usePrDetail, useThreads } from '../api/hooks';
import { hasBlockingLayer, isTypingTarget, useLayer } from '../lib/layers';
import { plainPreview } from '../lib/markdown';
import { dur, fmtDate, fmtDateTime, plural, rel } from '../lib/time';
import { commitDiffId, useUrlState } from '../lib/urlState';
import { actorName, actorSubject, copyText, isPlainClick } from '../lib/util';
import { Avatar } from './Avatar';
import { Diffstat, prIconName } from './bits';
import { Icon } from './Icon';
import { Labels } from './Label';
import { Markdown } from './Markdown';
import { RepoChip } from './RepoChip';
import { useToast } from './Toasts';

/** Threads in reading order without a diff at hand: general first, then by path and line. */
const sortThreads = (list: CommentThread[]) =>
  [...list].sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || (a.startLine ?? 0) - (b.startLine ?? 0) || a.id - b.id);

/** PR details: a right column on desktop, the content pane on narrow screens. */
export function PrDrawer({ id, compact }: { id: string; compact: boolean }) {
  const { set } = useUrlState();
  const qc = useQueryClient();
  const toast = useToast();
  const detail = usePrDetail(id);
  const threads = useThreads(id);
  const cached = useMemo(() => findCachedPr(qc, id), [qc, id, detail.dataUpdatedAt]);
  const pr: PullRequest | undefined = detail.data ?? cached;
  const full: PullRequestDetail | undefined = detail.data;
  const scroller = useRef<HTMLElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  const close = () => set({ pr: null });
  useLayer(true, close, false);
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

  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [id]);
  useEffect(() => {
    // The list is hidden in compact mode, so move keyboard focus into its replacement.
    if (compact && !hasBlockingLayer() && !scroller.current?.contains(document.activeElement)) {
      scroller.current?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.focus({ preventScroll: true });
    }
  }, [compact]);
  useLayoutEffect(() => {
    const drawer = scroller.current;
    return () => {
      // This is a nonmodal column: leave focus alone while it is outside the drawer,
      // but don't lose keyboard position when a focused drawer control disappears.
      if (!drawer?.contains(document.activeElement)) return;
      const row = document.querySelector<HTMLElement>(`article.pr[data-id="${CSS.escape(id)}"]`);
      const target = row ?? opener;
      if (target && target !== document.body && target.isConnected && !drawer.contains(target)) {
        // Wait until the list is visible again after the drawer's grid class is removed.
        requestAnimationFrame(() => {
          if (target.isConnected && target.getClientRects().length && getComputedStyle(target).visibility === 'visible' && document.activeElement === document.body) {
            target.focus({ preventScroll: true });
            if (compact) target.scrollIntoView({ block: 'nearest' });
          }
        });
      }
    };
  }, [id, opener, compact]);

  const copy = async (text: string, msg: string) => toast((await copyText(text)) ? msg : 'Copy failed');

  if (!pr) {
    return (
      <aside className="drawer" ref={scroller} aria-label="Pull request details">
        <div className="dr-head">
          <div className="dr-top">
            <span className="num">{id}</span>
            <span className="spacer" />
            <button type="button" className="btn icon ghost" onClick={close} title="Close (Esc)" aria-label="Close"><Icon name="x" /></button>
          </div>
          {detail.isError
            ? <p className="dr-missing">{(detail.error as { status?: number }).status === 404 ? 'This pull request is not in the local cache.' : `Couldn't load: ${(detail.error as Error).message}`}</p>
            : <div className="skel-block" aria-busy="true"><i style={{ width: '70%', height: 22 }} /><i style={{ width: '45%' }} /><i style={{ width: '90%' }} /><i style={{ width: '80%' }} /></div>}
        </div>
      </aside>
    );
  }

  const pill = pr.state === 'merged' ? ['Merged', 'merged'] : pr.state === 'closed' ? ['Closed', 'closed'] : pr.isDraft ? ['Draft', 'draft'] : ['Open', 'open'];
  const n = pr.commitCount;
  const when = pr.activityAt;
  const base = <code>{pr.baseRef || 'main'}</code>;
  const verb = pr.state === 'merged'
    ? <>merged {n} {plural(n, 'commit')} into {base}</>
    : pr.state === 'closed'
      ? <>closed this without merging</>
      : <>wants to merge {n} {plural(n, 'commit')} into {base}</>;
  const mdCopy = `**${pr.title}** ([${pr.repo}#${pr.number}](${pr.url}))${pr.body.trim() ? `\n\n${pr.body.trim()}` : ''}`;

  return (
    <aside className="drawer" ref={scroller} aria-label="Pull request details">
      <div className="dr-head">
        <div className="dr-top">
          <RepoChip name={pr.repo} />
          <span className="num">#{pr.number}</span>
          <span className="spacer" />
          <button type="button" className="btn icon ghost" onClick={close} title="Close (Esc)" aria-label="Close"><Icon name="x" /></button>
        </div>
        <h2>{pr.title}</h2>
        <div className="dr-meta">
          <span className={`state-pill ${pill[1]}`}><Icon name={prIconName(pr)} />{pill[0]}</span>
          <Avatar actor={pr.author} size={18} />
          <b>{actorSubject(pr.author)}</b> {verb} · <span title={fmtDateTime(when)}>{rel(when)}</span>
        </div>
        <div className="dr-actions">
          <a className="btn primary" href={pr.url} target="_blank" rel="noopener noreferrer"><Icon name="ext" />Open on GitHub</a>
          <button type="button" className="btn" data-diff={id} onClick={() => openDiff(id)} title="View the diff (d)">
            <Icon name="diff" />Files changed<span className="n">{pr.changedFiles.toLocaleString()}</span>
          </button>
          <button type="button" className="btn" onClick={() => copy(pr.url, 'Link copied')}><Icon name="copy" />Copy link</button>
          <button type="button" className="btn" onClick={() => copy(mdCopy, 'Copied as Markdown')}><Icon name="md" />Copy as Markdown</button>
        </div>
      </div>

      {!!threads.data?.length && (
        <section className="dr-sec">
          <h3>Comments <span className="n">{threads.data.length}</span></h3>
          {sortThreads(threads.data).map((t) => {
            const first = t.comments[0]!;
            const lines = t.startLine === null ? '' : `:${t.startLine === t.endLine ? t.startLine : `${t.startLine}–${t.endLine}`}`;
            const name = t.path === null ? 'General' : t.path.slice(t.path.lastIndexOf('/') + 1);
            return (
              <button key={t.id} type="button" className={`th-li${t.status === 'resolved' ? ' resolved' : ''}`} onClick={() => openDiff(id, t.id)}
                title={`${t.path ?? 'General'}${lines}${t.status === 'resolved' ? ' · resolved' : ''} · open the diff at this thread`}>
                <Icon name={t.status === 'resolved' ? 'check' : 'comment'} />
                <span className="th-where"><span className="name">{name}</span>{lines && <span className="ln">{lines}</span>}</span>
                <span className="th-text">{plainPreview(first.body, 140)}</span>
                {t.comments.length > 1 && <span className="th-n" title={`${t.comments.length - 1} ${plural(t.comments.length - 1, 'reply', 'replies')}`}>+{t.comments.length - 1}</span>}
              </button>
            );
          })}
        </section>
      )}

      <section className="dr-sec">
        <h3>Description</h3>
        <Markdown source={pr.body} />
      </section>


      {full ? (
        full.closingIssues.length > 0 && (
          <section className="dr-sec">
            <h3>Linked issues</h3>
            {full.closingIssues.map((i) => (
              <a key={i.number} className="iss-li" href={i.url} target="_blank" rel="noopener noreferrer">
                <Icon name={i.state === 'closed' ? 'issueClosed' : 'issue'} className={i.state === 'open' ? 'open' : undefined} />
                <span className="num">#{i.number}</span>
                <span className="iss-t">{i.title}</span>
                <span className="st">{i.state === 'closed' ? (pr.state === 'merged' ? 'closed by this PR' : 'closed') : pr.state === 'open' ? 'closes on merge' : 'open'}</span>
              </a>
            ))}
          </section>
        )
      ) : null}

      <section className="dr-sec">
        <h3>Commits <span className="n">{full ? full.commits.length : n}</span></h3>
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
          <div className="skel-block" aria-busy="true">{Array.from({ length: Math.min(4, Math.max(1, n)) }, (_, i) => <i key={i} style={{ width: `${88 - i * 9}%` }} />)}</div>
        )}
        {full && full.commits.length < pr.commitCount && (
          <div className="muted small">Showing {full.commits.length} of {pr.commitCount} commits · <a href={`${pr.url}/commits`} target="_blank" rel="noopener noreferrer">all on GitHub</a></div>
        )}
      </section>

      <section className="dr-sec last">
        <h3>Details</h3>
        <dl className="kv">
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
      </section>
    </aside>
  );
}
