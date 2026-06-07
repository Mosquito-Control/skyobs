"use client";

// Periodic alert pruning. Without this the alerts list grows unbounded —
// the alert engine refreshes lastSeen each tick a drone is in a zone, so
// the only way an alert ever leaves the panel is via pruneAlerts running
// against (now - lastSeen).
//
// Cadence: prune every second so an exit feels responsive ("drone left →
// alert disappears within ~1s of the next poll"). Pairs with the 5s
// staleMs/resolvedMs in pruneAlerts so the panel always reflects "what's
// happening in the current poll window", nothing older.

import { useEffect } from "react";
import { useApp } from "@/lib/store";

const TICK_MS = 1_000;

export function useAlertTtl(): void {
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const s = useApp.getState();
      s.pruneAlerts(now);
      // Same heartbeat sweeps expired zone mutes so an acknowledged zone
      // visibly comes back when its window runs out without needing a
      // dedicated timer per ack.
      s.evictExpiredMutes(now);
      // …and drops drones that stopped reporting. With System 4 as the
      // single track source, a drone the tracker loses (status='lost' →
      // dropped from /api/tracks) stops being refreshed and ages out
      // here, which gracefully clears its impact via the engine's exit
      // pathway. 30s window > the alert engine's 25s linger so the
      // sequence is: track lost → drone stale → linger expires → exit.
      s.pruneStaleDrones(now, 30_000);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);
}
