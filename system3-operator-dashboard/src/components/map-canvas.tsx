"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { MapContext, TerraDrawContext } from "@/lib/map-context";
import { setTerraDrawRef } from "@/lib/terra-draw-ref";
import { MaplibreTerradrawControl } from "@watergis/maplibre-gl-terradraw";
import {
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawCircleMode,
  TerraDrawSelectMode,
  type GeoJSONStoreFeatures,
} from "terra-draw";
import "maplibre-gl/dist/maplibre-gl.css";
import "@watergis/maplibre-gl-terradraw/dist/maplibre-gl-terradraw.css";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { centroid } from "@turf/centroid";
import {
  kinks,
  area,
  union,
  booleanIntersects,
  booleanPointInPolygon,
  featureCollection,
  point,
} from "@turf/turf";
import * as polygonClipping from "polygon-clipping";
import { useApp } from "@/lib/store";
import type { ZoneFeature, ZoneKind } from "@/lib/types";

// Mong Kok / dense Kowloon — the Unity scene's drone flight ring centre.
// This matches the anchor used by system4-unity-simulation/Tools/
// export_camera_geojson.py and the reference_origin in System 2's
// cameras.yaml, so the sim cameras and the triangulated drone fixes both
// land in the visible camera ring at this map center.
const HK_CENTER: [number, number] = [114.169, 22.318];

/**
 * Detect zones that the just-finished polygon intersects, union them all, and
 * write the result back onto `sid`. The overlapping zones are removed from
 * both terra-draw and the store. Mutates state via store actions; returns the
 * number of zones absorbed.
 */
function maybeUnionWithOverlaps(
  td: import("terra-draw").TerraDraw,
  sid: string,
  newGeom: Polygon,
): { unionedCount: number } {
  const store = useApp.getState();
  const newFeature: Feature<Polygon> = {
    type: "Feature",
    geometry: newGeom,
    properties: {},
  };

  const overlapping: string[] = [];
  for (const [id, zone] of Object.entries(store.zones)) {
    if (id === sid) continue;
    if (
      zone.geometry.type !== "Polygon" &&
      zone.geometry.type !== "MultiPolygon"
    ) {
      continue;
    }
    try {
      if (booleanIntersects(newFeature, zone)) {
        overlapping.push(id);
      }
    } catch {
      /* malformed — skip */
    }
  }

  if (overlapping.length === 0) return { unionedCount: 0 };

  // Compute the union of new + every overlapping zone in one call.
  let mergedGeom: Polygon | null = null;
  try {
    const toMerge: Feature<Polygon | MultiPolygon>[] = [newFeature];
    for (const id of overlapping) {
      const z = store.zones[id];
      if (z) {
        toMerge.push({
          type: "Feature",
          geometry: z.geometry,
          properties: {},
        });
      }
    }
    const result = union(
      featureCollection(toMerge) as unknown as GeoJSON.FeatureCollection<
        Polygon | MultiPolygon
      >,
    );
    if (result?.geometry) {
      if (result.geometry.type === "Polygon") {
        mergedGeom = result.geometry as Polygon;
      } else if (result.geometry.type === "MultiPolygon") {
        // Take the largest piece — terra-draw works with single polygons.
        const polys = (result.geometry.coordinates as number[][][][]).map(
          (coords) =>
            ({ type: "Polygon", coordinates: coords } as Polygon),
        );
        let best = polys[0];
        let bestArea = area({ type: "Feature", geometry: best, properties: {} });
        for (let i = 1; i < polys.length; i++) {
          const a = area({
            type: "Feature",
            geometry: polys[i],
            properties: {},
          });
          if (a > bestArea) {
            best = polys[i];
            bestArea = a;
          }
        }
        mergedGeom = best;
      }
    }
  } catch {
    /* union failed — fall through */
  }

  if (!mergedGeom) return { unionedCount: 0 };

  // Apply. Wrapped in queueMicrotask + isApplyingRemote so the terra-draw
  // change echo doesn't bounce back into syncFromTerra mid-sync.
  const ids = overlapping.slice();
  const finalGeom = mergedGeom;
  queueMicrotask(() => {
    // Update terra-draw: change geometry of `sid`, remove the absorbed ones.
    try {
      (
        td as unknown as {
          updateFeatureGeometry?: (
            id: string | number,
            geometry: Polygon,
          ) => void;
        }
      ).updateFeatureGeometry?.(sid, finalGeom);
    } catch {
      /* update failed */
    }
    try {
      td.removeFeatures(ids);
    } catch {
      /* already gone */
    }
    // Update store: drop the absorbed zones, replace `sid`'s geometry.
    const s = useApp.getState();
    const nextZones = Object.values(s.zones)
      .filter((z) => !ids.includes(z.properties.id))
      .map((z) =>
        z.properties.id === sid
          ? ({ ...z, geometry: finalGeom } as typeof z)
          : z,
      );
    s.setZones(nextZones);
  });

  return { unionedCount: overlapping.length };
}

