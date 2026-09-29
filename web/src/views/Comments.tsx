/**
 * Comments: every local diff-comment thread in scope, across PRs and commits, grouped per PR or commit (or repo, or
 * not at all). A row opens the diff at its thread; it also opens in place to read the conversation and resolve it.
 * Replying stays in the diff.
 */
import { useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Me, ThreadKindFilter, ThreadListItem, ThreadStatusFilter } from '../../../shared/api';
import { PROVIDERS, capitalize, refText } from '../../../shared/provider';
import { threadActions, useMe, useThreadList } from '../api/hooks';
import { threadListParams } from '../lib/apiQuery';
import { hasBlockingLayer, isTypingTarget } from '../lib/layers';
import { plainPreview } from '../lib/markdown';
import { fmtDateTime, plural, rel } from '../lib/time';
import { groupThreads, threadTarget } from '../lib/threadList';
import type { ThreadGroupOf } from '../lib/threadList';
import { useUrlState } from '../lib/urlState';
import type { ThreadGroup, ThreadOrder } from '../lib/urlState';
import { cx } from '../lib/util';
import { Avatar } from '../components/Avatar';
import { Ctl, MOD_K, prIconName } from '../components/bits';
import { EmptyState, ErrorNote, ProgressBar } from '../components/EmptyState';
import { FilterInput } from '../components/FilterInput';
import { FilterToolbar } from '../components/FilterToolbar';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { RepoChip } from '../components/RepoChip';
import { useProviderOf, useRepoLabel, useWords } from '../components/repoMapContext';
import { Seg } from '../components/Seg';
import { ThreadRow, threadPlace } from '../components/ThreadRow';
import { useToast } from '../components/Toasts';
import { useUI } from '../components/ui';
import { ListSkeleton, NoReposSelected } from './PullRequests';

const STATUS_WORD = { open: 'unresolved', resolved: 'resolved', all: '' } as const;
/** Controls that handle their own keys (the row's own button is the list's, see onKey). */
const CONTROLS = 'button, a[href], input, select, textarea, summary, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="separator"]';
const NONE = new Map<number, ThreadListItem>();

const rowButton = (id: number) => document.querySelector<HTMLElement>(`.cv-row[data-thread="${id}"] > .th-li`);

