from datetime import datetime
from pydantic import BaseModel, field_validator


class Detection(BaseModel):
    bearing_vector: list[float]  # [E, N, U] unit vector in ENU frame
    score: float

    @field_validator("bearing_vector")
    @classmethod
    def _check_length(cls, v: list[float]) -> list[float]:
        # numpy ops downstream assume length-3; reject early so a malformed
        # producer surfaces as a 422 instead of a triangulation crash.
        if len(v) != 3:
            raise ValueError(f"bearing_vector must have length 3, got {len(v)}")
        return v


class CameraEvent(BaseModel):
    cam_id: str
    timestamp: datetime
    detections: list[Detection]


class Position(BaseModel):
    timestamp: datetime
    lat: float
    lon: float
    alt_m: float
    cam_pair: str
    score_i: float | None
    score_j: float | None
