# Architecture — How the ML fits into the whole system

> Audience: teammates and AI agents working on any part of the drone
> airspace-monitoring system. This explains what the ML component does, the exact
> contracts at its boundaries, and how data flows end-to-end.

---

## 1. The whole system at a glance

Four components, each its own repo, plus the Unity simulator:

```
                         ┌─────────────────────────────────────────────┐
                         │  this repo: drone-detection-ml               │
                         │  the model + inference + bearing geometry     │
                         └───────────────────┬─────────────────────────┘
                                             │ imported by
                                             ▼
 Unity sim ─┐                ┌──────────────────────────┐  POST /events  ┌────────────────────────┐
 (Marius)   ├─RTSP stream──► │ system1-detection-agent  │ ─────────────► │ system2-positioning-   │
 Real cam ──┘  (per camera)  │ (Cristiana)              │  bearing vec   │ engine (Filipp)        │
                             │  capture → YOLO → bearing │                │  ray triangulation     │
                             │           → POST          │                │  → GPS position        │
                             └──────────────────────────┘                └───────────┬────────────┘
                                                                                      │ positions table
                                                                                      ▼
                                                                          ┌────────────────────────┐
                                                                          │ System 3 dashboard     │
                                                                          │ (Bogdan): map, zones,  │
                                                                          │ alerts                 │
                                                                          └────────────────────────┘
```

| Component | Repo | Owner | Responsibility |
|---|---|---|---|
| **ML model** | `drone-detection-ml` (this) | Cristiana | Detect drones in a frame; convert pixel → ENU bearing |
| System 1 — detection agent | `system1-detection-agent` | Cristiana | Runtime: pull RTSP frames, run the model, POST events to System 2 |
| System 2 — positioning | `system2-positioning-engine` | Filipp | Triangulate bearings from ≥2 cameras → GPS position → DB |
| System 3 — dashboard | (tbd) | Bogdan | Map of HK, forbidden zones, show drones, alerts |
| Simulator | Unity | Marius | Render cameras and expose them as RTSP streams |

**This repo is the "brain".** It does not open cameras, does not talk to the
network, and does not own any threads. It exposes two things that
`system1-detection-agent` imports:
1. `DroneDetector` — frame → detections (the model).
2. `bbox_center_to_bearing` — pixel → ENU bearing (the bridge to System 2).

---

## 2. One perception path (RTSP + YOLO)

**Unity cameras and real cameras are identical to System 1** — both are RTSP
streams; only the URL in `cameras.yaml` differs. Every frame, from every camera,
runs through the model:

```
RTSP frame ─► DroneDetector.detect() ─► [Detection(cx, cy, score, cls, bbox), ...]
                                              │
                                              ▼  bbox_center_to_bearing(cx, cy, ...)
                                        ENU bearing [E, N, U]
```

