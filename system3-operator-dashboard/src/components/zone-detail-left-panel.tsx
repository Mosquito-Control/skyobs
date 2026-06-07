"use client";

import { useMemo } from "react";
import { Bell, EyeOff, Eye, Pencil, ShieldAlert, Trash2, X } from "lucide-react";
import type maplibregl from "maplibre-gl";
import { useApp, type StaticZone } from "@/lib/store";
import type { DroneFix, ZoneFeature } from "@/lib/types";
import { useMapInstance } from "@/lib/map-context";

/**
 * Left-sidebar read-only zone detail. Shown when a zone is selected (and no
 * editor is open). Mirrors the previous right-side panel so every operator
 * action stays on the left. Editing happens through the Edit button, which
 * routes back into ZoneEditorPanel.
 */

const CATEGORY_LABEL: Record<string, string> = {
  event: "Event",
  vip: "VIP movement",
  airport: "Airport",
  military: "Military",
  "country-park": "Country park",
  custom: "Custom",
};

export default function ZoneDetailLeftPanel() {
  const drawnId = useApp((s) => s.selectedZoneId);
  const staticId = useApp((s) => s.selectedStaticZoneId);
  const zones = useApp((s) => s.zones);
  const staticZones = useApp((s) => s.staticZones);
  const zoneImpact = useApp((s) => s.zoneImpact);
  const drones = useApp((s) => s.drones);
  const selectZone = useApp((s) => s.selectZone);
  const removeZone = useApp((s) => s.removeZone);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const map = useMapInstance();

  const zone: ZoneFeature | null = drawnId ? zones[drawnId] ?? null : null;
  const staticZone: StaticZone | null = staticId
    ? staticZones[staticId] ?? null
    : null;

  // If a static zone is selected (and no drawn zone took priority), render
  // the static branch with Delete / Edit (promote) / Disable. Static zones
  // are read-only by design, so the only "edit" path is to promote the
  // polygon into the drawn-zones store and open the regular terra-draw
  // editor against it — same UI as any custom zone from there on.
  if (staticZone && !zone) {
    return (
      <StaticZoneDetail
        zone={staticZone}
        impactDroneIds={zoneImpact[staticZone.id]?.droneIds ?? []}
        drones={drones}
      />
    );
  }

  // The drones currently impacting this zone — sourced from zoneImpact
  // (linger-stable: a drone briefly orbiting outside the polygon stays in
  // the list for LINGER_MS rather than disappearing each poll tick).
  // This replaces the previous "filter alerts by point-in-polygon" which
  // strobed off as soon as the 5s alert TTL pruned, even while the impact
  // was still live.
  const impactDroneIds = useMemo<string[]>(() => {
    if (!zone) return [];
    return zoneImpact[zone.properties.id]?.droneIds ?? [];
  }, [zone, zoneImpact]);

  if (!zone) return null;

  const onClose = () => selectZone(null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b border-ops-700/70 px-4 py-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-alarm-500/40 bg-alarm-500/10 text-alarm-500">
          <ShieldAlert className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink-hi">
            {zone.properties.name}
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-lo">
            {`${CATEGORY_LABEL[zone.properties.category] ?? zone.properties.category} · ${zone.properties.kind === "permanent" ? "Permanent" : "Temporary"}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
          aria-label="Close zone detail"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex items-center gap-2 border-b border-ops-700/70 px-4 py-2.5">
        <button
          type="button"
          onClick={() => openZoneEditor(zone.properties.id, "edit")}
          className="flex items-center gap-1.5 rounded-md border border-ink-hi bg-ink-hi px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-black"
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
          Edit
        </button>
        <button
          type="button"
          onClick={() => removeZone(zone.properties.id)}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-ops-700 px-2.5 py-1.5 text-[12px] text-ink-med transition hover:border-alarm-500/40 hover:text-alarm-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>

      <div className="ops-scroll flex-1 overflow-y-auto">
        <section className="border-b border-ops-700/60 px-4 py-3 space-y-2.5">
          {zone.properties.kind === "temporary" && (
            <ReadField label="Expires">
              {zone.properties.expiresAt
                ? new Date(zone.properties.expiresAt).toLocaleString()
                : "—"}
            </ReadField>
          )}
          <ReadField label="Created">
            {new Date(zone.properties.createdAt).toLocaleString()}
          </ReadField>
          {zone.properties.notes && (
            <ReadField label="Notes">{zone.properties.notes}</ReadField>
          )}
        </section>

        <ImpactSection
          impactDroneIds={impactDroneIds}
          drones={drones}
          map={map}
        />
      </div>
    </div>
  );
}

/* ------------------------- Shared impact section ----------------------- */

function ImpactSection({
  impactDroneIds,
  drones,
  map,
}: {
  impactDroneIds: string[];
  drones: Record<string, DroneFix>;
  map: maplibregl.Map | null;
}) {
  const count = impactDroneIds.length;
  return (
    <section className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-lo">
          <Bell className="h-3.5 w-3.5" />
          Drones inside
        </div>
        <span
          className={
            "rounded-md border px-2 py-0.5 font-mono text-[10px] tabular-nums " +
            (count > 0
              ? "border-alarm-500/40 bg-alarm-500/10 text-alarm-400"
              : "border-ops-700 bg-ops-800/60 text-ink-hi")
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="rounded-md border border-dashed border-ops-700 px-3 py-6 text-center text-[12px] text-ink-med">
          No drones currently impacting this zone.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {impactDroneIds.map((droneId) => {
            const d = drones[droneId];
            return (
              <li key={droneId}>
                <button
                  type="button"
                  onClick={() => {
                    if (!map || !d) return;
                    map.flyTo({
                      center: [d.lng, d.lat],
                      zoom: Math.max(map.getZoom(), 14),
                      speed: 0.9,
                    });
                  }}
                  className="block w-full rounded-md border border-ops-700/70 bg-ops-800/40 px-3 py-2 text-left transition hover:border-alarm-500/40 hover:bg-alarm-500/5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-mono text-[11px] font-medium text-ink-hi">
                      {droneId}
                    </span>
                    {d && (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-lo">
                        {Math.round(d.altM)}m · {timeAgo(d.t)}
                      </span>
                    )}
                  </div>
                  {d && (
                    <div className="mt-0.5 truncate text-[12px] text-ink-med">
                      {d.lat.toFixed(4)}, {d.lng.toFixed(4)}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ReadField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-lo">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] text-ink-hi">{children}</div>
    </div>
  );
}

function timeAgo(ms: number) {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ----------------------- Static zone detail panel ----------------------- */

function StaticZoneDetail({
  zone,
  impactDroneIds,
  drones,
}: {
  zone: StaticZone;
  impactDroneIds: string[];
  drones: Record<string, DroneFix>;
}) {
  const selectStaticZone = useApp((s) => s.selectStaticZone);
  const removeStaticZone = useApp((s) => s.removeStaticZone);
  const promoteStaticToDrawn = useApp((s) => s.promoteStaticToDrawn);
  const disabled = useApp((s) => !!s.disabledZoneIds[zone.id]);
  const toggleZoneEnabled = useApp((s) => s.toggleZoneEnabled);
  const map = useMapInstance();

  const onDelete = () => {
    if (
      !confirm(
        `Delete "${zone.name}"? This removes it from the map for this session. To persist, regenerate hk-permanent-zones.geojson.`,
      )
    )
      return;
    removeStaticZone(zone.id);
  };

  const onEdit = () => {
    promoteStaticToDrawn(zone.id);
    // promoteStaticToDrawn already opens the editor on the new drawn zone.
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b border-ops-700/70 px-4 py-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-alarm-500/40 bg-alarm-500/10 text-alarm-500">
          <ShieldAlert className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink-hi">
            {zone.name}
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-lo">
            {(CATEGORY_LABEL[zone.category] ?? zone.category)} · HK no-fly (static)
          </div>
        </div>
        <button
          type="button"
          onClick={() => selectStaticZone(null)}
          className="rounded-md p-1.5 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
          aria-label="Close zone detail"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex items-center gap-2 border-b border-ops-700/70 px-4 py-2.5">
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center gap-1.5 rounded-md border border-ink-hi bg-ink-hi px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-black"
          title="Convert to an editable drawn zone and open the editor"
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
          Edit
        </button>
        <button
          type="button"
          onClick={() => toggleZoneEnabled(zone.id)}
          className="flex items-center gap-1.5 rounded-md border border-ops-700 px-2.5 py-1.5 text-[12px] text-ink-med transition hover:border-ink-hi hover:text-ink-hi"
          title={disabled ? "Re-enable enforcement on this zone" : "Mute this zone — alerts won't fire while disabled"}
        >
          {disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {disabled ? "Enable" : "Disable"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-ops-700 px-2.5 py-1.5 text-[12px] text-ink-med transition hover:border-alarm-500/40 hover:text-alarm-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>

      <div className="ops-scroll flex-1 overflow-y-auto">
        <section className="border-b border-ops-700/60 px-4 py-3 text-[12px] text-ink-med">
          Static no-fly zones come from{" "}
          <code className="rounded bg-ops-800/60 px-1 py-0.5 font-mono text-[11px] text-ink-hi">
            public/data/hk-permanent-zones.geojson
          </code>
          . Delete and Edit changes are session-only — reloading the dashboard
          re-reads the file. Promote via Edit to keep an edited version in the
          drawn-zones catalogue.
        </section>

        <ImpactSection
          impactDroneIds={impactDroneIds}
          drones={drones}
          map={map}
        />
      </div>
    </div>
  );
}
