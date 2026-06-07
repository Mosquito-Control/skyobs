"use client";

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { temporal } from "zundo";
import type { Alert, DroneFix, Track, ZoneFeature } from "./types";
import type { Feature, Polygon, MultiPolygon } from "geojson";

/** A read-only HK zone surfaced from /data/hk-permanent-zones.geojson. */
export interface StaticZone {
  id: string;
  name: string;
  category: string;
  geometry: Polygon | MultiPolygon;
}

export type LeftPanel = "draw" | "live" | "saved" | "alerts" | null;

/** When the editor panel is active, it overrides the leftPanel view above. */
export type EditorMode = "create" | "edit";

export interface Toast {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Mirrors the terra-draw mode names we register, plus "idle" for the
 * not-currently-drawing state. The status banner reads from this. */
export type DrawMode =
  | "idle"
  | "polygon"
  | "rectangle"
  | "circle"
  | "select";

export const DRAW_MODE_LABEL: Record<Exclude<DrawMode, "idle">, string> = {
  polygon: "Polygon",
  rectangle: "Rectangle",
  circle: "Circle",
  select: "Select & edit",
};

interface ZoneSlice {
  zones: Record<string, ZoneFeature>;
  zoneOrder: string[];
  selectedZoneId: string | null;
  drawMode: DrawMode;

