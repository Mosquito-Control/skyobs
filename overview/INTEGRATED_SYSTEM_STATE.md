# Sky Observations (SkyObs) — Integrated System State (Systems 1–5)

**Date**: 2026-06-07 (System 5 Unity simulator documented)
**Status**: Full 5-system pipeline wired, deployed, and verified end-to-end

---

## Executive Summary

**Sky Observations (SkyObs)** is a real-time drone airspace monitoring system designed for a Hong Kong deployment context. It ingests video from multiple fixed cameras, detects drones using ML, triangulates their GPS position, tracks them over time, and displays everything on an operator dashboard that enforces configurable no-fly zones.

### What it does end-to-end

1. **Detect** — Fixed cameras stream RTSP video. A YOLO model runs on each frame and converts bounding-box detections into 3D bearing vectors (ENU coordinate frame).
2. **Localise** — A positioning engine collects bearing vectors from all cameras and triangulates the drone's WGS84 GPS position by finding the midpoint of the closest-approach line between paired bearing rays. No depth model is needed — camera geometry alone yields the 3D position.
3. **Track** — A tracking engine reads the raw position stream and runs greedy nearest-neighbour association to stitch detections into persistent tracks. Each track accumulates a trail of timestamped `track_points`.
4. **Display & alert** — A browser dashboard polls positions and tracks, renders them on a MapLibre map of Hong Kong, and fires zone-violation alerts whenever any drone (real, tracked, or synthetic) crosses an operator-defined or static no-fly zone boundary.

### System boundaries

| System | Role | Runtime |
|---|---|---|
| **System 5** — Unity Simulator | Virtual drone scene + mediamtx RTSP server | Unity on local workstation |
| **System 1** — Detection Agent | Per-camera YOLO inference + bearing vector POST | Python process on camera host |
| **System 2** — Positioning Engine | Multi-camera triangulation → `positions` DB table | FastAPI on Azure Container Apps |
| **System 3** — Operator Dashboard | Map UI · zone alerts · track polylines | Next.js on Azure Container Apps |
| **System 4** — Tracking Engine | Greedy track association → `tracks` / `track_points` tables | FastAPI on Azure Container Apps |

### Shared data store

All systems communicate through a single **Azure PostgreSQL** instance (`dronedetection` DB, `drone-detection-pg.postgres.database.azure.com`). System 2 writes raw positions; System 4 reads positions and writes tracks; System 3 reads both. There is no direct API coupling between System 4 and System 3 — the database is the integration boundary.

### Key design decisions

- **Triangulation over monocular depth**: bearing-vector intersection gives sub-metre GPS accuracy across the camera overlap zone without any depth model.
- **ENU coordinate frame**: all bearing vectors use East-North-Up so azimuth/elevation angles from any camera orientation compose correctly before converting to WGS84.
- **Greedy track association**: nearest-neighbour within 50 m / 3 s is simple, fast, and sufficient for low-drone-count deployments; tunable via env vars.
- **Synthetic background traffic**: SIM-001/002/003 drones are always running in the dashboard so the alert engine and zone logic are always demonstrable without a live camera feed.
- **Degraded-mode resilience**: System 3 degrades silently if System 4 is unavailable — raw detection dots still appear; track polylines simply disappear.

### Deployment

All server-side components run as Docker containers on **Azure Container Apps** (westeurope). The PostgreSQL server is in northeurope. System 5 (Unity simulator) runs locally on the developer workstation and is not deployed to Azure. All five repositories live under the `github.com/Mosquito-Control/` org.

---

## Architecture Overview

