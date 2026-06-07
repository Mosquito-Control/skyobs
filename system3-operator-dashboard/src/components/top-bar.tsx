"use client";

import { useEffect, useState } from "react";

export default function TopBar() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const nextDelay = () => {
      if (consecutiveFailures <= 0) return 5_000;
      if (consecutiveFailures < 3) return 15_000;
      if (consecutiveFailures < 6) return 30_000;
      return 120_000;
    };

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        schedule(5_000);
        return;
      }
      try {
        const res = await fetch("/api/health", {
          signal: AbortSignal.timeout(2000),
        });
        if (cancelled) return;
        if (res.ok) {
          consecutiveFailures = 0;
          setConnected(true);
        } else {
          consecutiveFailures += 1;
          setConnected(false);
        }
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        setConnected(false);
      }
      schedule(nextDelay());
    };

    const onVisibility = () => {
      if (!document.hidden) void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center justify-between border-b border-ops-700/80 bg-ops-850/95 px-5">
      <div className="flex items-center gap-2.5">
        <span
          aria-label="Hong Kong"
          role="img"
          className="text-[18px] leading-none"
        >
          🇭🇰
        </span>
        <span className="text-[13px] font-medium tracking-tight text-ink-med">
          Hong Kong
        </span>
      </div>

      <div
        className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-lo"
        title={connected ? "Link online" : "Link offline"}
      >
        <span
          className={[
            "h-1.5 w-1.5 rounded-full",
            connected ? "bg-emerald-400" : "bg-alarm-500",
          ].join(" ")}
        />
        <span>{connected ? "Link" : "Offline"}</span>
      </div>
    </header>
  );
}
