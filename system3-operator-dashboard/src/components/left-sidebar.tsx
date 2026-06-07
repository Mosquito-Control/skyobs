"use client";

import {
  Bell,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Hexagon,
  MousePointer2,
  Pencil,
  Radio,
  Square,
  Circle,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useApp, type LeftPanel, type ZoneImpactState } from "@/lib/store";
import { bbox as turfBbox } from "@turf/turf";
import { getTerraDrawRef } from "@/lib/terra-draw-ref";
import type { Alert, ZoneCategory, ZoneFeature } from "@/lib/types";
import type { Polygon, MultiPolygon } from "geojson";
import { useMapInstance } from "@/lib/map-context";
import { useStaticZones, type StaticZoneEntry } from "@/lib/use-static-zones";
import { useCameras, type CameraFeature } from "@/lib/use-cameras";
import ZoneEditorPanel from "./zone-editor-panel";
import ZoneDetailLeftPanel from "./zone-detail-left-panel";

// Every drawn zone gets the same hexagon icon — categories used to drive
// distinct icons but the user-facing design now has a single accent so the
// extra iconography just adds noise. Kept the type-narrow map so the row
// renderer below stays explicit about which categories exist.
const CATEGORY_META: Record<ZoneCategory, { label: string; icon: LucideIcon }> = {
  airport: { label: "Airport", icon: Hexagon },
  "country-park": { label: "Country Park", icon: Hexagon },
  military: { label: "Military", icon: Hexagon },
  vip: { label: "VIP", icon: Hexagon },
  event: { label: "Event", icon: Hexagon },
  custom: { label: "Custom", icon: Hexagon },
};

export default function LeftSidebar() {
  const leftPanel = useApp((s) => s.leftPanel);
  const setLeftPanel = useApp((s) => s.setLeftPanel);
  // Rail badge counts ACTIVE ZONES (zones with ≥1 drone currently inside,
  // minus zones the operator has acknowledged), not raw alert rows. "How
  // many places need my attention right now" is the answer the operator
  // actually wants; total alert volume is buried in the panel.
  const activeZoneCount = useApp((s) => {
    const now = Date.now();
    let n = 0;
    for (const id of Object.keys(s.zoneImpact)) {
      const until = s.mutedZoneUntil[id];
      if (typeof until === "number" && until > now) continue;
      n++;
    }
    return n;
  });
  const zoneOrder = useApp((s) => s.zoneOrder);
  const disabledZoneIds = useApp((s) => s.disabledZoneIds);
  const staticQuery = useStaticZones();
  const staticEntries = staticQuery.data?.entries ?? [];
  const savedCount = zoneOrder.length + staticEntries.length;
  const liveCount = useMemo(() => {
    const drawnLive = zoneOrder.filter((id) => !disabledZoneIds[id]).length;
    const staticLive = staticEntries.filter(
      (e) => !disabledZoneIds[e.id],
    ).length;
    return drawnLive + staticLive;
  }, [zoneOrder, disabledZoneIds, staticEntries]);
  // Editor wins over everything; selected-zone detail wins over the
  // rail-driven views. This keeps every operator action on the left.
  const editorZoneId = useApp((s) => s.editorZoneId);
  const selectedZoneId = useApp((s) => s.selectedZoneId);
  const selectedStaticZoneId = useApp((s) => s.selectedStaticZoneId);
  const selectZone = useApp((s) => s.selectZone);
  const showEditor = editorZoneId !== null;
  // Detail panel covers BOTH drawn (selectedZoneId) and static
  // (selectedStaticZoneId) selections — ZoneDetailLeftPanel branches
  // internally on whichever one is set.
  const showDetail =
    !showEditor && (selectedZoneId !== null || selectedStaticZoneId !== null);

  const selectStaticZone = useApp((s) => s.selectStaticZone);
  const toggle = (p: LeftPanel) => {
    // Switching to a rail view clears any zone selection (drawn AND static)
    // so the detail panel doesn't override what the operator just picked.
    if (selectedZoneId !== null) selectZone(null);
    if (selectedStaticZoneId !== null) selectStaticZone(null);
    setLeftPanel(leftPanel === p ? null : p);
  };

  return (
    <aside className="relative z-30 flex h-full shrink-0">
      {/* Icon rail */}
      <div className="flex h-full w-[68px] flex-col items-center gap-1 border-r border-ops-700/80 bg-ops-850/95 py-3 backdrop-blur">
        <RailButton
          icon={Pencil}
          label="Draw"
          active={leftPanel === "draw"}
          onClick={() => toggle("draw")}
        />
        <RailButton
          icon={Radio}
          label="Live"
          badge={liveCount}
          active={leftPanel === "live"}
          onClick={() => toggle("live")}
        />
        <RailButton
          icon={Bookmark}
          label="Saved"
          badge={savedCount}
          active={leftPanel === "saved"}
          onClick={() => toggle("saved")}
        />
        <RailButton
          icon={Bell}
          label="Alerts"
          badge={activeZoneCount}
          badgeTone={activeZoneCount > 0 ? "alarm" : "neutral"}
          active={leftPanel === "alerts"}
          onClick={() => toggle("alerts")}
        />
      </div>

      {/* Expanded panel. Priority: editor (mid-edit, can't navigate away) →
          selected-zone detail → rail-picked view → closed. Slide-in keyed to
          the panel identity so switching tabs replays the animation. */}
      {(leftPanel || showEditor || showDetail) && (
        <div
          key={showEditor ? "editor" : showDetail ? "detail" : leftPanel ?? ""}
          className="panel-slide-in flex h-full w-[320px] flex-col border-r border-ops-700/80 bg-ops-850/98 backdrop-blur"
        >
          {showEditor ? (
            <ZoneEditorPanel />
          ) : showDetail ? (
            <ZoneDetailLeftPanel />
          ) : leftPanel === "draw" ? (
            <DrawPanel />
          ) : leftPanel === "live" ? (
            <ZonesPanel filter="live" />
          ) : leftPanel === "saved" ? (
            <ZonesPanel filter="saved" />
          ) : leftPanel === "alerts" ? (
            <AlertsPanel />
          ) : null}
        </div>
      )}
    </aside>
  );
}

