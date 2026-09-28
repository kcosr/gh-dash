/**
 * The diff view: a PR's or commit's changes, full width over the list and drawer columns (the whole
 * content area on narrow screens). A blocking layer, so list shortcuts stop while it's open. The
 * renderer (web/src/diff) is heavy, so it's split into its own chunk, loaded when a diff first opens.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { isUnreachable, rateLimitResetAt } from '../api/client';
import { findCachedCommit, findCachedPr, useDiff, useLoadFile, usePrDetail, useRefreshDiff, useRepoMap } from '../api/hooks';
import { useLayer } from '../lib/layers';
import { fmtTime, plural, rel, relFuture } from '../lib/time';
import { parseDiffId, useUrlState } from '../lib/urlState';
import type { DiffTarget } from '../lib/urlState';
import { isChunkLoadError } from '../lib/util';
import { Diffstat } from './bits';
import { EmptyState, ErrorNote, ProgressBar } from './EmptyState';
import { Icon } from './Icon';
import { RepoChip } from './RepoChip';
import { useToast } from './Toasts';

const loadViewer = () => import('../diff/DiffViewer');
const DiffViewer = lazy(loadViewer);

/** What the header can show before the diff arrives, from PRs and commits already loaded by lists. */
interface Summary { title: string; additions?: number; deletions?: number; files?: number; url: string }

function cachedSummary(qc: QueryClient, t: DiffTarget): Summary | undefined {
  if (t.kind === 'pr') {
    const pr = findCachedPr(qc, `${t.repo}#${t.number}`);
    return pr && { title: pr.title, additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles, url: `${pr.url}/files` };
  }
  const c = findCachedCommit(qc, t.repo, t.oid);
  return c && { title: c.headline, additions: c.additions, deletions: c.deletions, url: c.url };
}

export function DiffView({ id, compact }: { id: string; compact: boolean }) {
  const { s, set } = useUrlState();
  const qc = useQueryClient();
  const toast = useToast();
  const repos = useRepoMap();
  const t = useMemo(() => parseDiffId(id)!, [id]); // only mounted for a valid `diff` param
  const diff = useDiff(id);
  const refresh = useRefreshDiff(id);
  const loadFile = useLoadFile(t.repo);
  // The PR's details (from the local API, as the drawer loads them) fill the header while the diff
  // loads or when it fails, also on a deep link that opened before any list was loaded.
  const prDetail = usePrDetail(t.kind === 'pr' ? `${t.repo}#${t.number}` : null);
  const cached = useMemo(() => cachedSummary(qc, t), [qc, t, prDetail.data]);
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // The deep-linked file as of opening; after that the URL only follows the viewer.
  const [initialFile] = useState(s.file);

  const close = () => set({ diff: null });
  const isActive = useLayer(true, close);

  // Fetch the renderer's chunk alongside the diff instead of after it.
  useEffect(() => { loadViewer().catch(() => { /* shown by the boundary on render */ }); }, []);

  // Scrolling reports each file it passes; only the one it settles on goes into the URL (replacing
  // the entry, so Back still closes the diff).
  const setRef = useRef(set);
  setRef.current = set;
  const fileTimer = useRef(0);
  const onFileChange = useCallback((path: string) => {
    clearTimeout(fileTimer.current);
    fileTimer.current = window.setTimeout(() => setRef.current({ file: path }, { replace: true }), 300);
  }, []);
  useEffect(() => () => clearTimeout(fileTimer.current), []);

  useEffect(() => {
    // The list and drawer are hidden underneath: start keyboard focus (and scrolling) in the diff.
    if (!panel.current?.contains(document.activeElement)) body.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const box = panel.current;
    return () => {
      // Hand focus back once the list and drawer are visible again (unless the user had moved it
      // elsewhere, e.g. the sidebar): to the link or button that opened the diff, else the PR's row
      // (opened with `d`), else whatever had focus, else any link to this diff.
      const active = document.activeElement;
      if (active && active !== document.body && !box?.contains(active)) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const q = CSS.escape(id);
        const target = [
          opener?.dataset.diff === id ? opener : null,
          document.querySelector<HTMLElement>(`article.pr[data-id="${q}"]`),
          opener,
          document.querySelector<HTMLElement>(`[data-diff="${q}"]`),
        ].find((el) => el && el !== document.body && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
        target?.focus({ preventScroll: true });
      });
    };
  }, [id, opener]);

  const d = diff.data;
  const label = t.kind === 'pr' ? `#${t.number}` : (d?.headOid ?? t.oid).slice(0, 7);
  const title = d?.title ?? cached?.title;
  const add = d?.additions ?? cached?.additions;
  const del = d?.deletions ?? cached?.deletions;
  const files = d?.totalFiles ?? cached?.files;
  const repo = repos.get(t.repo);
  const ghUrl = d?.url ?? cached?.url ?? (repo && (t.kind === 'pr' ? `${repo.url}/pull/${t.number}/files` : `${repo.url}/commit/${t.oid}`));

  useEffect(() => {
    const prev = document.title;
    return () => { document.title = prev; };
  }, []);
  useEffect(() => {
    document.title = `${title ? `${title} · ` : ''}${t.repo}${t.kind === 'pr' ? label : `@${label}`} · gh-dash`;
  }, [title, t.repo, t.kind, label]);

  const doRefresh = () => refresh.mutate(undefined, {
    onSuccess: (next) => toast(d && next.headOid === d.headOid ? 'Already up to date' : 'Diff updated'),
    onError: (e) => toast(`Couldn't refresh: ${(e as Error).message}`, { error: true }),
  });

  return (
    <section ref={panel} className="diff-view" aria-label={`Changes in ${t.repo} ${label}`}>
      <header className="dv-head">
        <RepoChip name={t.repo} />
        <span className="num">{label}</span>
        <h2 className="dv-title" title={title}>{title ?? (diff.isError ? null : <span className="skel" style={{ width: 220 }} />)}</h2>
        {add !== undefined && del !== undefined && <Diffstat add={add} del={del} />}
        {files !== undefined && <span className="dv-files">{files.toLocaleString()} {plural(files, 'file')}</span>}
        <span className="dv-actions">
          {ghUrl && <a className="btn" href={ghUrl} target="_blank" rel="noopener noreferrer" title="Open on GitHub"><Icon name="ext" /><span className="dv-lbl">Open on GitHub</span></a>}
          <button type="button" className="btn icon ghost" onClick={doRefresh} disabled={refresh.isPending || diff.isLoading}
            title={d ? `Check GitHub for changes (fetched ${rel(d.fetchedAt)})` : 'Check GitHub for changes'} aria-label="Refresh diff">
            <Icon name="sync" />
          </button>
          <button type="button" className="btn icon ghost" onClick={close} title="Close (Esc)" aria-label="Close diff"><Icon name="x" /></button>
        </span>
      </header>
      {d && d.totalFiles > d.files.length && (
        <div className="list-note dv-note">
          Showing {d.files.length.toLocaleString()} of {d.totalFiles.toLocaleString()} files: GitHub lists at most 3,000.{' '}
          <a href={d.url} target="_blank" rel="noopener noreferrer">See all on GitHub</a>
        </div>
      )}
      <div className="dv-body" ref={body} tabIndex={-1}>
        <ProgressBar active={refresh.isPending} />
        {d ? (
          d.files.length === 0 ? (
            <EmptyState icon="diff" title="No changed files">GitHub lists no file changes for this {t.kind === 'pr' ? 'pull request' : 'commit'}.</EmptyState>
          ) : (
            <ViewerBoundary ghUrl={d.url}>
              <Suspense fallback={<DiffSkeleton />}>
                <DiffViewer diff={d} loadFile={loadFile} compact={compact} isActive={isActive} file={initialFile} onFileChange={onFileChange} />
              </Suspense>
            </ViewerBoundary>
          )
        ) : diff.isError ? (
          <DiffError error={diff.error} t={t} ghUrl={ghUrl} onRetry={() => diff.refetch()} />
        ) : <DiffSkeleton />}
      </div>
    </section>
  );
}

