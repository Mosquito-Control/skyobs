"use client";

import { Check, Trash2, X } from "lucide-react";
// X imported for both the inline header and the bottom Cancel/Discard buttons.
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { getTerraDrawRef } from "@/lib/terra-draw-ref";
import type {
  ZoneCategory,
  ZoneKind,
  ZoneProperties,
} from "@/lib/types";

/**
 * Left-side editor for a zone. Two modes:
 *   • create — opened automatically when terra-draw finishes a new polygon.
 *     Save commits the entered values; Discard removes the zone entirely.
 *   • edit   — opened when the operator clicks Edit on a saved zone's read-only
 *     detail panel. Save commits; Cancel restores the original values and
 *     closes the editor without touching the zone.
 *
 * The form holds a local draft until Save — there is no auto-debounce. This
 * is the explicit-commit flow the operator asked for.
 */

const CATEGORIES: { value: ZoneCategory; label: string }[] = [
  { value: "event", label: "Event" },
  { value: "vip", label: "VIP movement" },
  { value: "airport", label: "Airport" },
  { value: "military", label: "Military" },
  { value: "country-park", label: "Country park" },
  { value: "custom", label: "Custom" },
];

interface Draft {
  name: string;
  category: ZoneCategory;
  kind: ZoneKind;
  expiresAt: string;
  notes: string;
}

