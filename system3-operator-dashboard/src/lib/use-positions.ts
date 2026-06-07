"use client";

// Live-position polling against /api/positions (which proxies System 2's
// `positions` table — see src/app/api/positions/route.ts). Replaces the
// dev-mode useDroneStream stub once System 2 is reachable.
//
// Each tick:
//   1. asks for positions newer than the most-recent inserted_at we've seen
//   2. converts Position → DroneFix and ingests into the zustand store
//   3. logs degraded=true once if the backend is down so the operator knows
//
// React Query owns the timer; we don't keepalive a WebSocket because System 2
// is a poll-friendly REST API (its triangulation loop fires every 500ms).

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useApp } from "@/lib/store";
import type { DroneFix } from "@/lib/types";
import type { Position } from "@/app/api/positions/route";

// 5-second poll cadence — paired with the alert engine's 5s TTL so the
// "what's happening now" panel only ever shows the latest tick's breaches.
// Override via NEXT_PUBLIC_POSITIONS_POLL_MS if a louder demo loop is wanted.
const POLL_MS = Number(
  process.env.NEXT_PUBLIC_POSITIONS_POLL_MS ?? 5000,
);

type Payload = { positions: Position[]; degraded: boolean };

async function fetchPositions(since: string | null): Promise<Payload> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const res = await fetch(`/api/positions${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/positions ${res.status}`);
  return (await res.json()) as Payload;
}

function position2drone(p: Position): DroneFix {
  // Bridge the column names. cam_pair becomes the drone id for now — a real
  // tracker (next iteration) will assign stable IDs based on position
  // continuity. Severity-related fields default to undefined; alert
  // generation lives in the engine, not here.
  return {
    id: `${p.camPair}#${p.id}`,
    lat: p.lat,
    lng: p.lng,
    altM: p.altM,
    t: new Date(p.timestamp).getTime(),
    registered: false,
    category: "unknown",
  };
}

export function usePositions(enabled: boolean = true) {
  const ingestDrones = useApp((s) => s.ingestDrones);
  // Track the latest inserted_at across renders so the next poll only asks
  // for what's newer. useRef instead of state — bumping it shouldn't re-render.
  const sinceRef = useRef<string | null>(null);
  const degradedLoggedRef = useRef(false);

  const query = useQuery<Payload>({
    queryKey: ["positions"],
    queryFn: () => fetchPositions(sinceRef.current),
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (!query.data) return;
    const { positions, degraded } = query.data;
    if (degraded && !degradedLoggedRef.current) {
      // One-shot log; otherwise this fires every poll on a backend that's
      // down all session and floods the console.
      console.warn(
        "[positions] System 2 backend unreachable — dashboard will stay empty until it's up",
      );
      degradedLoggedRef.current = true;
    }
    if (positions.length === 0) return;
    // Reset the one-shot once we get real data again — operators flipping
    // System 2 on/off mid-session should still get a fresh warning later.
    degradedLoggedRef.current = false;
    sinceRef.current = positions[positions.length - 1].insertedAt;
    ingestDrones(positions.map(position2drone));
  }, [query.data, ingestDrones]);

  return query;
}
