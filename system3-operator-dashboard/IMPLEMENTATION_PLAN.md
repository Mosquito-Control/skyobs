# System 3 — Implementation Plan

This document is the source-of-truth for parallel agents finishing the **frontend dashboard** (System 3) of the HK drone-compliance stack. Each stream is independently claimable. Streams that block other streams are marked with `BLOCKS:`. The `Agent prompt` block in each stream is copy-pasteable into a sub-agent call.

---

## 0 · Where we stand (read first)

**Stack** (locked, no rediscussion): Next.js 16 App Router + TS + Tailwind v4 (CSS-first `@theme`) + MapLibre GL JS 5.24 + Terra Draw 1.31 via `@watergis/maplibre-gl-terradraw` + Zustand 5 + zundo (undo) + TanStack Query 5 + Geist Sans/Mono + lucide-react 1.x. Tile basemap: CARTO `dark-matter` (`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`).

**Already built** (in `Orgs/frontend/`):
- Dashboard shell — `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/dashboard.tsx`
- HK map (CARTO dark-matter, MapLibre v5) — `src/components/map-canvas.tsx`
- Terra Draw toolbar wired (polygon / rectangle / circle / select / delete / undo / redo) — same file
- Zone side panel with stats, undo bar, kind badges — `src/components/zone-panel.tsx`
- Top bar with KPI chips — `src/components/top-bar.tsx`
- Zustand store with zones/drones/alerts slices + zundo time travel — `src/lib/store.ts`
- Types — `src/lib/types.ts` (`ZoneFeature`, `DroneFix`, `Alert`)
- Dev-only globals `window.__map` / `window.__draw` for Playwright tests
- Theme: midnight-ops palette (`ops-{900..600}`, `glow-{400,500,700}`, `radar-{400,600}`, `alarm-{400,500,warn}`, `ink-{hi,med,lo}`)

**Upstream contract — System 2 positioning engine** (DO NOT change without coordinating with the System 2 owner):
- Postgres table `positions` — columns: `id`, `timestamp TIMESTAMPTZ`, `lat`, `lon`, `alt_m`, `cam_pair TEXT`, `score_i`, `score_j`, `inserted_at`.
- Reader role: `system3_reader` with `SELECT` on `positions` only.
- System 2 currently exposes `POST /events` (write, from cameras) and `GET /health`. **It does NOT expose a positions read endpoint yet** — Stream C must either negotiate that endpoint with System 2 owner, or read directly from Postgres in a Next.js route handler.

**Multi-agent validation already surfaced these issues — every stream that touches the affected file must address them or check that another stream did:**
| ID | Where | Issue | Severity |
|---|---|---|---|
| V1 | `src/lib/store.ts` `partialize` | `selectedZoneId` is in undo snapshot — selection changes silently corrupt undo history | HIGH |
| V2 | `src/components/map-canvas.tsx` `nextZoneName` | uses live count, produces `Zone 02` twice after a delete-then-add | HIGH |
| V3 | `src/lib/store.ts` `setZones` | rebuilds `zoneOrder` from terra-draw snapshot iteration order, shuffles panel on every edit | HIGH |
| V4 | `src/components/map-canvas.tsx` polygon style | Terra Draw's default cobalt blue is used — does NOT reflect PERM (green) / TMP (cyan) / selected | HIGH (visual) |
| V5 | `src/components/zone-panel.tsx` `bg-glow-500/8` | Tailwind v4 has no `/8` opacity scale → renders solid; should be `/10` or `/[0.08]` | MEDIUM |
| V6 | `src/components/map-canvas.tsx` remove loop | `td.removeFeatures` re-fires `change` → extra setZones round-trip + redundant undo entry | MEDIUM |
| V7 | Top bar | KPI chips static — needs pulsing radar dot and red alarm tint when alerts > 0 | MEDIUM (visual) |
| V8 | `aside` panel | No collapse at <1100px — eats 33% of viewport on 1024 | MEDIUM |
| V9 | HUD | bottom-left "Hong Kong SAR" overlaps MapLibre `ScaleControl` | LOW |
| V10 | `public/` | leftover create-next-app SVGs (`next.svg`, `vercel.svg`, etc.) | LOW |
| V11 | Bundle | 1.2 MB single chunk (MapLibre + Terra Draw) — MapCanvas already `next/dynamic({ssr:false})`, so this is structural for the libraries; defer | LOW |

