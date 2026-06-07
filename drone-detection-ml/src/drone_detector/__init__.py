"""drone-detection-ml — the ML component of the drone airspace-monitoring system.

Exposes:
    DroneDetector            — YOLOv8 ONNX inference, frame -> detections
    Detection                — one detection (pixel bbox center + score + class)
    bbox_center_to_bearing   — pixel -> ENU bearing vector (bridge to System 2)
"""

from .detector import Detection, DroneDetector
from .geometry import bbox_center_to_bearing

__all__ = [
    "DroneDetector",
    "Detection",
    "bbox_center_to_bearing",
]
