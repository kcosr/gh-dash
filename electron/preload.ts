/**
 * Preload for the app window (sandboxed: only `electron` can be required). Exposes window.ghDashDesktop; every
 * method is one ipcRenderer.invoke, and main validates the arguments and the sender.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { DESKTOP_IPC, type DesktopBridge } from '../shared/desktop';

/** Main answers { value } or { error } (see electron/ipc.ts), so rejections carry a clean, user-facing message. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as { value: T } | { error: string };
  if ('error' in reply) throw new Error(reply.error);
  return reply.value;
}

const bridge: DesktopBridge = {
  getState: () => call(DESKTOP_IPC.getState),
  useGitHubCli: () => call(DESKTOP_IPC.useGitHubCli),
  setToken: (token, remember) => call(DESKTOP_IPC.setToken, token, remember),
  signOut: () => call(DESKTOP_IPC.signOut),
  updateConfig: (patch) => call(DESKTOP_IPC.updateConfig, patch),
  chooseDataDir: () => call(DESKTOP_IPC.chooseDataDir),
  generateApiKey: () => call(DESKTOP_IPC.generateApiKey),
  chooseGhPath: () => call(DESKTOP_IPC.chooseGhPath),
  testSource: (draft) => call(DESKTOP_IPC.testSource, draft),
  addSource: (draft) => call(DESKTOP_IPC.addSource, draft),
  setSourceCredential: (host, credential) => call(DESKTOP_IPC.setSourceCredential, host, credential),
  signOutSource: (host) => call(DESKTOP_IPC.signOutSource, host),
  removeSource: (host) => call(DESKTOP_IPC.removeSource, host),
  chooseGlabPath: () => call(DESKTOP_IPC.chooseGlabPath),
  chooseTokenFile: (url) => call(DESKTOP_IPC.chooseTokenFile, url),
  addAgent: (name, token, sources) => call(DESKTOP_IPC.addAgent, name, token, sources),
  regenerateAgentToken: (id, token) => call(DESKTOP_IPC.regenerateAgentToken, id, token),
  revokeAgent: (id) => call(DESKTOP_IPC.revokeAgent, id),
  setAgentSources: (id, sources) => call(DESKTOP_IPC.setAgentSources, id, sources),
  enableMcp: () => call(DESKTOP_IPC.enableMcp),
};

contextBridge.exposeInMainWorld('ghDashDesktop', bridge);
