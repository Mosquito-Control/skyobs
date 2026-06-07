# System 2 — Positioning Engine: Architecture

## Role in the Pipeline

System 2 sits between the camera detection layer (System 1) and the map/dashboard (System 3).

```
System 1 (cameras)
  → POST /events  →  System 2 (positioning engine)
                         → positions table  →  System 3 (dashboard)
```

## Responsibilities

1. Receive detection events from N cameras via HTTP POST
2. Buffer events in an in-memory rolling cache
3. Periodically run multi-camera ray triangulation to compute drone positions
4. Persist raw events and triangulated positions to the database

---

## Input: Camera Event (POST /events)

Each camera sends a POST after every detection frame:

```json
{
  "cam_id": "cam_01",
  "timestamp": "2026-06-06T12:00:00.000Z",
  "detections": [
    {
      "bearing_vector": [ax, ay, az],
      "score": 0.92
    }
  ]
}
```

- `bearing_vector`: unit vector in a shared absolute coordinate frame (ENU or ECEF), pointing from the camera toward the detected object
- `score`: ML detection confidence
- One event may contain zero or more detections (empty list = no drone seen this frame)

Camera positions (GPS lat/lon/alt) are registered in the DB at startup — not sent per-event.

---

## In-Memory Cache

- **Type**: thread-safe ring buffer
- **Size**: 50 events total across all cameras (configurable: `CACHE_SIZE`)
- Incoming events are appended; oldest are evicted when full
- Periodically flushed to `camera_events` DB table and cleared

---

## Triangulation Loop

Runs on a background timer every `LOOP_INTERVAL_S` seconds.

### Step 1 — Time-window slice

Pull all events from the cache where `now - timestamp < TIME_WINDOW_S`.

### Step 2 — All-pairs intersection

For every pair of cameras `(C_i, C_j)` present in the slice:
- For every detection `d_i` from `C_i` and every detection `d_j` from `C_j`:
  - Compute the closest point between the two bearing rays (skew-line midpoint algorithm)
  - The rays are: `origin = camera_position`, `direction = bearing_vector`

### Step 3 — Distance filter

Accept the intersection point `P` only if:

```
distance(P, C_i.position) < MAX_DISTANCE_M
AND
distance(P, C_j.position) < MAX_DISTANCE_M
```

This prevents far-field false intersections where two rays happen to meet at an irrelevant point far from both cameras.

### Step 4 — Persist

Valid intersection points are upserted to the `positions` table for System 3 to poll.

---

## Skew-Line Midpoint Algorithm

Given two rays:
- Ray 1: origin **p₁** (camera 1 position), direction **d₁** (unit vector)
- Ray 2: origin **p₂** (camera 2 position), direction **d₂** (unit vector)

```
w  = p₁ - p₂
a  = d₁ · d₁  (= 1 if unit vectors)
b  = d₁ · d₂
c  = d₂ · d₂  (= 1 if unit vectors)
d  = d₁ · w
e  = d₂ · w

denom = a*c - b*b

t₁ = (b*e - c*d) / denom
t₂ = (a*e - b*d) / denom

closest_on_ray1 = p₁ + t₁ * d₁
closest_on_ray2 = p₂ + t₂ * d₂

intersection = (closest_on_ray1 + closest_on_ray2) / 2
```

Reject if `t₁ < 0` or `t₂ < 0` (intersection is behind a camera).
Reject if `denom ≈ 0` (rays are parallel).

---

## Database Schema

### `camera_positions` (registered at startup)

| column | type | notes |
|---|---|---|
| cam_id | TEXT PK | |
| lat | REAL | WGS84 |
| lon | REAL | WGS84 |
| alt_m | REAL | meters above sea level |

### `camera_events` (raw event log)

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| cam_id | TEXT | |
| timestamp | TEXT | UTC ISO-8601 |
| detections | TEXT | JSON array |
| inserted_at | TEXT | server time |

### `positions` (triangulated results, polled by System 3)

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| timestamp | TEXT | UTC, from the detection events |
| x_m | REAL | local Cartesian, metres from reference origin |
| y_m | REAL | |
| z_m | REAL | altitude |
| lat | REAL | converted WGS84 |
| lon | REAL | converted WGS84 |
| alt_m | REAL | |
| cam_pair | TEXT | e.g. "cam_01+cam_02" |
| score_i | REAL | detection confidence from camera i |
| score_j | REAL | detection confidence from camera j |
| inserted_at | TEXT | server time |

---

## Configuration

| parameter | default | description |
|---|---|---|
| `MAX_DISTANCE_M` | 500 | max distance from each camera to accept an intersection |
| `TIME_WINDOW_S` | 1.0 | how far back (seconds) to look in the cache per triangulation run |
| `CACHE_SIZE` | 50 | max events held in memory across all cameras |
| `LOOP_INTERVAL_S` | 0.5 | how often the triangulation loop fires |
| `DB_FLUSH_INTERVAL_S` | 5.0 | how often the cache is persisted to DB and flushed |

---

## File Layout

```
system2/
├── config.py          # all configurable parameters
├── models.py          # Pydantic schemas: CameraEvent, Detection, Position
├── cache.py           # thread-safe ring buffer (deque + Lock)
├── triangulation.py   # skew-line midpoint + distance filter (numpy)
├── db.py              # SQLite connection, table init, upsert helpers
├── loop.py            # background threads: triangulation loop + DB flush loop
├── api.py             # FastAPI app, POST /events
└── main.py            # startup: init DB, start loops, mount API
```

---

## Coordinate System Note

Cameras report positions in WGS84 (lat/lon/alt). Triangulation works in local Cartesian metres (ENU — East/North/Up) relative to a configurable reference origin (e.g. the centroid of the camera array). Results are converted back to WGS84 before being written to the `positions` table.