/**
 * Clean a self-intersecting polygon by running it through polygon-clipping's
 * union operator. Polygon-clipping resolves self-touching/self-crossing rings
 * via the non-zero fill rule (the JS equivalent of JTS's `buffer(0)` idiom)
 * and guarantees the output is non-self-touching and non-self-crossing —
 * which @turf/unkink-polygon explicitly does NOT (it returns some
 * self-intersecting shapes unchanged, see Turfjs/turf#1094 / Turfjs/turf#92).
 *
 * If the cleanup splits the polygon into disjoint pieces (rare for the bowtie
 * cases operators draw by accident), we keep the largest piece by area. Holes
 * within that piece are preserved.
 */
function pickLargestSimplePolygon(g: Polygon): Polygon | null {
  try {
    const cleaned = polygonClipping.union(
      g.coordinates as polygonClipping.Polygon,
    );
    if (!cleaned || cleaned.length === 0) return null;

    let bestRings = cleaned[0];
    let bestArea = area({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: bestRings },
      properties: {},
    });
    for (let i = 1; i < cleaned.length; i++) {
      const a = area({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: cleaned[i] },
        properties: {},
      });
      if (a > bestArea) {
        bestRings = cleaned[i];
        bestArea = a;
      }
    }
    return { type: "Polygon", coordinates: bestRings };
  } catch {
    return null;
  }
}

/** CARTO Positron — clean white basemap. Same CDN as dark-matter, no API key. */
const STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// Restricted-airspace palette — red for no-fly intent, regardless of perm/tmp.
// Permanent zones get a slightly darker fill so the kind badge still reads in
// the side panel, but the user-facing "don't fly here" signal stays consistent.
// Impacted variants stay in the same hue family — calm-vs-hot reads as
// intensity, not as a different category.
const COLOR = {
  permFill: "#DC2626",
  permOutline: "#991B1B",
  tmpFill: "#EF4444",
  tmpOutline: "#B91C1C",
  impactedFill: "#F87171",
  impactedOutline: "#FCA5A5",
  selectedOutline: "#0F172A",
} as const;

// Reads kind off of the live feature properties terra-draw mirrors. We seed these
// via updateFeatureProperties whenever the zone store changes.
const kindOf = (f: GeoJSONStoreFeatures): ZoneKind =>
  (f.properties?.kind as ZoneKind) ?? "temporary";
const isSelected = (f: GeoJSONStoreFeatures) =>
  Boolean(f.properties?.selected);
// "Hidden by filter" = some OTHER zone is selected, so this one collapses to
// fully transparent on the map. The zone still exists and stays in the sidebar
// list — clicking another row updates the selection and this one returns.
const isHiddenByFilter = (f: GeoJSONStoreFeatures) =>
  Boolean(f.properties?.hiddenByFilter);
// "Disabled" = the operator switched this zone off from the Saved list. It
// stays in the catalogue but stops rendering on the map and drops out of
// enforcement. Independent from hiddenByFilter so isolation + disable
// compose without one clobbering the other.
const isDisabled = (f: GeoJSONStoreFeatures) =>
  Boolean(f.properties?.disabled);
// "Impacted" = at least one drone is currently inside this drawn zone.
// Mirrored from the zoneImpact store. Drives brighter fill + thicker
// outline and is read by the rAF pulse loop further down which throbs
// `pulseAlpha` between ticks so the zone literally breathes.
const isImpacted = (f: GeoJSONStoreFeatures) =>
  Boolean(f.properties?.impacted);
const pulseAlphaOf = (f: GeoJSONStoreFeatures) => {
  const v = f.properties?.pulseAlpha;
  return typeof v === "number" ? v : 0;
};
// A zone hides ONLY when not selected. Selecting a disabled zone (clicking
// its row in Saved) should still surface it on the map so the operator can
// see what they're inspecting — same idea for the isolation filter.
const isInvisible = (f: GeoJSONStoreFeatures) =>
  !isSelected(f) && (isHiddenByFilter(f) || isDisabled(f));

