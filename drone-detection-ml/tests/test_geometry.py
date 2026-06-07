"""Tests for the bearing-vector math — the most safety-critical code in the system.

A wrong bearing produces a wrong GPS position downstream with NO error from
System 2. These tests pin the coordinate-frame conventions so a future change
fails here instead of silently corrupting positions.

Run (no pytest needed):
    python tests/test_geometry.py        # from repo root
or:
    pytest tests/
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from drone_detector.geometry import bbox_center_to_bearing

TOL = 1e-6


def _approx(a, b, tol=TOL):
    return abs(a - b) <= tol


def _is_unit(vec, tol=1e-9):
    return _approx(math.sqrt(sum(c * c for c in vec)), 1.0, tol)


def test_centre_matches_orientation():
    """Center pixel -> bearing equal to the camera's own azimuth/elevation."""
    az, el = 45.0, 20.0
    e, n, u = bbox_center_to_bearing(640, 360, 1280, 720, az, el, 90.0, 60.0)
    exp_e = math.cos(math.radians(el)) * math.sin(math.radians(az))
    exp_n = math.cos(math.radians(el)) * math.cos(math.radians(az))
    exp_u = math.sin(math.radians(el))
    assert _approx(e, exp_e) and _approx(n, exp_n) and _approx(u, exp_u), (e, n, u)


def test_output_is_unit_vector():
    for u_px, v_px in ([640, 360], [0, 0], [1279, 719], [900, 200]):
        assert _is_unit(bbox_center_to_bearing(u_px, v_px, 1280, 720, 0.0, 0.0, 90.0, 60.0))


def test_north_facing_centre_is_north():
    e, n, u = bbox_center_to_bearing(640, 360, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    assert _approx(e, 0.0) and _approx(n, 1.0) and _approx(u, 0.0), (e, n, u)


def test_right_pixel_points_east():
    """Right of center -> more clockwise (East-ward) than the camera center."""
    e, _, _ = bbox_center_to_bearing(1000, 360, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    assert e > 0.0, e


def test_left_pixel_points_west():
    e, _, _ = bbox_center_to_bearing(280, 360, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    assert e < 0.0, e


def test_high_pixel_increases_elevation():
    _, _, u_c = bbox_center_to_bearing(640, 360, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    _, _, u_h = bbox_center_to_bearing(640, 50, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    assert u_h > u_c, (u_c, u_h)


def test_low_pixel_decreases_elevation():
    _, _, u_c = bbox_center_to_bearing(640, 360, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    _, _, u_l = bbox_center_to_bearing(640, 700, 1280, 720, 0.0, 0.0, 90.0, 60.0)
    assert u_l < u_c, (u_c, u_l)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
            passed += 1
        except AssertionError as exc:
            print(f"FAIL  {t.__name__}: {exc}")
    print(f"\n{passed}/{len(tests)} passed")
    raise SystemExit(0 if passed == len(tests) else 1)
