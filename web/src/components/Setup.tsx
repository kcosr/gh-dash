import type { SyncStatus } from '../../../shared/api';
import { Icon } from './Icon';

/** Shown instead of a view when there's no GitHub token and nothing cached. */
export function NoTokenCard() {
  return (
    <div className="setup">
      <div className="setup-card">
        <span className="ic"><Icon name="key" /></span>
        <h2>Connect gh-dash to GitHub</h2>
        <p>
          gh-dash needs a read-only GitHub token to sync your repositories. It looks for one in this order:
        </p>
        <ol>
          <li>the <code>GITHUB_TOKEN</code> environment variable of the server process;</li>
          <li>the output of <code>gh auth token</code> (if the GitHub CLI is installed and logged in).</li>
        </ol>
        <h3>Option A · GitHub CLI</h3>
        <pre className="code">gh auth login</pre>
        <h3>Option B · fine-grained personal access token</h3>
        <p>
          Create one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub → Settings → Developer settings</a> with
          access to <b>All repositories</b> and these repository permissions, all <b>Read-only</b>:
          Metadata, Contents, Pull requests, Issues. Then start the server with it:
        </p>
        <pre className="code">GITHUB_TOKEN=github_pat_… npm start</pre>
        <p className="muted">Restart the server after setting the token; the first sync starts automatically.</p>
      </div>
    </div>
  );
}

/** First run: empty database, sync in progress (or not started yet). */
export function FirstSyncCard({ status, onSync }: { status: SyncStatus | undefined; onSync: () => void }) {
  const p = status?.progress;
  const running = !!status?.running;
  return (
    <div className="setup">
      <div className="setup-card center">
        <span className={`ic${running ? ' spin' : ''}`}><Icon name="sync" /></span>
        {running ? (
          <>
            <h2>First sync in progress…{p && p.total ? ` ${p.done}/${p.total} repos` : ''}</h2>
            <p>
              gh-dash is fetching your repositories{status?.viewer ? <> for <b>{status.viewer}</b></> : null}. Pull requests, commits, issues,
              releases and stars appear as each repository finishes.
            </p>
            {p && p.total > 0 && (
              <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
                <i style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} />
              </div>
            )}
            {p?.current && <p className="muted small">Now syncing <code>{p.current}</code></p>}
          </>
        ) : (
          <>
            <h2>No data yet</h2>
            <p>Nothing has been synced from GitHub yet{status?.viewer ? <> for <b>{status.viewer}</b></> : null}.</p>
            {status?.lastResult?.errors.length ? (
              <pre className="code err">{status.lastResult.errors.slice(0, 5).join('\n')}</pre>
            ) : null}
            <button type="button" className="btn primary" onClick={onSync}><Icon name="sync" />Sync now</button>
          </>
        )}
      </div>
    </div>
  );
}
