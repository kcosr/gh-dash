import type { SyncStatus } from '../../../shared/api';
import { useDesktop } from '../api/desktop';
import { useAccount, useCheckAccount } from '../api/hooks';
import { CreateTokenNote, GhCliChoice, TokenForm, TokenOrder } from './Account';
import { Icon } from './Icon';
import { useRepoLabel } from './repoMapContext';
import { useToast } from './Toasts';

/** Shown instead of a view when there's no GitHub token and nothing synced yet. */
export function NoTokenCard() {
  const { bridge, state } = useDesktop();
  const { data: account } = useAccount();
  const check = useCheckAccount();
  const toast = useToast();
  const retry = () => check.mutate(undefined, {
    onSuccess: (a) => { if (a.source !== 'none' && !a.error) toast(a.login ? `Connected as ${a.login}` : 'Token found'); },
    onError: (e) => toast(`Couldn't check: ${(e as Error).message}`, { error: true }),
  });
  const lastError = account?.error ? <p className="muted small">Last check: {account.error}</p> : null;

  if (bridge) {
    return (
      <div className="setup">
        <div className="setup-card">
          <span className="ic"><Icon name="key" /></span>
          <h2>Connect gh-dash to GitHub</h2>
          <p>gh-dash syncs your repositories, pull requests and issues with a GitHub token. It only reads; it never changes anything on GitHub.</p>
          {account?.locked ? (
            <>
              <p><code>GITHUB_TOKEN</code> is set in the environment gh-dash was started from, so it is always used, but it doesn't work.</p>
              {lastError}
              <p className="muted">Fix or unset <code>GITHUB_TOKEN</code> and start gh-dash again.</p>
            </>
          ) : (
            <>
              <h3>GitHub CLI</h3>
              <p>Use the account you're signed in to with <code>gh</code>.</p>
              {account ? <GhCliChoice account={account} idPrefix="setup-gh" /> : <p className="muted">Looking for the GitHub CLI…</p>}
              <h3>Personal access token</h3>
              <p><CreateTokenNote /> Then paste it here:</p>
              <TokenForm secureStorage={state?.secureStorage} idPrefix="setup-tok" />
              {lastError}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <span className="ic"><Icon name="key" /></span>
        <h2>Connect gh-dash to GitHub</h2>
        <p>gh-dash needs a read-only GitHub token to sync your repositories. The server looks for one in this order:</p>
        <TokenOrder account={account} />
        <h3>Option A · GitHub CLI</h3>
        <pre className="code">gh auth login</pre>
        <h3>Option B · fine-grained personal access token</h3>
        <p>
          <CreateTokenNote /> Save it in a file only you can read and point <code>GITHUB_TOKEN_FILE</code> at it,
          or start the server with <code>GITHUB_TOKEN</code>:
        </p>
        <pre className="code">GITHUB_TOKEN_FILE=~/.config/gh-dash/token npm start</pre>
        {lastError}
        <div className="setup-actions">
          <button type="button" className="btn" onClick={retry} disabled={check.isPending}><Icon name="sync" />{check.isPending ? 'Checking…' : 'Check again'}</button>
          <span className="muted small">This page moves on by itself once a token is found.</span>
        </div>
      </div>
    </div>
  );
}

/** First run: empty database, sync in progress (or not started yet). */
export function FirstSyncCard({ status, onSync }: { status: SyncStatus | undefined; onSync: () => void }) {
  const p = status?.progress;
  const repoLabel = useRepoLabel();
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
            {p?.current && <p className="muted small">Now syncing <code>{repoLabel(p.current)}</code></p>}
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
