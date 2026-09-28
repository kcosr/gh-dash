/**
 * GitHub account pieces shared by Settings and the no-token card: the desktop app's "Use GitHub CLI" and
 * paste-a-token controls, and the headless server's token instructions. The token itself is never shown.
 */
import { useState } from 'react';
import type { AccountStatus } from '../../../shared/api';
import { TOKEN_CREATE_URL } from '../../../shared/api';
import type { SecureStorage } from '../../../shared/desktop';
import { useDesktopActions } from '../api/desktop';
import { bridgeError, ghUnavailable } from '../lib/account';
import { Icon } from './Icon';
import { useToast } from './Toasts';

const connected = (a: AccountStatus) => (a.login ? `Connected as ${a.login}` : 'Connected');

/**
 * "Use GitHub CLI" with who gh is signed in as, or why it can't be used. A rejected switch is explained here:
 * the account shown elsewhere stays the one still in use.
 */
export function GhCliChoice({ account, idPrefix = 'gh-cli' }: { account: AccountStatus; idPrefix?: string }) {
  const { ghCli } = useDesktopActions();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const reason = ghUnavailable(account);
  const inUse = account.source === 'gh-cli';
  const run = () => {
    setError(null);
    ghCli.mutate(undefined, {
      onSuccess: (r) => (r.ok ? toast(connected(r.account)) : setError(r.account.error ?? "The GitHub CLI didn't return a usable token.")),
      onError: (e) => setError(bridgeError(e)),
    });
  };
  const shownError = inUse ? null : error;
  return (
    <span className="acct-choice">
      <button type="button" className="btn" onClick={run} disabled={!!reason || inUse || ghCli.isPending}
        aria-describedby={shownError ? `${idPrefix}-note ${idPrefix}-err` : `${idPrefix}-note`}>
        <Icon name={inUse ? 'check' : 'key'} />{inUse ? 'Using GitHub CLI' : ghCli.isPending ? 'Connecting…' : 'Use GitHub CLI'}
      </button>
      <small id={`${idPrefix}-note`} className="muted">
        {account.locked ? null
          : !account.gh.available ? <>Not found: get it from <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer">cli.github.com</a></>
            : account.gh.login ? <>Signed in as <b>{account.gh.login}</b></>
              : <>Run <code>gh auth login</code> first.</>}
      </small>
      {shownError && <span id={`${idPrefix}-err`} className="form-err" role="alert">{shownError}</span>}
    </span>
  );
}

/** Paste a token; remembered in the OS keychain when asked and possible. */
export function TokenForm({ secureStorage, idPrefix = 'tok' }: { secureStorage: SecureStorage | undefined; idPrefix?: string }) {
  const { setToken } = useDesktopActions();
  const toast = useToast();
  const [token, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canRemember = secureStorage === 'available';
  const submit = () => {
    const t = token.trim();
    if (!t || setToken.isPending) return;
    setError(null);
    setToken.mutate({ token: t, remember: canRemember && remember }, {
      onSuccess: (r) => {
        if (!r.ok) { setError(r.account.error ?? 'GitHub did not accept this token.'); return; }
        setValue('');
        toast(`${connected(r.account)}${r.remembered ? ' · saved in the OS keychain' : ''}`);
      },
      onError: (e) => setError(bridgeError(e)),
    });
  };
  return (
    <form className="acct-token" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <span className="acct-token-row">
        <input
          id={`${idPrefix}-input`}
          className="input"
          type="password"
          value={token}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          placeholder="github_pat_…"
          aria-label="GitHub token"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${idPrefix}-err` : undefined}
        />
        <button type="submit" className="btn" disabled={!token.trim() || setToken.isPending}>{setToken.isPending ? 'Checking…' : 'Use token'}</button>
      </span>
      <label className="acct-check">
        <input type="checkbox" className="repo-check" checked={canRemember && remember} disabled={!canRemember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this device
      </label>
      {!canRemember && secureStorage && (
        <small className="muted">No OS keychain is available, so the token is kept only until gh-dash quits.</small>
      )}
      {error && <div id={`${idPrefix}-err`} className="form-err" role="alert">{error}</div>}
    </form>
  );
}

/** Link to GitHub's token page, with read-only permissions filled in. */
export function CreateTokenNote() {
  return (
    <>
      <a href={TOKEN_CREATE_URL} target="_blank" rel="noopener noreferrer">Create a fine-grained token</a> on GitHub: the read-only
      permissions are filled in. Under <b>Repository access</b>, choose <b>All repositories</b>.
    </>
  );
}

/** Where a headless server looks for a token, for its configured choice (GITHUB_TOKEN always wins). */
export function TokenOrder({ account }: { account: AccountStatus | undefined }) {
  const choice = account?.choice ?? 'auto';
  return (
    <ol>
      <li><code>GITHUB_TOKEN</code> in the server's environment or env file (restart the server after setting it);</li>
      {(choice === 'auto' || choice === 'file') && (
        <li>the token file {account?.tokenFile ? <code>{account.tokenFile}</code> : <>named by <code>GITHUB_TOKEN_FILE</code></>}, re-read on use;</li>
      )}
      {(choice === 'auto' || choice === 'gh') && <li>the GitHub CLI: after <code>gh auth login</code>, gh-dash picks it up within a minute.</li>}
    </ol>
  );
}
