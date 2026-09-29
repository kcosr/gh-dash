import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import type { RepoCandidate, Visibility } from '../../../shared/api';
import { repoPath, resolveRepoKey } from '../../../shared/repos';
import { ApiError } from '../api/client';
import { qk, useAccount, useAddRepo, usePatchRepo, useRepoCandidates, useRepoLookup } from '../api/hooks';
import { useFocusTrap, useLayer } from '../lib/layers';
import { fmtNum } from '../lib/time';
import { backfillLine, inputKey, matchCandidates } from '../lib/tracking';
import { carrySearch } from '../lib/urlState';
import { cx, useDebounced } from '../lib/util';
import { Icon } from './Icon';
import { RepoName } from './RepoName';
import { useRepoLabel, useRepoMapCtx } from './repoMapContext';
import { useToast } from './Toasts';

const SUGGESTED = 8;
const PLACEHOLDER = 'Search your repositories or paste owner/name or a URL';

/** A list row: a repository the token can read, or "check access to <typed key>". */
type Row = { kind: 'repo'; c: RepoCandidate; tracked: boolean } | { kind: 'check'; key: string };

const visLabel = (v: Visibility) => (v === 'private' ? 'Private' : v === 'internal' ? 'Internal' : 'Public');

function Note({ icon, tone, children }: { icon: ReactNode; tone?: 'warn' | 'muted'; children: ReactNode }) {
  return <div className={cx('ar-note', tone)} role="status">{icon}<div className="ar-note-t">{children}</div></div>;
}

/**
 * Add a repository you don't own (design §5.5): pick one of the token's repositories, or paste owner/name or a URL.
 * The token's access is checked (and the first sync sized) before Add; repos you own or track already say so instead.
 */