function RailButton({
  icon: Icon,
  label,
  badge,
  badgeTone = "neutral",
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  badge?: number;
  badgeTone?: "neutral" | "alarm";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[
        "group relative flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg border transition outline-none focus-visible:ring-2 focus-visible:ring-glow-500/60",
        active
          ? "border-glow-500/50 bg-glow-500/10 text-glow-500"
          : "border-transparent text-ink-med hover:border-ops-700 hover:bg-ops-800/70 hover:text-ink-hi",
      ].join(" ")}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
      <span className="font-mono text-[8px] uppercase tracking-wider opacity-80">
        {label}
      </span>
      {typeof badge === "number" && badge > 0 && (
        <span
          className={[
            "absolute right-1 top-1 min-w-[16px] rounded-full px-1 py-px text-center font-mono text-[9px] font-medium tabular-nums",
            badgeTone === "alarm"
              ? "bg-alarm-500 text-white"
              : "bg-ops-700 text-ink-hi",
          ].join(" ")}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function PanelHeader({
  title,
  hint,
  onClose,
}: {
  title: string;
  hint?: string;
  onClose?: () => void;
}) {
  return (
    <header className="flex items-start gap-2 border-b border-ops-700/70 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-lo">
          {title}
        </div>
        {hint && (
          <div className="mt-1 text-[12px] leading-relaxed text-ink-med">
            {hint}
          </div>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1.5 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
          aria-label="Close panel"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </header>
  );
}

/* ---------------------------- Draw panel ---------------------------- */

type DrawableMode = "polygon" | "rectangle" | "circle" | "select";

const DRAW_MODES: { mode: DrawableMode; label: string; icon: LucideIcon; hint: string }[] = [
  { mode: "polygon", label: "Polygon", icon: Pencil, hint: "Click to add points, double-click to finish" },
  { mode: "rectangle", label: "Rectangle", icon: Square, hint: "Click and drag to draw a box" },
  { mode: "circle", label: "Circle", icon: Circle, hint: "Click and drag to draw a radius" },
  { mode: "select", label: "Select & Edit", icon: MousePointer2, hint: "Click a zone to edit its shape" },
];

function DrawPanel() {
  const drawMode = useApp((s) => s.drawMode);
  const setDrawMode = useApp((s) => s.setDrawMode);
  const setLeftPanel = useApp((s) => s.setLeftPanel);

  // Crosshair cursor + camera-click suppression both key off body.is-drawing.
  // Owned here because the DrawPanel is the canonical writer of drawMode.
  useEffect(() => {
    const cls = "is-drawing";
    if (drawMode !== "idle") {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    return () => document.body.classList.remove(cls);
  }, [drawMode]);

  const stopDrawing = () => {
    const ctrl = getTerraDrawRef();
    const td = ctrl?.getTerraDrawInstance();
    if (td) {
      try {
        td.setMode("static");
      } catch {
        /* harmless if static isn't registered */
      }
    }
    setDrawMode("idle");
  };

  const fireMode = (mode: DrawableMode) => {
    // Clicking the already-active shape toggles drawing off. That's the only
    // affordance for stopping — there is no banner overlay anymore.
    if (drawMode === mode) {
      stopDrawing();
      return;
    }
    const ctrl = getTerraDrawRef();
    if (!ctrl) {
      console.warn("[draw] terra-draw control not registered yet");
      return;
    }
    const td = ctrl.getTerraDrawInstance();
    if (!td) {
      console.warn("[draw] terra-draw instance not ready");
      return;
    }
    // Terra-Draw requires start() before setMode(). The watergis adapter only
    // calls start() when the user clicks the floating toolbar — which we've
    // hidden — so the sidebar buttons must start it themselves. Guard with
    // `enabled` because calling start() twice throws.
    try {
      if (!td.enabled) td.start();
    } catch (err) {
      console.warn("[draw] start() failed", err);
    }
    try {
      td.setMode(mode);
      setDrawMode(mode);
    } catch (err) {
      console.warn(`[draw] setMode(${mode}) failed`, err);
    }
  };

  return (
    <>
      <PanelHeader
        title="Draw no-fly zone"
        hint="Pick a shape, then click on the map to draw. Click the active shape again to stop. Finish a polygon to open the Save form."
        onClose={() => {
          // Closing the panel also stops drawing so we never leave the
          // operator in a draw mode they can't see.
          stopDrawing();
          setLeftPanel(null);
        }}
      />
      <div className="space-y-1.5 p-3">
        {DRAW_MODES.map((m) => {
          const active = drawMode === m.mode;
          return (
            <button
              key={m.mode}
              type="button"
              onClick={() => fireMode(m.mode)}
              aria-pressed={active}
              title={active ? "Click to stop" : m.label}
              className={[
                "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition",
                active
                  ? "border-ink-hi bg-ink-hi text-white"
                  : "border-ops-700/70 bg-ops-800/40 hover:border-ops-600 hover:bg-ops-800",
              ].join(" ")}
            >
              <span
                className={[
                  "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
                  active
                    ? "border-white/40 bg-white/10 text-white"
                    : "border-ops-700 bg-ops-800/80 text-ink-med",
                ].join(" ")}
              >
                <m.icon className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={[
                    "block text-[13px] font-medium",
                    active ? "text-white" : "text-ink-hi",
                  ].join(" ")}
                >
                  {m.label}
                </span>
                <span
                  className={[
                    "mt-0.5 block text-[11px] leading-snug",
                    active ? "text-white/80" : "text-ink-med",
                  ].join(" ")}
                >
                  {m.hint}
                </span>
              </span>
              {active && (
                <span className="mt-0.5 shrink-0 rounded-sm border border-white/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-white">
                  Active
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------- Zones panel ---------------------------- */

function ZonesPanel({ filter }: { filter: "live" | "saved" }) {
  const zoneOrder = useApp((s) => s.zoneOrder);
  const zones = useApp((s) => s.zones);
  const selectedZoneId = useApp((s) => s.selectedZoneId);
  const selectZone = useApp((s) => s.selectZone);
  const selectStaticZone = useApp((s) => s.selectStaticZone);
  const selectedStaticZoneId = useApp((s) => s.selectedStaticZoneId);
  const removeZone = useApp((s) => s.removeZone);
  const setLeftPanel = useApp((s) => s.setLeftPanel);
  const disabledZoneIds = useApp((s) => s.disabledZoneIds);
  const toggleZoneEnabled = useApp((s) => s.toggleZoneEnabled);
  const setZonesEnabled = useApp((s) => s.setZonesEnabled);

  const staticQuery = useStaticZones();
  const staticEntries = staticQuery.data?.entries ?? [];

  const drawn = useMemo(
    () => zoneOrder.map((id) => zones[id]).filter(Boolean) as ZoneFeature[],
    [zoneOrder, zones],
  );

  // Group BOTH drawn and static zones by category. Drawn zones default to
  // "custom", so user-added zones cluster under the Custom toggle — that's
  // how the operator quickly hides their own polygons while keeping the
  // pre-loaded HK ones visible (or vice versa).
  const byCategory = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of staticEntries) {
      const arr = map.get(e.category) ?? [];
      arr.push(e.id);
      map.set(e.category, arr);
    }
    for (const z of drawn) {
      const cat = z.properties.category;
      const arr = map.get(cat) ?? [];
      arr.push(z.properties.id);
      map.set(cat, arr);
    }
    return map;
  }, [staticEntries, drawn]);

  const drawnVisible = useMemo(
    () =>
      filter === "saved" ? drawn : drawn.filter((z) => !disabledZoneIds[z.properties.id]),
    [drawn, disabledZoneIds, filter],
  );

  const staticVisible = useMemo(
    () =>
      filter === "saved"
        ? staticEntries
        : staticEntries.filter((e) => !disabledZoneIds[e.id]),
    [staticEntries, disabledZoneIds, filter],
  );

  const total = drawnVisible.length + staticVisible.length;
  const title = filter === "live" ? "Live no-fly zones" : "Saved zones";
  const emptyHint =
    filter === "live"
      ? "No active zones. Enable saved zones or draw a new one."
      : "No zones yet. Use the Draw panel to add one.";
  const populatedHint =
    filter === "live"
      ? `${total} zone${total === 1 ? "" : "s"} enforced right now.`
      : `${total} zone${total === 1 ? "" : "s"} saved. Toggle to enable/disable on the map.`;

  return (
    <>
      <PanelHeader
        title={title}
        hint={total === 0 ? emptyHint : populatedHint}
        onClose={() => setLeftPanel(null)}
      />
      {filter === "saved" && byCategory.size > 0 && (
        <CategoryToggleBar
          byCategory={byCategory}
          disabledZoneIds={disabledZoneIds}
          setZonesEnabled={setZonesEnabled}
        />
      )}
      <div className="ops-scroll flex-1 overflow-y-auto px-2 py-2">
        {total === 0 ? (
          <div className="mt-6 rounded-md border border-dashed border-ops-700 px-4 py-10 text-center text-[12px] text-ink-med">
            {emptyHint}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {drawnVisible.map((z) => (
              <DrawnZoneRow
                key={z.properties.id}
                zone={z}
                selected={selectedZoneId === z.properties.id}
                disabled={!!disabledZoneIds[z.properties.id]}
                showToggle={filter === "saved"}
                onSelect={() => selectZone(z.properties.id)}
                onRemove={() => removeZone(z.properties.id)}
                onToggle={() => toggleZoneEnabled(z.properties.id)}
              />
            ))}
            {staticVisible.map((e) => (
              <StaticZoneRow
                key={e.id}
                entry={e}
                selected={selectedStaticZoneId === e.id}
                disabled={!!disabledZoneIds[e.id]}
                showToggle={filter === "saved"}
                onSelect={() => selectStaticZone(e.id)}
                onToggle={() => toggleZoneEnabled(e.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  airport: "Airport",
  "approach-area": "Approach",
  "country-park": "Country Park",
  military: "Military",
  vip: "VIP",
  event: "Event",
  custom: "Custom",
};

// Per-category swatch shown in rows and toggle chips. Stays visible even on
// disabled zones (which only dim the row content) so the operator can scan
// the list by colour and spot what each entry is.
const CATEGORY_COLOR: Record<string, string> = {
  custom: "#2563EB", // blue — operator-drawn
  event: "#F59E0B", // amber
  vip: "#A855F7", // purple
  airport: "#DC2626", // red
  military: "#7F1D1D", // dark red
  "country-park": "#16A34A", // green
  "approach-area": "#CA8A04", // yellow
};

function CategoryDot({ category }: { category: string }) {
  const color = CATEGORY_COLOR[category] ?? "#64748B";
  return (
    <span
      aria-hidden="true"
      className="block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function CategoryToggleBar({
  byCategory,
  disabledZoneIds,
  setZonesEnabled,
}: {
  byCategory: Map<string, string[]>;
  disabledZoneIds: Record<string, true>;
  setZonesEnabled: (ids: string[], enabled: boolean) => void;
}) {
  // Custom pinned first so the operator's own drawings are visually anchored;
  // the rest follow alphabetically.
  const cats = Array.from(byCategory.entries()).sort((a, b) => {
    if (a[0] === "custom") return -1;
    if (b[0] === "custom") return 1;
    return a[0].localeCompare(b[0]);
  });
  return (
    <div className="border-b border-ops-700/70 bg-ops-900/40 px-3 py-2">
      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-lo">
        Categories
      </div>
      <div className="flex flex-wrap gap-1.5">
        {cats.map(([cat, ids]) => {
          const enabledCount = ids.filter((id) => !disabledZoneIds[id]).length;
          const allOff = enabledCount === 0;
          const label = CATEGORY_LABEL[cat] ?? cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setZonesEnabled(ids, allOff)}
              aria-pressed={!allOff}
              className={[
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition",
                allOff
                  ? "border-ops-700 bg-ops-800/40 text-ink-lo hover:border-ops-600"
                  : "border-ops-600 bg-ops-800/70 text-ink-hi hover:border-ink-hi",
              ].join(" ")}
            >
              <CategoryDot category={cat} />
              <span>{label}</span>
              <span className="font-mono text-[9px] opacity-70">
                {enabledCount}/{ids.length}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StaticZoneRow({
  entry,
  selected,
  disabled,
  showToggle,
  onSelect,
  onToggle,
}: {
  entry: StaticZoneEntry;
  selected: boolean;
  disabled: boolean;
  showToggle: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={[
          "group flex items-center gap-2 rounded-md border px-3 py-2 outline-none transition focus-visible:ring-2 focus-visible:ring-glow-500/50",
          selected
            ? "border-glow-500/60 bg-glow-500/10"
            : "border-ops-700/70 bg-ops-800/40 hover:border-ops-600 hover:bg-ops-800/80",
          disabled ? "opacity-50" : "",
        ].join(" ")}
      >
        <CategoryDot category={entry.category} />
        <span className="truncate text-[13px] font-medium text-ink-hi">
          {entry.name}
        </span>
        <span className="ml-auto rounded border border-alarm-500/40 bg-alarm-500/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-alarm-500">
          PERM
        </span>
        {showToggle && (
          <EnableToggle disabled={disabled} onToggle={onToggle} name={entry.name} />
        )}
      </div>
    </li>
  );
}

function EnableToggle({
  disabled,
  onToggle,
  name,
}: {
  disabled: boolean;
  onToggle: () => void;
  name: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={!disabled}
      aria-label={`${disabled ? "Enable" : "Disable"} ${name}`}
      className={[
        "relative h-4 w-7 shrink-0 rounded-full border transition",
        disabled
          ? "border-ops-600 bg-ops-800"
          : "border-glow-500/50 bg-glow-500/30",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full transition",
          disabled ? "left-0.5 bg-ink-lo" : "left-3.5 bg-glow-500",
        ].join(" ")}
      />
    </button>
  );
}

function DrawnZoneRow({
  zone,
  selected,
  disabled,
  showToggle,
  onSelect,
  onRemove,
  onToggle,
}: {
  zone: ZoneFeature;
  selected: boolean;
  disabled: boolean;
  showToggle: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onToggle: () => void;
}) {
  // Icon/CATEGORY_META kept around for potential per-category icon work, but
  // the row visual is anchored by the colored CategoryDot so the operator
  // can scan by colour even when the row is dimmed (disabled).
  void CATEGORY_META;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={[
          "group flex items-center gap-2 rounded-md border px-3 py-2 outline-none transition focus-visible:ring-2 focus-visible:ring-glow-500/50",
          selected
            ? "border-glow-500/60 bg-glow-500/10"
            : "border-ops-700/70 bg-ops-800/40 hover:border-ops-600 hover:bg-ops-800/80",
          disabled ? "opacity-60" : "",
        ].join(" ")}
      >
        <CategoryDot category={zone.properties.category} />
        <span className="truncate text-[13px] font-medium text-ink-hi">
          {zone.properties.name}
        </span>
        <span
          className={[
            "ml-auto rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
            zone.properties.kind === "permanent"
              ? "border-alarm-500/40 bg-alarm-500/5 text-alarm-500"
              : "border-glow-500/40 bg-glow-500/5 text-glow-500",
          ].join(" ")}
        >
          {zone.properties.kind === "permanent" ? "PERM" : "TMP"}
        </span>
        {showToggle ? (
          <EnableToggle
            disabled={disabled}
            onToggle={onToggle}
            name={zone.properties.name}
          />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="rounded p-1 text-ink-lo opacity-0 transition group-hover:opacity-100 hover:bg-alarm-500/10 hover:text-alarm-500"
            aria-label={`Delete ${zone.properties.name}`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </li>
  );
}

/* ---------------------------- Alerts panel ---------------------------- */

interface ZoneLookup {
  id: string;
  name: string;
  category: string;
  geometry: Polygon | MultiPolygon;
  kind: "drawn" | "static";
}

/** Resolve a zoneId from `zoneImpact` to a name/category/geometry the panel
 * can render. Drawn zones win when ids collide — the operator's own polygon
 * takes precedence over a static one with the same id. */
function lookupZone(
  zoneId: string,
  zones: Record<string, ZoneFeature>,
  staticZones: Record<string, { name: string; category: string; geometry: Polygon | MultiPolygon }>,
): ZoneLookup | null {
  const drawn = zones[zoneId];
  if (drawn) {
    return {
      id: zoneId,
      name: drawn.properties.name,
      category: drawn.properties.category,
      geometry: drawn.geometry,
      kind: "drawn",
    };
  }
  const stat = staticZones[zoneId];
  if (stat) {
    return {
      id: zoneId,
      name: stat.name,
      category: stat.category,
      geometry: stat.geometry,
      kind: "static",
    };
  }
  return null;
}

/** Project a polygon's first ring into normalized [0..1]² coordinates suitable
 * for an SVG viewBox. Robust against MultiPolygon — picks the first piece. */
function polygonToSvgPath(
  geom: Polygon | MultiPolygon,
  size = 32,
  pad = 2,
): string | null {
  const ring =
    geom.type === "Polygon"
      ? geom.coordinates[0]
      : geom.coordinates[0]?.[0];
  if (!ring || ring.length < 3) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const w = maxLng - minLng || 1e-6;
  const h = maxLat - minLat || 1e-6;
  const inner = size - pad * 2;
  // Lock the aspect ratio to the larger axis so the silhouette stays
  // shape-true; a country park doesn't get squashed into the airport's box.
  const s = Math.min(inner / w, inner / h);
  const ox = pad + (inner - w * s) / 2;
  const oy = pad + (inner - h * s) / 2;
  const pts = ring.map(([lng, lat]) => {
    const x = ox + (lng - minLng) * s;
    // Flip y — SVG y grows downward, lat grows upward.
    const y = ox + (maxLat - lat) * s + (oy - ox);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M${pts.join("L")}Z`;
}

function AlertsPanel() {
  const setLeftPanel = useApp((s) => s.setLeftPanel);
  const zoneImpact = useApp((s) => s.zoneImpact);
  const mutedZoneUntil = useApp((s) => s.mutedZoneUntil);
  const muteImpactedZone = useApp((s) => s.muteImpactedZone);
  const unmuteImpactedZone = useApp((s) => s.unmuteImpactedZone);
  const zones = useApp((s) => s.zones);
  const staticZones = useApp((s) => s.staticZones);
  const selectZone = useApp((s) => s.selectZone);
  const selectStaticZone = useApp((s) => s.selectStaticZone);
  const alerts = useApp((s) => s.alerts);
  const map = useMapInstance();
  const [expandedZoneId, setExpandedZoneId] = useState<string | null>(null);

  // Split impacts into "active" (operator should see) and "muted" (acked,
  // hidden until the window expires). Both sorted by recency so the freshest
  // event floats to the top of each section.
  const { activeGroups, mutedGroups } = useMemo(() => {
    const now = Date.now();
    const active: Array<{ impact: ZoneImpactState; zone: ZoneLookup; mutedUntil?: number }> = [];
    const muted: Array<{ impact: ZoneImpactState; zone: ZoneLookup; mutedUntil: number }> = [];
    for (const impact of Object.values(zoneImpact)) {
      const zone = lookupZone(impact.zoneId, zones, staticZones);
      if (!zone) continue;
      const until = mutedZoneUntil[impact.zoneId];
      if (typeof until === "number" && until > now) {
        muted.push({ impact, zone, mutedUntil: until });
      } else {
        active.push({ impact, zone });
      }
    }
    active.sort((a, b) => b.impact.lastEventT - a.impact.lastEventT);
    muted.sort((a, b) => a.mutedUntil - b.mutedUntil);
    return { activeGroups: active, mutedGroups: muted };
  }, [zoneImpact, mutedZoneUntil, zones, staticZones]);

  const activeCount = activeGroups.length;
  const totalDronesInside = useMemo(
    () => activeGroups.reduce((n, g) => n + g.impact.droneIds.length, 0),
    [activeGroups],
  );

  const focusZone = (zone: ZoneLookup) => {
    if (zone.kind === "drawn") selectZone(zone.id);
    else selectStaticZone(zone.id);
    if (!map) return;
    try {
      const [minLng, minLat, maxLng, maxLat] = turfBbox({
        type: "Feature",
        geometry: zone.geometry,
        properties: {},
      });
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 80, duration: 700, maxZoom: 14.5 },
      );
    } catch {
      /* malformed geometry — selection alone is enough */
    }
  };

  return (
    <>
      <header className="flex items-start gap-2 border-b border-ops-700/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-lo">
            Active impacts
          </div>
          <div className="mt-1 font-mono text-[24px] leading-none tabular-nums text-ink-hi">
            {String(activeCount).padStart(2, "0")}
            <span className="ml-2 text-[12px] text-ink-lo">
              {totalDronesInside > 0 &&
                `· ${totalDronesInside} drone${totalDronesInside === 1 ? "" : "s"} inside`}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-ink-med">
            Live in 5s window. Map pulses zones currently being breached.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setLeftPanel(null)}
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1.5 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
          aria-label="Close panel"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="ops-scroll flex-1 overflow-y-auto">
        {activeCount === 0 && mutedGroups.length === 0 ? (
          <div className="mt-6 px-4 text-center text-[12px] text-ink-med">
            No active zone impacts. The map will pulse here and the bell badge
            will light up the moment a drone enters any enabled zone.
          </div>
        ) : (
          <>
            {activeGroups.length > 0 && (
              <ul className="divide-y divide-ops-700/60">
                {activeGroups.map(({ impact, zone }) => (
                  <ZoneImpactRow
                    key={zone.id}
                    impact={impact}
                    zone={zone}
                    expanded={expandedZoneId === zone.id}
                    muted={false}
                    onToggle={() =>
                      setExpandedZoneId((cur) => (cur === zone.id ? null : zone.id))
                    }
                    onFocus={() => focusZone(zone)}
                    onAck={() => muteImpactedZone(zone.id, 60_000)}
                    onUnmute={() => unmuteImpactedZone(zone.id)}
                    alerts={alerts}
                  />
                ))}
              </ul>
            )}
            {mutedGroups.length > 0 && (
              <>
                <div className="border-t border-ops-700/60 bg-ops-900/40 px-4 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-lo">
                  Acknowledged ({mutedGroups.length})
                </div>
                <ul className="divide-y divide-ops-700/60 opacity-70">
                  {mutedGroups.map(({ impact, zone, mutedUntil }) => (
                    <ZoneImpactRow
                      key={zone.id}
                      impact={impact}
                      zone={zone}
                      expanded={expandedZoneId === zone.id}
                      muted
                      mutedUntil={mutedUntil}
                      onToggle={() =>
                        setExpandedZoneId((cur) =>
                          cur === zone.id ? null : zone.id,
                        )
                      }
                      onFocus={() => focusZone(zone)}
                      onAck={() => muteImpactedZone(zone.id, 60_000)}
                      onUnmute={() => unmuteImpactedZone(zone.id)}
                      alerts={alerts}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ZoneImpactRow({
  impact,
  zone,
  expanded,
  muted,
  mutedUntil,
  onToggle,
  onFocus,
  onAck,
  onUnmute,
  alerts,
}: {
  impact: ZoneImpactState;
  zone: ZoneLookup;
  expanded: boolean;
  muted: boolean;
  mutedUntil?: number;
  onToggle: () => void;
  onFocus: () => void;
  onAck: () => void;
  onUnmute: () => void;
  alerts: Alert[];
}) {
  const path = useMemo(() => polygonToSvgPath(zone.geometry), [zone.geometry]);
  const droneCount = impact.droneIds.length;
  const hotMs = Date.now() - impact.firstEnterT;
  const mutedRemainingMs = muted && mutedUntil ? mutedUntil - Date.now() : 0;

  return (
    <li>
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            className="-ml-1 shrink-0 rounded p-1 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          {/* Zone silhouette + category dot. Click on the whole left chunk
              focuses the zone (selects + fitBounds) so the operator can
              inspect it on the map without expanding the row. */}
          <button
            type="button"
            onClick={onFocus}
            className="group flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-ops-700/70 bg-ops-900/40">
              {path ? (
                <svg viewBox="0 0 32 32" className="h-7 w-7">
                  <path
                    d={path}
                    fill={categoryColor(zone.category) + "33"}
                    stroke={categoryColor(zone.category)}
                    strokeWidth={1.2}
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <CategoryDot category={zone.category} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink-hi group-hover:text-glow-500">
                {zone.name}
              </span>
              <span className="block font-mono text-[10px] uppercase tracking-wider text-ink-lo">
                {zone.kind === "static" ? "Permanent" : "Drawn"} ·{" "}
                {(CATEGORY_LABEL[zone.category] ?? zone.category)}
              </span>
            </span>
          </button>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <span
              className={
                "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums " +
                (muted
                  ? "border-ops-600 bg-ops-800 text-ink-med"
                  : "border-alarm-500/50 bg-alarm-500/15 text-alarm-400")
              }
              title={`${droneCount} drone${droneCount === 1 ? "" : "s"} inside`}
            >
              {droneCount}
            </span>
            <span
              className="font-mono text-[10px] tabular-nums text-ink-lo"
              title={muted ? `Muted for ${formatDur(mutedRemainingMs)} more` : `Hot for ${formatDur(hotMs)}`}
            >
              {muted ? `mute ${formatDur(mutedRemainingMs)}` : formatDur(hotMs)}
            </span>
          </span>
        </div>

        {/* Action row — single decisive button. Ack snoozes the impact for
            60s (clears off the map + hides the row down to the muted
            section); Unmute brings it back. Focus is wired on the zone
            silhouette above. */}
        <div className="ml-7 mt-1.5 flex items-center gap-1">
          {muted ? (
            <button
              type="button"
              onClick={onUnmute}
              className="rounded-md border border-glow-500/40 bg-glow-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-glow-500 transition hover:bg-glow-500/20"
            >
              Re-arm
            </button>
          ) : (
            <button
              type="button"
              onClick={onAck}
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-amber-400 transition hover:bg-amber-500/20"
              title="Silence this zone for 60s"
            >
              Acknowledge
            </button>
          )}
          <button
            type="button"
            onClick={onFocus}
            className="rounded-md border border-ops-700 bg-ops-800/60 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-med transition hover:border-ink-hi hover:text-ink-hi"
          >
            Show on map
          </button>
        </div>

        {expanded && (
          <ZoneImpactDetail impact={impact} alerts={alerts} />
        )}
      </div>
    </li>
  );
}

function ZoneImpactDetail({
  impact,
  alerts,
}: {
  impact: ZoneImpactState;
  alerts: Alert[];
}) {
  const drones = useApp((s) => s.drones);
  const [expandedDroneId, setExpandedDroneId] = useState<string | null>(null);
  // Show drones currently inside (from impact) at the top, then any 5s-window
  // alerts for this zone that aren't already represented above.
  const insideAlerts = useMemo(() => {
    const byDrone = new Map<string, Alert>();
    for (const a of alerts) {
      if (a.zoneId !== impact.zoneId) continue;
      // Take the freshest per drone — pushAlert dedupes per pair, but be
      // defensive in case the engine queues two on the same tick.
      const cur = byDrone.get(a.droneId);
      if (!cur || a.lastSeen > cur.lastSeen) byDrone.set(a.droneId, a);
    }
    return byDrone;
  }, [alerts, impact.zoneId]);

  return (
    <div className="ml-7 mt-2 space-y-1 border-l border-ops-700/40 pl-2">
      {impact.droneIds.map((droneId) => {
        const drone = drones[droneId];
        const a = insideAlerts.get(droneId);
        const expanded = expandedDroneId === droneId;
        return (
          <div key={droneId} className="rounded border border-ops-700/40 bg-ops-900/30">
            <button
              type="button"
              onClick={() =>
                setExpandedDroneId((cur) => (cur === droneId ? null : droneId))
              }
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-ops-800/60"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-ink-lo" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-ink-lo" />
              )}
              <span className="truncate font-mono text-[11px] font-medium text-ink-hi">
                {droneId}
              </span>
              {drone && (
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-lo">
                  {Math.round(drone.altM)}m
                </span>
              )}
            </button>
            {expanded && a && <AlertDetail alert={a} drone={drone} />}
          </div>
        );
      })}
    </div>
  );
}

function formatDur(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] ?? "#64748B";
}

function AlertDetail({
  alert,
  drone,
}: {
  alert: Alert;
  drone?: { altM: number; speedMs?: number; bearingDeg?: number; t: number };
}) {
  const camerasQuery = useCameras();
  // Only Unity (sim_unity) cameras carry a real video feed in this build.
  // Real-world HKO/TD stills aren't tied to a specific alert — they're just
  // wide-area weather and traffic, not "this is what the drone looks like."
  // So we only attach a snapshot when the drone id parses to a sim_unity
  // cam_pair. MOCK-*, SIM-*, and any unknown id render metadata only.
  const camera = useMemo(
    () =>
      pickUnityCameraForAlert(
        alert.droneId,
        alert.lng,
        alert.lat,
        camerasQuery.data?.features ?? [],
      ),
    [alert.droneId, alert.lng, alert.lat, camerasQuery.data],
  );
  const feed = camera ? unityCameraFeedUrl(camera) : null;

  return (
    <div className="border-t border-ops-700/60 bg-ops-900/40 px-3 py-3 pl-[1.95rem]">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <Meta label="First seen">{new Date(alert.t).toLocaleTimeString()}</Meta>
        <Meta label="Last seen">{new Date(alert.lastSeen).toLocaleTimeString()}</Meta>
        <Meta label="Position">
          {alert.lat.toFixed(4)}, {alert.lng.toFixed(4)}
        </Meta>
        <Meta label="Severity" tone={alert.severity === "high" ? "alarm" : undefined}>
          {alert.severity}
        </Meta>
        {drone && (
          <>
            <Meta label="Alt">{Math.round(drone.altM)} m</Meta>
            <Meta label="Speed">
              {drone.speedMs != null ? `${Math.round(drone.speedMs)} m/s` : "—"}
            </Meta>
          </>
        )}
      </div>

      {feed && camera && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-lo">
            <span>Unity camera</span>
            <span className="text-ink-med">{camera.properties.name}</span>
          </div>
          <iframe
            src={feed}
            className="aspect-video w-full rounded border border-ops-700/60 bg-black"
            referrerPolicy="no-referrer"
            allow="autoplay *; fullscreen *"
            allowFullScreen
          />
        </div>
      )}
    </div>
  );
}

function Meta({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "alarm";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-lo">
        {label}
      </div>
      <div
        className={
          "mt-0.5 tabular-nums " +
          (tone === "alarm" ? "text-alarm-400" : "text-ink-hi")
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Pick the Unity (sim_unity) camera tied to this alert.
 *
 * Two id shapes resolve to a camera, everything else returns null:
 *   1. `cam_05+cam_08#rowid` — legacy System 2 cam_pair, first cam wins.
 *   2. `t-<trackId>`         — System 4 track. We don't know which cameras
 *      contributed, so fall back to the nearest sim_unity camera within
 *      UNITY_FALLBACK_RADIUS_M of the alert's coordinates. If the closest
 *      camera is far away, the drone is probably outside any Unity
 *      coverage area and we return null rather than show a misleading feed.
 *
 * MOCK-* / SIM-* mock drones always return null.
 */
const UNITY_FALLBACK_RADIUS_M = 700;

function haversineMeters(
  aLng: number,
  aLat: number,
  bLng: number,
  bLat: number,
): number {
  const R = 6371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function pickUnityCameraForAlert(
  droneId: string,
  alertLng: number,
  alertLat: number,
  cameras: CameraFeature[],
): CameraFeature | null {
  if (cameras.length === 0) return null;

  const pairMatch = droneId.match(/^(cam_[a-z0-9]+)\+(cam_[a-z0-9]+)/i);
  if (pairMatch) {
    const wanted = pairMatch[1].toLowerCase();
    const cam = cameras.find(
      (c) => c.properties.source_key.toLowerCase() === wanted,
    );
    if (cam && cam.properties.source === "sim_unity") return cam;
    return null;
  }

  if (droneId.startsWith("t-")) {
    let best: CameraFeature | null = null;
    let bestDist = Infinity;
    for (const c of cameras) {
      if (c.properties.source !== "sim_unity") continue;
      const [lng, lat] = c.geometry.coordinates;
      const d = haversineMeters(alertLng, alertLat, lng, lat);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (best && bestDist <= UNITY_FALLBACK_RADIUS_M) return best;
    return null;
  }

  return null;
}

function unityCameraFeedUrl(c: CameraFeature): string | null {
  if (c.properties.source !== "sim_unity") return null;
  return `http://localhost:8888/${c.properties.source_key}/`;
}