function DiffSkeleton() {
  return (
    <div className="skel-block dv-skel" aria-busy="true" aria-label="Loading diff">
      {[34, 0, 72, 64, 81, 58, 0, 41, 0, 77, 69, 86].map((w, i) => (w ? <i key={i} style={{ width: `${w}%` }} /> : <span key={i} />))}
    </div>
  );
}

function DiffError({ error, t, ghUrl, onRetry }: { error: unknown; t: DiffTarget; ghUrl: string | undefined; onRetry: () => void }) {
  const status = (error as { status?: number }).status;
  const retry = <button type="button" className="btn" onClick={onRetry}><Icon name="sync" />Try again</button>;
  const gh = ghUrl && <a className="btn" href={ghUrl} target="_blank" rel="noopener noreferrer"><Icon name="ext" />Open on GitHub</a>;
  if (isUnreachable(error)) return <ErrorNote error={error} onRetry={onRetry} />;
  if (status === 404) {
    return (
      <EmptyState icon="alert" title={t.kind === 'pr' ? 'Pull request not found' : 'Commit not found'} action={gh}>
        {t.kind === 'pr' ? `${t.repo}#${t.number} isn't in the local database or on GitHub.` : `GitHub has no commit ${t.oid.slice(0, 7)} in ${t.repo}.`}
      </EmptyState>
    );
  }
  if (status === 503) {
    return (
      <EmptyState icon="key" title="A GitHub token is needed to view diffs" action={<Link className="btn" to="/settings">How to set a token</Link>}>
        Diffs are fetched from GitHub when you open them, and the server has no token. Set <code>GITHUB_TOKEN</code> in
        its environment or sign in with <code>gh auth login</code>, then restart gh-dash.
      </EmptyState>
    );
  }
  if (status === 429) {
    const at = rateLimitResetAt(error);
    return (
      <EmptyState icon="alert" title="GitHub's rate limit is used up" action={<div className="empty-actions">{retry}{gh}</div>}>
        {at ? <>It resets at {fmtTime(at)} ({relFuture(at)}). </> : 'Try again in a while. '}
        Diffs you've opened before still load from the cache.
      </EmptyState>
    );
  }
  if (status === 502) {
    return (
      <EmptyState icon="alert" title="GitHub didn't return this diff" action={<div className="empty-actions">{retry}{gh}</div>}>
        {(error as Error).message}
      </EmptyState>
    );
  }
  return <ErrorNote error={error} onRetry={onRetry} />;
}

/** The viewer failing to load (e.g. after a redeploy) or to render a diff leaves the rest of the app alone. */
class ViewerBoundary extends Component<{ ghUrl: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <EmptyState
        icon="alert"
        title={chunk ? 'The diff viewer could not be loaded' : "Couldn't show this diff"}
        action={
          <div className="empty-actions">
            {chunk && <button type="button" className="btn" onClick={() => window.location.reload()}><Icon name="sync" />Reload</button>}
            <a className="btn" href={this.props.ghUrl} target="_blank" rel="noopener noreferrer"><Icon name="ext" />Open on GitHub</a>
          </div>
        }
      >
        {chunk ? 'The app may have been updated, or the server is unreachable.' : error.message}
      </EmptyState>
    );
  }
}
