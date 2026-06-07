"use client";

// Zone-violation alert engine. Subscribes to the drones store and runs a
// point-in-polygon check against all enabled drawn zones and HK static no-fly
// zones on every position update.
//
// Two outputs per tick:
//   1. pushAlert/refreshAlertSeen — the forensic log (used by the alerts
//      panel; dedupes per (drone, zone)).
//   2. applyImpactDiff — live zone-impact accounting (used by the map to
//      brighten/pulse the impacted polygons and by the alerts panel for the
//      "active zones" header).
//
// Works for both SIM-* (synthetic) and real cam-derived drone IDs.

import { useEffect, useRef } from "react";
import { useApp } from "@/lib/store";
import { booleanPointInPolygon, point } from "@turf/turf";
import type { Alert, ZoneFeature } from "@/lib/types";
import type { StaticZone } from "@/lib/store";
import type { Feature, Polygon, MultiPolygon } from "geojson";

type ViolationKey = string; // `${droneId}::${zoneId}`

function drawnSeverity(zone: ZoneFeature): Alert["severity"] {
  const { category } = zone.properties;
  return category === "military" || category === "airport" || category === "vip"
    ? "high"
    : "medium";
}

function isInside(
  lng: number,
  lat: number,
  geometry: Polygon | MultiPolygon,
): boolean {
  const poly: Feature<Polygon | MultiPolygon> = {
    type: "Feature",
    geometry,
    properties: {},
  };
  try {
    return booleanPointInPolygon(point([lng, lat]), poly);
  } catch {
    return false;
  }
}

/** Linger window — once a (drone, zone) pair has been "inside" this tick, the
 * impact stays lit for LINGER_MS even if the next polled fix lands outside.
 * Orbits that briefly cross the polygon edge therefore read as one continuous
 * breach rather than a strobe of entries.
 *
 * Tuned to 25s — comfortably covers a typical demo orbital period (drone
 * loops in/out every ~20s in the SIM* mocks) so the panel doesn't flicker
 * zones on/off between passes. Re-entries during linger don't fire fresh
 * `entries` — they just bump lastSeen. Real exit fires only after the
 * drone has been outside for the full LINGER_MS. */
const LINGER_MS = 25_000;

export function useAlertEngine(): void {
  // ViolationKey set carried across ticks so we can diff entries vs exits.
  const activeRef = useRef<Set<ViolationKey>>(new Set());
  // key -> wallclock ms after which the linger expires. Updated to
  // `now + LINGER_MS` on every PIP hit; consulted when computing `next` so
  // a recently-active key stays active even without a fresh hit this tick.
  const lingerRef = useRef<Map<ViolationKey, number>>(new Map());

  useEffect(() => {
    return useApp.subscribe(
      (s) => s.drones,
      (drones) => {
        const {
          zones,
          staticZones,
          disabledZoneIds,
          pushAlert,
          refreshAlertSeen,
          applyImpactDiff,
        } = useApp.getState();
        const now = Date.now();
        const next = new Set<ViolationKey>();
        const entries: { zoneId: string; droneId: string }[] = [];

        // Single PIP pass against every (drone, zone) pair. Drawn zones first,
        // then static — order doesn't matter for the engine, the map render
        // handles z-ordering separately.
        for (const drone of Object.values(drones)) {
          for (const [zoneId, zone] of Object.entries(zones)) {
            if (disabledZoneIds[zoneId]) continue;
            if (!isInside(drone.lng, drone.lat, zone.geometry)) continue;
            const key: ViolationKey = `${drone.id}::${zoneId}`;
            next.add(key);
            lingerRef.current.set(key, now + LINGER_MS);
            if (activeRef.current.has(key)) {
              // Live PIP refresh: bump lastSeen AND push the drone's current
              // position so the map marker moves with the drone instead of
              // staying frozen at the entry point.
              refreshAlertSeen(drone.id, zoneId, now, drone.lng, drone.lat);
              continue;
            }
            entries.push({ zoneId, droneId: drone.id });
            // Notifications stay quiet — the map's brighter fill + pulse is
            // the across-the-room signal. The alert log is still maintained
            // for the alerts panel, but we do NOT fire a toast per entry
            // (orbiting drones would spam multiple per minute).
            pushAlert({
              id: `alert-${drone.id}-${zoneId}`,
              droneId: drone.id,
              zoneId,
              t: now,
              lastSeen: now,
              status: "new",
              severity: drawnSeverity(zone),
              message: `${drone.id} entered ${zone.properties.name} (${zone.properties.category})`,
              lat: drone.lat,
              lng: drone.lng,
            });
          }

          for (const [zoneId, zone] of Object.entries(staticZones)) {
            if (disabledZoneIds[zoneId]) continue;
            if (!isInside(drone.lng, drone.lat, zone.geometry)) continue;
            const key: ViolationKey = `${drone.id}::${zoneId}`;
            next.add(key);
            lingerRef.current.set(key, now + LINGER_MS);
            if (activeRef.current.has(key)) {
              refreshAlertSeen(drone.id, zoneId, now, drone.lng, drone.lat);
              continue;
            }
            entries.push({ zoneId, droneId: drone.id });
            pushAlert({
              id: `alert-${drone.id}-${zoneId}`,
              droneId: drone.id,
              zoneId,
              t: now,
              lastSeen: now,
              status: "new",
              severity: "high",
              message: `${drone.id} in no-fly zone: ${zone.name}`,
              lat: drone.lat,
              lng: drone.lng,
            });
          }
        }

        // Apply linger: keys with an unexpired hold count as still-active
        // even if the drone wasn't detected inside this tick. Sweep expired
        // entries out so the map can drop them. This is what makes a drone
        // orbiting along a polygon edge read as one continuous breach.
        // Also bump lastSeen on lingered pairs (no lng/lat update — keeps
        // the alert marker pinned at the last in-zone position) so the TTL
        // ticker doesn't prune the alert mid-linger and make the panel
        // strobe.
        for (const [key, until] of lingerRef.current) {
          if (until <= now) {
            lingerRef.current.delete(key);
            continue;
          }
          next.add(key);
          // Only bump if this key wasn't already refreshed in the PIP loop
          // above (active-set check is a quick proxy — keys hit this tick
          // were added to active in the prior tick or just now).
          const sep = key.indexOf("::");
          if (sep < 0) continue;
          refreshAlertSeen(key.slice(0, sep), key.slice(sep + 2), now);
        }

        // Exits = keys in last tick's active set but not in this one
        // (post-linger). Covers (a) drone moved out and linger expired,
        // (b) drone disappeared from the fix stream entirely, and (c) zone
        // got disabled/deleted. All collapse to the same "drop the impact"
        // mutation.
        const exits: { zoneId: string; droneId: string }[] = [];
        for (const key of activeRef.current) {
          if (next.has(key)) continue;
          const sep = key.indexOf("::");
          if (sep < 0) continue;
          exits.push({
            droneId: key.slice(0, sep),
            zoneId: key.slice(sep + 2),
          });
        }

        if (entries.length > 0 || exits.length > 0) {
          applyImpactDiff(entries, exits, now);
        }

        activeRef.current = next;
      },
    );
  }, []);
}
