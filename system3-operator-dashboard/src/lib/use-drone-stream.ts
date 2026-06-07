"use client";

// Synthetic background traffic — 3 simulated drones orbiting HK in continuous
// loops. IDs are prefixed SIM- to distinguish them from real camera-derived
// fixes (which use cam_pair#rowid form). Alert generation is handled by
// useAlertEngine (use-alert-engine.ts), not here.

import { useEffect, useRef } from "react";
import { useApp } from "@/lib/store";
import type { DroneFix } from "@/lib/types";

// Demo spawn anchors. Each is the centre of a tight orbit that stays
// inside its corresponding static no-fly polygon, so useAlertEngine
// fires zone-entry violations on every loop. This keeps the map alive
// with visible alerts in multiple districts independent of Unity/S2.
//
// HK_CENTER matches map-canvas.tsx (Mong Kok / dense Kowloon) — the same
// anchor used by the Unity scene's drone flight ring, so SIM-* drones
// still sit over the same district as the real triangulated fixes once
// System 2 is online.
const HK_CENTER: [number, number] = [114.169, 22.318];

type SpawnAnchor = {
  id: string;
  centre: [number, number];
  ringDeg: number; // orbit radius in degrees (~0.01° ≈ 1 km)
  altM: number;
  registered: boolean;
};

// Tight rings stay inside the polygon; loose rings cross in and out
// (re-entry re-fires the alert, which is what we want for the demo).
const MOCK_SPAWNS: SpawnAnchor[] = [
  { id: "MOCK-HKIA",   centre: [113.92, 22.31],  ringDeg: 0.012, altM: 90,  registered: false }, // airport
  { id: "MOCK-HARBOUR", centre: [114.172, 22.293], ringDeg: 0.008, altM: 60, registered: false }, // TST waterfront (event)
  { id: "MOCK-VIP",     centre: [114.163, 22.281], ringDeg: 0.006, altM: 70, registered: false }, // Central govt/finance
  { id: "MOCK-MIL",     centre: [114.105, 22.435], ringDeg: 0.010, altM: 110, registered: false }, // Shek Kong airfield
];

function makeFix(
  id: string,
  seed: number,
  centre: [number, number],
  ringDeg: number,
  altM: number,
  registered: boolean,
): DroneFix {
  const theta = (Date.now() / 4000 + seed) % (Math.PI * 2);
  return {
    id,
    lng: centre[0] + Math.cos(theta) * ringDeg,
    lat: centre[1] + Math.sin(theta) * ringDeg,
    altM,
    bearingDeg: ((theta * 180) / Math.PI + 90) % 360,
    speedMs: 8 + ((seed * 3) % 11),
    t: Date.now(),
    registered,
    category: registered ? "A" : "B",
  };
}

// SIM-* drones orbit Mong Kok — same district as the real triangulated
// Unity fixes will show up. Keeps the Unity demo zone populated even when
// System 2 is offline.
function makeMongKokFix(id: string, seed: number): DroneFix {
  const ring = 0.04 + ((seed % 7) * 0.01);
  const theta = (Date.now() / 4000 + seed) % (Math.PI * 2);
  return {
    id,
    lng: HK_CENTER[0] + Math.cos(theta) * ring,
    lat: HK_CENTER[1] + Math.sin(theta) * ring,
    altM: 80 + ((seed * 13) % 90),
    bearingDeg: ((theta * 180) / Math.PI + 90) % 360,
    speedMs: 8 + ((seed * 3) % 11),
    t: Date.now(),
    registered: seed % 4 !== 0,
    category: seed % 3 === 0 ? "B" : "A",
  };
}

export function useDroneStream(enabled: boolean) {
  const tickRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      tickRef.current += 1;
      const tick = tickRef.current;
      const mongKok = [
        makeMongKokFix("SIM-001", tick + 1),
        makeMongKokFix("SIM-002", tick + 11),
        makeMongKokFix("SIM-003", tick + 23),
      ];
      const mockZones = MOCK_SPAWNS.map((s, i) =>
        makeFix(s.id, tick + i * 7, s.centre, s.ringDeg, s.altM, s.registered),
      );
      useApp.getState().ingestDrones([...mongKok, ...mockZones]);
    }, 5000);
    return () => clearInterval(id);
  }, [enabled]);
}
