"use client";

import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";
import { booleanPointInPolygon, point } from "@turf/turf";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import { useMapInstance } from "@/lib/map-context";
import { useApp } from "@/lib/store";
import type { Alert, DroneFix } from "@/lib/types";

/**
 * Live breach rendering. The previous persistent dot-per-detection layer
 * accumulated visual debt over time and didn't tell the operator anything the
 * zone pulse couldn't. Replaced by two animated layers:
 *
 *   1. "Ping" — a radial wave at the breach point that fades out over
 *      PING_LIFETIME_MS. Three concentric rings expanding from radius 0.
 *      Spawns ONCE per alert (first time we see its id) and dies regardless
 *      of whether the alert is still "live" — the zone-impact layer
 *      carries persistence, the ping is the "something just happened *here*"
 *      cue that drags peripheral attention.
 *
 *   2. "Trail" — for every drone currently in an impacted zone, the slice
 *      of its recent fix history inside that zone renders as a brighter
 *      polyline with a head dot. This answers "where in the zone has the
 *      drone been?" — area-aware, not just a point.
 */

const PING_SOURCE = "breach-pings";
const PING_LAYER_OUTER = "breach-pings-outer";
const PING_LAYER_MID = "breach-pings-mid";
const PING_LAYER_INNER = "breach-pings-inner";

const MARKER_SOURCE = "alert-markers";
const MARKER_HALO_LAYER = "alert-markers-halo";
const MARKER_DOT_LAYER = "alert-markers-dot";

const TRAIL_SOURCE = "breach-trails";
const TRAIL_LAYER_LINE = "breach-trails-line";
const TRAIL_LAYER_HEAD = "breach-trails-head";

const PING_LIFETIME_MS = 2500;
const PING_MAX_RADIUS_PX = 56;
// Cap how stale an alert can be before we still spawn a ping for it. With the
// 5s alert TTL, anything older than ~4.5s has effectively been pruned; this
// avoids replaying a flurry of pings on tab-resume.
const PING_MAX_AGE_FOR_SPAWN_MS = 4500;

interface PingFeature extends GeoJSON.Feature<GeoJSON.Point> {
  properties: {
    id: string;
    t: number;
    ageMs: number;
    progress: number;
    opacity: number;
  };
}

/** Synthetic-drone id prefixes from use-drone-stream.ts. The in-zone trail
 * skips these so demo wallpaper doesn't dominate the map; real triangulated
 * tracks (t-<id>) and any other source still render. */
const MOCK_ID_PREFIXES = ["MOCK-", "SIM-"];
function isMockDroneId(id: string): boolean {
  for (const p of MOCK_ID_PREFIXES) if (id.startsWith(p)) return true;
  return false;
}

/** Walk a drone's recent fixes newest-first and keep the contiguous tail
 * that's still inside `geom`. Reversed before return so the line renders
 * chronologically (oldest → newest). One contiguous "current incursion"
 * line beats a dotted history for legibility. */
function inZoneTail(
  fixes: DroneFix[],
  geom: Polygon | MultiPolygon,
): [number, number][] {
  const out: [number, number][] = [];
  const polyFeat: Feature<Polygon | MultiPolygon> = {
    type: "Feature",
    geometry: geom,
    properties: {},
  };
  for (let i = fixes.length - 1; i >= 0; i--) {
    const f = fixes[i];
    try {
      if (!booleanPointInPolygon(point([f.lng, f.lat]), polyFeat)) break;
    } catch {
      break;
    }
    out.push([f.lng, f.lat]);
  }
  out.reverse();
  return out;
}

