import { useState, useEffect, useCallback } from 'react';
import { cn } from '../../utils/cn';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

interface ToastMessage {
  id: string;
  message: string;
  variant: ToastVariant;
  exiting?: boolean;
}

const variantStyles: Record<ToastVariant, string> = {
  success: 'bg-green-500/15 text-green-400 border-green-500/20',
  error: 'bg-red-500/15 text-red-400 border-red-500/20',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  warning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
};

const variantIcons: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

let addToastGlobal: ((message: string, variant?: ToastVariant) => void) | null = null;

// eslint-disable-next-line react-refresh/only-export-components
export function toast(message: string, variant: ToastVariant = 'info') {
  addToastGlobal?.(message, variant);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    // Mark as exiting for animation
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t));
    // Remove after exit animation completes
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const addToast = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => removeToast(id), 4000);
  }, [removeToast]);

  useEffect(() => {
    addToastGlobal = addToast;
    return () => { addToastGlobal = null; };
  }, [addToast]);

  if (toasts.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-md transition-all duration-200',
            t.exiting
              ? 'translate-x-full opacity-0'
              : 'animate-in slide-in-from-bottom-2 fade-in',
            variantStyles[t.variant],
          )}
        >
          <span className="text-xs">{variantIcons[t.variant]}</span>
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => removeToast(t.id)}
            className="ml-1 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Kapat"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