```
┌─────────────────────┐
│     System 5        │  Mosquito-Control/system5-unity-simulation
│  Unity Simulator    │  Unity · mediamtx RTSP server
│  (or physical cam)  │  2 virtual cameras · drone actor
└────────┬────────────┘
         │  RTSP streams (rtsp://localhost:8554/cam0, /cam1)
         ▼
┌─────────────────────┐
│     System 1        │  Mosquito-Control/system1-detection-agent
│  Detection Agent    │  Python · YOLO · per-camera threads
└────────┬────────────┘
         │  POST /events  (HTTP, JSON)
         ▼
┌─────────────────────┐
│     System 2        │  Mosquito-Control/system2-positioning-engine
│  Positioning Engine │  FastAPI · Azure Container Apps
│                     │  triangulation loop every 500ms
└────────┬────────────┘
         │  INSERT positions (psycopg2)
         ▼
┌────────────────────────────────────────────┐
│              Azure PostgreSQL              │
│  drone-detection-pg.postgres.database…     │
│  tables: positions · tracks · track_points │
└──────────┬────────────────────┬────────────┘
           │ SELECT positions   │ SELECT tracks + track_points
           │ (poll every 1s)    │ (poll every 1.5s via /api/tracks)
           ▼                    │
┌─────────────────────┐         │
│     System 4        │         │
│  Tracking Engine    │         │
│  Python · FastAPI   │         │
│  Azure Container    │         │
│  Apps               │         │
│  50m/3s assoc ·     │         │
│  lost after 10s     │         │
└──────────┬──────────┘         │
           │ INSERT/UPDATE      │
           │ tracks,            │
           │ track_points       │
           └────────────────────┤
                                ▼
                    ┌─────────────────────┐
                    │     System 3        │  Mosquito-Control/system3-operator-dashboard
                    │ Operator Dashboard  │  Next.js 16 · MapLibre · Zustand
                    │  Azure Container    │  raw detection dots
                    │  Apps               │  polyline track trails + colored dots
                    │                     │  SIM-001/002/003 synthetic overlay
                    │                     │  zone-violation alert engine
                    └─────────────────────┘
```

---

## System 5 — Unity Simulator

**Repo**: `https://github.com/Mosquito-Control/system5-unity-simulation`
**Status**: Local development tool — not deployed to Azure

### What it does

System 5 is the simulation substitute for physical cameras. It runs a Unity scene containing a drone actor and two fixed virtual cameras, then streams the camera feeds over RTSP via **mediamtx** so that System 1 can consume them without modification.

In production, System 5 is replaced entirely by physical cameras serving real RTSP streams. System 1 has no awareness of whether its upstream source is simulated or physical — the RTSP URL is the only coupling point.

### How it works

1. **Unity scene** — a virtual environment models the Hong Kong area with two fixed cameras placed at known GPS coordinates and orientations (matching `cameras.yaml` in System 2).
2. **Drone actor** — a controllable drone flies through the scene. Ground-truth position can be logged for triangulation validation.
3. **mediamtx** — bundled RTSP media server re-publishes the Unity camera render textures as RTSP streams. Each camera maps to one stream path.
4. **System 1 connects** to `rtsp://localhost:8554/cam0` and `rtsp://localhost:8554/cam1` exactly as it would to physical cameras.

### RTSP stream mapping

| mediamtx path | Unity camera | System 1 `cam_id` |
|---|---|---|
| `/cam0` | Camera 1 (south-facing) | `cam_01` |
| `/cam1` | Camera 2 (north-facing, ~190 m north) | `cam_02` |

### Virtual camera configuration

The Unity cameras are placed to match the reference origin and positions defined in System 2's `cameras.yaml`:

| Camera | Lat | Lon | Alt | Azimuth | Elevation | HFOV |
|---|---|---|---|---|---|---|
| cam_01 | 22.3193 | 114.1694 | 15 m | 0° | −15° | 90° |
| cam_02 | 22.3210 | 114.1694 | 15 m | 90° | −15° | 90° |

### Running

```bash
# Start mediamtx (bundled or standalone)
./mediamtx mediamtx.yml

# Open the Unity project and enter Play mode — streams begin automatically.
# System 1 can now connect as usual:
python -m system1.main
```

### Key design decisions

- **Drop-in replacement**: System 1's `cameras.yaml` uses the same URLs (`rtsp://localhost:8554/cam0`) for both simulator and physical cameras — no code changes needed when switching.
- **Matching geometry**: the virtual camera placement exactly mirrors the real-world positions in System 2's `cameras.yaml`, so triangulation validation results transfer directly to the physical deployment.
- **mediamtx over Unity native RTSP**: mediamtx gives stable, well-tested RTSP output and decouples the Unity render loop from the streaming protocol, avoiding frame-sync issues.

---

## System 1 — Detection Agent

**Repo**: `https://github.com/Mosquito-Control/system1-detection-agent`
**Status**: Implemented, tested with mock System 2

### What it does
- Reads RTSP streams (one thread per camera)
- Runs YOLOv8 inference on each frame
- Converts bounding box centres to 3D ENU bearing vectors
- POSTs `CameraEvent` to System 2 on every frame with detections

### Key config (`cameras.yaml` + env)

| Setting | Value | Override |
|---|---|---|
| System 2 URL | `https://system2-api.agreeablesea-31719cb5.westeurope.azurecontainerapps.io` | `SYSTEM2_URL` |
| YOLO weights | `yolov8s.pt` | `MODEL_PATH` |
| Confidence threshold | `0.35` | `CONF_THRESHOLD` |
| Min POST interval | `0.1s` | `POST_INTERVAL_S` |
| Post empty detections | `false` | `POST_EMPTY_DETECTIONS` |

