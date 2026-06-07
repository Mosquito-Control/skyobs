# Model Card — `yolov8n-drone.onnx`

## Summary

YOLOv8-nano fine-tuned for drone detection, exported to ONNX with end-to-end NMS.
This is the perception model for the drone airspace-monitoring system: it finds
drones in a camera frame and returns pixel bounding boxes.

## Specs (read from the ONNX metadata)

| Property | Value |
|---|---|
| Architecture | YOLOv8n (Ultralytics) |
| Format | ONNX, opset via Ultralytics export, `simplify: true` |
| Input | `images`, shape `[1, 3, 640, 640]`, float32, RGB |
| Output | `output0`, shape `[1, 300, 6]` — **NMS baked in** (`[x1,y1,x2,y2,score,cls]`, max 300) |
| Stride | 32 |
| Classes | `{0: drone, 1: (unused in practice)}` — **filter to class 0** |
| Exported by | Ultralytics 8.3.241, 2025-12-29 |
| License | AGPL-3.0 (inherited from Ultralytics) |
| Size | ~12 MB |

Because NMS is inside the graph, **do not** add your own NMS. Ultralytics' `YOLO()`
loader handles preprocessing (letterbox to 640) and the baked-in NMS automatically.

## Measured behaviour (CPU, onnxruntime)

Tested on 6 public drone images (`SlapBot/drone-detection`):

| Case | Result |
|---|---|
| Clear drone, sky background | detected, **conf 0.69–0.84** |
| Drone on cluttered ground | detected, **conf 0.37** |
| Small/distant drone vs treeline | **MISSED** even at conf 0.10 |
| Overall | **5/6 detected**; every detection was class `0` |

**Strength:** close / clear / sky-background drones.
**Weakness:** small or distant drones against visual clutter — the known hard case
for nano models. Mitigations: lower `conf`, add SAHI (sliced inference) for
long range, or move to a larger backbone (YOLOv8s/m) if latency budget allows.

## Recommended inference settings

| Setting | Value | Why |
|---|---|---|
| `conf` | 0.25 (demo), 0.15 (max recall) | balance misses vs false positives |
| `classes` | `[0]` | only the drone class |
| `imgsz` | 640 | matches the export; do not change |
| provider | `onnxruntime-gpu` for live multi-camera | CPU is fine for single-stream testing |

## How to reproduce the checks

```bash
python tools/inspect_model.py            # dump shapes + metadata
python tools/batch_test.py               # run over samples/, report detections
```
