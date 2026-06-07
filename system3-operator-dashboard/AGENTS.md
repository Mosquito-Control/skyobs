<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Zone rendering contract

There are two zone sources on the map and they render through **different
pipelines on purpose**. When you touch zone code, keep the two paths
structurally identical — same property names, same disable semantics, same
click strategy — so behaviour stays predictable across both.

### Drawn (custom / operator) zones
- State of truth: `useApp().zones` (zustand) + terra-draw's internal store.
- Rendering: terra-draw's own layers, styled by the JS `polygonStyles`
  function in `map-canvas.tsx`. Styles read `properties.kind`,
  `properties.selected`, `properties.hiddenByFilter`, `properties.disabled`
  off each feature.
- Disable: `disabledZoneIds[id]` → `td.updateFeatureProperties(id, {disabled: true})`,
  which causes `polygonStyles.fillOpacity / outlineWidth` to return 0 via
  `isInvisible`.

### Static (HK permanent) zones
- State of truth: `public/data/hk-permanent-zones.geojson`, fetched by
  `hk-no-fly-layer.tsx` and also indexed into `useApp().staticZones`.
- Rendering: MapLibre `fill` / `line` layers backed by a single GeoJSON
  source. Paint expressions read `["get", "disabled"]` off each feature.
- Disable: `disabledZoneIds[id]` → mutate `properties.disabled` on the
  in-memory features array → `source.setData(...)` to push the whole
  collection. This mirrors the drawn-zone pattern (property + repaint)
  rather than using `feature-state`. Don't reintroduce `feature-state` —
  the hover/selected layer would override it, and `setData` can race
  with the `feature-state` cache during data refreshes.

### Click & hover
Both zone types are clicked through **one** handler in `map-canvas.tsx`
(`onMapClick`, `onMapMouseMove`). It does point-in-polygon against
`zones` first, then `staticZones`. Do NOT add a per-layer click handler
inside `hk-no-fly-layer.tsx` — `queryRenderedFeatures` is unreliable when
the source has just been `setData`-reissued.

### ID fallbacks
Some OSM features ship with no `id`. Both `use-static-zones.ts` and
`hk-no-fly-layer.tsx` fall back to `hk-${idx}` — and they must stay in
sync, because `disabledZoneIds` and `selectedStaticZoneId` key off this
shared id. If one drifts, panel toggles silently miss the corresponding
map feature.

### HTTP cache
The geojson fetches use `cache: "no-store"`. The data file gets
rewritten by `scripts/merge-zones.mjs` during dev — `force-cache` pinned
the browser to the pre-merge version even on hard reload until the SW
was purged. Don't switch back.

## System 2 integration (live positions)

The dashboard polls triangulated drone positions out of System 2's Postgres,
via a server-only Next.js route. The contract was defined in
`Tion-ping/research/SYSTEM_2_STATE.md` — "System 3 polls detected positions
from DB". We honour that: no per-position HTTP roundtrip to System 2's API,
just direct SELECT on the `positions` table.

### Where the wiring lives
- `src/lib/pg-pool.ts` — module-singleton `pg.Pool`. Defaults to System 2's
  local docker-compose DSN (`system3_reader@localhost:5432/dronedetection`).
  Override via `DATABASE_URL`.
- `src/app/api/positions/route.ts` — `GET /api/positions?since=<iso>&limit=<n>`.
  Returns `{ positions: Position[], degraded: boolean }`. Never 5xxs.
- `src/lib/use-positions.ts` — React Query hook, 1.5s poll, tracks the last
  `inserted_at` in a ref so each tick asks for strictly-newer rows. Maps
  `Position → DroneFix` and ingests via `useApp().ingestDrones`.
- `src/components/dashboard.tsx` — mounts `usePositions(true)`. The old
  `useDroneStream` stub is now dev-injector only.

### Local end-to-end
1. Start System 2: `cd Tion-ping/system2-positioning-engine && docker compose up -d`
2. Start the dashboard: `npm run dev`
3. Verify: `npm run probe` — should show pass on all three tiers (health, PG, route).
4. Drive triangulation with a synthetic event pair:
   ```bash
   curl -X POST http://localhost:8000/events \
     -H 'Content-Type: application/json' \
     -d '{"cam_id":"cam_01","timestamp":"<iso-now>","detections":[{"bearing_vector":[0.606,0.576,0.515],"score":0.93}]}'
   # …and the same for cam_02 with bearing_vector [0.606,-0.576,0.515]
   ```
   Within ~1s a triangulated row should appear in `positions`, and within
   the next poll tick a drone dot should appear on the map.

### Tests
- `npm run test:route` — spins up `postgres:16` on `:55432`, applies System
  2's `positions` schema, seeds backdated rows, runs the exact SQL the route
  uses, and asserts 9 behaviours of the route+hook contract. Real PG, real
  schema, no mocks.
- `npm run probe` — exercises the live local stack tier-by-tier. Exits 0
  on graceful degradation (warn), non-zero only on a malformed route
  response (which would mean the frontend itself is broken).

### Gotchas
- The route filters by `inserted_at` (server write time), NOT `timestamp`
  (detection time). When seeding fixtures, set `inserted_at` explicitly or
  the cursor logic won't behave like production.
- `pgPool()` caches on `globalThis.__dronePgPool` to survive Next.js's
  per-request module re-evaluation. If you swap the DSN at runtime, you
  need to clear that global or restart the dev server.
- System 2 does NOT expose `GET /cameras`. The seed at
  `public/data/cameras-seed.geojson` is the camera registry as far as
  System 3 is concerned. Don't reintroduce the proxy without coordination.

### Regenerating the static zones
`node scripts/merge-zones.mjs` reads
`public/data/hk-permanent-zones.geojson` and rewrites it in place
(airport+approaches unioned, touching parks merged, downtown bboxes
appended, polygons smoothed). The script is idempotent on a merged
input (no further unions to find) but you'll usually want to restore
from a backup of the original 57-feature OSM snapshot before tweaking
the rules — keep a `.bak` locally; it's gitignored.