### Camera config (`cameras.yaml`)

```yaml
cameras:
  - cam_id: cam_01
    stream_url: rtsp://localhost:8554/cam0   # Unity mediamtx cam 0
    azimuth_deg: 0.0
    elevation_deg: -15.0
    hfov_deg: 90.0
    vfov_deg: 60.0

  - cam_id: cam_02
    stream_url: rtsp://localhost:8554/cam1   # Unity mediamtx cam 1
    azimuth_deg: 90.0
    elevation_deg: -15.0
    hfov_deg: 90.0
    vfov_deg: 60.0
```

### POST /events payload

```json
{
  "cam_id": "cam_01",
  "timestamp": "2026-06-06T12:30:00.123Z",
  "detections": [
    { "bearing_vector": [0.606, 0.576, 0.515], "score": 0.91 }
  ]
}
```

**bearing_vector** is a 3D ENU (East-North-Up) unit vector:
```
E = cos(φ) * sin(α)   N = cos(φ) * cos(α)   U = sin(φ)
```
where α = azimuth (°, clockwise from north) and φ = elevation (°, above horizon).

### Running

```bash
cd system1-detection-agent
pip install -r requirements.txt
python -m system1.main          # real RTSP mode
python tests/e2e/run_e2e.py     # E2E test (no Unity needed)
```

---

## System 2 — Positioning Engine

**Repo**: `https://github.com/Mosquito-Control/system2-positioning-engine`
**Live API**: `https://system2-api.agreeablesea-31719cb5.westeurope.azurecontainerapps.io`
**Status**: Deployed on Azure Container Apps, verified

### What it does
- Receives `POST /events` from System 1 cameras
- Buffers detections in a per-camera ring cache (300 events max)
- Every 500ms: attempts triangulation for all camera pairs using skew-line midpoint in ENU
- Accepts intersections only within 500m of each camera
- Converts accepted ENU intersection to WGS84 (lat/lon/alt)
- Upserts to `positions` table; also flushes raw camera events to DB every 5s

### Live endpoints

| Endpoint | Purpose |
|---|---|
| `POST /events` | Receive detection event from System 1 |
| `GET /health` | Returns `{status, cache_size, db_ok}` |

### Azure resources (resource group: `drone-detection`)

| Resource | Name | Region |
|---|---|---|
| PostgreSQL Flexible Server | `drone-detection-pg` | northeurope |
| Container Registry | `dronedetectionacr` | westeurope |
| Container Apps environment | `drone-detection-env` | westeurope |
| Container App | `system2-api` | westeurope |
| Container App | `system3-dashboard` | westeurope |
| Container App | `system4-tracking` | westeurope |

### Runtime config

| Var | Value | Meaning |
|---|---|---|
| `MAX_DISTANCE_M` | 500 | Max metres from each camera for valid intersection |
| `TIME_WINDOW_S` | 1.0 | How far back in cache to look per triangulation run |
| `CACHE_SIZE` | 300 | Max events in ring buffer across all cameras |
| `LOOP_INTERVAL_S` | 0.5 | Triangulation loop cadence |
| `DB_FLUSH_INTERVAL_S` | 5.0 | How often raw events flush to DB |

### Camera configuration (`cameras.yaml` in repo)

```yaml
reference_origin:
  lat: 22.3193
  lon: 114.1694
  alt_m: 0.0

cameras:
  - id: cam_01
    lat: 22.3193
    lon: 114.1694
    alt_m: 15.0
  - id: cam_02
    lat: 22.3210    # ~190m north of cam_01
    lon: 114.1694
    alt_m: 15.0
```

To add cameras: add entries here and redeploy — no code changes needed.

### `positions` table schema

```sql
SELECT id, timestamp, lat, lon, alt_m, cam_pair, score_i, score_j, inserted_at
FROM positions ORDER BY inserted_at DESC;
```

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | Auto-increment |
| `timestamp` | TIMESTAMPTZ | UTC time of source detections |
| `lat` / `lon` | DOUBLE PRECISION | WGS84 |
| `alt_m` | DOUBLE PRECISION | Metres above sea level |
| `cam_pair` | TEXT | e.g. `cam_01+cam_02` |
| `score_i/j` | DOUBLE PRECISION | ML detection confidence |
| `inserted_at` | TIMESTAMPTZ | Server write time |

### Local dev

```bash
cd system2-positioning-engine
docker-compose up    # FastAPI on :8000 + Postgres on :5432
```