export function CommentsView() {
  const { s, set } = useUrlState();
  const { openExport } = useUI();
  const qc = useQueryClient();
  const toast = useToast();
  const words = useWords();
  const w = words.pr;
  const providerOf = useProviderOf();
  const label = useRepoLabel();
  const me = useMe().data;
  const params = threadListParams(s);
  const list = useThreadList(params);
  const data = list.data;
  const filterKey = JSON.stringify(params);

  // The list holds still while you work through it, until the filters change: rows keep the place they had when first
  // seen (a reply or a status change doesn't move them to the top), and a thread resolved or reopened here stays in
  // view (the newer copy of the two), even once it no longer matches the status filter.
  const [kept, setKept] = useState(() => ({ key: filterKey, rows: NONE }));
  const keptRows = kept.key === filterKey ? kept.rows : NONE;
  const seen = useRef({ key: filterKey, at: new Map<number, string>() });
  const items = useMemo(() => {
    if (seen.current.key !== filterKey) seen.current = { key: filterKey, at: new Map() };
    const at = seen.current.at;
    const byId = new Map((data?.items ?? []).map((t) => [t.id, t]));
    for (const t of keptRows.values()) {
      const cur = byId.get(t.id);
      if (!cur || cur.updatedAt < t.updatedAt) byId.set(t.id, t);
    }
    for (const t of byId.values()) if (!at.has(t.id)) at.set(t.id, t.updatedAt);
    return [...byId.values()];
  }, [data, keptRows, filterKey]);
  const groups = useMemo(() => {
    const at = seen.current.at;
    return groupThreads(items, s.threadGroup, s.threadSort, (t) => at.get(t.id) ?? t.updatedAt);
  }, [items, s.threadGroup, s.threadSort]);
  const rows = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // The j/k cursor: a thread, and where it was (a row that leaves the list leaves the cursor at its place).
  const [cursor, setCursor] = useState<{ id: number; index: number } | null>(null);
  useEffect(() => { setCursor(null); }, [filterKey]);
  const cursorIndex = useMemo(() => {
    if (!cursor || !rows.length) return -1;
    const i = rows.findIndex((t) => t.id === cursor.id);
    return i >= 0 ? i : Math.min(cursor.index, rows.length - 1);
  }, [cursor, rows]);
  const cursorId = cursorIndex >= 0 ? rows[cursorIndex]!.id : null;

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const setOpen = useCallback((id: number, open: boolean) => {
    setExpanded((cur) => {
      if (cur.has(id) === open) return cur;
      const next = new Set(cur);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    // Closing with focus inside the conversation: keep it on the row.
    if (!open && document.activeElement?.closest(`#cv-conv-${id}`)) rowButton(id)?.focus({ preventScroll: true });
  }, []);

  /** The diff opens from the row's own button, so closing it hands focus back there (DiffView). */
  const openDiff = useCallback((t: ThreadListItem) => {
    const i = rows.findIndex((r) => r.id === t.id);
    if (i >= 0) setCursor({ id: t.id, index: i });
    const btn = rowButton(t.id);
    if (btn && document.activeElement !== btn) btn.focus({ preventScroll: true });
    set({ diff: threadTarget(t), thread: t.id });
  }, [rows, set]);

  const toggleStatus = useCallback(async (t: ThreadListItem) => {
    const status = t.status === 'open' ? 'resolved' : 'open';
    try {
      const next = await threadActions(qc, threadTarget(t)).setStatus(t.id, status);
      setKept((k) => ({ key: filterKey, rows: new Map(k.key === filterKey ? k.rows : NONE).set(t.id, { ...t, ...next }) }));
      toast(status === 'resolved' ? 'Resolved' : 'Reopened');
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, { error: true });
    }
  }, [qc, filterKey, toast]);

  /** A row's button took focus (Tab, a click, back from the diff): the cursor follows. */
  const onRowFocus = useCallback((id: number) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) setCursor({ id, index: i });
  }, [rows]);

  const move = useCallback((i: number, focus: boolean) => {
    const t = rows[i]!;
    setCursor({ id: t.id, index: i });
    const btn = rowButton(t.id);
    btn?.closest('.cv-row')?.scrollIntoView({ block: 'nearest' });
    if (focus) btn?.focus({ preventScroll: true });
  }, [rows]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasBlockingLayer() || isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey || !rows.length) return;
      const el = e.target as Element | null;
      // A row's own button takes the list's keys (Space expands it rather than opening the diff); other controls
      // keep Enter, Space and the arrows.
      const onRow = !!el?.closest?.('.cv-row > .th-li');
      const inList = !!el?.closest?.('.cv-list');
      const onControl = !onRow && !!el?.closest?.(CONTROLS);
      const cur = cursorIndex >= 0 ? rows[cursorIndex] : undefined;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        move(Math.max(0, Math.min(rows.length - 1, cursorIndex + (e.key === 'j' ? 1 : -1))), inList);
      } else if (e.key === 'Enter') {
        if (!cur || onControl || onRow) return;
        e.preventDefault();
        openDiff(cur);
      } else if (e.key === ' ') {
        if (!cur || onControl) return;
        e.preventDefault();
        setOpen(cur.id, !expanded.has(cur.id));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!cur || (onControl && !inList)) return;
        e.preventDefault();
        setOpen(cur.id, e.key === 'ArrowRight');
      } else if (e.key === 'e') {
        if (!cur) return;
        e.preventDefault();
        void toggleStatus(cur);
      } else if (e.key === 'o') {
        if (!cur) return;
        e.preventDefault();
        window.open(cur.targetUrl, '_blank', 'noopener');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, cursorIndex, expanded, move, openDiff, setOpen, toggleStatus]);

  const total = data?.total ?? 0;
  const counts = data?.counts;
  const fetching = list.isFetching && !!data;
  const stWord = STATUS_WORD[s.status];
  const summary = useMemo(() => {
    const prs = new Set<string>(), commits = new Set<string>(), repos = new Set<string>();
    for (const t of data?.items ?? []) {
      (t.kind === 'pr' ? prs : commits).add(threadTarget(t));
      repos.add(t.repo);
    }
    const on = [prs.size && `${prs.size} ${plural(prs.size, w.short, w.shortMany)}`, commits.size && `${commits.size} ${plural(commits.size, 'commit')}`].filter(Boolean).join(' and ');
    return `${[stWord, plural(total, 'thread')].filter(Boolean).join(' ')}${on ? ` on ${on}` : ''}${repos.size ? ` · ${repos.size} ${plural(repos.size, 'repo')}` : ''}`;
  }, [data, total, stWord, w]);
  // "PR or commit"; with both hosts' repos in view, "PR/MR or commit".
  const changeWord = words.host ? w.short : `${PROVIDERS.github.pr.short}/${PROVIDERS.gitlab.pr.short}`;
  const kindWord = s.kind === 'pr' ? `on ${w.shortMany}` : s.kind === 'commit' ? 'on commits' : '';
  const n = (x: number | undefined) => x !== undefined && <span className="n">{x.toLocaleString()}</span>;

  return (
    <main className="main">
      <FilterToolbar summary={[s.status === 'open' ? 'Unresolved' : s.status === 'resolved' ? 'Resolved' : 'All', s.kind === 'pr' ? w.shortMany : s.kind === 'commit' ? 'Commits' : '', s.q && `“${s.q}”`].filter(Boolean).join(' · ')}>
        <div className="row">
          <Seg<ThreadStatusFilter>
            value={s.status}
            onChange={(status) => set({ status })}
            ariaLabel="Status"
            options={[
              { value: 'open', label: <><Icon name="comment" />Unresolved{n(counts?.open)}</> },
              { value: 'resolved', label: <><Icon name="check" />Resolved{n(counts?.resolved)}</> },
              { value: 'all', label: <>All{n(counts && counts.open + counts.resolved)}</> },
            ]}
          />
          <Seg<ThreadKindFilter> value={s.kind} onChange={(kind) => set({ kind })} ariaLabel="Threads on" options={[
            { value: 'all', label: 'All' }, { value: 'pr', label: w.shortMany }, { value: 'commit', label: 'Commits' },
          ]} />
          <span className="summary grow" title={data ? `${total.toLocaleString()} ${summary}` : undefined}>
            {data ? <><b>{total.toLocaleString()}</b> {summary}</> : list.isError ? null : <span className="muted">Loading…</span>}
          </span>
          <span className="btn-group">
            <button type="button" className="btn" onClick={() => openExport('md')}><Icon name="md" />Markdown</button>
            <button type="button" className="btn" onClick={() => openExport('api')}><Icon name="braces" />API</button>
          </span>
        </div>
        <div className="row">
          <FilterInput value={s.q} onChange={(q) => set({ q }, { replace: true })} placeholder="Filter by comment or file path…" />
          <span className="spacer" />
          <Ctl label="Group">
            <Seg<ThreadGroup> className="sm" value={s.threadGroup} onChange={(threadGroup) => set({ threadGroup })} ariaLabel="Group by" options={[
              { value: 'target', label: `${changeWord} or commit` }, { value: 'repo', label: 'Repo' }, { value: 'none', label: 'None' },
            ]} />
          </Ctl>
          <Ctl label="Sort">
            <Seg<ThreadOrder> className="sm" value={s.threadSort} onChange={(threadSort) => set({ threadSort })} ariaLabel="Sort" options={[
              { value: 'recent', label: 'Recent', title: 'Latest activity first' },
              { value: 'oldest', label: 'Oldest', title: 'Earliest activity first' },
              { value: 'file', label: 'File order', title: `Each ${changeWord} or commit read top to bottom: general comments, then by file and line` },
            ]} />
          </Ctl>
        </div>
      </FilterToolbar>

      <div className="scroll" id="scroll">
        <ProgressBar active={fetching} />
        <div className={cx('list cv-list', s.threadGroup === 'none' && 'flat', fetching && 'stale')}>
          {list.isError && !data ? (
            <ErrorNote error={list.error} onRetry={() => list.refetch()} />
          ) : !data ? (
            <ListSkeleton density="titles" />
          ) : s.repos?.length === 0 ? (
            <NoReposSelected onSelectAll={() => set({ repos: null })} />
          ) : !rows.length && counts && counts.open + counts.resolved === 0 && !s.q && s.kind === 'all' ? (
            <EmptyState icon="comment" title={s.repos === null && s.vis === 'all' && s.own === 'all' ? 'No comments yet' : 'No comments in these repositories'}>
              Comments you add in a diff show up here. Open the changes of a {changeWord} or a commit, and use the + beside a
              line, or the comments column for one on the whole of it.
            </EmptyState>
          ) : !rows.length ? (
            <EmptyState
              icon="comment"
              title={`No ${[stWord, 'comments', kindWord].filter(Boolean).join(' ')}${s.q ? ` matching “${s.q}”` : ''}`}
              action={
                <div className="empty-actions">
                  {s.status !== 'all' && counts && (s.status === 'open' ? counts.resolved : counts.open) > 0 && (
                    <button type="button" className="btn" onClick={() => set({ status: 'all' })}>Show all comments</button>
                  )}
                  {s.kind !== 'all' && <button type="button" className="btn" onClick={() => set({ kind: 'all' })}>Show {w.shortMany} and commits</button>}
                  {s.q && <button type="button" className="btn" onClick={() => set({ q: '' })}>Clear filter</button>}
                </div>
              }
            >
              {s.status === 'open' && !s.q && counts && counts.resolved > 0 ? 'Everything here is resolved.' : 'Try another filter, or select more repositories.'}
            </EmptyState>
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.key} aria-label={s.threadGroup === 'target' ? targetText(g.items[0]!, label, providerOf) : s.threadGroup === 'repo' ? label(g.key) : undefined}>
                  {s.threadGroup === 'target' ? (
                    <TargetHeader g={g} status={s.status} onDiff={() => set({ diff: g.key, thread: null })} onDetails={() => set({ pr: g.key })} />
                  ) : s.threadGroup === 'repo' ? (
                    <div className="group-h">
                      <span className="gt"><RepoChip repo={g.key} className="repo-ref" /></span>
                      <span className="rule" />
                      <span className="gc">{groupCount(g, s.status)}</span>
                    </div>
                  ) : null}
                  {g.items.map((t) => (
                    <Row key={t.id} t={t} on={s.threadGroup === 'none' ? 'repo' : s.threadGroup === 'repo' ? 'ref' : null}
                      cursor={cursorId === t.id} open={expanded.has(t.id)} me={me}
                      onOpen={openDiff} onToggle={setOpen} onStatus={toggleStatus} onFocus={onRowFocus} />
                  ))}
                </section>
              ))}
              {data.nextCursor && (
                <div className="list-note">Showing the {data.items.length.toLocaleString()} {s.threadSort === 'oldest' ? 'least' : 'most'} recently active of {total.toLocaleString()} threads. Filter to see the rest.</div>
              )}
              <div className="list-foot">
                <span><kbd>j</kbd> <kbd>k</kbd> move</span>
                <span><kbd>↵</kbd> open in diff</span>
                <span><kbd>Space</kbd> conversation</span>
                <span><kbd>e</kbd> resolve / reopen</span>
                <span><kbd>/</kbd> filter</span>
                <span><kbd>{MOD_K}</kbd> jump anywhere</span>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