export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const { repos: repoMap } = useRepoMapCtx();
  const label = useRepoLabel();
  const account = useAccount().data;
  const candidates = useRepoCandidates(account?.source !== 'none' && !account?.mismatch);
  // The server refuses results for another account (409), cached ones too: the same as the account's mismatch.
  const refused = candidates.error instanceof ApiError && candidates.error.status === 409 ? candidates.error.message : null;
  const blocked = account?.source === 'none' ? 'token' : account?.mismatch || refused ? 'mismatch' : null;
  const add = useAddRepo();
  const patch = usePatchRepo();
  const toast = useToast();
  const navigate = useNavigate();

  const [text, setText] = useState('');
  /** A key chosen outright (a row, Enter, a paste): checked without waiting for typing to pause. */
  const [picked, setPicked] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [include, setInclude] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);
  useFocusTrap(box);
  const qc = useQueryClient();
  useEffect(() => { if (refused) void qc.invalidateQueries({ queryKey: qk.account }); }, [refused, qc]);
  // Blocked after it opened: the input it focused is disabled now, so keep focus inside (on Close).
  useEffect(() => {
    if (blocked && !box.current?.contains(document.activeElement)) box.current?.querySelector<HTMLElement>('.modal-h button')?.focus();
  }, [blocked]);

  const items = useMemo(() => candidates.data?.items ?? [], [candidates.data]);
  const typed = inputKey(text);
  const matches = useMemo(() => matchCandidates(items, text), [items, text]);
  const exact = !!typed && matches.some((c) => c.key.toLowerCase() === typed.toLowerCase());
  // A typed key is checked once typing pauses, unless the list still offers longer names that start with it (typing
  // "acme/inf" on the way to "acme/infra"): then a "Check" row offers it.
  const auto = typed && (exact || !matches.length) ? typed : null;
  const settled = useDebounced(auto, 300);
  const pending = picked ?? auto;
  const target = picked ?? (settled === auto ? auto : null);
  const trackedRepo = pending ? repoMap.get(resolveRepoKey(pending, repoMap) ?? '') ?? null : null;
  // Tracked repos are answered from the list; everything else asks GitHub (one GraphQL point).
  const lookup = useRepoLookup(target && !trackedRepo && !blocked ? target : null);

  const rows: Row[] = pending || blocked ? [] : text.trim()
    ? [
      ...matches.map((c): Row => ({ kind: 'repo', c, tracked: !!c.tracked || repoMap.has(c.key) })),
      ...(typed && !exact ? [{ kind: 'check', key: typed } as Row] : []),
    ]
    : (candidates.data?.suggested ?? []).filter((c) => !repoMap.has(c.key)).slice(0, SUGGESTED).map((c): Row => ({ kind: 'repo', c, tracked: false }));
  const cur = Math.max(0, Math.min(active, rows.length - 1));
  useEffect(() => { list.current?.querySelector<HTMLElement>('.ar-row.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, rows.length]);

  const res = lookup.data;
  const preview = res?.ok ? res.repo : null;
  const failure = res && !res.ok ? res : null;
  const known = trackedRepo
    ? { key: trackedRepo.key, owned: trackedRepo.trackedBy === 'owned', hidden: trackedRepo.hidden, open: true }
    : preview && (preview.owned || preview.tracked)
      ? { key: preview.key, owned: preview.owned || preview.tracked === 'owned', hidden: !!preview.hidden, open: repoMap.has(preview.key) }
      : null;
  const checking = !!pending && !known && (!target || lookup.isFetching);
  const addable = !!preview && !known && !checking;
  const blockedWhy = blocked === 'token' ? 'Connect a GitHub account first (Settings)' : blocked === 'mismatch' ? 'The token belongs to another account' : undefined;

  const pick = (key: string) => { setText(key); setPicked(key); setErr(null); };
  const choose = (row: Row) => pick(row.kind === 'repo' ? row.c.key : row.key);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    const k = inputKey(v);
    setText(v);
    setActive(0);
    setErr(null);
    // A pasted key or URL is checked right away; editing lets go of a picked key.
    const pasted = (e.nativeEvent as InputEvent).inputType === 'insertFromPaste';
    setPicked(k && (pasted || k.toLowerCase() === picked?.toLowerCase()) ? k : null);
  };

  const doAdd = () => {
    if (!addable || !preview || blocked || add.isPending) return;
    setErr(null);
    add.mutate({ repo: preview.key, includeInDefault: include }, {
      onSuccess: (r) => {
        toast(`Added ${r.repo.key} · ${r.sync === 'started' ? 'syncing its history' : 'it syncs after the current sync'}`, { ms: 5000 });
        onClose();
      },
      onError: (e) => {
        const hint = e instanceof ApiError ? (e.details as { hint?: string | null } | undefined)?.hint : null;
        setErr([e.message, hint].filter(Boolean).join(' '));
      },
    });
  };
  const show = (key: string) => patch.mutate({ key, patch: { hidden: false } }, {
    onSuccess: () => { toast(`${label(key)} is back in the default selection`); onClose(); },
    onError: (e) => setErr(`Couldn't update ${label(key)}: ${e.message}`),
  });
  const open = (key: string) => { onClose(); navigate(`${repoPath(key)}${carrySearch(window.location.search)}`); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setActive((cur + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows.length) choose(rows[cur]!);
      else if (addable) doAdd();
      else if (typed && !picked) pick(typed);
    }
  };

  const row = (r: Row, i: number) => (
    <button
      key={r.kind === 'repo' ? r.c.key : `check:${r.key}`}
      id={`ar-row-${i}`}
      type="button"
      role="option"
      aria-selected={i === cur}
      tabIndex={-1}
      className={cx('ar-row', i === cur && 'on', r.kind === 'repo' && r.tracked && 'tracked')}
      onMouseMove={() => { if (i !== cur) setActive(i); }}
      onClick={() => choose(r)}
    >
      {r.kind === 'check' ? (
        <><Icon name="search" /><span className="ar-check">Check <b>{r.key}</b></span></>
      ) : (
        <>
          <RepoName repo={r.c.key} className="ar-name" />
          {r.c.visibility !== 'public' && <span className="lk"><Icon name="lock" title={visLabel(r.c.visibility)} /></span>}
          <span className="ar-desc">{r.c.description}</span>
          {r.tracked ? <span className="ar-tag">Tracked</span> : <span className="ar-stars" title="Stars"><Icon name="star" />{fmtNum(r.c.stars)}</span>}
        </>
      )}
    </button>
  );

  let out: ReactNode;
  if (blocked) {
    out = (
      <Note icon={<Icon name="alert" />} tone="warn">
        {blocked === 'token'
          ? <p>gh-dash reads repositories with a GitHub token, and none is set. Connect an account in <Link to="/settings" onClick={onClose}>Settings</Link>.</p>
          : account?.mismatch
            ? <p>The token is for <b>{account.login ?? 'another account'}</b>, but this database belongs to <b>{account.dbLogin ?? 'another account'}</b>. Adding repositories is paused until they match (<Link to="/settings" onClick={onClose}>Settings</Link>).</p>
            : <p>{refused} Adding repositories is paused until they match (<Link to="/settings" onClick={onClose}>Settings</Link>).</p>}
      </Note>
    );
  } else if (pending) {
    if (known) {
      out = (
        <Note icon={<Icon name="check" />}>
          <p className="ar-note-h"><RepoName repo={known.key} /></p>
          <p>{known.owned ? "You own this repository, so it's tracked automatically." : 'Already tracked.'}{known.hidden ? " It's left out of your default selection." : ''}</p>
        </Note>
      );
    } else if (checking) {
      out = <Note icon={<span className="spin"><Icon name="sync" /></span>} tone="muted"><p>Checking access to {pending}…</p></Note>;
    } else if (lookup.isError) {
      out = <Note icon={<Icon name="alert" />} tone="warn"><p>{(lookup.error as Error).message}</p></Note>;
    } else if (failure) {
      out = (
        <Note icon={<Icon name="alert" />} tone="warn">
          <p>{failure.message}</p>
          {failure.hint && <p className="ar-hint">{failure.hint}</p>}
        </Note>
      );
    } else if (preview) {
      out = (
        <div className="ar-card">
          <div className="ar-card-h">
            <RepoName repo={preview.key} className="ar-card-name" />
            <span className="vis-badge">{preview.visibility !== 'public' && <Icon name="lock" />}{visLabel(preview.visibility)}</span>
            {preview.isArchived && <span className="vis-badge">Archived</span>}
            {preview.isFork && <span className="vis-badge"><Icon name="fork" />Fork</span>}
            <span className="spacer" />
            <a className="pin-btn" href={preview.url} target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label={`Open ${preview.key} on GitHub`}><Icon name="ext" /></a>
          </div>
          {preview.description && <p className="ar-card-desc">{preview.description}</p>}
          <div className="rc-stats">
            <span title="Stars"><Icon name="star" />{preview.stars.toLocaleString()}</span>
            <span><Icon name="prOpen" />{preview.openPrs.toLocaleString()} open PRs</span>
            <span><Icon name="issue" />{preview.openIssues.toLocaleString()} open issues</span>
          </div>
          <p className="ar-backfill">{backfillLine(preview.backfill)}</p>
        </div>
      );
    }
  } else if (rows.length) {
    out = (
      <>
        {!text.trim() && <div className="ar-sec">Suggested</div>}
        <div className="ar-list" id="ar-list" role="listbox" aria-label={text.trim() ? 'Matching repositories' : 'Suggested repositories'} ref={list}>
          {rows.map(row)}
        </div>
        {text.trim() && candidates.data?.truncated && <p className="ar-foot">Searching your 1,000 most recently pushed repositories.</p>}
      </>
    );
  } else if (candidates.isPending) {
    out = <div className="skel-block ar-skel" aria-label="Loading your repositories">{Array.from({ length: 4 }, (_, i) => <i key={i} />)}</div>;
  } else if (candidates.isError) {
    out = <p className="ar-muted">Couldn't load your repositories: {(candidates.error as Error).message}</p>;
  } else if (text.trim()) {
    out = <p className="ar-muted">No repository you can access matches. Paste owner/name to add any repository the token can read.</p>;
  } else {
    out = <p className="ar-muted">Paste owner/name or a github.com URL to add any repository the token can read.</p>;
  }

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div ref={box} className="modal add-repo" role="dialog" aria-modal="true" aria-labelledby="add-repo-title">
        <div className="modal-h">
          <h3 id="add-repo-title">Add repository</h3>
          <span className="spacer" />
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-b ar-b">
          <label className="field ar-field">
            <Icon name="search" />
            <input
              autoFocus
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              placeholder={PLACEHOLDER}
              aria-label="Repository"
              autoComplete="off"
              spellCheck={false}
              disabled={!!blocked}
              readOnly={add.isPending}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="ar-list"
              aria-autocomplete="list"
              aria-activedescendant={rows.length ? `ar-row-${cur}` : undefined}
            />
          </label>
          <div className="ar-out">{out}</div>
          {err && <div className="form-err" role="alert">{err}</div>}
        </div>
        <div className="modal-f">
          {addable && (
            <label className="ar-inc" title="Unchecked: it's tracked but left out of the default selection, like a hidden repository">
              <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} disabled={add.isPending} />
              Include in default selection
            </label>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {known ? (
            <>
              {known.hidden && <button type="button" className="btn" disabled={patch.isPending} onClick={() => show(known.key)}>Show in default selection</button>}
              {known.open && <button type="button" className="btn primary" onClick={() => open(known.key)}>Open</button>}
            </>
          ) : pending && !checking && (failure || lookup.isError) ? (
            <button type="button" className="btn" onClick={() => { setErr(null); void lookup.refetch(); }}><Icon name="sync" />Try again</button>
          ) : (
            <button type="button" className="btn primary" disabled={!addable || !!blocked || add.isPending} title={blockedWhy ?? (addable ? undefined : 'Choose a repository first')} onClick={doAdd}>
              {add.isPending ? <><span className="spin"><Icon name="sync" /></span>Adding…</> : 'Add repository'}
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
