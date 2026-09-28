/** App-wide overlay state: command palette, export modal, name prompt. */
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

  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const togglePalette = useCallback(() => setPalette((o) => !o), []);
  const openExport = useCallback((t: ExportTab) => { setPalette(false); setExport(t); }, []);
  const closeExport = useCallback(() => setExport(null), []);
  const openPrompt = useCallback((p: PromptRequest) => setPrompt(p), []);
  const closePrompt = useCallback(() => setPrompt(null), []);

  const value = useMemo(
    () => ({ paletteOpen, openPalette, closePalette, togglePalette, exportTab, openExport, closeExport, prompt, openPrompt, closePrompt }),
    [paletteOpen, openPalette, closePalette, togglePalette, exportTab, openExport, closeExport, prompt, openPrompt, closePrompt],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
