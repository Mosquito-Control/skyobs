import json
import logging

import psycopg2
from psycopg2.pool import ThreadedConnectionPool

from .models import CameraEvent, Position

logger = logging.getLogger(__name__)

_pool: ThreadedConnectionPool | None = None


def init(database_url: str, reader_password: str) -> None:
    global _pool
    _pool = ThreadedConnectionPool(minconn=1, maxconn=5, dsn=database_url)
    _create_tables()
    _create_reader_role(reader_password)


def close() -> None:
    if _pool:
        _pool.closeall()


class _Conn:
    def __init__(self):
        if _pool is None:
            raise RuntimeError("db.init() must be called before any DB access")
        self._conn = _pool.getconn()

    def __enter__(self):
        return self._conn

    def __exit__(self, exc_type, *_):
        if exc_type:
            self._conn.rollback()
        else:
            self._conn.commit()
        _pool.putconn(self._conn)


def _create_tables() -> None:
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS camera_events (
                    id          SERIAL PRIMARY KEY,
                    cam_id      TEXT NOT NULL,
                    timestamp   TIMESTAMPTZ NOT NULL,
                    detections  JSONB NOT NULL,
                    inserted_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS positions (
                    id          SERIAL PRIMARY KEY,
                    timestamp   TIMESTAMPTZ NOT NULL,
                    lat         DOUBLE PRECISION NOT NULL,
                    lon         DOUBLE PRECISION NOT NULL,
                    alt_m       DOUBLE PRECISION NOT NULL,
                    cam_pair    TEXT NOT NULL,
                    score_i     DOUBLE PRECISION,
                    score_j     DOUBLE PRECISION,
                    inserted_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            # System 4 polls positions ordered by inserted_at; without this
            # index it degrades to a seq scan on every tick.
            cur.execute(
                "CREATE INDEX IF NOT EXISTS positions_inserted_at_idx "
                "ON positions(inserted_at)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS camera_events_timestamp_idx "
                "ON camera_events(timestamp)"
            )
    logger.info("DB tables ready")


def _create_reader_role(password: str) -> None:
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                DO $$ BEGIN
                    IF NOT EXISTS (
                        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'system3_reader'
                    ) THEN
                        CREATE ROLE system3_reader WITH LOGIN PASSWORD %s;
                    END IF;
                END $$;
            """, (password,))
            cur.execute("GRANT SELECT ON positions TO system3_reader")
    logger.info("system3_reader role ready")


def insert_camera_events(events: list[CameraEvent]) -> None:
    if not events:
        return
    rows = [
        (
            e.cam_id,
            e.timestamp,
            json.dumps([d.model_dump() for d in e.detections]),
        )
        for e in events
    ]
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO camera_events (cam_id, timestamp, detections) VALUES (%s, %s, %s)",
                rows,
            )
    logger.debug("Flushed %d camera events to DB", len(rows))


def insert_positions(positions: list[Position]) -> None:
    if not positions:
        return
    rows = [
        (p.timestamp, p.lat, p.lon, p.alt_m, p.cam_pair, p.score_i, p.score_j)
        for p in positions
    ]
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO positions (timestamp, lat, lon, alt_m, cam_pair, score_i, score_j)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                rows,
            )
    logger.debug("Inserted %d positions to DB", len(rows))