function isoToLocal(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function propsToDraft(p: ZoneProperties, mode: "create" | "edit"): Draft {
  // Newly-drawn zones default to category="custom" so they cluster together
  // under the Custom filter in the Saved list — the operator can tell their
  // hand-drawn shapes apart from anything pre-loaded. Kind defaults to
  // "temporary" for create mode so the expiry field is exposed.
  void mode;
  return {
    name: p.name,
    category: p.category,
    kind: p.kind,
    expiresAt: isoToLocal(p.expiresAt),
    notes: p.notes ?? "",
  };
}

export default function ZoneEditorPanel() {
  const editorZoneId = useApp((s) => s.editorZoneId);
  const editorMode = useApp((s) => s.editorMode);
  const zone = useApp((s) =>
    editorZoneId ? s.zones[editorZoneId] : null,
  );
  const patchZoneProps = useApp((s) => s.patchZoneProps);
  const removeZone = useApp((s) => s.removeZone);
  const closeZoneEditor = useApp((s) => s.closeZoneEditor);
  const setLeftPanel = useApp((s) => s.setLeftPanel);
  const setDrawMode = useApp((s) => s.setDrawMode);
  const selectZone = useApp((s) => s.selectZone);
  const pushToast = useApp((s) => s.pushToast);

  // Snapshot the original props once per editor session so Cancel can revert.
  const originalRef = useRef<ZoneProperties | null>(null);
  useEffect(() => {
    originalRef.current = zone ? { ...zone.properties } : null;
  }, [editorZoneId, zone]);

  const initial = useMemo<Draft>(() => {
    if (!zone || !editorMode) {
      return {
        name: "",
        category: "event",
        kind: "temporary",
        expiresAt: "",
        notes: "",
      };
    }
    return propsToDraft(zone.properties, editorMode);
  }, [zone, editorMode]);

  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  if (!zone || !editorMode) return null;

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const name = draft.name.trim() || zone.properties.name;
    const patch: Partial<ZoneProperties> = {
      name,
      category: draft.category,
      kind: draft.kind,
      notes: draft.notes.trim() ? draft.notes.trim() : undefined,
      expiresAt:
        draft.kind === "temporary" ? localToIso(draft.expiresAt) : undefined,
    };
    const savedId = zone.properties.id;
    patchZoneProps(savedId, patch);
    closeZoneEditor();

    // Stop the active draw mode so a single click on the map doesn't start
    // another polygon. The terra-draw "static" mode is the no-op equivalent
    // of "idle".
    const td = getTerraDrawRef()?.getTerraDrawInstance();
    if (td) {
      try {
        td.setMode("static");
      } catch {
        /* harmless if static isn't registered */
      }
    }
    setDrawMode("idle");

    // Open the right-side detail view by selecting the saved zone — that's
    // where the operator confirms the result of the Save.
    selectZone(savedId);
    setLeftPanel(null);

    pushToast({
      level: "info",
      message: editorMode === "create" ? `Zone "${name}" saved.` : "Changes saved.",
    });
  };

  const discardOrCancel = () => {
    if (editorMode === "create") {
      removeZone(zone.properties.id);
      // Also stop drawing — otherwise the operator's next map click starts
      // another polygon. Symmetric with Save.
      const td = getTerraDrawRef()?.getTerraDrawInstance();
      if (td) {
        try {
          td.setMode("static");
        } catch {
          /* harmless */
        }
      }
      setDrawMode("idle");
      pushToast({ level: "info", message: "Draft zone discarded." });
    } else if (originalRef.current) {
      // Edit mode — nothing was committed during editing, so just close.
    }
    closeZoneEditor();
  };

  const headerTitle =
    editorMode === "create" ? "Save new zone" : "Edit zone";
  const headerHint =
    editorMode === "create"
      ? "Fill in the details, then click Save to commit. Discard removes the polygon."
      : "Update the details. Cancel keeps the saved values.";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-2 border-b border-ops-700/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-lo">
            {headerTitle}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-ink-med">
            {headerHint}
          </div>
        </div>
        <button
          type="button"
          onClick={discardOrCancel}
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1.5 text-ink-lo transition hover:bg-ops-800 hover:text-ink-hi"
          aria-label={editorMode === "create" ? "Discard zone" : "Cancel"}
          title={editorMode === "create" ? "Discard" : "Cancel"}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="ops-scroll flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <Field label="Name">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Causeway Bay parade"
            className="w-full rounded-md border border-ops-700 bg-ops-800/40 px-2.5 py-2 text-[13px] text-ink-hi outline-none focus:border-ink-hi"
          />
        </Field>

        <Field label="Category">
          <div className="grid grid-cols-2 gap-1.5">
            {CATEGORIES.map((c) => {
              const active = draft.category === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => update("category", c.value)}
                  className={[
                    "rounded-md border px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider transition",
                    active
                      ? "border-ink-hi bg-ink-hi text-white"
                      : "border-ops-700 bg-ops-800/40 text-ink-med hover:border-ops-600 hover:text-ink-hi",
                  ].join(" ")}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Kind">
          <div className="inline-flex rounded-md border border-ops-700 bg-ops-800/40 p-0.5 font-mono text-[10px] uppercase tracking-wider">
            <button
              type="button"
              onClick={() => update("kind", "permanent")}
              className={[
                "rounded px-3 py-1.5 transition",
                draft.kind === "permanent"
                  ? "bg-ink-hi text-white"
                  : "text-ink-med hover:text-ink-hi",
              ].join(" ")}
            >
              Permanent
            </button>
            <button
              type="button"
              onClick={() => update("kind", "temporary")}
              className={[
                "rounded px-3 py-1.5 transition",
                draft.kind === "temporary"
                  ? "bg-ink-hi text-white"
                  : "text-ink-med hover:text-ink-hi",
              ].join(" ")}
            >
              Temporary
            </button>
          </div>
        </Field>

        {draft.kind === "temporary" && (
          <Field label="Expires at">
            <input
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(e) => update("expiresAt", e.target.value)}
              className="w-full rounded-md border border-ops-700 bg-ops-800/40 px-2.5 py-2 font-mono text-[12px] text-ink-hi outline-none focus:border-ink-hi"
            />
          </Field>
        )}

        <Field label="Notes">
          <textarea
            value={draft.notes}
            onChange={(e) => update("notes", e.target.value)}
            rows={3}
            placeholder="Context, contact, source…"
            className="ops-scroll w-full resize-none rounded-md border border-ops-700 bg-ops-800/40 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-hi outline-none focus:border-ink-hi"
          />
        </Field>
      </div>

      <footer className="flex items-center gap-2 border-t border-ops-700/70 bg-ops-850 px-4 py-3">
        <button
          type="button"
          onClick={discardOrCancel}
          className="flex items-center gap-1.5 rounded-md border border-ops-700 px-3 py-1.5 text-[12px] font-medium text-ink-med transition hover:border-alarm-500/40 hover:text-alarm-500"
        >
          {editorMode === "create" ? (
            <>
              <Trash2 className="h-3.5 w-3.5" />
              Discard
            </>
          ) : (
            <>
              <X className="h-3.5 w-3.5" />
              Cancel
            </>
          )}
        </button>
        <button
          type="button"
          onClick={save}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-ink-hi px-4 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-black"
        >
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
          Save
        </button>
      </footer>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-lo">
        <span>{label}</span>
        {hint && <span className="text-[9px] text-ink-lo/70">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