type ProviderOf = ReturnType<typeof useProviderOf>;

/** "#42" or "!42" for a PR, "@3f2a91c" for a commit. */
const refOf = (t: ThreadListItem, providerOf: ProviderOf) => (t.kind === 'pr' ? `${providerOf(t.repo).prRef}${t.number}` : `@${t.commitOid.slice(0, 7)}`);

/** "app#42" or "app@3f2a91c", as the exports name them. */
const targetText = (t: ThreadListItem, label: (key: string) => string, providerOf: ProviderOf) =>
  t.kind === 'pr' ? refText(providerOf(t.repo).kind, label(t.repo), t.number!, 'pr') : `${label(t.repo)}@${t.commitOid.slice(0, 7)}`;

/** "3 threads · 1 unresolved": the unresolved part when it says something the status filter doesn't. */
function groupCount(g: ThreadGroupOf<ThreadListItem>, status: ThreadStatusFilter) {
  const n = g.items.length;
  return `${n} ${plural(n, 'thread')}${g.open > 0 && (g.open < n || status !== 'open') ? ` · ${g.open} unresolved` : ''}`;
}

/** A PR's or commit's group: what it is (the diff opens from its title), its threads, its last activity. */
function TargetHeader({ g, status, onDiff, onDetails }: { g: ThreadGroupOf<ThreadListItem>; status: ThreadStatusFilter; onDiff: () => void; onDetails: () => void }) {
  const t = g.items[0]!;
  const providerOf = useProviderOf();
  const p = providerOf(t.repo);
  const pr = t.kind === 'pr';
  const what = pr ? capitalize(p.pr.one) : 'Commit';
  const title = t.targetTitle ?? `${what} not synced`;
  const state = pr && t.prState;
  return (
    <div className="group-h cv-gh">
      <span className="gt">
        <span className={cx('pr-ic', state || 'commit')} title={state ? `${what} ${state}` : pr ? what : 'Commit'}>
          <Icon name={state ? prIconName({ state, isDraft: false }) : pr ? 'prOpen' : 'commit'} />
        </span>
        <RepoChip repo={t.repo} />
        <button type="button" className="cv-target" data-diff={g.key} onClick={onDiff} title={`${title} · open the diff`}>
          <span className="num">{refOf(t, providerOf)}</span>
          <span className={cx('cv-title', !t.targetTitle && 'muted')}>{title}</span>
        </button>
      </span>
      <span className="cv-acts">
        {pr && <button type="button" className="gh" onClick={onDetails} title={`${capitalize(p.pr.one)} details`} aria-label={`${capitalize(p.pr.one)} details`}><Icon name="doc" /></button>}
        <a className="gh" href={t.targetUrl} target="_blank" rel="noopener noreferrer" title={`Open on ${p.name}`} aria-label={`Open on ${p.name}`}><Icon name="ext" /></a>
      </span>
      <span className="rule" />
      <span className="gc">{groupCount(g, status)}<span className="cv-when"> · <time dateTime={g.lastAt} title={fmtDateTime(g.lastAt)}>{rel(g.lastAt)}</time></span></span>
    </div>
  );
}

