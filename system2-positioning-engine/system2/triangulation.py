from dataclasses import dataclass

import numpy as np


# WGS84 ellipsoid parameters
_A = 6378137.0
_F = 1 / 298.257223563
_E2 = 2 * _F - _F ** 2


def _to_ecef(lat_r: float, lon_r: float, alt: float) -> np.ndarray:
    N = _A / np.sqrt(1 - _E2 * np.sin(lat_r) ** 2)
    return np.array([
        (N + alt) * np.cos(lat_r) * np.cos(lon_r),
        (N + alt) * np.cos(lat_r) * np.sin(lon_r),
        (N * (1 - _E2) + alt) * np.sin(lat_r),
    ])


def _enu_rotation(ref_lat_r: float, ref_lon_r: float) -> np.ndarray:
    """ECEF-delta to ENU rotation matrix for given reference point."""
    sl, cl = np.sin(ref_lat_r), np.cos(ref_lat_r)
    sn, cn = np.sin(ref_lon_r), np.cos(ref_lon_r)
    return np.array([
        [-sn,       cn,      0],
        [-sl * cn, -sl * sn, cl],
        [ cl * cn,  cl * sn, sl],
    ])


def gps_to_enu(lat: float, lon: float, alt: float,
               ref_lat: float, ref_lon: float, ref_alt: float) -> np.ndarray:
    """Convert WGS84 position to local ENU metres relative to reference origin."""
    lat_r, lon_r = np.radians(lat), np.radians(lon)
    ref_lat_r, ref_lon_r = np.radians(ref_lat), np.radians(ref_lon)
    d = _to_ecef(lat_r, lon_r, alt) - _to_ecef(ref_lat_r, ref_lon_r, ref_alt)
    return _enu_rotation(ref_lat_r, ref_lon_r) @ d


def enu_to_gps(enu: np.ndarray,
               ref_lat: float, ref_lon: float, ref_alt: float) -> tuple[float, float, float] | None:
    """Convert local ENU metres back to WGS84.

    Returns None on degenerate geometry (point too close to Earth's centre or
    pole singularity) so the caller can skip rather than store NaN.
    """
    ref_lat_r, ref_lon_r = np.radians(ref_lat), np.radians(ref_lon)
    R_inv = _enu_rotation(ref_lat_r, ref_lon_r).T
    ecef = _to_ecef(ref_lat_r, ref_lon_r, ref_alt) + R_inv @ enu

    x, y, z = ecef
    p = np.sqrt(x ** 2 + y ** 2)
    # p ≈ 0 → on the polar axis; lat formula collapses. Won't happen for
    # ground-based deployments but guard so callers never see NaN.
    if p < 1.0:
        return None

    lon = np.arctan2(y, x)
    lat = np.arctan2(z, p * (1 - _E2))
    for _ in range(5):
        N = _A / np.sqrt(1 - _E2 * np.sin(lat) ** 2)
        lat = np.arctan2(z + _E2 * N * np.sin(lat), p)

    N = _A / np.sqrt(1 - _E2 * np.sin(lat) ** 2)
    alt = p / np.cos(lat) - N

    lat_d, lon_d, alt_f = float(np.degrees(lat)), float(np.degrees(lon)), float(alt)
    if not (np.isfinite(lat_d) and np.isfinite(lon_d) and np.isfinite(alt_f)):
        return None
    return lat_d, lon_d, alt_f


def intersect_rays(p1: np.ndarray, d1: np.ndarray,
                   p2: np.ndarray, d2: np.ndarray) -> np.ndarray | None:
    """
    Skew-line midpoint: closest point between two rays.
    Returns the midpoint, or None if rays are parallel or intersect behind a camera.
    p1, p2 — camera origins in local ENU metres
    d1, d2 — unit bearing vectors in ENU
    """
    w = p1 - p2
    a = np.dot(d1, d1)
    b = np.dot(d1, d2)
    c = np.dot(d2, d2)
    d = np.dot(d1, w)
    e = np.dot(d2, w)

    denom = a * c - b * b
    if abs(denom) < 1e-10:
        return None  # parallel

    t1 = (b * e - c * d) / denom
    t2 = (a * e - b * d) / denom

    if t1 < 0 or t2 < 0:
        return None  # intersection is behind one of the cameras

    q1 = p1 + t1 * d1
    q2 = p2 + t2 * d2
    return (q1 + q2) / 2


@dataclass
class Camera:
    id: str
    lat: float
    lon: float
    alt_m: float
    enu_pos: np.ndarray  # pre-computed at startup


def load_cameras(cameras_config: dict) -> dict[str, Camera]:
    """
    Build Camera objects from the parsed cameras.yaml dict.
    ENU positions are computed once relative to the reference origin.
    """
    origin = cameras_config["reference_origin"]
    ref_lat = origin["lat"]
    ref_lon = origin["lon"]
    ref_alt = origin["alt_m"]

    cameras: dict[str, Camera] = {}
    for c in cameras_config["cameras"]:
        enu = gps_to_enu(c["lat"], c["lon"], c["alt_m"], ref_lat, ref_lon, ref_alt)
        cameras[c["id"]] = Camera(
            id=c["id"],
            lat=c["lat"],
            lon=c["lon"],
            alt_m=c["alt_m"],
            enu_pos=enu,
        )
    return cameras