Stream A owns V1–V6, V9. Stream F owns V7, V10. Stream G owns V8.

---

## Stream A — Map polish & zone styling (HIGH IMPACT, ship first)

**Owns:** V1, V2, V3, V4, V6, V9. This is the single biggest perceived-quality lift — without it the dashboard looks like a Terra Draw demo.

**Files:** `src/components/map-canvas.tsx`, `src/lib/store.ts`, `src/components/dashboard.tsx`, `src/components/zone-panel.tsx`.

**Acceptance:**
- Permanent zones render with `fillColor:#39875F fill:0.18`, `outlineColor:#6CCB78 outline:2.5px`. Temporary zones render with `fillColor:#1FBAD6 fill:0.18`, `outlineColor:#5EE7FF outline:2.5px`. Selected zone gets an extra outer glow ring 4px @ 0.35.
- Toggling PERM/TMP from the side panel immediately recolours the polygon on the map (call `td.updateFeatureProperties(id, { kind })` from `patchZoneProps` or via store subscription).
- Selecting a zone from the side panel `flyTo`s the zone centroid (use `@turf/centroid`).
- `zoneSeq` monotonic counter wired up — names never collide after delete-then-add. Use `useApp.getState().nextZoneNumber()` in `syncFromTerra`.
- `setZones` preserves prior order for known IDs; appends new IDs at end.
- `partialize` in zundo no longer includes `selectedZoneId` (UI state).
- Programmatic remove guarded by an `isApplyingRemote` ref so terra-draw's echo `change` doesn't double-fire `setZones`.
- Bottom-left HUD chip moved to `bottom-12` or `bottom-right` so it doesn't sit over the MapLibre scale bar.
- `bg-glow-500/8` → `bg-glow-500/10`.

**Agent prompt:**
```
You're implementing Stream A of Orgs/frontend/IMPLEMENTATION_PLAN.md. Read the plan first (`Orgs/frontend/IMPLEMENTATION_PLAN.md`) — your scope is the "Stream A" section + the validator items V1, V2, V3, V4, V6, V9 in the table at the top.

Don't touch other streams. Files: src/components/map-canvas.tsx, src/lib/store.ts, src/components/dashboard.tsx, src/components/zone-panel.tsx.

Confirm by running: `npx tsc --noEmit` (zero errors), `npm run build` (success), then drive the dev server at localhost:3187 via Playwright MCP to draw 3 polygons, toggle one to PERM, select another, and verify the colours, the flyTo, and the name sequencing visually. Submit screenshots as evidence.
```

---

## Stream B — HK static no-fly layers (parallel with A)

**Owns:** rendering airport, country parks, and military overlays on the map as a separate non-editable "permanent restricted airspace" layer that lives BELOW the user-drawn zones.

**Files:** new `public/data/hk-permanent-zones.geojson`, new `scripts/build-hk-data.mjs` (or `.sh`), `src/components/map-canvas.tsx` (add a MapLibre source + 2 layers after style load).

**Data sources** (validated by deep-research, verified URLs):
- HKIA polygon: OSM relation 16105017 (Chek Lap Kok)
- HKIA Approach Areas: `https://opendata.esrichina.hk/api/download/v1/items/38a75b5339514f58a08bdca25f51c9e8/geojson?layers=0`
- Country parks (~40% of HK): Overpass POST `[out:json][timeout:180];relation["boundary"="national_park"](22.15,113.83,22.57,114.42);out geom;`
- HK admin boundary: OSM relation 20044132
- Military: OSM way 160073829 (Shek Kong Airfield)
- CAD eSUA drone restricted zones: no public GeoJSON — leave as TODO with `// TBD: digitise from cad.gov.hk PDF` marker

