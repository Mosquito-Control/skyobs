"use client";

// HK camera overlay — renders TD CCTV + HKO weather-cam markers on the map.
// Dots are intentionally tiny and a quiet gray so they don't compete with
// no-fly zones (red) or alert detections (black). Clicking a dot opens a
// MapLibre popup with the camera's live still image.

import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";
import maplibreglRuntime from "maplibre-gl";
import { useMapInstance } from "@/lib/map-context";
import { useApp } from "@/lib/store";
import { useCameras, type CameraFeatureCollection } from "@/lib/use-cameras";

const SOURCE_ID = "cameras";
const CIRCLE_LAYER_ID = "cameras-circle";

const EMPTY_FC: CameraFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Build the public image URL for a camera. Patterns are HK government's
 * documented public endpoints — both data.gov.hk traffic cameras and HKO's
 * weather-cam stills are publicly accessible without auth, and the URL shapes
 * here are what gov.hk's own dashboards use.
 *
 *   HKO_<CODE>    → https://www.hko.gov.hk/wxinfo/aws/hko_mica/<lower>/latest_<CODE>.jpg
 *   TD_<KEY>      → https://tdcctv.data.one.gov.hk/<KEY>.JPG
 *
 * Returns null for unknown sources so the popup can show "no preview".
 */
function feedUrl(source: string, source_key: string): string | null {
  if (source === "hko") {
    const code = source_key.replace(/^HKO_/, "");
    return `https://www.hko.gov.hk/wxinfo/aws/hko_mica/${code.toLowerCase()}/latest_${code}.jpg`;
  }
  if (source === "td_cctv") {
    const key = source_key.replace(/^TD_/, "");
    return `https://tdcctv.data.one.gov.hk/${key}.JPG`;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Build the popup body. Cache-bust the image URL so refreshes pull a new still. */
function popupHtml(props: Record<string, unknown>): string {
  const name = typeof props.name === "string" ? props.name : "Camera";
  const source = typeof props.source === "string" ? props.source : "";
  const source_key =
    typeof props.source_key === "string" ? props.source_key : "";
  const url = feedUrl(source, source_key);
  const cacheBust = url ? `${url}?t=${Date.now()}` : null;
  const safeName = escapeHtml(name);
  const safeKey = escapeHtml(source_key);
  const safeSource = escapeHtml(source.toUpperCase());

  const img = cacheBust
    ? `<img src="${escapeHtml(cacheBust)}" alt="${safeName}" class="cam-popup__img" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
       <div class="cam-popup__fallback" style="display:none">Live feed unavailable</div>`
    : `<div class="cam-popup__fallback">No preview for this source</div>`;

  return `
    <div class="cam-popup">
      <div class="cam-popup__head">
        <div class="cam-popup__title">${safeName}</div>
        <div class="cam-popup__meta">${safeSource} · ${safeKey}</div>
      </div>
      <div class="cam-popup__body">${img}</div>
    </div>
  `;
}

export default function CamerasLayer() {
  const map = useMapInstance();
  const { data } = useCameras();
  const popupRef = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    if (!map) return;

    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
      });
    }

    if (!map.getLayer(CIRCLE_LAYER_ID)) {
      map.addLayer({
        id: CIRCLE_LAYER_ID,
        type: "circle",
        // Visible from city-wide overview so the real-cam coverage is
        // legible alongside the green sim cams. Still smaller than the
        // sim layer so the hierarchy stays clear.
        minzoom: 8,
        source: SOURCE_ID,
        paint: {
          "circle-color": "#cbd5e1",
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            2.5,
            12,
            4,
            16,
            6.5,
          ],
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 1,
          "circle-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            0.7,
            11,
            0.9,
            14,
            1.0,
          ],
        },
      } satisfies maplibregl.CircleLayerSpecification);
    }

    const onClick = (e: maplibregl.MapMouseEvent) => {
      // Suppress camera clicks while the operator is mid-draw — otherwise a
      // mis-click on a camera dot opens a popup instead of placing a vertex.
      if (useApp.getState().drawMode !== "idle") return;
      const feats = map.queryRenderedFeatures(e.point, {
        layers: [CIRCLE_LAYER_ID],
      });
      const f = feats[0];
      if (!f) return;
      const coords = (f.geometry as GeoJSON.Point).coordinates as [
        number,
        number,
      ];
      popupRef.current?.remove();
      popupRef.current = new maplibreglRuntime.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "340px",
        offset: 8,
      })
        .setLngLat(coords)
        .setHTML(popupHtml(f.properties ?? {}))
        .addTo(map);
    };
    // Cursor changes are owned by the central mousemove in map-canvas so we
    // don't fight other layers. Click handler is layer-specific so the popup
    // only opens when the click really lands on a camera dot.
    map.on("click", CIRCLE_LAYER_ID, onClick);

    return () => {
      // Guard the whole cleanup — under StrictMode/HMR the map may already be
      // mid-teardown by the time React invokes us, and any call into MapLibre
      // can throw.
      try {
        map.off("click", CIRCLE_LAYER_ID, onClick);
      } catch {
        /* map already torn down */
      }
      popupRef.current?.remove();
      popupRef.current = null;
      try {
        if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        /* same */
      }
    };
  }, [map]);

  // Push fresh data into the existing source whenever the query resolves.
  useEffect(() => {
    if (!map || !data) return;
    const src = map.getSource(SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData(data as unknown as GeoJSON.FeatureCollection);
  }, [map, data]);

  return null;
}
