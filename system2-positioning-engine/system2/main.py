import logging
from contextlib import asynccontextmanager

import yaml
from fastapi import FastAPI

from . import db, loop
from .api import router
from .cache import EventCache
from .config import settings
from .triangulation import load_cameras

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _load_cameras_yaml() -> dict:
    with open(settings.cameras_file) as f:
        return yaml.safe_load(f)


@asynccontextmanager
async def lifespan(application: FastAPI):
    cameras_config = _load_cameras_yaml()
    cameras = load_cameras(cameras_config)
    logger.info("Loaded %d camera(s): %s", len(cameras), list(cameras.keys()))

    origin = cameras_config["reference_origin"]
    ref_lat, ref_lon, ref_alt = origin["lat"], origin["lon"], origin["alt_m"]

    db.init(settings.database_url, settings.reader_password)

    cache = EventCache(maxlen=settings.cache_size)
    application.state.cache = cache

    loop.start(cameras, cache, settings, ref_lat, ref_lon, ref_alt)

    yield

    loop.stop()
    db.close()


app = FastAPI(title="System 2 — Positioning Engine", lifespan=lifespan)
app.include_router(router)