/** Space activates a button on keyup: the row's own button leaves Space to the list (it expands the row). */
const keepSpace = (e: ReactKeyboardEvent) => { if (e.key === ' ') e.preventDefault(); };

/** One thread. Memoized: keep every prop stable, so moving the cursor re-renders two rows, not the list. */
const Row = memo(function Row({ t, on, cursor, open, me, onOpen, onToggle, onStatus, onFocus }: {
  t: ThreadListItem;
  /** Name what the thread is on: its ref (grouped per repo), with the repo (ungrouped), or not (grouped per target). */
  on: 'ref' | 'repo' | null;
  cursor: boolean;
  open: boolean;
  me: Me | undefined;
  onOpen: (t: ThreadListItem) => void;
  onToggle: (id: number, open: boolean) => void;
  onStatus: (t: ThreadListItem) => Promise<void>;
  onFocus: (id: number) => void;
}) {
  const providerOf = useProviderOf();
  const label = useRepoLabel();
  const resolved = t.status === 'resolved';
  const replies = t.comments.length - 1;
  const target = on === 'repo' ? targetText(t, label, providerOf) : refOf(t, providerOf);
  const convId = `cv-conv-${t.id}`;
  const aria = [
    resolved ? 'Resolved' : 'Unresolved',
    threadPlace(t),
    on && `on ${target}${t.targetTitle ? ` (${t.targetTitle})` : ''}`,
    plainPreview(t.comments[0]!.body, 120),
    replies > 0 && `${replies} ${plural(replies, 'reply', 'replies')}`,
    rel(t.updatedAt),
  ].filter(Boolean).join(', ');
  return (
    <div className={cx('cv-row', cursor && 'cursor', open && 'open', resolved && 'resolved')} data-thread={t.id}>
      <button type="button" className="cv-disc" tabIndex={-1} aria-expanded={open} aria-controls={open ? convId : undefined}
        aria-label={open ? 'Hide the conversation' : 'Show the conversation'} title={`${open ? 'Hide' : 'Show'} the conversation (Space)`}
        onClick={() => onToggle(t.id, !open)}>
        <Icon name={open ? 'chevron' : 'chevronRight'} />
      </button>
      <ThreadRow thread={t} onOpen={() => onOpen(t)} data-diff={threadTarget(t)} aria-label={aria} onFocus={() => onFocus(t.id)} onKeyDown={keepSpace} onKeyUp={keepSpace}
        before={on && <span className="cv-on" title={t.targetTitle ?? undefined}>{on === 'repo' && <span className="r">{label(t.repo)}</span>}{refOf(t, providerOf)}</span>}
        after={<>
          {t.earlierPush && <span className="cv-tag" title={`Made on an earlier push (${t.commitOid.slice(0, 7)}); the ${providerOf(t.repo).pr.short} has changed since`}>earlier push</span>}
          <time className="cv-time" dateTime={t.updatedAt} title={fmtDateTime(t.updatedAt)}>{rel(t.updatedAt)}</time>
        </>} />
      {open && <Conversation id={convId} t={t} me={me} onOpen={onOpen} onStatus={onStatus} />}
    </div>
  );
});

