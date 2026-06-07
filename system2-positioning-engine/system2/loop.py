import itertools
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import numpy as np

from . import db
from .cache import EventCache
from .config import Settings
from .models import Position
from .triangulation import Camera, enu_to_gps, intersect_rays

logger = logging.getLogger(__name__)

_stop = threading.Event()


def start(cameras: dict[str, Camera], cache: EventCache, settings: Settings,
          ref_lat: float, ref_lon: float, ref_alt: float) -> None:
    _stop.clear()
    threading.Thread(
        target=_triangulation_loop,
        args=(cameras, cache, settings, ref_lat, ref_lon, ref_alt),
        daemon=True,
        name="triangulation",
    ).start()
    threading.Thread(
        target=_flush_loop,
        args=(cache, settings),
        daemon=True,
        name="db-flush",
    ).start()
    logger.info("Background loops started")


def stop() -> None:
    _stop.set()


def _triangulation_loop(cameras: dict[str, Camera], cache: EventCache,
                        settings: Settings, ref_lat: float, ref_lon: float,
                        ref_alt: float) -> None:
    while not _stop.wait(timeout=settings.loop_interval_s):
        try:
            _run_triangulation(cameras, cache, settings, ref_lat, ref_lon, ref_alt)
        except Exception:
            logger.exception("Triangulation loop error")


def _flush_loop(cache: EventCache, settings: Settings) -> None:
    while not _stop.wait(timeout=settings.db_flush_interval_s):
        try:
            events = cache.flush()
            db.insert_camera_events(events)
        except Exception:
            logger.exception("Flush loop error")


def _run_triangulation(cameras: dict[str, Camera], cache: EventCache,
                       settings: Settings, ref_lat: float, ref_lon: float,
                       ref_alt: float) -> None:
    cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=settings.time_window_s)
    events = cache.snapshot_since(cutoff)
    if not events:
        return

    # group events by cam_id, keeping only cameras we know about
    # store (detection, event_timestamp) so we can use the source timestamp
    by_cam: dict[str, list[tuple]] = {}
    for event in events:
        if event.cam_id not in cameras:
            continue
        for det in event.detections:
            by_cam.setdefault(event.cam_id, []).append((det, event.timestamp))

    cam_ids = list(by_cam.keys())
    if len(cam_ids) < 2:
        return

    positions: list[Position] = []
    for id_i, id_j in itertools.combinations(cam_ids, 2):
        cam_i = cameras[id_i]
        cam_j = cameras[id_j]

        for det_i, ts_i in by_cam[id_i]:
            for det_j, ts_j in by_cam[id_j]:
                timestamp = ts_i + (ts_j - ts_i) / 2
                d1 = np.array(det_i.bearing_vector, dtype=float)
                d2 = np.array(det_j.bearing_vector, dtype=float)

                # normalise — System 1 should send unit vectors, but be safe
                norm1, norm2 = np.linalg.norm(d1), np.linalg.norm(d2)
                if norm1 < 1e-9 or norm2 < 1e-9:
                    continue
                d1, d2 = d1 / norm1, d2 / norm2

                point = intersect_rays(cam_i.enu_pos, d1, cam_j.enu_pos, d2)
                if point is None:
                    continue

                dist_i = float(np.linalg.norm(point - cam_i.enu_pos))
                dist_j = float(np.linalg.norm(point - cam_j.enu_pos))
                if dist_i > settings.max_distance_m or dist_j > settings.max_distance_m:
                    continue

                gps = enu_to_gps(point, ref_lat, ref_lon, ref_alt)
                if gps is None:
                    continue
                lat, lon, alt = gps
                positions.append(Position(
                    timestamp=timestamp,
                    lat=lat,
                    lon=lon,
                    alt_m=alt,
                    cam_pair=f"{id_i}+{id_j}",
                    score_i=det_i.score,
                    score_j=det_j.score,
                ))

    if positions:
        db.insert_positions(positions)
        logger.debug("Triangulated %d position(s)", len(positions))
