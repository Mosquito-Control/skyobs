"use client";

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { LayerSpecification } from "maplibre-gl";
import { useMapInstance } from "@/lib/map-context";
import { useApp, type StaticZone } from "@/lib/store";
import type { Polygon, MultiPolygon } from "geojson";

/**
 * Renders the static HK permanent no-fly polygons as a non-editable map layer
 * sitting BELOW terra-draw's editable feature layers. Every category renders
 * in the same red so the operator gets a single, unambiguous "no fly" signal
 * regardless of why the polygon exists (airport / park / military).
 *
 * On click, the feature is published to the zustand store as the selected
 * static zone — the right detail panel reads from there.
 */

const SOURCE_ID = "hk-no-fly";
const FILL_LAYER_ID = "hk-no-fly-fill";
const FILL_HOVER_LAYER_ID = "hk-no-fly-fill-hover";
const OUTLINE_LAYER_ID = "hk-no-fly-outline";
const PULSE_LAYER_ID = "hk-no-fly-pulse";

const DATA_URL = "/data/hk-permanent-zones.geojson";

// Uniform red palette — operator-facing signal is "don't fly here", regardless
// of why (airport / park / military). Category differentiation lives in the
// sidebar swatches; the map stays one signal.
const RED_FILL = "#DC2626";
const RED_OUTLINE = "#991B1B";
// Brighter red used when the zone is currently being breached. Keeps the same
// hue family so a calm-vs-hot scan reads as intensity, not as a different
// category. `IMPACTED_OUTLINE` is the bright red ring; the separate PULSE
// layer overlays on top with a wider radius and animated opacity.
const IMPACTED_FILL = "#F87171";
const IMPACTED_OUTLINE = "#FCA5A5";
// Dormant no-fly polygons are intentionally faint — just enough tint to say
// "restricted" without competing with the impacted highlight. The "something
// is happening here" signal only fires when a drone is actually inside,
// where the fill jumps 5–6× to FILL_OPACITY_IMPACTED.
const FILL_OPACITY_DEFAULT = 0.07;
const FILL_OPACITY_HOVER = 0.18;
const FILL_OPACITY_IMPACTED = 0.42;
const SELECTED_OUTLINE = "#0F172A";

/** Resolve where to insert our layers so terra-draw's overlays stay on top. */
function findTerraDrawBeforeId(map: maplibregl.Map): string | undefined {
  const style = map.getStyle();
  const layers = style?.layers as LayerSpecification[] | undefined;
  if (!layers) return undefined;
  for (const layer of layers) {
    if (
      typeof layer.id === "string" &&
      (layer.id.startsWith("td-") || layer.id.startsWith("gl-draw-"))
    ) {
      return layer.id;
    }
  }
  return undefined;
}

