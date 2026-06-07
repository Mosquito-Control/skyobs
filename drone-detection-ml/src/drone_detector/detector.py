"""YOLOv8 ONNX inference wrapper for drone detection.

This is the ML "brain": it turns a camera frame into a list of drone detections
(pixel bounding-box centers + confidence). It does NOT compute bearings or POST
anything — that is the job of System 1 (the detection agent), which imports this.

The bundled model `models/yolov8n-drone.onnx`:
  - input  : 640x640 RGB
  - output : NMS baked in (end-to-end export)
  - classes: {0: drone, 1: unused in practice}  -> filter to class 0

Swap the model by pointing `model_path` at any Ultralytics-exported .pt/.onnx.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Detection:
    """One detected object in a single frame."""
    cx: float          # bounding-box center x, pixels (origin top-left)
    cy: float          # bounding-box center y, pixels (y increases downward)
    score: float       # confidence 0..1
    cls: int           # class id (0 = drone for the bundled model)
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 in pixels


class DroneDetector:
    """Loads a YOLO model once and runs per-frame inference.

    Args:
        model_path: path to a .onnx or .pt model.
        conf: confidence threshold.
        classes: class ids to keep (e.g. [0] for drone-only); None keeps all.
        imgsz: inference resolution (model is exported at 640).
    """

    def __init__(
        self,
        model_path: str = "models/yolov8n-drone.onnx",
        conf: float = 0.25,
        classes: list[int] | None = (0,),
        imgsz: int = 640,
    ) -> None:
        from ultralytics import YOLO  # heavy import, deferred

        self._model = YOLO(model_path, task="detect")
        self._conf = conf
        self._classes = list(classes) if classes is not None else None
        self._imgsz = imgsz
        self.names = self._model.names

    def detect(self, frame) -> list[Detection]:
        """Run inference on one BGR frame (numpy array) or image path.

        Returns a list of Detection, one per object above threshold.
        """
        res = self._model.predict(
            frame,
            conf=self._conf,
            classes=self._classes,
            imgsz=self._imgsz,
            verbose=False,
        )[0]

        out: list[Detection] = []
        for b in res.boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            out.append(
                Detection(
                    cx=(x1 + x2) / 2.0,
                    cy=(y1 + y2) / 2.0,
                    score=float(b.conf[0]),
                    cls=int(b.cls[0]),
                    bbox=(x1, y1, x2, y2),
                )
            )
        return out
