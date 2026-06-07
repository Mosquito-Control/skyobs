"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect } from "react";
import { useApp } from "@/lib/store";

/**
 * Bottom-right stack of toasts. Each toast auto-dismisses after a fixed
 * timeout; the operator can also click X. Stays out of the operator's primary
 * map+sidebar field of view so transient feedback doesn't obscure their work.
 */

const TIMEOUT_MS = 4500;

export default function Toaster() {
  const toasts = useApp((s) => s.toasts);
  const dismissToast = useApp((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => dismissToast(t.id), TIMEOUT_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-40 flex w-[320px] flex-col gap-2">
      {toasts.map((t) => {
        const Icon =
          t.level === "error"
            ? AlertTriangle
            : t.level === "warn"
              ? AlertTriangle
              : t.level === "info"
                ? CheckCircle2
                : Info;
        const accent =
          t.level === "error"
            ? "border-alarm-500/40 text-alarm-500"
            : t.level === "warn"
              ? "border-alarm-warn/40 text-alarm-warn"
              : "border-ops-700 text-ink-hi";
        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-2 rounded-md border bg-ops-850 px-3 py-2.5 shadow-lg backdrop-blur ${accent}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} />
            <span className="flex-1 text-[12.5px] leading-snug text-ink-hi">
              {t.message}
            </span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="rounded p-0.5 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
