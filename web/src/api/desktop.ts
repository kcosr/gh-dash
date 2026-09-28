/**
 * The desktop app's bridge (window.ghDashDesktop, see shared/desktop.ts) as react-query hooks. Absent in a
 * normal browser: callers check `bridge` and fall back to the headless UI.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { AccountStatus } from '../../../shared/api';
import type { DesktopBridge, DesktopConfigPatch, DesktopState, DesktopTokenResult } from '../../../shared/desktop';
import { invalidateAccountData, qk } from './hooks';

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
 * account is refetched from the server instead (see tokenResult).
 */
function tokenChanged(qc: QueryClient, account: AccountStatus | null) {
  if (account) qc.setQueryData(qk.account, account);
  else void qc.invalidateQueries({ queryKey: qk.account });
  invalidateAccountData(qc);
  void qc.invalidateQueries({ queryKey: qk.instance });
  void qc.invalidateQueries({ queryKey: qk.desktop });
}

/**
 * Applies the answer to "use GitHub CLI" or a pasted token. When GitHub rejected it, main has already put the
 * previous token back, and `r.account` describes the rejected attempt: the form that made it shows its error,
 * while the cache keeps the active account and everything is refetched (a poll may have caught the attempt).
 */
export function tokenResult(qc: QueryClient, r: DesktopTokenResult) {
  tokenChanged(qc, r.ok ? r.account : null);
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
  const updateConfig = useMutation({
    mutationFn: (patch: DesktopConfigPatch) => need(bridge).updateConfig(patch),
    onSuccess: (state, patch) => {
      qc.setQueryData(qk.desktop, state);
      // The server restarted: everything may have changed, and with a new data folder it's another database.
      const others = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== qk.desktop[0] };
      if (patch.dataDir !== undefined) void qc.resetQueries(others);
      else void qc.invalidateQueries(others);
    },
  });
  const chooseDataDir = useMutation({ mutationFn: () => need(bridge).chooseDataDir() });
  const generateApiKey = useMutation({ mutationFn: () => need(bridge).generateApiKey() });
  return { ghCli, setToken, signOut, updateConfig, chooseDataDir, generateApiKey };
}
