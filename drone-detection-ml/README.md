# drone-detection-ml

**The machine-learning component of the drone airspace-monitoring system.**
It detects drones in a camera frame and converts each detection into an ENU
bearing vector — the input System 2 needs to triangulate a drone's GPS position.

Part of the drone airspace-monitoring system:
`drone-detection-ml` (this) · `system1-detection-agent` · `system2-positioning-engine`.

> **New here? Read [`ARCHITECTURE.md`](ARCHITECTURE.md)** — it explains how this
> component combines with System 1 → 2 → 3 and the Unity simulator, with the exact
> contracts at every boundary. This README is the quickstart.

---

## What it does (one picture)

```
camera frame ──► DroneDetector (YOLOv8 ONNX) ──► detections (pixel bbox + score)
                                                      │
                                                      ▼  bbox_center_to_bearing / sim_bearing
                                              ENU bearing [E, N, U]  ──► System 2 (triangulation → GPS)
```

This repo is the **brain**: pure perception + geometry. It opens no cameras and
talks to no network — `system1-detection-agent` imports it and does the I/O.
Unity cameras and real cameras are both RTSP streams, so **this model runs on
every camera** — including the Unity demo.

---

## The model

Two models are available:

### Fine-tuned YOLOv11x (recommended)

Trained on 17,351 images from two public datasets (Zhejiang University + DetFly).
Weights on HuggingFace: **[FilippTrigub/yolov11x-drone-finetuned](https://huggingface.co/FilippTrigub/yolov11x-drone-finetuned)**

```python
from huggingface_hub import hf_hub_download
pt_path = hf_hub_download("FilippTrigub/yolov11x-drone-finetuned", "weights/best.pt")
```

| | |
|---|---|
| Input | 640×640 RGB |
| Classes | `{0: drone}` |
| Precision | 0.775 |
| Recall | 0.606 |
| mAP@0.5 | 0.555 |
| mAP@0.5:0.95 | 0.279 |

Evaluated on 2,320 images (Zhejiang + DetFly val sets combined). See [`BENCHMARKS.md`](BENCHMARKS.md) for full comparison.

### Baseline YOLOv8n (bundled)

`models/yolov8n-drone.onnx` — lighter, faster, less accurate.

| | |
|---|---|
| Input | 640×640 RGB |
| Output | `[1, 300, 6]`, NMS inside the graph |
| Classes | `{0: drone, 1: unused}` → **use class 0** |
| Measured | 5/6 test drones detected, conf 0.37–0.84; misses small/distant ones |

Full details and test results: [`models/MODEL_CARD.md`](models/MODEL_CARD.md).

---

## Quickstart

```bash
pip install -r requirements.txt

# 1. inspect the model (shapes + metadata)
python tools/inspect_model.py

# 2. confirm it detects drones on the bundled samples
python tools/batch_test.py

# 3. test on YOUR camera (point it at a drone clip/photo; press q to quit)
python tools/test_camera_detect.py --source 0
#    or a single image / video:
python tools/test_camera_detect.py --source samples/drone_1.jpg
python tools/test_camera_detect.py --source clip.mp4
```

Tuning: lower `--conf 0.15` to catch more drones; raise it to cut false positives.
For real-time multi-camera, install `onnxruntime-gpu` instead of `onnxruntime`.

---

## Use it from code

```python
import sys; sys.path.insert(0, "src")
from drone_detector import DroneDetector, bbox_center_to_bearing

det = DroneDetector("models/yolov8n-drone.onnx", conf=0.25, classes=[0])

for d in det.detect(frame):                 # frame = BGR numpy array
    bearing = bbox_center_to_bearing(
        d.cx, d.cy, frame.shape[1], frame.shape[0],
        azimuth_deg=45.0, elevation_deg=-10.0, hfov_deg=90.0, vfov_deg=60.0,
    )
    # bearing is the [E, N, U] unit vector to POST to System 2 as "bearing_vector"
```

The `azimuth/elevation/hfov/vfov` come from the camera's entry in System 1's
`cameras.yaml`. See [`ARCHITECTURE.md` §4](ARCHITECTURE.md) for the math and conventions.

---

## The output contract (must never drift)

`POST {SYSTEM2_URL}/events`
```json
{ "cam_id": "cam_01", "timestamp": "2026-06-06T14:23:00.456Z",
  "detections": [ { "bearing_vector": [0.342, 0.876, -0.340], "score": 0.97 } ] }
```
`cam_id` must match System 2's `cameras.yaml`; `bearing_vector` is a unit ENU
vector; `timestamp` is NTP-synced UTC. Details + silent-failure traps in
[`ARCHITECTURE.md` §3, §6](ARCHITECTURE.md).

---

## Tests

The bearing geometry is the highest-risk code (a wrong bearing = wrong GPS with no
error). It is pinned by unit tests:

```bash
python tests/test_geometry.py      # 7 invariants, no pytest needed
# or: pytest tests/
```

> Keep `src/drone_detector/geometry.py` identical to
> `system1-detection-agent/system1/geometry.py`. If you change one, change both and
> run the tests in both repos.

---

## Layout

```
drone-detection-ml/
├── README.md                 # you are here
├── ARCHITECTURE.md           # how it combines with the rest (read this)
├── models/
│   ├── yolov8n-drone.onnx     # the model
│   └── MODEL_CARD.md          # specs, limits, measured behaviour
├── src/drone_detector/
│   ├── detector.py            # DroneDetector — frame → detections
│   └── geometry.py            # pixel → ENU bearing (canonical reference)
├── tools/                     # inspect_model, batch_test, test_camera_detect
├── tests/test_geometry.py     # bearing-math invariants
└── samples/                   # sample drone images
```

## License
Model is AGPL-3.0 (inherited from Ultralytics). See `models/MODEL_CARD.md`.
