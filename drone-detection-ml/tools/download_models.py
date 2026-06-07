"""Download and export drop-in replacement anti-drone detection models.

    python tools/download_models.py

Each model is downloaded as a .pt file, exported to ONNX with NMS baked in
(matching the existing yolov8n-drone.onnx format: [1, 300, 6]), then the
intermediate .pt is removed — unless "pt" is set, in which case the .pt is
kept at that path for fine-tuning.

Models:
  - doguilmak/Drone-Detection-YOLOv11x  (YOLOv11x, mAP@0.5=90.5%, MIT)
  - doguilmak/Drone-Detection-YOLOv8x   (YOLOv8x, Kaggle drone dataset)

Skipped (requires Roboflow API key):
  - "Drones YOLO11 A" (mAP@0.5=95.6%, 9,900 images)
      from roboflow import Roboflow
      rf = Roboflow(api_key="YOUR_KEY")
      rf.workspace("drone-a7lpy").project("drones-yolo11-a").version(1).download("yolov11")
"""

import os
from huggingface_hub import hf_hub_download
from ultralytics import YOLO

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")

DOWNLOADS = [
    {
        "repo": "doguilmak/Drone-Detection-YOLOv11x",
        "remote": "weight/best.pt",
        "onnx": "yolov11x-drone.onnx",
        "pt": "yolov11x-drone.pt",  # kept for fine-tuning
        "note": "YOLOv11x fine-tuned, mAP@0.5=90.5%, MIT license",
    },
    {
        "repo": "doguilmak/Drone-Detection-YOLOv8x",
        "remote": "weight/best.pt",
        "onnx": "yolov8x-drone.onnx",
        "note": "YOLOv8x fine-tuned on Kaggle drone dataset",
    },
]


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)

    for m in DOWNLOADS:
        dest_onnx = os.path.join(MODELS_DIR, m["onnx"])
        dest_pt = os.path.join(MODELS_DIR, m["pt"]) if "pt" in m else None

        onnx_exists = os.path.exists(dest_onnx)
        pt_exists = dest_pt is not None and os.path.exists(dest_pt)

        if onnx_exists and (dest_pt is None or pt_exists):
            size_mb = os.path.getsize(dest_onnx) / 1e6
            print(f"[skip]  {m['onnx']} already exists ({size_mb:.0f} MB)")
            if dest_pt and pt_exists:
                size_mb_pt = os.path.getsize(dest_pt) / 1e6
                print(f"[skip]  {m['pt']} already exists ({size_mb_pt:.0f} MB)")
            continue

        print(f"[dl]    {m['repo']} → (temp .pt)")
        print(f"        {m['note']}")
        pt_path = hf_hub_download(
            repo_id=m["repo"],
            filename=m["remote"],
            local_dir=MODELS_DIR,
        )

        if not onnx_exists:
            print(f"[export] → {m['onnx']}")
            model = YOLO(pt_path)
            exported = model.export(format="onnx", nms=True, imgsz=640)
            os.rename(exported, dest_onnx)
            size_mb = os.path.getsize(dest_onnx) / 1e6
            print(f"        done — {size_mb:.0f} MB")

        if dest_pt and not pt_exists:
            os.rename(pt_path, dest_pt)
            size_mb_pt = os.path.getsize(dest_pt) / 1e6
            print(f"[keep]  {m['pt']} — {size_mb_pt:.0f} MB")
        else:
            os.remove(pt_path)

        # remove empty weight/ subdir left by hf_hub_download
        weight_dir = os.path.join(MODELS_DIR, "weight")
        if os.path.isdir(weight_dir) and not os.listdir(weight_dir):
            os.rmdir(weight_dir)

        print()

    print("Models in models/:")
    for f in sorted(os.listdir(MODELS_DIR)):
        if f.endswith((".onnx", ".pt")):
            size_mb = os.path.getsize(os.path.join(MODELS_DIR, f)) / 1e6
            print(f"  {f:<35s} {size_mb:5.0f} MB")


if __name__ == "__main__":
    main()
