"""Run the drone model over every image in a folder and report detections.

    python tools/batch_test.py                 # uses models/yolov8n-drone.onnx, samples/
    python tools/batch_test.py <model> <folder>
"""
import glob
import os
import sys

import cv2
from ultralytics import YOLO

model_path = sys.argv[1] if len(sys.argv) > 1 else "models/yolov8n-drone.onnx"
folder = sys.argv[2] if len(sys.argv) > 2 else "samples"
out_dir = "samples_annotated"
os.makedirs(out_dir, exist_ok=True)

model = YOLO(model_path, task="detect")
print(f"classes: {model.names}\n")

imgs = sorted(glob.glob(os.path.join(folder, "*.jpg")) + glob.glob(os.path.join(folder, "*.png")))
hits = 0
for path in imgs:
    res = None
    for conf in (0.25, 0.10):
        r = model.predict(path, conf=conf, imgsz=640, verbose=False)[0]
        if len(r.boxes):
            res = (conf, r)
            break
    name = os.path.basename(path)
    if res is None:
        print(f"{name:18s} -> NO detection (even @0.10)")
        continue
    conf, r = res
    hits += 1
    dets = [f"cls{int(b.cls[0])}:{float(b.conf[0]):.2f}" for b in r.boxes]
    print(f"{name:18s} -> {len(r.boxes)} det @>={conf}: {dets}")
    cv2.imwrite(os.path.join(out_dir, name), r.plot())

print(f"\n{hits}/{len(imgs)} images had a detection. Annotated -> {out_dir}/")