export default function HkNoFlyLayer() {
  const map = useMapInstance();

  useEffect(() => {
    if (!map) return;
    const ac = new AbortController();
    let hoveredId: string | number | null = null;

    (async () => {
      let data: GeoJSON.FeatureCollection;
      try {
        const res = await fetch(DATA_URL, {
          // no-store, NOT force-cache: this geojson gets rewritten by the
          // merge script during dev, and force-cache pins the tab to the
          // pre-merge version even on hard reload until the SW is purged.
          cache: "no-store",
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        if (!res.ok) {
          console.warn(`[hk-no-fly] fetch ${DATA_URL} → ${res.status}`);
          return;
        }
        data = (await res.json()) as GeoJSON.FeatureCollection;
      } catch (err) {
        if (ac.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("[hk-no-fly] fetch failed", err);
        return;
      }
      if (ac.signal.aborted) return;

      // Ensure every feature has a stable id — needed for feature-state hover
      // and for store lookups when a click fires. Stamp `disabled` and
      // `impacted` up front so paint expressions reading `["get","…"]` always
      // have a value (terra-draw uses the same property-on-feature approach
      // for operator-drawn zones — we mirror it here so the two render paths
      // stay structurally identical).
      const seedDisabled = useApp.getState().disabledZoneIds;
      const seedImpact = useApp.getState().zoneImpact;
      const features = (data.features ?? []).map((f, idx) => {
        const id =
          (typeof f.id === "string" || typeof f.id === "number")
            ? String(f.id)
            : `hk-${idx}`;
        const props = {
          ...(f.properties ?? {}),
          disabled: !!seedDisabled[id],
          impacted: !!seedImpact[id],
        };
        return { ...f, id, properties: props };
      });
      console.log("[hk-no-fly] features loaded:", features.length, {
        firstIds: features.slice(0, 3).map((f) => f.id),
        sampleGeom: features[0]?.geometry?.type,
      });

      // Publish to the store so the right detail panel can resolve a static
      // zone by id without reading the map back.
      const summary: StaticZone[] = [];
      for (const f of features) {
        if (
          f.geometry?.type !== "Polygon" &&
          f.geometry?.type !== "MultiPolygon"
        ) {
          continue;
        }
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const name =
          (typeof props.name === "string" && props.name) ||
          (typeof props.label === "string" && props.label) ||
          `Zone ${String(f.id)}`;
        const category =
          typeof props.category === "string" ? props.category : "other";
        summary.push({
          id: String(f.id),
          name,
          category,
          geometry: f.geometry as Polygon | MultiPolygon,
        });
      }
      useApp.getState().setStaticZones(summary);

      if (map.getSource(SOURCE_ID)) {
        console.log("[hk-no-fly] source already exists — skipping addSource");
        return;
      }

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { ...data, features } as GeoJSON.FeatureCollection,
      });
      if (ac.signal.aborted) return;

      const beforeId = findTerraDrawBeforeId(map);
      console.log("[hk-no-fly] source added; beforeId =", beforeId);

      map.addLayer(
        {
          id: FILL_LAYER_ID,
          type: "fill",
          source: SOURCE_ID,
          paint: {
            // Impacted zones swap to the brighter red so they stand out from
            // dormant ones even before the operator looks at the outline.
            "fill-color": [
              "case",
              ["boolean", ["get", "impacted"], false],
              IMPACTED_FILL,
              RED_FILL,
            ],
            // Disabled ALWAYS wins — hiding is the whole point of disabling.
            "fill-opacity": [
              "case",
              ["boolean", ["get", "disabled"], false],
              0,
              ["boolean", ["get", "impacted"], false],
              FILL_OPACITY_IMPACTED,
              FILL_OPACITY_DEFAULT,
            ],
          },
        },
        beforeId,
      );
      if (ac.signal.aborted) return;

      // Hover/selected fill — driven by feature-state. Sits on top of the
      // base fill so the brighter alpha takes over without re-painting it.
      map.addLayer(
        {
          id: FILL_HOVER_LAYER_ID,
          type: "fill",
          source: SOURCE_ID,
          paint: {
            "fill-color": RED_FILL,
            // Disabled wins over hover/selected too — otherwise a disabled
            // zone reappears the moment the cursor passes over it.
            "fill-opacity": [
              "case",
              ["boolean", ["get", "disabled"], false],
              0,
              ["boolean", ["feature-state", "selected"], false],
              FILL_OPACITY_HOVER,
              ["boolean", ["feature-state", "hover"], false],
              FILL_OPACITY_HOVER - 0.08,
              0,
            ],
          },
        },
        beforeId,
      );

      map.addLayer(
        {
          id: OUTLINE_LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              SELECTED_OUTLINE,
              ["boolean", ["get", "impacted"], false],
              IMPACTED_OUTLINE,
              RED_OUTLINE,
            ],
            "line-width": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              3,
              ["boolean", ["get", "impacted"], false],
              3,
              ["boolean", ["feature-state", "hover"], false],
              2,
              1.5,
            ],
            "line-opacity": [
              "case",
              ["boolean", ["get", "disabled"], false],
              0,
              0.85,
            ],
          },
        },
        beforeId,
      );

      // Pulse layer — a wider, brighter ring on top of the base outline that
      // only shows for impacted zones. line-opacity is driven from JS via
      // setPaintProperty in a requestAnimationFrame loop so the pulse stays
      // visually live even when nothing else changes. Pinned BELOW any
      // terra-draw overlays so the operator-drawn zones still win z-order.
      map.addLayer(
        {
          id: PULSE_LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": IMPACTED_OUTLINE,
            "line-width": 7,
            "line-blur": 4,
            "line-opacity": [
              "case",
              ["boolean", ["get", "disabled"], false],
              0,
              ["boolean", ["get", "impacted"], false],
              // The actual alpha is driven from JS; this initial value is a
              // safe baseline before the rAF loop kicks in on first impact.
              0.55,
              0,
            ],
          },
        },
        beforeId,
      );

      const onMouseMove = (e: maplibregl.MapMouseEvent) => {
        const feats = map.queryRenderedFeatures(e.point, {
          layers: [FILL_LAYER_ID],
        });
        const id = feats[0]?.id ?? null;
        if (id === hoveredId) return;
        if (hoveredId !== null) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoveredId },
            { hover: false },
          );
        }
        hoveredId = id as string | number | null;
        if (hoveredId !== null) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoveredId },
            { hover: true },
          );
        }
        map.getCanvas().style.cursor = hoveredId !== null ? "pointer" : "";
      };

      const onMouseLeave = () => {
        if (hoveredId !== null) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoveredId },
            { hover: false },
          );
          hoveredId = null;
        }
        map.getCanvas().style.cursor = "";
      };

      // NOTE: click handling intentionally lives in map-canvas.tsx's central
      // onMapClick — it does point-in-polygon against `staticZones` from the
      // store (same approach as the drawn zones). queryRenderedFeatures here
      // was racy when source.setData refreshed the tile cache mid-click.

      map.on("mousemove", FILL_LAYER_ID, onMouseMove);
      map.on("mouseleave", FILL_LAYER_ID, onMouseLeave);

      // Subscribe to selection changes so the layer paints the selected ring.
      let lastSelected: string | null = useApp.getState().selectedStaticZoneId;
      const unsub = useApp.subscribe(
        (s) => s.selectedStaticZoneId,
        (id) => {
          if (lastSelected && lastSelected !== id) {
            map.setFeatureState(
              { source: SOURCE_ID, id: lastSelected },
              { selected: false },
            );
          }
          if (id) {
            map.setFeatureState(
              { source: SOURCE_ID, id },
              { selected: true },
            );
          }
          lastSelected = id;
        },
      );

      // Disable wiring — same shape as the operator-drawn (custom) zones:
      // stamp `properties.disabled` on the feature, then re-push the whole
      // FeatureCollection via source.setData. Paint expressions read it via
      // ["get","disabled"] so a single source of truth (the feature itself)
      // drives every layer. feature-state was abandoned because (a) it doesn't
      // mirror the custom path and (b) the hover/selected layer could repaint
      // a "disabled" zone on hover unless every expression remembered to
      // re-check it.
      const applyDisabled = (disabledMap: Record<string, true>) => {
        const src = map.getSource(SOURCE_ID) as
          | (maplibregl.GeoJSONSource & {
              setData: (d: GeoJSON.FeatureCollection) => void;
            })
          | undefined;
        if (!src) return;
        let changed = false;
        for (const f of features) {
          const next = !!disabledMap[String(f.id)];
          const props = (f.properties ?? {}) as Record<string, unknown> & {
            disabled: boolean;
            impacted: boolean;
          };
          if (props.disabled !== next) {
            props.disabled = next;
            f.properties = props;
            changed = true;
          }
        }
        if (!changed) return;
        src.setData({
          type: "FeatureCollection",
          features,
        } as GeoJSON.FeatureCollection);
      };
      // Seed initial state in case the store already has disabled IDs from
      // some prior session (zustand isn't persisted today but this stays
      // correct if it ever is).
      applyDisabled(useApp.getState().disabledZoneIds);
      const unsubDisabled = useApp.subscribe(
        (s) => s.disabledZoneIds,
        (next) => {
          console.log("[hk-no-fly] disabled set:", Object.keys(next));
          applyDisabled(next);
        },
      );

      // Impacted mirror — same property+setData pattern as `disabled`, so the
      // paint expressions reading ["get","impacted"] flip in lockstep with
      // the zoneImpact store. An ack'd zone is treated as not-impacted here
      // (mute set by the operator → polygon stops pulsing immediately) even
      // if drones are still inside, so visual quiet wins until the mute
      // expires. The engine keeps tracking the real impact, the panel hides
      // muted rows, and the map dims them — restored automatically when
      // use-alert-ttl evicts the expired entry.
      const computeEffectiveImpact = () => {
        const state = useApp.getState();
        const now = Date.now();
        const out: Record<string, true> = {};
        for (const id of Object.keys(state.zoneImpact)) {
          const muteUntil = state.mutedZoneUntil[id];
          if (typeof muteUntil === "number" && muteUntil > now) continue;
          out[id] = true;
        }
        return out;
      };
      const applyImpacted = () => {
        const src = map.getSource(SOURCE_ID) as
          | (maplibregl.GeoJSONSource & {
              setData: (d: GeoJSON.FeatureCollection) => void;
            })
          | undefined;
        if (!src) return;
        const impactMap = computeEffectiveImpact();
        let changed = false;
        for (const f of features) {
          const next = !!impactMap[String(f.id)];
          const props = (f.properties ?? {}) as Record<string, unknown> & {
            disabled: boolean;
            impacted: boolean;
          };
          if (props.impacted !== next) {
            props.impacted = next;
            f.properties = props;
            changed = true;
          }
        }
        if (!changed) return;
        src.setData({
          type: "FeatureCollection",
          features,
        } as GeoJSON.FeatureCollection);
      };
      applyImpacted();
      const unsubImpacted = useApp.subscribe(
        (s) => s.zoneImpact,
        applyImpacted,
      );
      const unsubMutes = useApp.subscribe(
        (s) => s.mutedZoneUntil,
        applyImpacted,
      );

      // Pulse animation — drives the wider PULSE layer's opacity in a sine
      // wave so impacted zones visibly throb. One rAF loop for all features
      // (cheap: a single setPaintProperty call per frame), decays to ~0
      // within PULSE_DECAY_MS of the last entry event so the pulse fades
      // even if the zone stays "hot" by drone count alone.
      const PULSE_PERIOD_MS = 1200;
      const PULSE_DECAY_MS = 6000;
      let rafId: number | null = null;
      const animatePulse = () => {
        const impactState = useApp.getState().zoneImpact;
        const ids = Object.keys(impactState);
        // Take the freshest lastEventT across all impacted zones — the layer
        // pulse stays bright as long as something's still entering somewhere.
        let freshest = 0;
        for (const id of ids) {
          const cur = impactState[id];
          if (cur && cur.lastEventT > freshest) freshest = cur.lastEventT;
        }
        const wallNow = Date.now();
        const ageMs = freshest === 0 ? PULSE_DECAY_MS : Math.max(0, wallNow - freshest);
        const decay = Math.max(0, 1 - ageMs / PULSE_DECAY_MS);
        const throb = 0.5 + 0.5 * Math.sin((performance.now() / PULSE_PERIOD_MS) * Math.PI * 2);
        const alpha = ids.length === 0 ? 0 : 0.25 + 0.55 * throb * decay;
        try {
          map.setPaintProperty(PULSE_LAYER_ID, "line-opacity", [
            "case",
            ["boolean", ["get", "disabled"], false],
            0,
            ["boolean", ["get", "impacted"], false],
            alpha,
            0,
          ]);
        } catch {
          // Layer torn down between rAFs — bail. The cleanup below will
          // cancel rafId; nothing else to do here.
          return;
        }
        rafId = requestAnimationFrame(animatePulse);
      };
      rafId = requestAnimationFrame(animatePulse);

      // Stash cleanup off the ac.signal for the outer effect to read.
      ac.signal.addEventListener("abort", () => {
        map.off("mousemove", FILL_LAYER_ID, onMouseMove);
        map.off("mouseleave", FILL_LAYER_ID, onMouseLeave);
        unsub();
        unsubDisabled();
        unsubImpacted();
        unsubMutes();
        if (rafId !== null) cancelAnimationFrame(rafId);
      });
    })();

    return () => {
      ac.abort();
      for (const id of [PULSE_LAYER_ID, OUTLINE_LAYER_ID, FILL_HOVER_LAYER_ID, FILL_LAYER_ID]) {
        if (map.getLayer(id)) {
          try {
            map.removeLayer(id);
          } catch {
            /* style may already be torn down */
          }
        }
      }
      if (map.getSource(SOURCE_ID)) {
        try {
          map.removeSource(SOURCE_ID);
        } catch {
          /* same */
        }
      }
    };
  }, [map]);

  return null;
}