const polygonStyles = {
  fillColor: (f: GeoJSONStoreFeatures) => {
    if (isImpacted(f)) return COLOR.impactedFill;
    return kindOf(f) === "permanent" ? COLOR.permFill : COLOR.tmpFill;
  },
  fillOpacity: (f: GeoJSONStoreFeatures) => {
    if (isInvisible(f)) return 0;
    // Dormant drawn zones are quiet (0.08) — restricted but not screaming
    // for attention. Impacted state jumps 5× so a breach is impossible to
    // miss scanning across the map.
    return isImpacted(f) ? 0.42 : 0.08;
  },
  outlineColor: (f: GeoJSONStoreFeatures) => {
    if (isSelected(f)) return COLOR.selectedOutline;
    if (isImpacted(f)) return COLOR.impactedOutline;
    return kindOf(f) === "permanent" ? COLOR.permOutline : COLOR.tmpOutline;
  },
  outlineWidth: (f: GeoJSONStoreFeatures) => {
    if (isInvisible(f)) return 0;
    if (isSelected(f)) return 3.5;
    if (isImpacted(f)) {
      // Pulse breathes between 3 and 7 px via pulseAlpha (0..1) updated by
      // the rAF loop below. Re-rendering through updateFeatureProperties
      // forces terra-draw to re-evaluate this style function.
      return 3 + pulseAlphaOf(f) * 4;
    }
    return 2;
  },
};

const selectionStyles = {
  selectedPolygonColor: (f: GeoJSONStoreFeatures) =>
    kindOf(f) === "permanent" ? COLOR.permFill : COLOR.tmpFill,
  selectedPolygonFillOpacity: 0.28,
  selectedPolygonOutlineColor: COLOR.selectedOutline,
  selectedPolygonOutlineWidth: 3.5,
  selectionPointColor: COLOR.selectedOutline,
  selectionPointOutlineColor: "#FFFFFF" as `#${string}`,
  midPointColor: "#475569" as `#${string}`,
  midPointOutlineColor: "#FFFFFF" as `#${string}`,
};