---

## System 4 — Tracking Engine

**Repo**: `https://github.com/Mosquito-Control/system4-tracking-engine`
**Live API**: `https://system4-tracking.agreeablesea-31719cb5.westeurope.azurecontainerapps.io`
**Status**: Deployed on Azure Container Apps, DB connected, tracker loop running

### What it does
- Polls `positions` table every 1s since its last cursor (`inserted_at` watermark)
- Greedy nearest-neighbour association per new detection:
  - Finds all active tracks with `last_seen` within `ASSOC_TIME_S`
  - Picks the nearest if within `ASSOC_DIST_M`; otherwise starts a new track
- Updates `tracks.last_lat/lon/alt_m/last_seen/point_count` on match
- Inserts one `track_points` row per detection, linking it to `positions.id`
- Marks tracks with `last_seen < NOW() - LOST_AFTER_S` as `lost`

### Live endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{status, activeTracks, dbOk}` |
| `GET /tracks?window_m=5&trail_points=50` | All tracks active in last N minutes, with trail |
| `GET /tracks/{id}?trail_points=200` | Single track with full history |

### DB tables (migration: `migrations/001_create_tracks.sql`)

**`tracks`**

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | Auto-increment track ID |
| `first_seen` | TIMESTAMPTZ | Timestamp of first linked detection |
| `last_seen` | TIMESTAMPTZ | Timestamp of most recent linked detection |
| `last_lat/lon/alt_m` | DOUBLE PRECISION | WGS84 position of last point |
| `point_count` | INTEGER | Total detections linked |
| `status` | TEXT | `active` or `lost` |

**`track_points`**

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | |
| `track_id` | INTEGER | FK → `tracks.id` |
| `position_id` | INTEGER | FK → `positions.id` |
| `timestamp` | TIMESTAMPTZ | Detection time |
| `lat/lon/alt_m` | DOUBLE PRECISION | WGS84 |
| `inserted_at` | TIMESTAMPTZ | Server write time |

### Runtime config

| Var | Value | Meaning |
|---|---|---|
| `DATABASE_URL` | droneadmin @ drone-detection-pg | Full read+write |
| `ASSOC_DIST_M` | 50 | Max metres to associate to existing track |
| `ASSOC_TIME_S` | 3.0 | Max seconds since track's last point |
| `LOST_AFTER_S` | 10.0 | Idle seconds before marking track lost |
| `LOOP_INTERVAL_S` | 1.0 | Tracker poll cadence |

### Local dev

```bash
cd system4-tracking-engine
cp .env.example .env    # fill in droneadmin DATABASE_URL
pip install -r requirements.txt
uvicorn system4.main:app --reload --port 8001
```

---

## System 3 — Operator Dashboard

**Repo**: `https://github.com/Mosquito-Control/system3-operator-dashboard`
**Live URL**: `https://system3-dashboard.agreeablesea-31719cb5.westeurope.azurecontainerapps.io`
**Status**: Deployed on Azure Container Apps, connected to Azure PostgreSQL

### What it does
- Polls `positions` table every 1.5s (`/api/positions`) — raw detection dots on map
- Polls `tracks` + `track_points` every 1.5s (`/api/tracks`) — polyline trail + colored dot per track
- Runs synthetic background traffic (SIM-001/002/003) always on for demo continuity
- Zone-violation alert engine fires on entry for all drone IDs (raw, tracked, synthetic)
- Operator can draw/edit/save restricted zones on the map
- Alerts panel lists all violations with severity and drone ID

### Data streams

| Stream | Hook | ID format | Always on? |
|---|---|---|---|
| Real detections | `usePositions` | `cam_01+cam_02#<row_id>` | Yes |
| System 4 tracks | `useTracks` | `t-<track_id>` | Yes (degrades silently if unavailable) |
| Synthetic background | `useDroneStream` | `SIM-001`, `SIM-002`, `SIM-003` | Yes |

All three feed into the same Zustand `drones` store and through the same alert engine.
`useTracks` additionally writes to a separate `tracks` store slice for the polyline layer.

### Alert engine (`use-alert-engine.ts`)

Subscribes to `drones` store. On each update:
1. Runs `booleanPointInPolygon` for every drone against every enabled drawn zone
2. Runs same check against every enabled HK static no-fly zone
3. Fires `pushAlert` on zone **entry only** (re-entry after exit fires again)

Severity: `high` — military / airport / vip / any HK static zone · `medium` — event / country-park / custom

### Required `.env.local` (local dev only — not committed)