/** The whole conversation, read-only: authors, times, the Markdown. Resolve or reopen here; reply in the diff. */
function Conversation({ id, t, me, onOpen, onStatus }: { id: string; t: ThreadListItem; me: Me | undefined; onOpen: (t: ThreadListItem) => void; onStatus: (t: ThreadListItem) => Promise<void> }) {
  const resolved = t.status === 'resolved';
  const [busy, setBusy] = useState(false);
  return (
    <div className="cv-conv" id={id} role="group" aria-label={`Conversation on ${threadPlace(t)}`}>
      {t.snippet !== null && t.path !== null && <pre className="cv-snip" title={threadPlace(t)}>{t.snippet}</pre>}
      {t.comments.map((c) => {
        const self = c.author.kind === 'self';
        return (
          <div key={c.id} className="cv-c">
            <div className="cv-c-head">
              <Avatar actor={self ? { login: me?.login ?? null, name: me?.name ?? me?.login ?? 'You', avatarUrl: null, isMe: true } : { login: null, name: c.author.name, avatarUrl: null, isMe: false }} size={16} />
              <b>{self ? 'You' : c.author.name}</b>
              {!self && <span className="cv-agent" title="Written by an agent through the API">agent</span>}
              <time dateTime={c.createdAt} title={fmtDateTime(c.createdAt)}>{rel(c.createdAt)}</time>
              {c.editedAt && <span title={`Edited ${fmtDateTime(c.editedAt)}`}>· edited</span>}
            </div>
            <Markdown source={c.body} repo={t.repo} className="md cv-md" />
          </div>
        );
      })}
      <div className="cv-foot">
        <button type="button" className="btn sm" disabled={busy} title={`${resolved ? 'Reopen' : 'Resolve'} (e)`}
          onClick={() => { setBusy(true); void onStatus(t).finally(() => setBusy(false)); }}>
          <Icon name={resolved ? 'comment' : 'check'} />{resolved ? 'Reopen' : 'Resolve'}
        </button>
        <button type="button" className="btn sm" data-diff={threadTarget(t)} onClick={() => onOpen(t)} title="Open the diff at this thread, to reply (Enter)">
          <Icon name="diff" />Open in diff
        </button>
      </div>
    </div>
  );
}