export default function AlertsLayer() {
  const map = useMapInstance();
  // Active pings keyed by alert id. Seeded from `alerts` subscription, aged
  // out by the rAF loop. Map preserves insertion order so the memory cap
  // below drops the oldest entries first.
  const pingsRef = useRef<Map<string, { t: number; lng: number; lat: number }>>(
    new Map(),
  );

  useEffect(() => {
    if (!map) return;

    if (!map.getSource(PING_SOURCE)) {
      map.addSource(PING_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getSource(MARKER_SOURCE)) {
      map.addSource(MARKER_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getSource(TRAIL_SOURCE)) {
      map.addSource(TRAIL_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    // Persistent moving marker per alert. One halo + one colored dot per
    // alert, keyed by alert.id so position updates propagate via setData
    // without churn. New alerts read alarm-red; acknowledged ones stay
    // amber so the operator can still see "the same alert is still in
    // play, just acknowledged". Reads alert.lng/lat directly — the engine
    // bumps those each PIP hit, so the marker tracks the drone.
    if (!map.getLayer(MARKER_HALO_LAYER)) {
      map.addLayer({
        id: MARKER_HALO_LAYER,
        type: "circle",
        source: MARKER_SOURCE,
        paint: {
          "circle-color": "#FFFFFF",
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            8, 6, 16, 11,
          ],
          "circle-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer(MARKER_DOT_LAYER)) {
      map.addLayer({
        id: MARKER_DOT_LAYER,
        type: "circle",
        source: MARKER_SOURCE,
        paint: {
          "circle-color": [
            "match", ["get", "status"],
            "ack", "#F59E0B",
            "resolved", "#64748B",
            // default — "new"
            "#DC2626",
          ],
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            8, 3.5, 16, 7,
          ],
          "circle-stroke-color": "#0F172A",
          "circle-stroke-width": 1.5,
          "circle-opacity": [
            "match", ["get", "status"],
            "resolved", 0.45,
            1,
          ],
        },
      });
    }

    // Three concentric rings expanding from radius 0. circle-radius reads
    // `progress` (0..1) updated per frame by the animator and scales it by
    // PING_MAX_RADIUS_PX × per-ring factor so they stagger out.
    const ringIds = [PING_LAYER_OUTER, PING_LAYER_MID, PING_LAYER_INNER];
    const ringColors = ["#FCA5A5", "#F87171", "#FFFFFF"];
    const ringScales = [1.0, 0.7, 0.45];
    for (let i = 0; i < 3; i++) {
      if (!map.getLayer(ringIds[i])) {
        map.addLayer({
          id: ringIds[i],
          type: "circle",
          source: PING_SOURCE,
          paint: {
            "circle-color": "rgba(0,0,0,0)",
            "circle-radius": [
              "*",
              ["get", "progress"],
              PING_MAX_RADIUS_PX * ringScales[i],
            ],
            "circle-stroke-color": ringColors[i],
            "circle-stroke-width": i === 2 ? 1.5 : 2,
            "circle-stroke-opacity": ["get", "opacity"],
            "circle-opacity": 0,
          },
        });
      }
    }

    if (!map.getLayer(TRAIL_LAYER_LINE)) {
      map.addLayer({
        id: TRAIL_LAYER_LINE,
        type: "line",
        source: TRAIL_SOURCE,
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#FCA5A5",
          "line-width": 3,
          "line-opacity": 0.85,
          "line-blur": 0.5,
        },
      });
    }
    if (!map.getLayer(TRAIL_LAYER_HEAD)) {
      map.addLayer({
        id: TRAIL_LAYER_HEAD,
        type: "circle",
        source: TRAIL_SOURCE,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": "#FFFFFF",
          "circle-radius": 4,
          "circle-stroke-color": "#0F172A",
          "circle-stroke-width": 1.5,
        },
      });
    }

    // Each fresh alert (within PING_MAX_AGE_FOR_SPAWN_MS) gets a one-shot
    // ping. Repeated alerts dedupe by id so an alert that survives a few
    // poll ticks doesn't re-spawn its ring each tick.
    const seedFromAlerts = (alerts: Alert[]) => {
      const now = Date.now();
      for (const a of alerts) {
        if (pingsRef.current.has(a.id)) continue;
        if (now - a.t > PING_MAX_AGE_FOR_SPAWN_MS) continue;
        pingsRef.current.set(a.id, { t: a.t, lng: a.lng, lat: a.lat });
      }
      if (pingsRef.current.size > 100) {
        let toDrop = pingsRef.current.size - 100;
        for (const k of pingsRef.current.keys()) {
          if (toDrop-- <= 0) break;
          pingsRef.current.delete(k);
        }
      }
    };
    seedFromAlerts(useApp.getState().alerts);
    const unsubAlerts = useApp.subscribe((s) => s.alerts, seedFromAlerts);

    // Persistent marker layer — one feature per alert at its current lat/lng.
    // The engine bumps alert.lng/lat on every PIP hit, so each setData call
    // here moves the dots smoothly with the drones (within poll cadence).
    const repaintMarkers = (alerts: Alert[]) => {
      const src = map.getSource(MARKER_SOURCE) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (!src) return;
      const features: GeoJSON.Feature[] = alerts.map((a) => ({
        type: "Feature",
        id: a.id,
        geometry: { type: "Point", coordinates: [a.lng, a.lat] },
        properties: {
          id: a.id,
          droneId: a.droneId,
          zoneId: a.zoneId,
          status: a.status,
          severity: a.severity,
        },
      }));
      src.setData({ type: "FeatureCollection", features });
    };
    repaintMarkers(useApp.getState().alerts);
    const unsubMarkers = useApp.subscribe((s) => s.alerts, repaintMarkers);

    // Trail recompute is cheap (impacted zones × drones inside, both small).
    // Output is the full FeatureCollection so we never serve a stale
    // per-feature property.
    const recomputeTrails = () => {
      const src = map.getSource(TRAIL_SOURCE) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (!src) return;
      const state = useApp.getState();
      const now = Date.now();
      // Skip zones the operator has acknowledged — the trail is a "look at
      // this incursion" cue and an ack means "stop showing me this one".
      const impactedIds = Object.keys(state.zoneImpact).filter((id) => {
        const until = state.mutedZoneUntil[id];
        return !(typeof until === "number" && until > now);
      });
      if (impactedIds.length === 0) {
        src.setData({ type: "FeatureCollection", features: [] });
        return;
      }
      const features: GeoJSON.Feature[] = [];
      for (const zoneId of impactedIds) {
        const impact = state.zoneImpact[zoneId];
        const drawnZone = state.zones[zoneId];
        const staticZone = state.staticZones[zoneId];
        const geom = drawnZone?.geometry ?? staticZone?.geometry;
        if (!geom) continue;
        for (const droneId of impact.droneIds) {
          // Skip the synthetic mocks — their orbital paths are demo wallpaper
          // and rendering their in-zone trail just adds visual debt. Real
          // tracks (t-*) and any other id still draw normally.
          if (isMockDroneId(droneId)) continue;
          const fixes = state.recentFixes[droneId];
          if (!fixes || fixes.length === 0) continue;
          const tail = inZoneTail(fixes, geom);
          if (tail.length < 1) continue;
          if (tail.length >= 2) {
            features.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: tail },
              properties: { droneId, zoneId },
            });
          }
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: tail[tail.length - 1] },
            properties: { droneId, zoneId, head: true },
          });
        }
      }
      src.setData({ type: "FeatureCollection", features });
    };
    recomputeTrails();
    const unsubDrones = useApp.subscribe((s) => s.drones, recomputeTrails);
    const unsubImpact = useApp.subscribe((s) => s.zoneImpact, recomputeTrails);
    const unsubMute = useApp.subscribe((s) => s.mutedZoneUntil, recomputeTrails);

    // rAF loop ages every live ping. Stops itself when the set empties — the
    // alerts/kick subscription below restarts it on the next fresh ping.
    let rafId: number | null = null;
    const tick = () => {
      rafId = null;
      const src = map.getSource(PING_SOURCE) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (!src) return;
      const now = Date.now();
      const features: PingFeature[] = [];
      for (const [id, p] of pingsRef.current) {
        const age = now - p.t;
        if (age >= PING_LIFETIME_MS) {
          pingsRef.current.delete(id);
          continue;
        }
        const progress = age / PING_LIFETIME_MS;
        // Sharper-than-linear fade: squaring (1-progress) gives the ring
        // a punchy snap-then-vanish profile, not a slow wash.
        const fade = 1 - progress;
        const opacity = Math.max(0, Math.min(0.95, fade * fade * 0.95));
        features.push({
          type: "Feature",
          id,
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
          properties: { id, t: p.t, ageMs: age, progress, opacity },
        });
      }
      src.setData({ type: "FeatureCollection", features });
      if (pingsRef.current.size > 0) {
        rafId = requestAnimationFrame(tick);
      }
    };
    const kick = () => {
      if (rafId === null && pingsRef.current.size > 0) {
        rafId = requestAnimationFrame(tick);
      }
    };
    const unsubKick = useApp.subscribe((s) => s.alerts, kick);
    kick();

    const onClickPing = (e: maplibregl.MapMouseEvent) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: [PING_LAYER_OUTER, PING_LAYER_MID, PING_LAYER_INNER],
      });
      const f = feats[0];
      if (!f) return;
      const coords = (f.geometry as GeoJSON.Point).coordinates as [
        number,
        number,
      ];
      map.flyTo({
        center: coords,
        zoom: Math.max(map.getZoom(), 13.5),
        speed: 0.9,
      });
    };
    map.on("click", PING_LAYER_OUTER, onClickPing);
    map.on("click", PING_LAYER_MID, onClickPing);
    map.on("click", PING_LAYER_INNER, onClickPing);

    const onClickMarker = (e: maplibregl.MapMouseEvent) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: [MARKER_DOT_LAYER],
      });
      const f = feats[0];
      if (!f) return;
      const coords = (f.geometry as GeoJSON.Point).coordinates as [
        number,
        number,
      ];
      map.flyTo({
        center: coords,
        zoom: Math.max(map.getZoom(), 13.5),
        speed: 0.9,
      });
    };
    map.on("click", MARKER_DOT_LAYER, onClickMarker);

    return () => {
      unsubAlerts();
      unsubMarkers();
      unsubDrones();
      unsubImpact();
      unsubMute();
      unsubKick();
      if (rafId !== null) cancelAnimationFrame(rafId);
      try {
        map.off("click", PING_LAYER_OUTER, onClickPing);
        map.off("click", PING_LAYER_MID, onClickPing);
        map.off("click", PING_LAYER_INNER, onClickPing);
        map.off("click", MARKER_DOT_LAYER, onClickMarker);
      } catch {
        /* map gone */
      }
      for (const id of [
        TRAIL_LAYER_HEAD,
        TRAIL_LAYER_LINE,
        MARKER_DOT_LAYER,
        MARKER_HALO_LAYER,
        PING_LAYER_INNER,
        PING_LAYER_MID,
        PING_LAYER_OUTER,
      ]) {
        if (map.getLayer(id)) {
          try {
            map.removeLayer(id);
          } catch {
            /* style tearing down */
          }
        }
      }
      for (const id of [TRAIL_SOURCE, MARKER_SOURCE, PING_SOURCE]) {
        if (map.getSource(id)) {
          try {
            map.removeSource(id);
          } catch {
            /* same */
          }
        }
      }
    };
  }, [map]);

  return null;
}
