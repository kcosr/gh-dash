/** Settings → Tracked repositories (`/settings#tracked`): your own (automatic) and the ones you added by hand. */
import { Switch, useToast } from '../workbench';
import { Link } from 'react-router';
import type { Repo } from '../../../shared/api';
import { usePatchRepo, useRepos } from '../api/hooks';
import { Icon } from '../components/Icon';
import { RepoName } from '../components/RepoName';
import { useConfirmRemoveRepo } from '../components/RepoTracking';
import { useRepoLabel } from '../components/repoMapContext';
import { useUI } from '../components/ui';
import { fmtDateSmart, fmtNum, relLong } from '../lib/time';
import { useNow } from '../lib/util';

function Status({ repo, now }: { repo: Repo; now: number }) {
  if (repo.unavailable) {
    return <span className="trk-st warn" title={repo.unavailable.reason}><Icon name="alert" />Unavailable since {fmtDateSmart(repo.unavailable.since)}</span>;
  }
  return <span className="trk-st">{repo.syncedAt ? `Synced ${relLong(repo.syncedAt, now)}` : 'Waiting for first sync'}</span>;
}

export function TrackedSection() {
  const repos = useRepos();
  const patch = usePatchRepo();
  const toast = useToast();
  const label = useRepoLabel();
  const { openAddRepo } = useUI();
  const confirmRemove = useConfirmRemoveRepo();
  const now = useNow(60_000);
  const all = repos.data ?? [];
  const owned = all.filter((r) => r.trackedBy === 'owned');
  const ownedHidden = owned.filter((r) => r.hidden).length;
  const added = all.filter((r) => r.trackedBy === 'manual').sort((a, b) => a.key.localeCompare(b.key));

  const setDefault = (r: Repo, on: boolean) => patch.mutate({ key: r.key, patch: { hidden: !on } }, {
    onError: (e) => toast(`Couldn't update ${label(r.key)}: ${e.message}`, { tone: 'error' }),
  });

  return (
    <section className="card set-sec" id="tracked">
      <h2>Tracked repositories</h2>
      {!repos.data ? (
        repos.isError ? <p className="muted">Couldn't load repositories: {(repos.error as Error).message}</p> : <p className="muted">Loading…</p>
      ) : (
        <div className="set-form">
          <div className="set-row">
            <span className="set-l">Repositories you own<small>Tracked automatically.</small></span>
            <span className="set-c">
              <Link to="/repos?own=mine">{fmtNum(owned.length)} {owned.length === 1 ? 'repository' : 'repositories'}</Link>
              {ownedHidden > 0 && <span className="muted">({fmtNum(ownedHidden)} hidden)</span>}
            </span>
          </div>
          <div className="set-row top">
            <span className="set-l">Added repositories<small>Other owners' repositories you added. Switched off, one stays tracked but out of the default selection.</small></span>
            <span className="set-c grow stack">
              {added.length ? (
                <ul className="trk-list">
                  {added.map((r) => (
                    <li key={r.key} className="trk-row">
                      <span className="trk-name">
                        <RepoName repo={r.key} />
                        {r.visibility !== 'public' && <span className="lk"><Icon name="lock" title={r.visibility === 'internal' ? 'Internal' : 'Private'} /></span>}
                      </span>
                      <Status repo={r} now={now} />
                      <span className="spacer" />
                      <Switch checked={!r.hidden} onChange={(e) => setDefault(r, e.target.checked)}
                        title="Default selection" aria-label={`Include ${label(r.key)} in the default selection`} />
                      <button type="button" className="pin-btn" title="Remove…" aria-label={`Remove ${label(r.key)}`} onClick={() => confirmRemove(r)}>
                        <Icon name="trash" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <span className="muted">None yet.</span>}
            </span>
          </div>
        </div>
      )}
      <div className="set-actions">
        <button type="button" className="wb-btn" onClick={openAddRepo}><Icon name="plus" />Add repository</button>
      </div>
    </section>
  );
}
