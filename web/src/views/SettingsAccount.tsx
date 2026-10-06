/**
 * Settings → Sources → GitHub: who the token belongs to, its kind and expiry, and (in the desktop app) choosing it.
 * SettingsSources.tsx puts it under its heading, as the github.com source.
 */
import { useState } from 'react';
import type { AccountStatus, SyncStatus } from '../../../shared/api';
import { useDesktop, useDesktopActions } from '../api/desktop';
import { useAccount, useCheckAccount, useInstance } from '../api/hooks';
import { CreateTokenNote, GhCliChoice, TokenForm, TokenOrder } from '../components/Account';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useToast } from '../workbench';
import { bridgeError, tokenAccess, tokenExpiry, tokenKindLabel, tokenSourceLabel } from '../lib/account';
import { fmtNum, fmtTime, relLong } from '../lib/time';
import { cx, useNow } from '../lib/util';

/** The account's GitHub avatar (a single image, from GitHub's avatar host), else its initial. */
function AccountAvatar({ a }: { a: AccountStatus }) {
  const [failed, setFailed] = useState(false);
  if (!a.avatarUrl || failed) return <Avatar actor={{ login: a.login, name: a.name, avatarUrl: null, isMe: true }} size={20} />;
  const src = `${a.avatarUrl}${a.avatarUrl.includes('?') ? '&' : '?'}s=40`;
  return <img className="acct-av" src={src} alt="" width={20} height={20} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function TokenLine({ a, now }: { a: AccountStatus; now: number }) {
  const exp = tokenExpiry(a.expiresAt, a.kind, now);
  const access = tokenAccess(a.scopes);
  return (
    <>
      <span>
        {tokenKindLabel(a.kind ?? 'unknown')}
        {access === 'full' && (
          <span className="muted" title="Its scopes include repo: read and write access to all your repositories. gh-dash only reads; a fine-grained token can be limited to read-only.">
            {' · full access'}
          </span>
        )}
        {access === 'public' && <span className="muted"> · public repositories only</span>}
        {exp && !exp.warn && <span className="muted"> · {exp.text}</span>}
      </span>
      {exp?.warn && <span className="dot-lbl warn">{exp.text}</span>}
    </>
  );
}

function MismatchNote({ a, desktop }: { a: AccountStatus; desktop: boolean }) {
  return (
    <p className="set-note" role="status">
      <span>
        This database belongs to <b>{a.dbLogin ?? 'another account'}</b>, but the token is for <b>{a.login ?? 'another account'}</b>.
        Syncing is paused: switch back to {a.dbLogin ? <b>{a.dbLogin}</b> : 'that account'}, or {desktop ? 'choose another data folder under Instance' : <>use a different database (<code>GH_DASH_DB</code>)</>}.
      </span>
    </p>
  );
}

export function GitHubAccount({ rateLimit }: { rateLimit: SyncStatus['rateLimit'] | undefined }) {
  const account = useAccount();
  const check = useCheckAccount();
  const instance = useInstance();
  const { bridge, state: desk } = useDesktop();
  const { signOut } = useDesktopActions();
  const toast = useToast();
  const now = useNow(60_000);
  const a = account.data;
  const desktop = !!bridge;

  const retry = () => check.mutate(undefined, {
    onSuccess: (x) => toast(x.error ?? (x.login ? `Token checked · ${x.login}` : 'Token checked'), { tone: x.error ? 'error' : 'default' }),
    onError: (e) => toast(`Couldn't check: ${(e as Error).message}`, { tone: 'error' }),
  });
  const doSignOut = () => {
    if (!a) return;
    const what = a.source === 'app'
      ? `Sign out? The pasted token is removed from gh-dash${desk?.tokenRemembered ? ' and the OS keychain' : ''}.`
      : 'Sign out? gh-dash stops using this token until you connect again.';
    if (!window.confirm(what)) return;
    signOut.mutate(undefined, {
      onSuccess: () => toast('Signed out'),
      onError: (e) => toast(`Couldn't sign out: ${bridgeError(e)}`, { tone: 'error' }),
    });
  };

  return (
    <>
      {!a ? (
        account.isError ? <p className="muted">Couldn't load the account: {(account.error as Error).message}</p> : <p className="muted">Loading…</p>
      ) : (
        <>
          {a.mismatch && <MismatchNote a={a} desktop={desktop} />}
          <dl className="wb-kv">
            {a.login && (
              <>
                <dt>Account</dt>
                <dd><span className="acct-who"><AccountAvatar a={a} /><b>{a.login}</b>{a.name && a.name !== a.login ? <span className="muted">{a.name}</span> : null}</span></dd>
              </>
            )}
            <dt>Source</dt>
            <dd>
              <span className={cx('dot-lbl', (a.source === 'none' || !!a.error) && 'warn')}>
                {tokenSourceLabel(a.source, { desktop, remembered: desk?.tokenRemembered, chosen: a.choice !== null })}
              </span>
              {a.source === 'file' && a.tokenFile && <code className="path">{a.tokenFile}</code>}
            </dd>
            {a.kind && <><dt>Token</dt><dd><TokenLine a={a} now={now} /></dd></>}
            {a.scopes && <><dt>Scopes</dt><dd>{a.scopes.length ? <span className="acct-scopes">{a.scopes.join(', ')}</span> : <span className="muted">none</span>}</dd></>}
            {a.repos && (
              <>
                <dt>Repositories</dt>
                <dd title="Repositories you own that this token can see">{fmtNum(a.repos.total)} owned · {fmtNum(a.repos.private)} private</dd>
              </>
            )}
            <dt>Rate limit</dt>
            <dd>{rateLimit ? <>{fmtNum(rateLimit.remaining)} / {fmtNum(rateLimit.limit)} remaining · resets {fmtTime(rateLimit.resetAt)}</> : <span className="muted">unknown</span>}</dd>
            {a.error && <><dt>Problem</dt><dd className="acct-err">{a.error}</dd></>}
          </dl>
          <div className="set-actions">
            <button type="button" className="wb-btn" onClick={retry} disabled={check.isPending} title="Read the token again and check it with GitHub">
              <Icon name="sync" />{check.isPending ? 'Checking…' : 'Check again'}
            </button>
            {desktop && !a.locked && (a.choice !== null || a.source !== 'none') && (
              <button type="button" className="wb-btn" onClick={doSignOut} disabled={signOut.isPending}>Sign out</button>
            )}
            {a.checkedAt && <span className="set-when">Checked {relLong(a.checkedAt, now)}</span>}
          </div>
          {desktop ? (
            a.locked ? (
              <p className="set-foot with-ic"><Icon name="lock" />
                <span><code>GITHUB_TOKEN</code> is set in the environment gh-dash was started from, so it is always used. To use another account,
                quit gh-dash, unset <code>GITHUB_TOKEN</code> and start it again.</span>
              </p>
            ) : (
              <div className="set-form set-sub">
                <div className="set-row">
                  <span className="set-l">GitHub CLI<small>Use the account you're signed in to with <code>gh</code>.</small></span>
                  <span className="set-c grow"><GhCliChoice account={a} idPrefix="set-gh" /></span>
                </div>
                <div className="set-row top">
                  <span className="set-l">Personal access token<small>{a.source === 'app' ? 'In use. Paste another to replace it.' : "Paste a token. It's never shown again."}</small></span>
                  <span className="set-c grow stack">
                    <TokenForm secureStorage={desk?.secureStorage} idPrefix="set-tok" />
                    <small className="muted"><CreateTokenNote /></small>
                  </span>
                </div>
              </div>
            )
          ) : instance.data?.desktop ? (
            <p className="set-foot muted">This server is run by the gh-dash desktop app: change the account in the app's Settings.</p>
          ) : (
            <details className="help" open={a.source === 'none'}>
              <summary>How to connect a token</summary>
              <p>The server looks for a token in this order:</p>
              <TokenOrder account={a} />
              <p>
                <CreateTokenNote /> Save it in a file only you can read and point <code>GITHUB_TOKEN_FILE</code> at it,
                or start the server with <code>GITHUB_TOKEN</code>.
              </p>
              <pre className="code">GITHUB_TOKEN_FILE=~/.config/gh-dash/token npm start</pre>
              <p className="muted">The token is never stored in the database or shown here.</p>
            </details>
          )}
        </>
      )}
    </>
  );
}