The bearing comes from the camera's surveyed `azimuth / elevation / hfov / vfov`
(in System 1's `cameras.yaml`).

> **Why your model matters for the demo:** because the Unity demo runs over RTSP,
> the demo itself runs *this* YOLO model — there is no separate ground-truth
> detection path. The model is on the critical path for both Unity and real cameras.

### Ground truth (evaluation only, not detection)

Unity also broadcasts UDP JSON label datagrams (port 9870) with ground-truth drone
positions and boxes. These are **not** part of the detection pipeline. System 1's
`tools/unity_gt_listener.py` reads them to (a) evaluate YOLO output against truth
and (b) read camera `rot_q` values when deriving the `azimuth/elevation` for
`cameras.yaml`. Treat them as a test/calibration aid only.

---

## 3. The output contract (ML/System 1 → System 2)

Everything the ML produces is ultimately shaped into this POST. **This is the one
contract that must never drift.**

`POST {SYSTEM2_URL}/events`

```json
{
  "cam_id": "cam_01",
  "timestamp": "2026-06-06T14:23:00.456Z",
  "detections": [
    { "bearing_vector": [0.342, 0.876, -0.340], "score": 0.87 }
  ]
}
```

| Field | Meaning | Hard rule |
|---|---|---|
| `cam_id` | which camera | must match System 2's `cameras.yaml` exactly, else **silently dropped** |
| `timestamp` | UTC time of the frame (captured at frame read) | drift between cameras > ~0.5 s breaks triangulation's time window |
| `bearing_vector` | unit `[E, N, U]` direction to the drone | must be ENU and unit-length |
| `score` | YOLO confidence | 0..1 |

`detections: []` is valid (camera sees nothing this frame).

---

## 4. The bridge: pixel → ENU bearing (the math that matters)

A wrong bearing produces a wrong GPS position **with no error anywhere** — System 2
will happily triangulate garbage. This is the highest-risk code in the system, so
it is pinned by `tests/test_geometry.py`.

**ENU frame:** `+E` east, `+N` north, `+U` up (right-handed).

`bbox_center_to_bearing(u, v, w, h, az, el, hfov, vfov)`:
```
α = az + ((u - w/2)/w) · hfov        # azimuth, clockwise from North
φ = el - ((v - h/2)/h) · vfov        # elevation, up positive
[E,N,U] = [cosφ·sinα, cosφ·cosα, sinφ]   (then normalized)
```

**Invariants the tests lock down:**
- center pixel → the camera's own `(azimuth, elevation)` direction
- north-facing center → `[0,1,0]`
- pixel right of center → leans East; pixel above center → higher elevation
- output is always a unit vector

> Earlier there was also a Unity/quaternion path (`sim_bearing`). It was removed
> when System 1 unified on RTSP+YOLO; both repos now expose only
> `bbox_center_to_bearing`.

---

## 5. End-to-end data flow

```
1. Unity (or a real camera) exposes each camera as an RTSP stream
2. System 1 pulls frames (OpenCV), one worker thread per camera
3. Per frame: DroneDetector.detect() → for each detection, bbox_center_to_bearing(...) → [E,N,U]
4. System 1 POSTs one /events per camera to System 2
5. System 2 caches bearings; when ≥2 cameras report the same drone within the
   time window, it triangulates the ray intersection → lat/lon/alt → positions table
6. System 3 polls positions, draws them on the HK map, checks forbidden zones, alerts
```

A position should appear in System 2's DB within ~1 s of the drone being visible
to two cameras.

---

## 6. Boundaries an agent must respect

| Boundary | Contract | Where defined |
|---|---|---|
| ML → System 1 | `DroneDetector.detect(frame) -> list[Detection]` | `src/drone_detector/detector.py` |
| pixel → world | `bbox_center_to_bearing(...) -> (E, N, U)` unit vector | `src/drone_detector/geometry.py` |
| System 1 → System 2 | `POST /events` JSON above | this doc + System 2 repo |
| Camera → System 1 | RTSP `rtsp://host:8554/camN` (H.264, 1280×720) | Marius + System 1 `cameras.yaml` |
| Unity ground truth | UDP JSON labels on port 9870 (eval/calibration only) | System 1 `tools/unity_gt_listener.py` |
| System 2 → System 3 | `positions` table (lat, lon, alt_m, cam_pair, …) | System 2 repo |

### Silent-failure traps (no error is raised — verify these manually)
1. `cam_id` mismatch with System 2's `cameras.yaml` → events dropped.
2. Non-ENU or non-unit bearing → wrong GPS, no error.
3. Wrong `azimuth/elevation/FOV` in `cameras.yaml` → bearings point the wrong way.
4. Clock drift between cameras → triangulation time window misses.

---

## 7. Where to change what

- **Better detection / new weights** → swap `models/yolov8n-drone.onnx`; point
  System 1's `MODEL_PATH` at it. No code change.
- **Long-range / small drones** → add SAHI in `detector.py` (see MODEL_CARD).
- **Bearing math** → `geometry.py` here is the canonical reference; keep
  `system1-detection-agent/system1/geometry.py` identical, and run the tests in
  both repos.
- **New camera** → add it to System 1 and System 2 `cameras.yaml` with matching
  `cam_id`, plus the correct RTSP URL and orientation.
