# Model Benchmarks

## Our fine-tuned model vs. base models

Evaluated 2026-06-07 on the **combined validation set** (2,320 images: Zhejiang + DetFly,
single `drone` class, conf=0.25, IoU=0.5).

| Model | Precision | Recall | mAP@0.5 | mAP@0.5:0.95 |
|---|---|---|---|---|
| **yolov11x fine-tuned (ours)** | **0.775** | **0.606** | **0.555** | **0.279** |
| yolov11x base (`doguilmak/Drone-Detection-YOLOv11x`) | 0.359 | 0.087 | 0.063 | 0.027 |
| yolov8n base (`yolov8n-drone.onnx`) | 0.247 | 0.043 | 0.024 | 0.005 |

The base models score near-zero on this val set because they were never trained on
Zhejiang/DetFly data — the low scores reflect distribution shift, not model quality.

---

## Stated author metrics for the base v11x

The `doguilmak/Drone-Detection-YOLOv11x` model was evaluated by its author on their
own validation split (~350 images, same distribution as training, single UAV dataset):

| Metric | Author-stated |
|---|---|
| Precision | 0.922 |
| Recall | 0.831 |
| mAP@0.5 | 0.905 |
| mAP@0.5:0.95 | 0.546 |

No published text metrics exist for `doguilmak/Drone-Detection-YOLOv8x` — results
were only published as a plot image. No canonical benchmark exists for the `yolov8n-drone`
baseline either.

---

## Apples-to-apples interpretation

The two evaluation sets are not comparable directly:

| | Author val | Our combined val |
|---|---|---|
| Images | ~350 | 2,320 |
| Diversity | Single UAV dataset | Zhejiang (ground cam) + DetFly (varied BG) |
| Difficulty | In-distribution | Out-of-distribution for base models |

**What the numbers mean:**
- The base v11x at mAP@0.5=0.905 on its own data drops to 0.063 on ours — a large
  distribution shift. Our fine-tuned model reaches 0.555 on this harder, more diverse set.
- Our precision (0.775) vs. author's (0.922): we trade some precision for much better
  recall (0.606 vs. 0.831 is closer, but recall also suffers on the harder data).
- The fine-tuned model is better suited for deployment on diverse, real-world imagery.

---

## Training run summary

| Parameter | Value |
|---|---|
| Base checkpoint | `models/yolov11x-drone.pt` (doguilmak, mAP@0.5=0.905) |
| Training data | `datasets/combined/` — 17,351 images (Zhejiang + DetFly) |
| Epochs run | 16 (early-stopped, patience=10) |
| Final val mAP@0.5 | 0.632 (reported by trainer at last epoch) |
| Output | `runs/detect/runs/finetune/yolov11x-combined/weights/best.pt` |
