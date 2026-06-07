"use client";

import dynamic from "next/dynamic";
import TopBar from "./top-bar";
import LeftSidebar from "./left-sidebar";
import CamerasLayer from "./cameras-layer";
import SimCamerasLayer from "./sim-cameras-layer";
import AlertsLayer from "./alerts-layer";
import HkNoFlyLayer from "./hk-no-fly-layer";
import TracksLayer from "./tracks-layer";
import Toaster from "./toaster";
import { useDroneStream } from "@/lib/use-drone-stream";
import { useAlertEngine } from "@/lib/use-alert-engine";
import { useAlertTtl } from "@/lib/use-alert-ttl";
import { useTracks } from "@/lib/use-tracks";

// MapLibre touches `window` on import — keep it strictly client-side.
const MapCanvas = dynamic(() => import("./map-canvas"), { ssr: false });
// Dev-only synthetic ingest harness. Tree-shaken in production builds via the
// NODE_ENV guard below, so the chunk never ships to operators.
const DevInjector = dynamic(() => import("./dev-injector"), { ssr: false });

const IS_DEV = process.env.NODE_ENV !== "production";

export default function Dashboard() {
  // System 4 is the single source of truth for real (camera-derived) drone
  // fixes. Each track has a stable integer id (t-<id>), so one physical drone
  // fires ONE entry alert per zone — not one per detection row like raw
  // /api/positions used to. Degrades silently if the tracks table isn't
  // available; useDroneStream below keeps the demo alive in that case.
  useTracks(true);
  // Always-on synthetic background traffic (MOCK-* / SIM-* drones). Stable
  // IDs across ticks → also one alert per zone entry. Independent of any
  // backend; keeps the map demoable offline.
  useDroneStream(true);
  // Zone-violation detector — runs PIP against drawn + static zones for
  // every fix in the drones store (tracks + synthetic) and fires pushAlert
  // on entry. Stable IDs upstream → no duplicate alerts.
  useAlertEngine();
  // TTL prune — ages alerts out (5s) and sweeps expired zone mutes.
  useAlertTtl();

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-ops-900">
      <TopBar />
      <div className="relative flex flex-1 overflow-hidden">
        <LeftSidebar />
        <div className="relative flex-1">
          <MapCanvas>
            <HkNoFlyLayer />
            <CamerasLayer />
            <SimCamerasLayer />
            <TracksLayer />
            <AlertsLayer />
          </MapCanvas>
          <Toaster />
          {IS_DEV ? <DevInjector /> : null}
        </div>
      </div>
    </div>
  );
}
