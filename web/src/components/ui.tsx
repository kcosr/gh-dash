/** App-wide overlay state: command palette, export modal, name prompt, Add repository, confirmations. */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ExportTab = 'md' | 'api';

export interface PromptRequest {
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  hint?: ReactNode;
  onSubmit: (value: string) => void | Promise<unknown>;
}

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** A destructive action: the button is red. */
  danger?: boolean;
  /** Runs on confirm. The dialog stays open (busy) until it settles and shows its error if it fails. */
  onConfirm: () => void | Promise<unknown>;
}

interface UI {
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  exportTab: ExportTab | null;
  openExport: (tab: ExportTab) => void;
  closeExport: () => void;
  prompt: PromptRequest | null;
  openPrompt: (p: PromptRequest) => void;
  closePrompt: () => void;
  addRepo: boolean;
  openAddRepo: () => void;
  closeAddRepo: () => void;
  confirm: ConfirmRequest | null;
  openConfirm: (c: ConfirmRequest) => void;
  closeConfirm: () => void;
}

const Ctx = createContext<UI | null>(null);

export function useUI(): UI {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUI outside UIProvider');
  return v;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPalette] = useState(false);
  const [exportTab, setExport] = useState<ExportTab | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [addRepo, setAddRepo] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const togglePalette = useCallback(() => setPalette((o) => !o), []);
  const openExport = useCallback((t: ExportTab) => { setPalette(false); setExport(t); }, []);
  const closeExport = useCallback(() => setExport(null), []);
  const openPrompt = useCallback((p: PromptRequest) => setPrompt(p), []);
  const closePrompt = useCallback(() => setPrompt(null), []);
  const openAddRepo = useCallback(() => { setPalette(false); setAddRepo(true); }, []);
  const closeAddRepo = useCallback(() => setAddRepo(false), []);
  const openConfirm = useCallback((c: ConfirmRequest) => setConfirm(c), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  const value = useMemo(
    () => ({
      paletteOpen, openPalette, closePalette, togglePalette, exportTab, openExport, closeExport, prompt, openPrompt, closePrompt,
      addRepo, openAddRepo, closeAddRepo, confirm, openConfirm, closeConfirm,
    }),
    [paletteOpen, openPalette, closePalette, togglePalette, exportTab, openExport, closeExport, prompt, openPrompt, closePrompt,
      addRepo, openAddRepo, closeAddRepo, confirm, openConfirm, closeConfirm],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