```
DATABASE_URL=postgresql://system3_reader:system3reader@drone-detection-pg.postgres.database.azure.com/dronedetection?sslmode=require
NEXT_PUBLIC_POSITIONS_POLL_MS=1500
POSITIONS_LIMIT=200
```

### Running locally

```bash
cd system3-operator-dashboard
npm install
cp .env.example .env.local   # fill in DATABASE_URL above
npm run dev                   # dashboard on http://localhost:3000
npm run probe                 # verifies System 2 API + DB + /api/positions route
```

### Key source files

```
src/
├── app/api/
│   ├── positions/route.ts     # SELECTs from positions table
│   └── tracks/route.ts        # SELECTs from tracks + track_points tables
├── components/
│   ├── dashboard.tsx          # mounts all four hooks
│   ├── tracks-layer.tsx       # polyline trail + colored dot per track
│   ├── alerts-layer.tsx       # alert dots on map
│   ├── map-canvas.tsx         # zone draw/edit, point-in-polygon for clicks
│   └── hk-no-fly-layer.tsx    # HK static no-fly zone rendering
└── lib/
    ├── use-positions.ts       # raw DB poll hook
    ├── use-tracks.ts          # System 4 track poll hook
    ├── use-drone-stream.ts    # synthetic SIM-* stream
    ├── use-alert-engine.ts    # zone-violation alert engine
    ├── pg-pool.ts             # postgres connection pool (server-only)
    ├── store.ts               # Zustand store (drones, zones, alerts, tracks)
    └── types.ts               # DroneFix, Alert, Track, TrackPoint, ZoneFeature
```

---

## Database Access

Server: `drone-detection-pg.postgres.database.azure.com` / DB: `dronedetection`

| Role | Password | Tables accessible |
|---|---|---|
| `droneadmin` | in System 2 + System 4 container env | Full admin on all tables |
| `system3_reader` | `system3reader` | SELECT on `positions`, `tracks`, `track_points` |

---

## Integration Verification Checklist

- [x] System 5 streams available — mediamtx serving `rtsp://localhost:8554/cam0` and `/cam1`
- [x] System 1 E2E test passes (bearing vectors, cam_id, POSTs reach System 2)
- [x] System 2 deployed — `/health` returns `{"status":"ok","cache_size":0}`
- [x] DB migration run — `tracks` + `track_points` tables exist, `system3_reader` SELECT grants applied
- [x] System 4 deployed — `/health` returns `{"status":"ok","activeTracks":0,"dbOk":true}`
- [x] System 4 `/tracks` returns `{"tracks":[],"asOf":"..."}` (empty until System 1 streams)
- [x] System 3 deployed — dashboard root returns 200
- [x] System 3 `/api/tracks` returns `{"tracks":[],"degraded":false}`
- [x] System 3 TypeScript build green (0 errors)
- [x] Track polyline trail + colored dot layers present in map component tree
- [x] Alert engine wired to `t-<id>` drone IDs from `useTracks`
- [x] All five repos pushed to `github.com/Mosquito-Control/`

---

## Known Risks / Gotchas

| Risk | Impact | Mitigation |
|---|---|---|
| System 5 camera geometry differs from `cameras.yaml` | Triangulated positions are off even with correct detections | Keep Unity camera placement exactly in sync with System 2 `cameras.yaml` |
| mediamtx frame drops under load | System 1 misses frames, detection rate drops | Keep Unity running at stable frame rate; mediamtx is low overhead |
| System 1 clock drift >0.5s from NTP | Events fall outside System 2 time window, silently dropped | Ensure NTP on all System 1 hosts |
| `cam_id` mismatch between System 1 and System 2 `cameras.yaml` | Events silently dropped | Both have `cam_01`, `cam_02` — keep in sync |
| Bearing vector in wrong coordinate frame | Wrong positions, no error | ENU frame required: E=cos(φ)sin(α), N=cos(φ)cos(α), U=sin(φ) |
| `ASSOC_DIST_M` too tight for fast-moving drones | Detections create new tracks instead of extending existing ones | Tune upward if drone speed > ~17 m/s (50m / 3s) |
| `ASSOC_TIME_S` too loose with multiple drones | Wrong drone gets a detection linked to it | Reduce if tracks are being mis-merged |
| `system3_reader` default password | Low security | Acceptable for hackathon; rotate before production |
| `positions` or `tracks` schema changes | Downstream queries break silently | Coordinate across all four systems before column changes |
| System 3 `NEXT_PUBLIC_*` vars baked at build time | Changing poll interval requires image rebuild + redeploy | Rebuild from `system3-operator-dashboard/` Dockerfile |