  upsertZone: (z: ZoneFeature) => void;
  removeZone: (id: string) => void;
  /** Replaces the zone map. Optional `priorOrder` preserves panel ordering;
   * otherwise the current store's zoneOrder is reused. New IDs always append. */
  setZones: (zones: ZoneFeature[], priorOrder?: string[]) => void;
  selectZone: (id: string | null) => void;
  setDrawMode: (m: DrawMode) => void;
  patchZoneProps: (id: string, patch: Partial<ZoneFeature["properties"]>) => void;
}

interface DroneSlice {
  drones: Record<string, DroneFix>;
  ingestDrones: (batch: DroneFix[]) => void;
  /** Drop drones whose `t` is older than `maxAgeMs` ago. Called by the TTL
   * ticker so a drone that stops being refreshed (track went lost, or an
   * old cam_pair#rowid id from a deprecated stream) doesn't haunt the
   * impact map forever. Pairs with the alert-engine linger window — a
   * vanished drone gracefully degrades to exit via the standard pathway. */
  pruneStaleDrones: (nowMs: number, maxAgeMs?: number) => void;
}

/** Live impact accounting per zone. Subset of zoneImpact whose `droneIds` is
 * non-empty represents zones currently being breached. The dashboard's
 * "across the room" signal — zone fill brightens, outline pulses, rail badge
 * counts ACTIVE zones — all derive from this map. Sister concept to
 * `alerts`: the alert log is forensic (history), zoneImpact is live state. */
export interface ZoneImpactState {
  zoneId: string;
  droneIds: string[];
  /** ms since epoch — first time droneIds transitioned 0 → 1 in this hot
   * period. Reset whenever the zone goes fully empty and reignites. */
  firstEnterT: number;
  /** ms since epoch — most recent entry tick (NOT every PIP hit). The map
   * pulse layer reads this to time the radial wave decay. */
  lastEventT: number;
  /** Lifetime entries since the dashboard mounted. Survives the zone going
   * cold and reheating; used by the zone-grouped alerts panel header. */
  totalEvents: number;
}

interface AlertSlice {
  alerts: Alert[];
  /** Insert or refresh. Dedups by (droneId, zoneId): a re-entry on an
   * existing pair bumps lastSeen and resets a `resolved` row back to
   * `new`, so the panel doesn't fill with duplicates on every orbit. */
  pushAlert: (a: Alert) => void;
  /** Bump lastSeen on an existing (drone,zone) pair WITHOUT changing
   * status. Called every cycle the drone remains in (or lingers around)
   * the polygon so TTL doesn't prune mid-violation. When `lng`/`lat` are
   * supplied (fresh PIP hit), the alert's stored position is also
   * updated — the on-map marker moves with the drone instead of staying
   * frozen at the entry point. Omit `lng`/`lat` during linger so the
   * marker stays at the last in-zone position. No-op if the pair doesn't
   * exist. */
  refreshAlertSeen: (
    droneId: string,
    zoneId: string,
    nowMs: number,
    lng?: number,
    lat?: number,
  ) => void;
  acknowledgeAlert: (id: string) => void;
  resolveAlert: (id: string) => void;
  clearAlerts: () => void;
  /** TTL prune. Drop `new`/`ack` after `staleMs`, `resolved` after
   * `resolvedMs`, and any row past `hardMs` regardless of status. */
  pruneAlerts: (
    nowMs: number,
    opts?: { staleMs?: number; resolvedMs?: number; hardMs?: number },
  ) => void;
}

interface ImpactSlice {
  zoneImpact: Record<string, ZoneImpactState>;
  /** Atomic per-tick mutation called by the alert engine. `entries` are
   * (zoneId, droneId) pairs that newly entered this tick; `exits` are pairs
   * that left. Zones whose droneIds list goes empty are dropped from the map
   * so `Object.keys(zoneImpact).length` is the live active-zones count. */
  applyImpactDiff: (
    entries: { zoneId: string; droneId: string }[],
    exits: { zoneId: string; droneId: string }[],
    now: number,
  ) => void;
  /** ZoneId → wallclock ms after which the mute expires. Acknowledged zones
   * are silenced in the alerts panel and stop pulsing on the map. The engine
   * still tracks them (so impact counters keep ticking up), they're just
   * hidden until the timer runs out or the operator hits "unmute". */
  mutedZoneUntil: Record<string, number>;
  /** Operator action: silence a zone's impact for `durationMs`. Default 60s
   * is enough for the demo loop without being a permanent off-switch. The
   * zone visibly drops out of the panel and stops pulsing on the map
   * immediately; if any drones remain inside, the count comes back as soon
   * as the mute expires. */
  muteImpactedZone: (zoneId: string, durationMs?: number) => void;
  /** Operator action: re-arm an acknowledged zone immediately. */
  unmuteImpactedZone: (zoneId: string) => void;
  /** Sweep expired mutes. Called by use-alert-ttl every second so subscribers
   * (map paint mirrors, panel groups) re-evaluate and a zone visibly comes
   * back when its mute window runs out. */
  evictExpiredMutes: (nowMs: number) => void;
}

interface RecentFixesSlice {
  /** Ring buffer of recent fixes per drone, oldest first. Bounded to
   * RECENT_FIX_LIMIT entries to cap memory. Drives the "in-zone trail"
   * polyline on the map — the alert engine sips it via getState() rather
   * than subscribing, so growth doesn't churn the React tree. */
  recentFixes: Record<string, DroneFix[]>;
}

interface StaticZoneSlice {
  staticZones: Record<string, StaticZone>;
  selectedStaticZoneId: string | null;
  setStaticZones: (zones: StaticZone[]) => void;
  selectStaticZone: (id: string | null) => void;
  /** Ephemeral delete. The next staticZones fetch (hk-no-fly-layer)
   * re-seeds from the GeoJSON file, so this is session-only — fine for
   * the demo workflow where the operator deletes a badly-drawn static
   * polygon and replaces it with a hand-drawn one. To persist, edit
   * public/data/hk-permanent-zones.geojson. */
  removeStaticZone: (id: string) => void;
  /** Promote a static zone into the drawn-zones store so the operator
   * can edit it with terra-draw. Copies geometry + name, maps category
   * to the ZoneCategory enum (unknown source categories become
   * "custom"), removes the static original, and returns the new drawn
   * zone id so callers can immediately open the editor. */
  promoteStaticToDrawn: (id: string) => string | null;
  /** IDs (drawn or static) the operator has temporarily disabled. Disabled
   * zones stay in the Saved catalogue but drop off the Live list and out of
   * map enforcement. Not undoable — it's runtime UI state, not a content edit. */
  disabledZoneIds: Record<string, true>;
  setZoneEnabled: (id: string, enabled: boolean) => void;
  toggleZoneEnabled: (id: string) => void;
  /** Bulk version — used by the Saved panel's category toggles so flipping
   * "country-park" off doesn't fire 47 separate store updates. */
  setZonesEnabled: (ids: string[], enabled: boolean) => void;
}

interface UiSlice {
  leftPanel: LeftPanel;
  setLeftPanel: (p: LeftPanel) => void;
  /** Non-null while the left-side editor form is open. */
  editorZoneId: string | null;
  editorMode: EditorMode | null;
  openZoneEditor: (id: string, mode: EditorMode) => void;
  closeZoneEditor: () => void;
}

interface ToastSlice {
  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

interface TracksSlice {
  tracks: Record<number, Track>;
  setTracks: (tracks: Track[]) => void;
}

export type AppState = ZoneSlice &
  DroneSlice &
  AlertSlice &
  ImpactSlice &
  RecentFixesSlice &
  StaticZoneSlice &
  UiSlice &
  ToastSlice &
  TracksSlice;

/** Per-drone fix history depth. ~30s at the 1.5s poll cadence — long enough
 * for the in-zone trail to render a meaningful path, short enough that 50
 * drones × 20 fixes stays well under a megabyte. */
const RECENT_FIX_LIMIT = 20;

// Only zone edits are undoable. Drone fixes and alerts are excluded.
export const useApp = create<AppState>()(
  subscribeWithSelector(
    temporal(
      (set) => ({
        zones: {},
        zoneOrder: [],
        selectedZoneId: null,
        drawMode: "idle",

        upsertZone: (z) =>
          set((s) => {
            const exists = z.properties.id in s.zones;
            return {
              zones: { ...s.zones, [z.properties.id]: z },
              zoneOrder: exists ? s.zoneOrder : [...s.zoneOrder, z.properties.id],
            };
          }),
        removeZone: (id) =>
          set((s) => {
            const next = { ...s.zones };
            delete next[id];
            return {
              zones: next,
              zoneOrder: s.zoneOrder.filter((x) => x !== id),
              selectedZoneId: s.selectedZoneId === id ? null : s.selectedZoneId,
            };
          }),
        setZones: (zones, priorOrder) =>
          set((s) => {
            const map: Record<string, ZoneFeature> = {};
            for (const z of zones) map[z.properties.id] = z;
            const ref = priorOrder ?? s.zoneOrder;
            const seen = new Set<string>();
            const order: string[] = [];
            // 1) prior IDs that still exist — preserve panel order
            for (const id of ref) {
              if (map[id] && !seen.has(id)) {
                order.push(id);
                seen.add(id);
              }
            }
            // 2) brand-new IDs — append in incoming order
            for (const z of zones) {
              const id = z.properties.id;
              if (!seen.has(id)) {
                order.push(id);
                seen.add(id);
              }
            }
            return { zones: map, zoneOrder: order };
          }),
        selectZone: (id) =>
          // Symmetric with selectStaticZone — clear the other side so the
          // right detail panel has a single source of truth.
          set((s) => ({
            selectedZoneId: id,
            selectedStaticZoneId: id ? null : s.selectedStaticZoneId,
          })),
        setDrawMode: (m) => set({ drawMode: m }),
        patchZoneProps: (id, patch) =>
          set((s) => {
            const z = s.zones[id];
            if (!z) return {};
            return {
              zones: {
                ...s.zones,
                [id]: { ...z, properties: { ...z.properties, ...patch } },
              },
            };
          }),

        drones: {},
        pruneStaleDrones: (nowMs, maxAgeMs = 30_000) =>
          set((s) => {
            let changed = false;
            const nextDrones: Record<string, DroneFix> = {};
            const nextFixes = { ...s.recentFixes };
            for (const [id, d] of Object.entries(s.drones)) {
              if (nowMs - d.t > maxAgeMs) {
                changed = true;
                delete nextFixes[id];
                continue;
              }
              nextDrones[id] = d;
            }
            if (!changed) return {};
            return { drones: nextDrones, recentFixes: nextFixes };
          }),
        ingestDrones: (batch) =>
          set((s) => {
            const next = { ...s.drones };
            const nextFixes = { ...s.recentFixes };
            for (const d of batch) {
              next[d.id] = d;
              // Append to per-drone ring buffer, drop the head when over
              // RECENT_FIX_LIMIT. We allocate a fresh array per drone that
              // got a fix this batch — others share their reference so
              // shallow-equality consumers don't think they changed.
              const prev = nextFixes[d.id];
              if (!prev) {
                nextFixes[d.id] = [d];
              } else {
                const appended = prev.length >= RECENT_FIX_LIMIT
                  ? [...prev.slice(prev.length - RECENT_FIX_LIMIT + 1), d]
                  : [...prev, d];
                nextFixes[d.id] = appended;
              }
            }
            return { drones: next, recentFixes: nextFixes };
          }),

        recentFixes: {},

        mutedZoneUntil: {},
        muteImpactedZone: (zoneId, durationMs = 60_000) =>
          set((s) => ({
            mutedZoneUntil: {
              ...s.mutedZoneUntil,
              [zoneId]: Date.now() + durationMs,
            },
          })),
        unmuteImpactedZone: (zoneId) =>
          set((s) => {
            if (!(zoneId in s.mutedZoneUntil)) return {};
            const next = { ...s.mutedZoneUntil };
            delete next[zoneId];
            return { mutedZoneUntil: next };
          }),
        evictExpiredMutes: (nowMs) =>
          set((s) => {
            let changed = false;
            const next = { ...s.mutedZoneUntil };
            for (const id of Object.keys(next)) {
              if (next[id] <= nowMs) {
                delete next[id];
                changed = true;
              }
            }
            return changed ? { mutedZoneUntil: next } : {};
          }),

        zoneImpact: {},
        applyImpactDiff: (entries, exits, now) =>
          set((s) => {
            if (entries.length === 0 && exits.length === 0) return {};
            const next: Record<string, ZoneImpactState> = { ...s.zoneImpact };

            // Apply exits first so a drone leaving + re-entering in the same
            // tick (theoretically possible via teleporting fixes) is correctly
            // treated as still-inside.
            for (const { zoneId, droneId } of exits) {
              const cur = next[zoneId];
              if (!cur) continue;
              const remaining = cur.droneIds.filter((id) => id !== droneId);
              if (remaining.length === 0) {
                // Zone went cold — drop the entry entirely. lastEventT lives
                // on but consumers should fall back to "not impacted" once
                // the key is gone. firstEnterT is regenerated next time
                // someone enters, intentionally.
                delete next[zoneId];
              } else {
                next[zoneId] = { ...cur, droneIds: remaining };
              }
            }

            for (const { zoneId, droneId } of entries) {
              const cur = next[zoneId];
              if (!cur) {
                next[zoneId] = {
                  zoneId,
                  droneIds: [droneId],
                  firstEnterT: now,
                  lastEventT: now,
                  totalEvents: 1,
                };
              } else if (!cur.droneIds.includes(droneId)) {
                next[zoneId] = {
                  ...cur,
                  droneIds: [...cur.droneIds, droneId],
                  lastEventT: now,
                  totalEvents: cur.totalEvents + 1,
                };
              }
            }

            return { zoneImpact: next };
          }),

        alerts: [],
        pushAlert: (a) =>
          set((s) => {
            // Dedup by (droneId, zoneId). A drone that orbits in→out→in
            // through the same polygon should not create a fresh row each
            // pass — just refresh lastSeen + reset status if it was
            // resolved. The incoming Alert's id is used only on first
            // insert; later updates keep the original id so the UI keeps
            // the same row stable.
            const key = `${a.droneId}::${a.zoneId}`;
            const existingIdx = s.alerts.findIndex(
              (x) => `${x.droneId}::${x.zoneId}` === key,
            );
            if (existingIdx >= 0) {
              const prev = s.alerts[existingIdx];
              const refreshed: Alert = {
                ...prev,
                lastSeen: a.t,
                // re-entry after resolution promotes back to `new` so the
                // operator notices the second incursion.
                status: prev.status === "resolved" ? "new" : prev.status,
                lat: a.lat,
                lng: a.lng,
                message: a.message,
                severity: a.severity,
              };
              const next = [...s.alerts];
              next.splice(existingIdx, 1);
              return { alerts: [refreshed, ...next] };
            }
            const fresh: Alert = {
              ...a,
              lastSeen: a.lastSeen ?? a.t,
              status: a.status ?? "new",
            };
            const next = [fresh, ...s.alerts];
            if (next.length > 500) next.pop();
            return { alerts: next };
          }),
        refreshAlertSeen: (droneId, zoneId, nowMs, lng, lat) =>
          set((s) => {
            const key = `${droneId}::${zoneId}`;
            let touched = false;
            const next = s.alerts.map((a) => {
              if (`${a.droneId}::${a.zoneId}` !== key) return a;
              if (a.status === "resolved") return a; // operator decided; don't drag back
              touched = true;
              // When lng/lat are supplied (live PIP hit this tick), the
              // alert's coordinates are bumped — that's what makes the
              // map marker MOVE with the drone instead of staying pinned
              // to the entry point. During linger (no lng/lat passed),
              // the marker stays at the last known in-zone position.
              if (lng !== undefined && lat !== undefined) {
                return { ...a, lastSeen: nowMs, lng, lat };
              }
              return { ...a, lastSeen: nowMs };
            });
            return touched ? { alerts: next } : {};
          }),
        acknowledgeAlert: (id) =>
          set((s) => ({
            alerts: s.alerts.map((a) =>
              a.id === id && a.status === "new" ? { ...a, status: "ack" } : a,
            ),
          })),
        resolveAlert: (id) =>
          set((s) => ({
            alerts: s.alerts.map((a) =>
              a.id === id ? { ...a, status: "resolved", lastSeen: Date.now() } : a,
            ),
          })),
        clearAlerts: () => set({ alerts: [] }),
        pruneAlerts: (nowMs, opts) =>
          set((s) => {
            // 5s across the board — the panel shows "what's happening in the
            // current poll tick", nothing older. The map's zoneImpact +
            // pulse carries the persistent "this zone is hot" signal.
            const staleMs = opts?.staleMs ?? 5_000;
            const resolvedMs = opts?.resolvedMs ?? 5_000;
            const hardMs = opts?.hardMs ?? 5_000;
            const next = s.alerts.filter((a) => {
              const ageFromLastSeen = nowMs - a.lastSeen;
              const ageFromFirst = nowMs - a.t;
              if (ageFromFirst > hardMs) return false;
              if (a.status === "resolved") return ageFromLastSeen <= resolvedMs;
              return ageFromLastSeen <= staleMs;
            });
            if (next.length === s.alerts.length) return {};
            return { alerts: next };
          }),

        staticZones: {},
        selectedStaticZoneId: null,
        setStaticZones: (zones) =>
          set(() => {
            const map: Record<string, StaticZone> = {};
            for (const z of zones) map[z.id] = z;
            return { staticZones: map };
          }),
        selectStaticZone: (id) =>
          // Clear drawn-zone selection when picking a static one so the right
          // detail panel never tries to show both.
          set(() => ({ selectedStaticZoneId: id, selectedZoneId: null })),

        removeStaticZone: (id) =>
          set((s) => {
            if (!(id in s.staticZones)) return {};
            const next = { ...s.staticZones };
            delete next[id];
            const nextDisabled = { ...s.disabledZoneIds };
            delete nextDisabled[id];
            return {
              staticZones: next,
              disabledZoneIds: nextDisabled,
              selectedStaticZoneId:
                s.selectedStaticZoneId === id ? null : s.selectedStaticZoneId,
            };
          }),

        promoteStaticToDrawn: (id) => {
          const s = useApp.getState();
          const sz = s.staticZones[id];
          if (!sz) return null;
          const ALLOWED: Record<string, true> = {
            airport: true,
            "country-park": true,
            military: true,
            vip: true,
            event: true,
            custom: true,
          };
          const cat = ALLOWED[sz.category]
            ? (sz.category as ZoneFeature["properties"]["category"])
            : "custom";
          const newId = `promoted-${id}-${Math.round(performance.now())}`;
          const feature: ZoneFeature = {
            type: "Feature",
            geometry: sz.geometry,
            properties: {
              id: newId,
              name: sz.name,
              kind: "permanent",
              category: cat,
              createdAt: new Date().toISOString(),
              notes: `Promoted from static zone ${id}`,
            },
          };
          set((cur) => {
            const nextStatic = { ...cur.staticZones };
            delete nextStatic[id];
            const nextDisabled = { ...cur.disabledZoneIds };
            delete nextDisabled[id];
            return {
              zones: { ...cur.zones, [newId]: feature },
              zoneOrder: [...cur.zoneOrder, newId],
              staticZones: nextStatic,
              disabledZoneIds: nextDisabled,
              selectedStaticZoneId:
                cur.selectedStaticZoneId === id ? null : cur.selectedStaticZoneId,
              selectedZoneId: newId,
              editorZoneId: newId,
              editorMode: "edit",
            };
          });
          return newId;
        },

        disabledZoneIds: {},
        setZoneEnabled: (id, enabled) =>
          set((s) => {
            const next = { ...s.disabledZoneIds };
            if (enabled) delete next[id];
            else next[id] = true;
            return { disabledZoneIds: next };
          }),
        toggleZoneEnabled: (id) =>
          set((s) => {
            const next = { ...s.disabledZoneIds };
            if (next[id]) delete next[id];
            else next[id] = true;
            return { disabledZoneIds: next };
          }),
        setZonesEnabled: (ids, enabled) =>
          set((s) => {
            const next = { ...s.disabledZoneIds };
            for (const id of ids) {
              if (enabled) delete next[id];
              else next[id] = true;
            }
            return { disabledZoneIds: next };
          }),

        leftPanel: "live" as LeftPanel,
        setLeftPanel: (p) => set({ leftPanel: p }),

        editorZoneId: null,
        editorMode: null,
        openZoneEditor: (id, mode) =>
          set({ editorZoneId: id, editorMode: mode }),
        closeZoneEditor: () =>
          set({ editorZoneId: null, editorMode: null }),

        toasts: [],
        pushToast: (t) =>
          set((s) => {
            // Monotonic-ish id without leaning on Date.now()/Math.random() —
            // both are forbidden in some agent harnesses and brittle anyway.
            const id = `t-${s.toasts.length}-${Math.round(performance.now())}`;
            return { toasts: [...s.toasts, { id, ...t }] };
          }),
        dismissToast: (id) =>
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

        tracks: {},
        setTracks: (incoming) =>
          set(() => {
            const next: Record<number, Track> = {};
            for (const t of incoming) next[t.id] = t;
            return { tracks: next };
          }),
      }),
      {
        // selectedZoneId is pure UI state — it must NOT travel through undo,
        // otherwise selecting/deselecting a row corrupts the history stack.
        partialize: (s) => ({
          zones: s.zones,
          zoneOrder: s.zoneOrder,
        }),
        limit: 50,
        equality: (a, b) => a.zones === b.zones && a.zoneOrder === b.zoneOrder,
      },
    ),
  ),
);

export const useTemporal = () => useApp.temporal.getState();
