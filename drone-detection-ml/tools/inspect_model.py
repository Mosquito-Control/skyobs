"""Print an ONNX YOLO model's input/output shapes and embedded metadata.

    python tools/inspect_model.py [models/yolov8n-drone.onnx]
"""
import sys

import onnxruntime as ort

path = sys.argv[1] if len(sys.argv) > 1 else "models/yolov8n-drone.onnx"
sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

print("== inputs ==")
for i in sess.get_inputs():
    print(f"  {i.name}  shape={i.shape}  dtype={i.type}")
print("== outputs ==")
for o in sess.get_outputs():
    print(f"  {o.name}  shape={o.shape}  dtype={o.type}")
print("== embedded metadata ==")
for k, v in sess.get_modelmeta().custom_metadata_map.items():
    print(f"  {k}: {v}")
