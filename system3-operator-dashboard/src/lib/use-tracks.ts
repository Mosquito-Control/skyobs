"use client";

// Polls /api/tracks every 1.5s and feeds results into two store slices:
//   1. useApp.setTracks()  → TracksSlice, consumed by tracks-layer.tsx for rendering
//   2. useApp.ingestDrones() → DroneSlice, consumed by useAlertEngine for zone violations
//
// The drone IDs for tracked drones use the "t-<trackId>" prefix so they
// don't collide with raw detection IDs like "cam_01+cam_02#123".

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useApp } from "@/lib/store";
import type { DroneFix, Track } from "@/lib/types";

const POLL_MS = Number(process.env.NEXT_PUBLIC_POSITIONS_POLL_MS ?? 1500);

type Payload = { tracks: Track[]; degraded: boolean };

async function fetchTracks(): Promise<Payload> {
  const res = await fetch("/api/tracks", { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/tracks ${res.status}`);
  return (await res.json()) as Payload;
}

function trackToFix(t: Track): DroneFix {
  return {
    id: `t-${t.id}`,
    lat: t.lastLat,
    lng: t.lastLon,
    altM: t.lastAltM,
    t: new Date(t.lastSeen).getTime(),
  };
}

export function useTracks(enabled: boolean = true) {
  const setTracks = useApp((s) => s.setTracks);
  const ingestDrones = useApp((s) => s.ingestDrones);
  const degradedLoggedRef = useRef(false);

  const query = useQuery<Payload>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (!query.data) return;
    const { tracks, degraded } = query.data;

    if (degraded && !degradedLoggedRef.current) {
      console.warn(
        "[tracks] System 4 / tracks table unreachable — track overlays disabled until available",
      );
      degradedLoggedRef.current = true;
    }
    if (tracks.length === 0) return;
    degradedLoggedRef.current = false;

    // Update the dedicated tracks slice (for the polyline layer)
    setTracks(tracks);
    // Also push current track positions into the drones store so the alert
    // engine fires zone-entry events for tracked drones just like raw detections.
    ingestDrones(tracks.map(trackToFix));
  }, [query.data, setTracks, ingestDrones]);

  return query;
}
