# Drone Detection Datasets — Research Notes

> Researched 2026-06-06. For context on why we need these, see RESEARCH.md §ML Models: Detection.

## What the current model misses

`yolov8n-drone.onnx` (nano): misses small/distant drones against clutter.
`yolov11x-drone.pt` and `yolov8x-drone.pt` (extra-large, fine-tuned) are in `models/` but undocumented — test these first before acquiring new data.

---

## Datasets, ranked by relevance

### 1. Anti-UAV (CVPR Challenge) — strongest match

**Why top**: static ground camera → drone at range, full-HD RGB + IR video, organized by HKU + PolyU (Hong Kong universities). Closest institutional and environmental match to the deployment target.

| Property | Value |
|---|---|
| Size | 410 video sequences |
| Resolution | Full HD |
| Modalities | RGB + IR |
| Camera | Static ground camera |
| Drone scales | Small to large |
| Latest challenge | CVPR 2025 (4th edition) |
| Access | Register at anti-uav.github.io |

- Homepage: https://anti-uav.github.io/
- GitHub: https://github.com/ZhaoJ9014/Anti-UAV

---

### 2. Drone-vs-Bird Detection Challenge — targets the exact weakness

The 2025 IJCNN Grand Challenge (8th edition) winner used YOLOv11 + multi-scale + copy-paste augmentation on this dataset. Designed explicitly for small drones that are visually confusable with birds — the known hard case.

| Property | Value |
|---|---|
| Size | 77+ video sequences (grows each year) |
| Resolution | 720×576 to 3840×2160 |
| Camera | Static + moving |
| Key challenge | Drone vs. bird discrimination at range |

- Paper (1st place 2025): https://arxiv.org/abs/2504.19347
- Supplementary / dataset links: https://raysonlaroca.github.io/supp/drone-vs-bird/

---

### 3. Roboflow Universe — fastest to use (ready today)

Already annotated in YOLO format; direct `yolo train` integration via `roboflow` Python package.

| Dataset | Images | Notes |
|---|---|---|
| [Drones Detection with YOLOv8 (Zhejiang Univ.)](https://universe.roboflow.com/zhejiang-university-china-dliq1/drones-detection-with-yolov8) | 4,231 | Ground camera perspective |
| [YOLOv8_DetFly(02)](https://universe.roboflow.com/yolov8-drone-detection/yolov8_detfly-02) | 6,913 | UAV images, varied backgrounds |
| [DroneDet](https://universe.roboflow.com/yolov8-qsle1/dronedet-9ndje) | 1,339 | Open source drone images |

```bash
pip install roboflow
# then download whichever dataset in "yolov11" format (same labels, model-agnostic)
```

---

### 4. SimD3 — synthetic, high-fidelity (not yet public)

- Unreal Engine 5 + Cosys-AirSim (same sim stack we're using)
- Drones with heterogeneous payloads; bird distractors; diverse weather + lighting
- Good for augmenting training data once released
- Paper: https://arxiv.org/abs/2601.14742
- Status: pending public release as of Jan 2026

---

### 5. DUT Anti-UAV (already in RESEARCH.md)

- 10,000 frames, RGB + thermal, urban/rural/indoor
- Still worth including as part of a combined training set

---

## Model / dataset format note

The Roboflow datasets export in "YOLOv8" or "YOLOv11" format — these are **identical label formats** (same `.txt` annotation files, same `data.yaml` structure). The only difference is the model checkpoint passed to `yolo train`. Use `yolov11x-drone.pt` as the starting checkpoint for further fine-tuning.

```bash
# Fine-tune from the existing YOLOv11x checkpoint
yolo train model=models/yolov11x-drone.pt data=combined.yaml epochs=50 imgsz=640
```

---

## Recommended acquisition order

1. **Now**: Download Zhejiang University Roboflow dataset (no registration, YOLO format)
2. **This week**: Register for Anti-UAV challenge dataset (HKU/PolyU, best env match)
3. **This week**: Download Drone-vs-Bird sequences (addresses the small-drone weakness directly)
4. **Later**: SimD3 once publicly released (synthetic augmentation)