export default function MapCanvas({ children }: { children?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<MaplibreTerradrawControl | null>(null);
  // Suppresses terra-draw's `change` echo when we mutate features programmatically
  // (kind toggle, selection flag, removal).
  const isApplyingRemote = useRef(false);
  // Captured during `map.on('load')` so cleanup can call td.off(…) with the
  // exact same references — otherwise stale closures leak under StrictMode/HMR.
  const tdHandlersRef = useRef<{
    syncFromTerra?: () => void;
    onFinish?: (id: string | number) => void;
    onSelect?: (id: string | number) => void;
    onDeselect?: () => void;
    onMapClick?: (e: maplibregl.MapMouseEvent) => void;
    onMapMouseMove?: (e: maplibregl.MapMouseEvent) => void;
  }>({});
  // Threaded between syncFromTerra (where we detect a brand-new feature) and
  // onFinish (where we validate then open the editor) so we only open the
  // form for a polygon that passed validation.
  const pendingEditorIdRef = useRef<string | null>(null);
  // Gated on the map's `load` event — only then is it safe for overlay children
  // to call `map.addSource` / `map.addLayer`. Until then we publish `null`.
  const [readyMap, setReadyMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL as unknown as StyleSpecification | string,
      center: HK_CENTER,
      zoom: 10.2,
      pitch: 28,
      bearing: -8,
      attributionControl: { compact: true },
      maxBounds: [
        [113.5, 21.9],
        [114.7, 22.8],
      ],
    });
    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    const draw = new MaplibreTerradrawControl({
      modes: [
        "render",
        "polygon",
        "rectangle",
        "circle",
        "select",
        "delete-selection",
        "delete",
        "undo",
        "redo",
        "download",
      ],
      open: true,
      modeOptions: {
        polygon: new TerraDrawPolygonMode({ styles: polygonStyles }),
        rectangle: new TerraDrawRectangleMode({ styles: polygonStyles }),
        circle: new TerraDrawCircleMode({ styles: polygonStyles }),
        select: new TerraDrawSelectMode({
          styles: selectionStyles,
          flags: {
            polygon: {
              feature: {
                draggable: true,
                coordinates: { midpoints: true, draggable: true, deletable: true },
              },
            },
            rectangle: {
              feature: {
                draggable: true,
                coordinates: { midpoints: true, draggable: true, deletable: true },
              },
            },
            circle: {
              feature: {
                draggable: true,
                coordinates: { midpoints: true, draggable: true, deletable: true },
              },
            },
          },
        }),
      },
      adapterOptions: { coordinatePrecision: 6 },
    });
    drawRef.current = draw;
    map.addControl(draw, "top-left");
    // Publish to the module-level ref so the left sidebar can call
    // td.setMode() without needing context propagation.
    setTerraDrawRef(draw);

    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __map?: maplibregl.Map }).__map = map;
      (window as unknown as { __draw?: MaplibreTerradrawControl }).__draw = draw;
    }

    map.on("load", () => {
      // Publish the map to MapContext now that the style is loaded — overlay
      // children mounted under <MapContext.Provider> can safely add sources.
      setReadyMap(map);

      const td = draw.getTerraDrawInstance();
      if (!td) return;

      const syncFromTerra = () => {
        if (isApplyingRemote.current) return;
        const snapshot = td.getSnapshot() ?? [];
        const { zones, zoneOrder } = useApp.getState();
        const out: ZoneFeature[] = [];
        // For each terra-draw feature, either reuse the existing zone metadata
        // OR assign a fresh number derived from the current store. Deriving
        // from the store (instead of a monotonic counter) means discarded
        // numbers get reclaimed — draw → discard → draw produces the same
        // label rather than incrementing forever.
        const existingNumbers: number[] = [];
        for (const z of Object.values(zones)) {
          const m = z.properties.name.match(/^Zone (\d+)$/);
          if (m) existingNumbers.push(parseInt(m[1], 10));
        }
        let nextNum =
          existingNumbers.length === 0 ? 1 : Math.max(...existingNumbers) + 1;
        const seeded: { id: string; kind: ZoneKind }[] = [];
        for (const f of snapshot) {
          if (f.geometry.type !== "Polygon") continue;
          const id = String(f.id ?? "");
          if (!id) continue;
          const existing = zones[id];
          if (existing) {
            out.push({
              type: "Feature",
              id,
              geometry: f.geometry as Polygon,
              properties: existing.properties,
            });
            seeded.push({ id, kind: existing.properties.kind });
          } else {
            const n = nextNum++;
            const props = {
              id,
              name: `Zone ${String(n).padStart(2, "0")}`,
              kind: "temporary" as ZoneKind,
              category: "custom" as const,
              createdAt: new Date().toISOString(),
            };
            out.push({
              type: "Feature",
              id,
              geometry: f.geometry as Polygon,
              properties: props,
            });
            seeded.push({ id, kind: props.kind });
          }
        }

        // Track which IDs are brand-new this tick — before we overwrite the
        // store snapshot. Used below to open the editor for the latest draw.
        const newlyCreated = seeded
          .map((s) => s.id)
          .filter((id) => !zones[id]);

        // NOTE: self-intersection validation runs on the `finish` event, NOT
        // here. During an active polygon draw the `change` event fires for
        // every added vertex, and the in-progress shape can transiently
        // self-intersect — removing it mid-draw corrupts terra-draw's
        // internal queue ("No feature with this <id>, can not update
        // geometry"). The validation lives in onFinish below.
        useApp.getState().setZones(out, zoneOrder);

        // Mirror app-level properties back into terra-draw so the style fn picks them up.
        isApplyingRemote.current = true;
        const currentSelected = useApp.getState().selectedZoneId;
        const currentDisabled = useApp.getState().disabledZoneIds;
        for (const { id, kind } of seeded) {
          try {
            td.updateFeatureProperties(id, {
              kind,
              // Honour the current isolation filter for newly-arrived
              // features too — otherwise drawing while a zone is selected
              // leaks the new shape onto the map alongside the selected one.
              hiddenByFilter:
                currentSelected !== null && id !== currentSelected,
              // Disabled flag mirrors the store so a zone toggled off in the
              // Saved list stays hidden across re-syncs.
              disabled: !!currentDisabled[id],
            });
          } catch {
            /* feature may have been removed mid-sync */
          }
        }
        isApplyingRemote.current = false;

        // Track which fresh draws to open the editor for. The actual editor
        // dispatch happens in onFinish (post-validation) so we don't open a
        // form for a polygon that's about to be rejected.
        if (newlyCreated.length > 0) {
          pendingEditorIdRef.current =
            newlyCreated[newlyCreated.length - 1];
        }
      };

      // Validation + editor handoff fire on FINISH only. The handler receives
      // the finished feature id from terra-draw; we re-read the snapshot and
      // run kinks() against the now-closed polygon.
      const onFinish = (id: string | number) => {
        // Make sure the store has the just-finished polygon's geometry.
        syncFromTerra();
        const sid = String(id);
        const snapshot = td.getSnapshot() ?? [];
        const finishedFeat = snapshot.find((f) => String(f.id) === sid);
        if (
          !finishedFeat ||
          finishedFeat.geometry.type !== "Polygon"
        ) {
          // Not a polygon (rectangle/circle never self-intersect) — just open
          // the editor if this matches our pending fresh-draw.
          if (pendingEditorIdRef.current === sid) {
            const target = sid;
            pendingEditorIdRef.current = null;
            queueMicrotask(() =>
              useApp.getState().openZoneEditor(target, "create"),
            );
          }
          return;
        }
        let invalid = false;
        try {
          const k = kinks({
            type: "Feature",
            geometry: finishedFeat.geometry,
            properties: {},
          }).features;
          invalid = k.length > 0;
        } catch {
          invalid = true;
        }

        if (invalid) {
          // Auto-fix: split via unkinkPolygon and keep the largest simple
          // polygon. The operator never has to redraw — they get a toast
          // explaining what happened, but the zone stays.
          const fixedGeometry = pickLargestSimplePolygon(
            finishedFeat.geometry as Polygon,
          );

          queueMicrotask(() => {
            isApplyingRemote.current = true;
            if (fixedGeometry) {
              // Swap geometry in place — same id, same properties — so the
              // editor below still points at the right zone.
              let updateOk = false;
              try {
                (
                  td as unknown as {
                    updateFeatureGeometry?: (
                      id: string | number,
                      geometry: Polygon,
                    ) => void;
                  }
                ).updateFeatureGeometry?.(sid, fixedGeometry);
                updateOk = true;
              } catch {
                updateOk = false;
              }
              if (updateOk) {
                // Mirror into the store so detail readers see the fixed shape.
                const store = useApp.getState();
                const current = store.zones[sid];
                if (current) {
                  store.setZones(
                    Object.values(store.zones).map((z) =>
                      z.properties.id === sid
                        ? ({ ...z, geometry: fixedGeometry } as typeof z)
                        : z,
                    ),
                  );
                }
                store.pushToast({
                  level: "info",
                  message:
                    "Polygon was self-overlapping — auto-corrected to the largest piece.",
                });
              } else {
                // updateFeatureGeometry isn't exposed on this terra-draw
                // build — drop the zone and tell the operator.
                try {
                  td.removeFeatures([sid]);
                } catch {
                  /* already gone */
                }
                useApp.getState().removeZone(sid);
                if (useApp.getState().editorZoneId === sid) {
                  useApp.getState().closeZoneEditor();
                }
                useApp.getState().pushToast({
                  level: "error",
                  message:
                    "Polygon was invalid and couldn't be auto-corrected.",
                });
              }
            } else {
              // Unkink couldn't recover anything sensible.
              try {
                td.removeFeatures([sid]);
              } catch {
                /* already gone */
              }
              useApp.getState().removeZone(sid);
              if (useApp.getState().editorZoneId === sid) {
                useApp.getState().closeZoneEditor();
              }
              useApp.getState().pushToast({
                level: "error",
                message:
                  "Polygon was invalid and couldn't be auto-corrected.",
              });
            }
            isApplyingRemote.current = false;
          });

          // Editor still opens below on `sid` — by the time the editor
          // microtask runs, the geometry has been corrected (or the zone
          // removed, in which case the editor panel renders nothing because
          // the zone lookup is null).
        }

        // Inter-zone overlap → union. If the just-finished polygon intersects
        // any existing zone, merge them all into a single polygon. The merged
        // shape lives on `sid`; the others are removed. This is what makes
        // "draw a triangle overlapping a rectangle → single combined polygon"
        // work without the operator having to manage union manually.
        const mergedHere = maybeUnionWithOverlaps(td, sid, finishedFeat.geometry as Polygon);
        if (mergedHere.unionedCount > 0) {
          useApp.getState().pushToast({
            level: "info",
            message:
              mergedHere.unionedCount === 1
                ? "Merged with 1 overlapping zone."
                : `Merged with ${mergedHere.unionedCount} overlapping zones.`,
          });
        }

        // Valid polygon — open the Save Event editor on the left.
        if (pendingEditorIdRef.current === sid) {
          const target = sid;
          pendingEditorIdRef.current = null;
          queueMicrotask(() =>
            useApp.getState().openZoneEditor(target, "create"),
          );
        }
      };

      const onSelect = (id: string | number) =>
        useApp.getState().selectZone(String(id));
      const onDeselect = () => useApp.getState().selectZone(null);

      td.on("change", syncFromTerra);
      td.on("finish", onFinish);
      td.on("deselect", onDeselect);
      td.on("select", onSelect);

      // Click-to-select on drawn zones. Earlier this used queryRenderedFeatures,
      // but matching the rendered tile back to a zone id was unreliable — terra
      // -draw render layers don't always expose the original feature id at the
      // tile level, so the operator saw the pointer cursor (mousemove found a
      // match by some other means) but the click silently fell through.
      //
      // Direct point-in-polygon against the zone geometries in the store is
      // O(n) per click but n is small (zones the operator drew), and the
      // result is render-stack independent.
      const onMapClick = (e: maplibregl.MapMouseEvent) => {
        if (useApp.getState().drawMode !== "idle") return;

        // Layer-specific hits we explicitly want to NOT steal — cameras and
        // alerts both have their own click handlers that should win.
        const layerHits = map.queryRenderedFeatures(e.point, {
          layers: ["cameras-circle", "alerts-dot"].filter((id) =>
            map.getLayer(id),
          ),
        });
        if (layerHits.length > 0) {
          // Camera or alert layer was clicked — leave zone selection alone.
          return;
        }

        const clickPoint = point([e.lngLat.lng, e.lngLat.lat]);
        const { zones, staticZones } = useApp.getState();
        // Drawn zones first — operator-drawn polygons should always win over
        // static airspace when both cover the click point (operator edits
        // their own polygons; static catalogue is read-only).
        for (const z of Object.values(zones)) {
          if (
            z.geometry.type !== "Polygon" &&
            z.geometry.type !== "MultiPolygon"
          ) {
            continue;
          }
          try {
            if (
              booleanPointInPolygon(clickPoint, {
                type: "Feature",
                geometry: z.geometry,
                properties: {},
              })
            ) {
              useApp.getState().selectZone(z.properties.id);
              return;
            }
          } catch {
            /* malformed geometry — skip */
          }
        }
        // Static (HK permanent) zones — same point-in-polygon strategy as the
        // drawn ones. Replaces hk-no-fly-layer's queryRenderedFeatures click,
        // which became flaky after we switched to property-driven disabling
        // (source.setData reissues kill the render-tile feature cache mid-
        // flight, so a click landing during the reissue would silently miss).
        for (const s of Object.values(staticZones)) {
          try {
            if (
              booleanPointInPolygon(clickPoint, {
                type: "Feature",
                geometry: s.geometry,
                properties: {},
              })
            ) {
              useApp.getState().selectStaticZone(s.id);
              return;
            }
          } catch {
            /* malformed — skip */
          }
        }

        // Clicked empty map (no zone, no camera, no alert) — clear both
        // selections so the detail panel closes.
        const st = useApp.getState();
        if (st.selectedZoneId !== null) st.selectZone(null);
        if (st.selectedStaticZoneId !== null) st.selectStaticZone(null);
      };

      // Layer ids of every interactive marker — the central mousemove flips
      // to pointer when any of them sit under the cursor. Owning cursor
      // logic in one place avoids the per-layer handlers fighting each
      // other (and avoids MapLibre's default `grab` showing through).
      const INTERACTIVE_LAYER_IDS = new Set([
        "cameras-circle",
        "alerts-dot",
      ]);

      const onMapMouseMove = (e: maplibregl.MapMouseEvent) => {
        const canvas = map.getCanvas();
        if (useApp.getState().drawMode !== "idle") {
          // DrawPanel owns the crosshair via body.is-drawing — don't fight it.
          return;
        }
        // Hover detection mirrors click detection: point-in-polygon against
        // the zone geometries (reliable across render-stack quirks) plus a
        // layer-specific query for cameras / alerts.
        const layerHits = map.queryRenderedFeatures(e.point, {
          layers: Array.from(INTERACTIVE_LAYER_IDS).filter((id) =>
            map.getLayer(id),
          ),
        });
        let pointer = layerHits.length > 0;
        if (!pointer) {
          const hoverPoint = point([e.lngLat.lng, e.lngLat.lat]);
          const { zones, staticZones } = useApp.getState();
          for (const z of Object.values(zones)) {
            if (
              z.geometry.type !== "Polygon" &&
              z.geometry.type !== "MultiPolygon"
            ) {
              continue;
            }
            try {
              if (
                booleanPointInPolygon(hoverPoint, {
                  type: "Feature",
                  geometry: z.geometry,
                  properties: {},
                })
              ) {
                pointer = true;
                break;
              }
            } catch {
              /* skip */
            }
          }
          if (!pointer) {
            for (const s of Object.values(staticZones)) {
              try {
                if (
                  booleanPointInPolygon(hoverPoint, {
                    type: "Feature",
                    geometry: s.geometry,
                    properties: {},
                  })
                ) {
                  pointer = true;
                  break;
                }
              } catch {
                /* skip */
              }
            }
          }
        }
        canvas.style.cursor = pointer ? "pointer" : "default";
      };

      map.on("click", onMapClick);
      map.on("mousemove", onMapMouseMove);

      tdHandlersRef.current = {
        syncFromTerra,
        onFinish,
        onSelect,
        onDeselect,
        onMapClick,
        onMapMouseMove,
      };

      // initial sync in case anything was pre-loaded
      syncFromTerra();
    });

    return () => {
      // Detach terra-draw listeners BEFORE tearing down the map — under
      // StrictMode/HMR the same module instance gets a second mount, and any
      // listener left attached holds a closure over the previous map.
      const td = drawRef.current?.getTerraDrawInstance();
      const {
        syncFromTerra,
        onFinish,
        onSelect,
        onDeselect,
        onMapClick,
        onMapMouseMove,
      } = tdHandlersRef.current;
      if (td) {
        try {
          if (syncFromTerra) td.off("change", syncFromTerra);
          if (onFinish) td.off("finish", onFinish);
          if (onSelect) td.off("select", onSelect);
          if (onDeselect) td.off("deselect", onDeselect);
        } catch {
          /* terra-draw may already be torn down */
        }
      }
      try {
        if (onMapClick) map.off("click", onMapClick);
        if (onMapMouseMove) map.off("mousemove", onMapMouseMove);
      } catch {
        /* map already torn down */
      }
      tdHandlersRef.current = {};
      if (drawRef.current) {
        try {
          map.removeControl(drawRef.current);
        } catch {
          /* control may already be detached */
        }
      }
      drawRef.current = null;
      setTerraDrawRef(null);
      setReadyMap(null);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Programmatic removal from side panel → tell TerraDraw to drop the feature.
  // Guarded by isApplyingRemote so the echo `change` doesn't re-fire setZones.
  useEffect(() => {
    let lastIds = new Set(Object.keys(useApp.getState().zones));
    const unsub = useApp.subscribe(
      (s) => s.zones,
      (zones) => {
        const td = drawRef.current?.getTerraDrawInstance();
        if (!td) {
          lastIds = new Set(Object.keys(zones));
          return;
        }
        const nowIds = new Set(Object.keys(zones));
        const toRemove: string[] = [];
        for (const id of lastIds) {
          if (!nowIds.has(id)) toRemove.push(id);
        }
        if (toRemove.length > 0) {
          isApplyingRemote.current = true;
          try {
            td.removeFeatures(toRemove);
          } catch {
            /* terra-draw throws if id is unknown — ignore */
          }
          isApplyingRemote.current = false;
        }
        lastIds = nowIds;
      },
    );
    return unsub;
  }, []);

  // Selection change → mark `selected` on the picked feature, `hiddenByFilter`
  // on every other feature, and flyTo the picked zone's centroid. Clearing
  // selection wipes both flags so every zone returns.
  useEffect(() => {
    const apply = (selectedId: string | null) => {
      const td = drawRef.current?.getTerraDrawInstance();
      const map = mapRef.current;
      if (!td || !map) return;

      isApplyingRemote.current = true;
      const allIds = Object.keys(useApp.getState().zones);
      for (const id of allIds) {
        const isSel = id === selectedId;
        try {
          td.updateFeatureProperties(id, {
            selected: isSel,
            hiddenByFilter: selectedId !== null && !isSel,
          });
        } catch {
          /* feature gone — fine */
        }
      }
      isApplyingRemote.current = false;

      if (selectedId) {
        const zone = useApp.getState().zones[selectedId];
        if (
          zone?.geometry &&
          (zone.geometry.type === "Polygon" ||
            zone.geometry.type === "MultiPolygon")
        ) {
          try {
            const feature: Feature<Polygon | MultiPolygon> = {
              type: "Feature",
              geometry: zone.geometry,
              properties: {},
            };
            const [lng, lat] = centroid(feature).geometry.coordinates;
            map.flyTo({
              center: [lng, lat],
              zoom: Math.max(map.getZoom(), 12.5),
              speed: 0.9,
            });
          } catch {
            /* malformed geometry, skip */
          }
        }
      }
    };

    // Sync once on mount in case a selection already exists (HMR).
    apply(useApp.getState().selectedZoneId);
    return useApp.subscribe((s) => s.selectedZoneId, apply);
  }, []);

  // Clear map selection when the user clicks an empty bit of map. Terra-draw
  // handles this in select mode; outside select mode the operator's escape
  // hatch is clicking a row again in the sidebar, OR pressing Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)
      ) {
        return;
      }
      if (useApp.getState().selectedZoneId) {
        useApp.getState().selectZone(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Disabled toggle from the Saved list → mirror onto terra-draw so its style
  // fn repaints (fillOpacity goes to 0 for the affected zone).
  useEffect(() => {
    let prev: Record<string, true> = useApp.getState().disabledZoneIds;
    const unsub = useApp.subscribe(
      (s) => s.disabledZoneIds,
      (next) => {
        const td = drawRef.current?.getTerraDrawInstance();
        if (!td) return;
        const allIds = new Set([
          ...Object.keys(prev),
          ...Object.keys(next),
        ]);
        isApplyingRemote.current = true;
        for (const id of allIds) {
          const wasDisabled = !!prev[id];
          const isNowDisabled = !!next[id];
          if (wasDisabled === isNowDisabled) continue;
          try {
            td.updateFeatureProperties(id, { disabled: isNowDisabled });
          } catch {
            /* feature may not be in terra-draw (e.g. it's a static HK
               zone) — fine, hk-no-fly-layer handles those separately. */
          }
        }
        isApplyingRemote.current = false;
        prev = next;
      },
    );
    return unsub;
  }, []);

  // Impact mirror — when zoneImpact updates, flip `impacted` on every drawn
  // feature so polygonStyles repaints fill/outline in the brighter hue.
  // We deliberately do NOT run a per-frame pulse on terra-draw features:
  // updateFeatureProperties fires terra-draw's `change` event back through
  // syncFromTerra → setZones, and at 60Hz that churns the whole subscription
  // chain (drones, alerts, trail recompute) hard enough to feel like the
  // map is "reloading". The brighter outline + thicker stroke from
  // polygonStyles is signal enough; the radial ping carries the "something
  // just happened" cue. Static zones keep their pulse because that's a
  // direct layer paint (setPaintProperty), not a feature property write.
  useEffect(() => {
    let lastImpacted = new Set<string>();
    const apply = () => {
      const td = drawRef.current?.getTerraDrawInstance();
      if (!td) return;
      const state = useApp.getState();
      const now = Date.now();
      const drawnIds = Object.keys(state.zones);
      // Effective impact = impacted AND not currently muted by the operator.
      const nowImpacted = new Set(
        drawnIds.filter((id) => {
          if (!state.zoneImpact[id]) return false;
          const until = state.mutedZoneUntil[id];
          return !(typeof until === "number" && until > now);
        }),
      );
      const all = new Set([...lastImpacted, ...nowImpacted]);
      let changed = false;
      isApplyingRemote.current = true;
      for (const id of all) {
        const next = nowImpacted.has(id);
        const prev = lastImpacted.has(id);
        if (next === prev) continue;
        try {
          td.updateFeatureProperties(id, { impacted: next });
          changed = true;
        } catch {
          /* feature gone */
        }
      }
      isApplyingRemote.current = false;
      if (changed) lastImpacted = nowImpacted;
    };
    apply();
    const unsubImpact = useApp.subscribe((s) => s.zoneImpact, apply);
    const unsubMute = useApp.subscribe((s) => s.mutedZoneUntil, apply);
    return () => {
      unsubImpact();
      unsubMute();
    };
  }, []);

  // Kind toggle from the panel → mirror onto terra-draw so its style fn repaints.
  useEffect(() => {
    let snapshot: Record<string, ZoneKind> = {};
    for (const [id, z] of Object.entries(useApp.getState().zones)) {
      snapshot[id] = z.properties.kind;
    }
    const unsub = useApp.subscribe(
      (s) => s.zones,
      (zones) => {
        const td = drawRef.current?.getTerraDrawInstance();
        if (!td) return;
        const changed: { id: string; kind: ZoneKind }[] = [];
        const next: Record<string, ZoneKind> = {};
        for (const [id, z] of Object.entries(zones)) {
          next[id] = z.properties.kind;
          if (snapshot[id] !== undefined && snapshot[id] !== z.properties.kind) {
            changed.push({ id, kind: z.properties.kind });
          }
        }
        snapshot = next;
        if (changed.length === 0) return;
        isApplyingRemote.current = true;
        for (const { id, kind } of changed) {
          try {
            td.updateFeatureProperties(id, { kind });
          } catch {
            /* gone */
          }
        }
        isApplyingRemote.current = false;
      },
    );
    return unsub;
  }, []);

  return (
    <div
      className="absolute inset-0 bg-ops-950"
      aria-label="Hong Kong drone airspace map"
    >
      <div ref={containerRef} className="h-full w-full" />
      {/* Overlay children mount only after the style has loaded — so they can
          safely call addSource/addLayer via useMapInstance(). */}
      <MapContext.Provider value={readyMap}>
        <TerraDrawContext.Provider value={readyMap ? drawRef.current : null}>
          {readyMap ? children : null}
        </TerraDrawContext.Provider>
      </MapContext.Provider>
    </div>
  );
}
