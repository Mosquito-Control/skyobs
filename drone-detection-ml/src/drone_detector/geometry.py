"""Pixel bounding-box  ->  ENU bearing vector.

This is the BRIDGE between the ML model and the rest of the system. The model
says "there is a drone at pixel (u, v) in camera C"; System 2 needs a direction
in world space to triangulate. This converts a pixel + the camera's surveyed
orientation into a unit `[E, N, U]` bearing vector — exactly the `bearing_vector`
field in System 2's `/events` contract.

This module is the CANONICAL reference for the bearing math. The production copy
runs inside `system1-detection-agent` (`system1/geometry.py`) and must stay
identical; the unit tests in `tests/test_geometry.py` pin the conventions.

Conventions:
    ENU world frame: +E east, +N north, +U up   (right-handed)
    azimuth: degrees clockwise from North (the way the camera faces)
    elevation: degrees above the horizon (negative = looking down)

Note: an earlier design also had a Unity/quaternion path (`sim_bearing`). That
was removed when System 1 unified on a single RTSP+YOLO pipeline — Unity cameras
are now ordinary RTSP streams, so every camera uses `bbox_center_to_bearing`.
"""

import math


def bbox_center_to_bearing(
    u: float,
    v: float,
    img_width: int,
    img_height: int,
    azimuth_deg: float,
    elevation_deg: float,
    hfov_deg: float,
    vfov_deg: float,
) -> tuple[float, float, float]:
    """Pixel bbox center + camera orientation -> ENU unit bearing vector.

    Uses a flat-field linear approximation; valid for hFOV < ~120 degrees.
    A detection at the image center returns the camera's own azimuth/elevation
    direction; offsets are mapped linearly onto the field of view.
    """
    dx = (u - img_width / 2.0) / img_width
    dy = -(v - img_height / 2.0) / img_height  # image y down -> elevation up

    alpha = math.radians(azimuth_deg + dx * hfov_deg)
    phi = math.radians(elevation_deg + dy * vfov_deg)

    E = math.cos(phi) * math.sin(alpha)
    N = math.cos(phi) * math.cos(alpha)
    U = math.sin(phi)

    mag = math.sqrt(E * E + N * N + U * U)
    return (E / mag, N / mag, U / mag)
