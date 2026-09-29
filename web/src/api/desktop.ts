/**
 * The desktop app's bridge (window.ghDashDesktop, see shared/desktop.ts) as react-query hooks. Absent in a
 * normal browser: callers check `bridge` and fall back to the headless UI.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { AccountStatus } from '../../../shared/api';
import type { CredentialDraft, DesktopBridge, DesktopConfigPatch, DesktopState, DesktopTokenResult, SourceDraft } from '../../../shared/desktop';
import { invalidateAccountData, qk, refetchAfterSync } from './hooks';

/** The bridge, only inside the desktop app. */
export const getBridge = (): DesktopBridge | null => (typeof window === 'undefined' ? null : window.ghDashDesktop ?? null);

function need(bridge: DesktopBridge | null): DesktopBridge {
  if (!bridge) throw new Error('Only available in the gh-dash desktop app');
  return bridge;
}

/** The bridge and the app's state (config, keychain, Local API URL); state is undefined outside the app. */
export function useDesktop(): { bridge: DesktopBridge | null; state: DesktopState | undefined; loading: boolean } {
  const bridge = getBridge();
  const q = useQuery({
    queryKey: qk.desktop,
    queryFn: () => need(bridge).getState(),
    enabled: !!bridge,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return { bridge, state: q.data, loading: !!bridge && q.isPending };
}

/**
 * After the token changed: the account from the answer, then everything that depends on it. With null the
 * account is refetched from the server instead (see tokenResult). A poll already in flight is cancelled first:
 * it would otherwise land after the answer and put back the account from before the change.
 */
async function tokenChanged(qc: QueryClient, account: AccountStatus | null) {
  if (account) {
    await qc.cancelQueries({ queryKey: qk.account });
    qc.setQueryData(qk.account, account);
  } else {
    void qc.invalidateQueries({ queryKey: qk.account });
  }
  invalidateAccountData(qc);
  void qc.invalidateQueries({ queryKey: qk.instance });
  void qc.invalidateQueries({ queryKey: qk.desktop });
}

/**
 * Applies the answer to "use GitHub CLI" or a pasted token. When GitHub rejected it, main has already put the
 * previous token back, and `r.account` describes the rejected attempt: the form that made it shows its error,
 * while the cache keeps the active account and everything is refetched (a poll may have caught the attempt).
 */
export function tokenResult(qc: QueryClient, r: DesktopTokenResult): Promise<void> {
  return tokenChanged(qc, r.ok ? r.account : null);
}

/** Token and instance actions of the desktop app. Each rejects outside the app. */
export function useDesktopActions() {
  const bridge = getBridge();
  const qc = useQueryClient();
  // A failed call may have left the server on either token: refetch what it uses.
  const ghCli = useMutation({
    mutationFn: () => need(bridge).useGitHubCli(),
    onSuccess: (r) => tokenResult(qc, r),
    onError: () => tokenChanged(qc, null),
  });
  const setToken = useMutation({
    mutationFn: ({ token, remember }: { token: string; remember: boolean }) => need(bridge).setToken(token, remember),
    onSuccess: (r) => tokenResult(qc, r),
    onError: () => tokenChanged(qc, null),
  });
  const signOut = useMutation({
    mutationFn: () => need(bridge).signOut(),
    onSuccess: (a) => tokenChanged(qc, a),
  });
  // After a server restart everything may have changed; with a new data folder it's another database.
  const others = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== qk.desktop[0] };
  const updateConfig = useMutation({
    mutationFn: (patch: DesktopConfigPatch) => need(bridge).updateConfig(patch),
    onSuccess: (state, patch) => {
      qc.setQueryData(qk.desktop, state);
      if (patch.dataDir !== undefined) void qc.resetQueries(others);
      else void qc.invalidateQueries(others);
    },
  });
  const locateGh = useMutation({
    mutationFn: () => need(bridge).chooseGhPath(),
    onSuccess: (state) => {
      if (!state) return; // cancelled
      qc.setQueryData(qk.desktop, state);
      void qc.invalidateQueries(others);
    },
  });
  const chooseDataDir = useMutation({ mutationFn: () => need(bridge).chooseDataDir() });
  const generateApiKey = useMutation({ mutationFn: () => need(bridge).generateApiKey() });
  return { ghCli, setToken, signOut, updateConfig, chooseDataDir, generateApiKey, locateGh };
}

/**
 * A source was added, removed or signed in another way: what the server says about sources, the sync, the repos and
 * the instance (its list of sources) is refetched, and the app's state (keychain, config.json) with them.
 */
function sourcesChanged(qc: QueryClient, removed = false) {
  if (removed) void qc.invalidateQueries({ predicate: refetchAfterSync });
  for (const queryKey of [qk.sources, qk.sync, qk.repos, qk.instance, qk.desktop]) void qc.invalidateQueries({ queryKey });
}

/** The desktop app's GitLab source actions (design §8). Each rejects outside the app. */
export function useSourceActions() {
  const bridge = getBridge();
  const qc = useQueryClient();
  const testSource = useMutation({ mutationFn: (draft: SourceDraft) => need(bridge).testSource(draft) });
  const addSource = useMutation({
    mutationFn: (draft: SourceDraft) => need(bridge).addSource(draft),
    onSettled: () => sourcesChanged(qc),
  });
  const setCredential = useMutation({
    mutationFn: ({ host, credential }: { host: string; credential: CredentialDraft }) => need(bridge).setSourceCredential(host, credential),
    onSettled: () => sourcesChanged(qc),
  });
  const signOut = useMutation({
    mutationFn: (host: string) => need(bridge).signOutSource(host),
    onSettled: () => sourcesChanged(qc),
  });
  const remove = useMutation({
    mutationFn: (host: string) => need(bridge).removeSource(host),
    onSuccess: (state) => qc.setQueryData(qk.desktop, state),
    onSettled: () => sourcesChanged(qc, true),
  });
  const locateGlab = useMutation({
    mutationFn: () => need(bridge).chooseGlabPath(),
    onSuccess: (state) => {
      if (!state) return; // cancelled
      qc.setQueryData(qk.desktop, state);
      void qc.invalidateQueries({ queryKey: qk.sources });
    },
  });
  const chooseTokenFile = useMutation({ mutationFn: (url: string) => need(bridge).chooseTokenFile(url) });
  return { testSource, addSource, setCredential, signOut, remove, locateGlab, chooseTokenFile };
}
