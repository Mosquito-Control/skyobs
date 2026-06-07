# Fine-Tuning Handoff

> Goal: improve the drone detector — especially on small/distant drones — by fine-tuning
> the existing `yolov11x-drone.pt` checkpoint on two additional Roboflow datasets.

---

## What we have

| File | Architecture | Size | Status |
|---|---|---|---|
| `models/yolov8n-drone.onnx` | YOLOv8 nano | ~12 MB | documented, baseline |
| `models/yolov8x-drone.pt` | YOLOv8 extra-large | — | undocumented, untested |
| `models/yolov11x-drone.pt` | YOLOv11 extra-large | — | **start here for fine-tuning** |
| `models/yolov11x-drone.onnx` | YOLOv11 extra-large | — | ready to deploy |

**Use `yolov11x-drone.pt` as the fine-tuning base.** YOLOv11 is the current Ultralytics
architecture; the `.pt` checkpoint lets you resume training with a `yolo train` call.

---

## Step 1 — Download the datasets (browser required)

Cloudflare blocks `curl` on these URLs. Open in a browser, save the zip, and extract to the
paths below.

### Dataset A — Zhejiang University (4,231 images, ground camera)

Download URL: `https://universe.roboflow.com/ds/A1H28MXHoT?key=d2Tqk2u8xU`

Extract to:
```
drone-detection-ml/datasets/zhejiang/
```

Expected structure after extraction:
```
datasets/zhejiang/
├── train/
│   ├── images/
│   └── labels/
├── valid/
│   ├── images/
│   └── labels/
├── test/
│   ├── images/
│   └── labels/
└── data.yaml
```

### Dataset B — YOLOv8 DetFly (6,913 images, varied backgrounds)

Download URL: `https://universe.roboflow.com/ds/YmAtgUcqZh?key=ATVxRpFgZp`

Extract to:
```
drone-detection-ml/datasets/detfly/
```

Same folder structure as above.

---

## Step 2 — Merge datasets

Run the merge script to create a combined dataset that `yolo train` can consume:

```bash
cd drone-detection-ml
python tools/merge_datasets.py
```

This creates `datasets/combined/` with:
```
datasets/combined/
├── train/images/   ← all train images from both datasets
├── train/labels/   ← all train labels from both datasets
├── valid/images/
├── valid/labels/
└── data.yaml       ← single YAML pointing at combined/
```

---

## Step 3 — Fine-tune

```bash
cd drone-detection-ml

yolo train \
  model=models/yolov11x-drone.pt \
  data=datasets/combined/data.yaml \
  epochs=50 \
  imgsz=640 \
  batch=16 \
  patience=10 \
  project=runs/finetune \
  name=yolov11x-combined
```

Adjust `batch` down to 8 if you hit VRAM limits. Output lands in
`runs/finetune/yolov11x-combined/weights/best.pt`.

### Key flags

| Flag | Value | Why |
|---|---|---|
| `model` | `models/yolov11x-drone.pt` | Resume from existing fine-tuned checkpoint |
| `imgsz` | 640 | Matches model export; do not change for ONNX compatibility |
| `patience` | 10 | Early-stop if val mAP stops improving |
| `epochs` | 50 | Conservative for fine-tuning (not training from scratch) |

---

## Step 4 — Export to ONNX

```bash
yolo export \
  model=runs/finetune/yolov11x-combined/weights/best.pt \
  format=onnx \
  imgsz=640 \
  simplify=True \
  nms=True
```

Copy the resulting `.onnx` to `models/yolov11x-drone-v2.onnx` and update
`system1-detection-agent` to point at it.

---

## Step 5 — Validate

```bash
# quick sanity check on existing samples
python tools/batch_test.py runs/finetune/yolov11x-combined/weights/best.pt samples/

# compare against original nano baseline
python tools/batch_test.py models/yolov8n-drone.onnx samples/
```

Look for: (a) same detections still firing, (b) the previously missed small/distant drone
now detected.

---

## Known weakness being targeted

From `models/MODEL_CARD.md`:

> Small/distant drone vs treeline → **MISSED** even at conf 0.10

The Zhejiang dataset (ground camera perspective) and DetFly (varied backgrounds including
sky clutter) both contribute examples in this regime. The Drone-vs-Bird challenge dataset
(see `research/DATASETS.md`) would push this further if acquired.

---

## Dataset format note

Roboflow exports use the same `.txt` label format for both "YOLOv8" and "YOLOv11" format
options — they are identical. Either works. The architecture is determined solely by the
`model=` checkpoint, not the dataset format.

---

## Files created by this sprint

| Path | Purpose |
|---|---|
| `datasets/zhejiang/` | Zhejiang University drone dataset (to be downloaded) |
| `datasets/detfly/` | DetFly drone dataset (to be downloaded) |
| `datasets/combined/` | Merged training set (created by merge script) |
| `tools/merge_datasets.py` | Merge script |
| `runs/finetune/` | Training outputs (gitignored) |
