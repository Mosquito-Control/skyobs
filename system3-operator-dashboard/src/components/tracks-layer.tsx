"use client";

// Renders System 4 drone tracks on the map:
//   - Grey polyline trail per track (historical positions from track_points)
//   - Colored dot at the track's last known position
//
// Follows the same pattern as alerts-layer.tsx: two MapLibre GeoJSON sources
// each with their own layers, subscribed to the Zustand store via
// useApp.subscribe so map updates don't trigger React re-renders.

import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";
import { useMapInstance } from "@/lib/map-context";
import { useApp } from "@/lib/store";
import type { Track } from "@/lib/types";

const TRAIL_SOURCE = "tracks-trail";
const TRAIL_LAYER = "tracks-trail-line";
const DOT_SOURCE = "tracks-dot";
const DOT_HALO_LAYER = "tracks-dot-halo";
const DOT_LAYER = "tracks-dot-circle";

// Stable palette — hue-cycled so adjacent track IDs get distinct colours.
const TRACK_COLORS = [
  "#38bdf8", // sky-400
  "#34d399", // emerald-400
  "#fb923c", // orange-400
  "#a78bfa", // violet-400
  "#f472b6", // pink-400
  "#facc15", // yellow-400
  "#4ade80", // green-400
  "#60a5fa", // blue-400
];

function trackColor(id: number): string {
  return TRACK_COLORS[id % TRACK_COLORS.length];
}

function buildTrailFc(tracks: Record<number, Track>): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const t of Object.values(tracks)) {
    if (t.trail.length < 2) continue; // need at least 2 points to draw a line
    features.push({
      type: "Feature",
      id: t.id,
      geometry: {
        type: "LineString",
        coordinates: t.trail.map((p) => [p.lon, p.lat]),
      },
      properties: { trackId: t.id, status: t.status, color: trackColor(t.id) },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildDotFc(tracks: Record<number, Track>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Object.values(tracks).map((t) => ({
      type: "Feature",
      id: t.id,
      geometry: { type: "Point", coordinates: [t.lastLon, t.lastLat] },
      properties: {
        trackId: t.id,
        status: t.status,
        color: trackColor(t.id),
        pointCount: t.pointCount,
      },
    })),
  };
}

export default function TracksLayer() {
  const map = useMapInstance();
  const readyRef = useRef(false);

  useEffect(() => {
    if (!map) return;
    readyRef.current = false;

    const initial = useApp.getState().tracks;

    // --- Trail source + line layer ---
    if (!map.getSource(TRAIL_SOURCE)) {
      map.addSource(TRAIL_SOURCE, { type: "geojson", data: buildTrailFc(initial) });
    }
    if (!map.getLayer(TRAIL_LAYER)) {
      map.addLayer({
        id: TRAIL_LAYER,
        type: "line",
        source: TRAIL_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 3],
          "line-opacity": ["case", ["==", ["get", "status"], "active"], 0.7, 0.35],
        },
      } satisfies maplibregl.LineLayerSpecification);
    }

    // --- Dot source + halo + circle layers ---
    if (!map.getSource(DOT_SOURCE)) {
      map.addSource(DOT_SOURCE, { type: "geojson", data: buildDotFc(initial) });
    }
    if (!map.getLayer(DOT_HALO_LAYER)) {
      map.addLayer({
        id: DOT_HALO_LAYER,
        type: "circle",
        source: DOT_SOURCE,
        paint: {
          "circle-color": "#FFFFFF",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 12],
          "circle-opacity": 0.9,
        },
      } satisfies maplibregl.CircleLayerSpecification);
    }
    if (!map.getLayer(DOT_LAYER)) {
      map.addLayer({
        id: DOT_LAYER,
        type: "circle",
        source: DOT_SOURCE,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 8],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 1.5,
          "circle-opacity": ["case", ["==", ["get", "status"], "active"], 1, 0.5],
        },
      } satisfies maplibregl.CircleLayerSpecification);
    }

    readyRef.current = true;

    return () => {
      readyRef.current = false;
      for (const id of [DOT_LAYER, DOT_HALO_LAYER, TRAIL_LAYER]) {
        if (map.getLayer(id)) {
          try { map.removeLayer(id); } catch { /* style tearing */ }
        }
      }
      for (const id of [DOT_SOURCE, TRAIL_SOURCE]) {
        if (map.getSource(id)) {
          try { map.removeSource(id); } catch { /* same */ }
        }
      }
    };
  }, [map]);

  // Push updated geometry into MapLibre sources on every store change.
  // Direct subscription avoids re-rendering the React tree on each poll tick.
  useEffect(() => {
    if (!map) return;
    const apply = (tracks: Record<number, Track>) => {
      if (!readyRef.current) return;
      (map.getSource(TRAIL_SOURCE) as maplibregl.GeoJSONSource | undefined)
        ?.setData(buildTrailFc(tracks));
      (map.getSource(DOT_SOURCE) as maplibregl.GeoJSONSource | undefined)
        ?.setData(buildDotFc(tracks));
    };
    apply(useApp.getState().tracks);
    return useApp.subscribe((s) => s.tracks, apply);
  }, [map]);

  return null;
}
