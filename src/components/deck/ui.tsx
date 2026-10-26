"use client";

// deck 工作台共享小组件：Modal / toast / spinner / 本地小图标。
import { useCallback, useEffect, useRef, useState } from "react";
import { CloseIcon } from "@/components/icons";

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-brand-line border-t-brand ${className}`}
      style={{ width: "1em", height: "1em" }}
      aria-hidden
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = "max-w-lg",
  ariaLabel,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
  ariaLabel?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? title}
      onClick={onClose}
    >
      <div
        className={`flex max-h-[85vh] w-full ${width} flex-col rounded-2xl bg-card p-6 shadow-pop`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button
            type="button"
            aria-label="关闭"
            className="rounded-full p-1 text-ink-3 transition hover:bg-page"
            onClick={onClose}
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export interface ToastItem {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (text: string, opts: { actionLabel?: string; onAction?: () => void; duration?: number } = {}) => {
      const id = idRef.current++;
      setToasts((prev) => [...prev, { id, text, actionLabel: opts.actionLabel, onAction: opts.onAction }]);
      window.setTimeout(() => dismiss(id), opts.duration ?? 5000);
      return id;
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex w-full items-center gap-3 rounded-xl bg-dark px-4 py-3 text-sm text-white shadow-pop"
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">{t.text}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              className="shrink-0 font-medium text-brand-soft underline underline-offset-2"
              onClick={() => {
                t.onAction?.();
                onDismiss(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            aria-label="关闭提示"
            className="shrink-0 text-white/60 hover:text-white"
            onClick={() => onDismiss(t.id)}
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------- 本地小图标（icons.tsx 之外的补充） ------- */

export function GripIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      {...props}
    >
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

export function DownloadIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M12 4v12m0 0 5-5m-5 5-5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}

export function RefreshIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function WarnIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M12 3 2.5 20h19L12 3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.4" fill="currentColor" />
    </svg>
  );
}