**Acceptance:**
- `npm run data:hk` builds `public/data/hk-permanent-zones.geojson` containing four categorised features (airport, approach-area, country-parks-collection, military) with a `category` property each, total <500 KB minified.
- Map renders this layer with `fill-color` driven by `category` (airport `#5EE7FF`@0.12 + outline `#1FBAD6`, country-park `#6CCB78`@0.08 + outline `#39875F`, military `#FF5A6E`@0.10 + outline `#F9042C`), sat under user-drawn polygons (use MapLibre's `beforeId` to insert below the Terra Draw layers).
- The side panel shows a fixed PERM count = number of features in the static layer + user-drawn PERMs.

**Agent prompt:**
```
You're implementing Stream B of Orgs/frontend/IMPLEMENTATION_PLAN.md. Pull HK no-fly GeoJSON, merge into one file, and render under the user-drawn polygons in MapLibre. Use osmtogeojson via `npx -y osmtogeojson` to convert OSM JSON. Do not touch the Terra Draw control. Do not interleave with Stream A's polygon styling — your fills must be visually distinct (lower opacity) so user-drawn zones stay dominant.

Acceptance is in the "Stream B" section of the plan. Verify by drawing one user polygon overlapping with a country park and confirming the user polygon visibly sits ON TOP.
```

---

## Stream C — Drone position ingest & live pins (BLOCKS: D, E)

**Owns:** Wiring System 2's positions table into the dashboard as live drone pins.

**Sub-decision needed first:**
- Path (1) Negotiate a `GET /positions?since=<iso>` endpoint with the System 2 owner (preferred — clean API boundary).
- Path (2) Read directly from Postgres in a Next.js route handler `app/api/positions/route.ts` using `system3_reader` credentials from env (`SYSTEM2_DB_URL`, `SYSTEM3_READER_PASSWORD`). Client polls/SSEs the route.

Default: **Path 2 for hackathon, Path 1 for v2**.

**Files:** new `src/app/api/positions/route.ts` (server, polls Postgres or System 2), new `src/lib/use-drone-stream.ts` (client hook, EventSource or polling), `src/components/map-canvas.tsx` (add a deck.gl `MapboxOverlay` with an `IconLayer`/`ScatterplotLayer` for live pins driven by `useApp.subscribe`), `src/lib/store.ts` (use the existing `ingestDrones` slice, no schema change).

**Acceptance:**
- Hitting `GET /api/positions?since=<iso8601>` returns `{positions: DroneFix[]}` newest-first.
- Client opens an EventSource at `/api/positions/stream` (or polls every 250 ms — pick one, document the choice in the file header) and pushes new fixes into `useApp.getState().ingestDrones`.
- A `ScatterplotLayer` (cyan dot, radius 6px, anti-aliased) renders all drones from `state.drones`. Pulsing outer ring via a sibling layer with `getRadius` animated by `requestAnimationFrame`.
- Top bar "LIVE · N tracks" chip reflects live count from the store, not the static `0`.
- WebSocket / poll teardown on unmount; no leaks across HMR.
- Dev-mode injector: a button in dev only that pushes a fake `DroneFix` so Streams D/E can develop without System 2 running.

**Agent prompt:**
```
You're implementing Stream C of Orgs/frontend/IMPLEMENTATION_PLAN.md. Build the bridge between System 2's positions table and the live drone pins on the map. Pick Path 2 (direct Postgres read in a Next.js route handler) for the hackathon. Schema and credentials are documented in Orgs/system2-positioning-engine/system2/db.py — DO NOT modify that file.

Add `pg` (`npm i pg`) for the route handler. Don't bundle `pg` into the client (`"use server"` boundary). Verify the layer count in `state.drones` reflects the route output, and the top bar's "LIVE · N" updates without other panels re-rendering.
```

---

## Stream D — Violation engine (depends on C)

**Owns:** Computing per-fix violations against active zones (user-drawn + Stream B's static layer), emitting `Alert` records into the store.

**Files:** new `src/lib/violation-engine.ts` (pure, no React), wire into `use-drone-stream.ts` from Stream C.

**Acceptance:**
- Function signature: `evaluate(drone: DroneFix, zones: ZoneFeature[]): Alert[]` — returns one alert per zone the drone is inside.
- Uses `@turf/turf` `booleanPointInPolygon` (already installed).
- `expiresAt` is honoured: temporary zones whose `expiresAt < now` are skipped.
- `ceilingM`: if drone `altM < zone.properties.ceilingM`, no alert (drone is below the legal floor of the zone). If `ceilingM` is undefined, any altitude triggers.
- Severity: airport/military = `high`; country-park = `medium`; everything else = `low`.
- Coalesce duplicates: don't push an alert if there's an open alert for `(droneId, zoneId)` in the last 5 s.
- Push via `useApp.getState().pushAlert` — alerts slice already exists.

**Agent prompt:**
```
You're implementing Stream D of Orgs/frontend/IMPLEMENTATION_PLAN.md. Pure logic — write `src/lib/violation-engine.ts` with unit tests in `src/lib/violation-engine.test.ts` (vitest if available, otherwise `node --test`). Acceptance criteria in the Stream D section. Don't touch the map or the alert UI — Stream E owns those visuals. The engine must be wired into Stream C's stream hook so every DroneFix is evaluated; subscribe in `use-drone-stream.ts`.
```

---

## Stream E — Alert feed UI + incident report panel (depends on D)

**Owns:** A bottom-docked or right-rail alert feed surfacing live violations, plus an "Generate incident report" affordance using an LLM call.

**Files:** new `src/components/alert-feed.tsx`, new `src/components/incident-report-modal.tsx`, new `src/app/api/incident-report/route.ts` (Anthropic API call — server only).

**Acceptance:**
- Alert feed lists newest first; each row shows time-ago, severity badge, drone ID, zone name, "Generate report" button.
- On click → modal with structured fields (location, altitude, timestamp, drone category, risk level, recommended authority, confidence score) — populated by an Anthropic API call using the alert + drone + zone as input.
- Use `claude-haiku-4-5` for the report (fast, cheap).
- API key from `process.env.ANTHROPIC_API_KEY` — server-only.
- The top bar `ALERTS` chip turns red and counts up.
- Dismissable; dismissed alerts are removed from the active feed but stay in `state.alerts` (no destructive delete).

**Agent prompt:**
```
You're implementing Stream E of Orgs/frontend/IMPLEMENTATION_PLAN.md. UI surface for alerts + LLM-generated incident reports. Use Anthropic's SDK (`npm i @anthropic-ai/sdk`) on the server side. The skill `claude-api` has the canonical pattern — invoke it before writing the route handler. The dashboard layout currently has 2 columns (map | aside); add the alert feed as a horizontal strip below the map, OR a tab inside the existing aside. Pick one and document the choice. Do not touch Stream A/B/C/D files outside reading their types.
```

---

## Stream F — Top-bar liveness + brand polish (parallel, low risk)

**Owns:** V7, V10. Makes the dashboard feel "alive" without altering behavior.

**Files:** `src/components/top-bar.tsx`, `src/components/dashboard.tsx`, `public/` cleanup.

**Acceptance:**
- TopBar `LIVE` chip: pulsing radar-green dot before the text. Tint changes to red when `state.alerts.length > 0`.
- TopBar `ALERTS NN` chip: when `> 0` render with `border-alarm-500/40 bg-alarm-500/10 text-alarm-400` + tiny shake animation on increment.
- TopBar adds a "CONNECTION" indicator that polls `/api/health` (Stream C) every 5 s — green dot if 200, red if not.
- `rm public/{file,globe,next,vercel,window}.svg`. Replace `app/favicon.ico` with a small generated cyan shield favicon (or leave default — call it).
- Side-panel `<aside>` `Stat` block: `TOT` becomes `text-2xl ink-hi`, `PERM`/`TMP` become `text-xs ink-med` — restore hierarchy.

**Agent prompt:**
```
You're implementing Stream F of Orgs/frontend/IMPLEMENTATION_PLAN.md. Visual polish only — top bar liveness + dashboard chrome cleanup. Files in the Stream F section. Don't touch the map or the store. After your changes, run Playwright at 1440×900 and confirm visually that the dashboard feels "live" (pulsing dot, animated alarms) — submit screenshots.
```

---

## Stream G — Responsive aside + zone form (parallel, low risk)

**Owns:** V8. Makes the dashboard usable on a 1024-px laptop and adds richer per-zone editing.

**Files:** `src/components/zone-panel.tsx`, new `src/components/zone-detail-panel.tsx`, `src/components/dashboard.tsx`.

**Acceptance:**
- `<aside>` collapses to a slim 56-px rail under `1100px` viewport width with a chevron toggle; full width on click. Use CSS container queries or Tailwind responsive prefixes.
- Selecting a zone opens a detail panel below the list with editable fields: `name`, `category` (radio), `kind` (toggle), `ceilingM` (number input, m AGL), `expiresAt` (datetime-local), `notes` (textarea). Edits call `patchZoneProps`.
- The 340-px aside also gets a keyboard shortcut: `[` to collapse, `]` to expand.

**Agent prompt:**
```
You're implementing Stream G of Orgs/frontend/IMPLEMENTATION_PLAN.md. Responsive aside + per-zone detail editing. Files in the Stream G section. Don't touch the map or the store actions other than calling `patchZoneProps`. After your changes, drive Playwright at 1024×768, 1280×720, 1920×1080 and confirm no horizontal scroll at any breakpoint.
```

---

## Dependency graph

```
A ──┐
B ──┼── ship parallel (independent)
F ──┤
G ──┘
       
C ── D ── E
(C must land before D; D before E)
```

Recommended fanout (the user can spawn these as 4 parallel sub-agents at once):

| Wave | Agents | Why |
|---|---|---|
| 1 | A, B, F, G (all four in parallel) | independent, all visual / data layers |
| 2 | C (single agent, blocking) | sets up the live-data backbone |
| 3 | D, E (parallel after C lands) | both consume C's stream |

---

## Out-of-scope (do NOT do)

- Drawing improvements to Terra Draw itself (vertex snapping, midpoint UX). Upstream bugs in `terra-draw#593`, `#710` are not ours to fix.
- Direct edits in `Orgs/system2-positioning-engine/`. If a System 2 change is needed (e.g. a `GET /positions` endpoint), file an issue / ping the System 2 owner.
- Building a separate auth layer — use Vercel preview password or `basic-auth` middleware. Real auth is out of scope for the hackathon.
- Multi-camera triangulation logic. Lives in System 2.
- Drone identification / eSUA cross-reference. Stretch goal per `Idea.md` — leave a `TODO` marker only.

---

## Definition of Done (whole System 3)

A judge clicking around at 1440 × 900 should be able to:
1. See Hong Kong on a dark vector map with airport / country parks / military zones pre-loaded as coloured permanent no-fly areas.
2. Draw a polygon / rectangle / circle anywhere — it lands as a cyan temporary zone in the side panel with a unique monotonic name.
3. Toggle it to PERM → polygon recolours to radar green, both on map and badge.
4. Select another zone → map fly-to + glow ring around its polygon.
5. See live drone pins moving on the map (fed by System 2 via `/api/positions`).
6. When a pin enters a zone, an alert appears bottom-right; the ALERTS chip turns red; "Generate report" opens a structured LLM-authored incident report.
7. Undo / Redo the last few zone edits.
8. Resize to 1024 → aside collapses, map still readable.
9. Zero console errors. Zero TypeScript errors. `npm run build` green.
