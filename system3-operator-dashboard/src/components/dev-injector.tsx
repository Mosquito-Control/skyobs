"use client";

// Dev-only debug toolbar. Synthetic stream is always-on (controlled in
// Dashboard); this just shows live counts and provides a clear-alerts reset.

import { useApp } from "@/lib/store";

export default function DevInjector() {
  const droneCount = useApp((s) => Object.keys(s.drones).length);
  const alertCount = useApp((s) => s.alerts.length);
  const clearAlerts = useApp((s) => s.clearAlerts);

  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border border-ops-700/60 bg-ops-850/90 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-med shadow-lg backdrop-blur">
      <span className="text-ink-lo">DEV</span>
      <span className="tabular-nums text-ink-hi">
        {String(droneCount).padStart(2, "0")} drones
      </span>
      <span className="tabular-nums text-ink-hi">
        {String(alertCount).padStart(2, "0")} alerts
      </span>
      <button
        type="button"
        onClick={() => clearAlerts()}
        className="rounded border border-ops-700/60 bg-ops-800/60 px-2 py-1 text-ink-med transition hover:border-alarm-500/40 hover:text-alarm-400"
      >
        Clear alerts
      </button>
    </div>
  );
}
