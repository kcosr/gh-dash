import { FilterInput } from '../workbench';
/**
 * Pushed branches to review (their diff against the default branch, with or without a PR): the repo page's Branches
 * card, and what the palette's branch list shares with it. The list is the code host's, asked for on demand (useBranches).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { BranchSummary, Repo } from '../../../shared/api';
import { capitalize, repoProvider } from '../../../shared/provider';
import type { Provider } from '../../../shared/provider';
import { isUnreachable, rateLimitResetAt } from '../api/client';
import { useBranches } from '../api/hooks';
import { hostBranchQuery } from '../lib/branches';
import { fmtDateTime, relFuture, rel } from '../lib/time';
import { branchDiffId, useUrlState } from '../lib/urlState';
import { cx, useDebounced } from '../lib/util';
import { prIconClass, prIconName } from './bits';
import { Icon } from './Icon';
import { useSyncNow } from './TopBar';

/** Rows the card shows; a filter finds the rest. */
const SHOWN = 8;

/**
 * Why a branch list couldn't be had, in a line, and what helps: a sync (the default branch isn't known yet), a token
 * (Settings), or trying again.
 */
export function branchListTrouble(error: unknown, p: Provider): { text: string; fix: 'sync' | 'settings' | 'retry' } {
  const status = (error as { status?: number } | null)?.status;
  if (isUnreachable(error)) return { text: (error as Error).message, fix: 'retry' };
  if (status === 409) return { text: "The default branch isn't known yet: branches are compared with it.", fix: 'sync' };
  if (status === 503) return { text: `A ${p.name} token is needed to list branches.`, fix: 'settings' };
  if (status === 429) {
    const at = rateLimitResetAt(error);
    return { text: `${p.name}'s rate limit is used up${at ? `; it resets ${relFuture(at)}` : ''}.`, fix: 'retry' };
  }
  return { text: `Couldn't list the branches: ${(error as Error).message}`, fix: 'retry' };
}

/** The PR from a branch, as a small ref: its state's icon and number. */
export function BranchPrRef({ pr, p }: { pr: NonNullable<BranchSummary['pr']>; p: Provider }) {
  return (
    <span className="br-pr" title={`${capitalize(p.pr.one)} ${p.prRef}${pr.number} (${pr.state}): ${pr.title}`}>
      <span className={`pr-ic ${prIconClass({ state: pr.state, isDraft: false })}`}><Icon name={prIconName({ state: pr.state, isDraft: false })} /></span>
      <span className="num">{p.prRef}{pr.number}</span>
    </span>
  );
}

/** The branches matching a filter as typed: the host's newest 100, narrowed here; past those, the host searches. */
export function useBranchSearch(repo: string | null, filter: string) {
  const q = filter.trim();
  const dq = useDebounced(q, 250);
  const all = useBranches(repo);
  const asked = hostBranchQuery(all.data, dq);
  const searched = useBranches(repo && asked ? repo : null, asked ?? '');
  const items = useMemo(() => {
    const ql = q.toLowerCase();
    const from = searched.data && dq && q.startsWith(dq) ? searched.data.items : all.data?.items ?? [];
    return ql ? from.filter((b) => b.name.toLowerCase().includes(ql)) : from;
  }, [all.data, searched.data, q, dq]);
  return { all, items, searching: searched.isFetching };
}

/** The repo page's recent branches, newest first: one opens its diff (over the page, as a PR's does from the drawer). */
export function BranchesCard({ repo }: { repo: Repo }) {
  const { s, set } = useUrlState();
  const p = repoProvider(repo);
  const [filter, setFilter] = useState('');
  const { all, items } = useBranchSearch(repo.key, filter);
  const sync = useSyncNow();
  const listed = all.data?.items.length ?? 0;
  const open = (b: BranchSummary) => set({ diff: branchDiffId(repo.key, b.name), file: null, thread: null, only: null });
  const trouble = all.isError && !all.data ? branchListTrouble(all.error, p) : null;
  const rest = items.length - SHOWN;

  return (
    <section className="card list-card br-card">
      <div className="card-h">
        <div>
          <h3>Branches</h3>
          <div className="sub">newest first{all.data && <>, compared with <code>{all.data.defaultBranch}</code></>}</div>
        </div>
        <span className="spacer" />
        {(listed > SHOWN || filter) && (
          <FilterInput className="br-filter" value={filter} onChange={setFilter} placeholder="Filter branches" hotkey={null} />
        )}
      </div>
      {trouble ? (
        <div className="chart-empty br-empty">
          {trouble.text}{' '}
          {trouble.fix === 'sync'
            ? <button type="button" className="tbl-btn" onClick={() => sync.run({ repo: repo.key })} disabled={sync.pending}>Sync now</button>
            : trouble.fix === 'settings' ? <Link className="tbl-btn" to="/settings">Settings</Link>
              : <button type="button" className="tbl-btn" onClick={() => void all.refetch()}>Try again</button>}
        </div>
      ) : items.length ? (
        items.slice(0, SHOWN).map((b) => {
          const id = branchDiffId(repo.key, b.name);
          return (
            <button key={b.name} type="button" className={cx('mini-br', s.diff === id && 'active')} data-diff={id} onClick={() => open(b)} title={`${b.name} · open the diff`}>
              <Icon name="branch" />
              <span className="mb-name">{b.name}</span>
              {b.pr ? <BranchPrRef pr={b.pr} p={p} /> : <span />}
              {b.committedAt ? <time dateTime={b.committedAt} title={fmtDateTime(b.committedAt)}>{rel(b.committedAt)}</time> : <span />}
            </button>
          );
        })
      ) : (
        <div className="chart-empty">{!all.data ? 'Loading…' : filter.trim() ? `No branches matching “${filter.trim()}”` : 'No branches besides the default one'}</div>
      )}
      {rest > 0 && <div className="card-more">+{rest} more{all.data?.more && !filter.trim() ? ', and older ones' : ''}</div>}
    </section>
  );
}
