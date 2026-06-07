from collections import deque
from datetime import datetime, timezone
from threading import Lock

from .models import CameraEvent


class EventCache:
    def __init__(self, maxlen: int):
        self._q: deque[CameraEvent] = deque(maxlen=maxlen)
        self._lock = Lock()

    def append(self, event: CameraEvent) -> None:
        with self._lock:
            self._q.append(event)

    def snapshot_since(self, cutoff: datetime) -> list[CameraEvent]:
        with self._lock:
            return [e for e in self._q if e.timestamp >= cutoff]

    def flush(self) -> list[CameraEvent]:
        with self._lock:
            events = list(self._q)
            self._q.clear()
            return events

    def __len__(self) -> int:
        with self._lock:
            return len(self._q)
