import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastFn = (message: string, opts?: { error?: boolean; ms?: number }) => void;
const ToastCtx = createContext<ToastFn>(() => {});

export const useToast = () => useContext(ToastCtx);

interface T { id: number; message: string; error: boolean }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<T[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const toast = useCallback<ToastFn>((message, opts = {}) => {
    const id = ++seq.current;
    // one at a time, like the mock: the newest replaces the previous
    setToasts([{ id, message, error: !!opts.error }]);
    timers.current.set(id, setTimeout(() => {
      setToasts((ts) => ts.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, opts.ms ?? (opts.error ? 4000 : 2200)));
  }, []);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div aria-live="polite" role="status" className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' toast-err' : ''}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
