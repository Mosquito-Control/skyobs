from fastapi import APIRouter, Request, status

from .models import CameraEvent

router = APIRouter()


@router.post("/events", status_code=status.HTTP_200_OK)
async def receive_event(event: CameraEvent, request: Request) -> dict:
    request.app.state.cache.append(event)
    return {"status": "ok"}


@router.get("/health")
async def health(request: Request) -> dict:
    return {
        "status": "ok",
        "cache_size": len(request.app.state.cache),
    }
