"""Управление сессиями видеомоста в памяти с автоочисткой."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

logger = logging.getLogger("signaling")

SESSION_TTL_EMPTY = 300  # Пустая сессия живёт 5 минут
SESSION_TTL_INACTIVE = 3600  # Неактивная сессия — 1 час
CLEANUP_INTERVAL = 60  # Проверка каждую минуту


@dataclass
class Session:
    """Сессия видеосвязи между двумя участниками."""

    key: str
    clients: dict[str, WebSocket] = field(default_factory=dict)
    created_at: float = field(default_factory=time.monotonic)
    last_activity: float = field(default_factory=time.monotonic)

    @property
    def is_full(self) -> bool:
        return len(self.clients) >= 2

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def is_expired(self, now: float) -> bool:
        if not self.clients:
            return (now - self.last_activity) > SESSION_TTL_EMPTY
        return (now - self.last_activity) > SESSION_TTL_INACTIVE


class SessionManager:
    """Хранилище активных сессий с периодической очисткой."""

    def __init__(self, max_sessions: int = 10) -> None:
        self._sessions: dict[str, Session] = {}
        self._max_sessions = max_sessions
        self._cleanup_task: asyncio.Task | None = None

    @property
    def count(self) -> int:
        return len(self._sessions)

    @property
    def limit_reached(self) -> bool:
        return self.count >= self._max_sessions

    def start_cleanup_loop(self) -> None:
        """Запускает фоновую задачу очистки. Вызывать при старте приложения."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL)
            self._remove_expired()

    def _remove_expired(self) -> None:
        now = time.monotonic()
        expired = [k for k, s in self._sessions.items() if s.is_expired(now)]
        for key in expired:
            logger.info("Сессия %s удалена по TTL", key)
            del self._sessions[key]

    def create(self) -> str | None:
        """Создаёт сессию. Возвращает ключ или None при лимите."""
        if self.limit_reached:
            return None
        key = uuid.uuid4().hex[:8]
        self._sessions[key] = Session(key=key)
        return key

    def ensure(self, key: str) -> bool:
        """Гарантирует существование сессии. Возвращает False при лимите."""
        if key in self._sessions:
            self._sessions[key].touch()
            return True
        if self.limit_reached:
            return False
        self._sessions[key] = Session(key=key)
        return True

    def exists(self, key: str) -> bool:
        return key in self._sessions

    def has_client(self, key: str, client_id: str) -> bool:
        session = self._sessions.get(key)
        return session is not None and client_id in session.clients

    def is_full_for(self, key: str, client_id: str) -> bool:
        """Сессия полна для данного клиента? Реконнект (тот же client_id) — ок."""
        session = self._sessions.get(key)
        if session is None:
            return True
        if client_id in session.clients:
            return False
        return session.is_full

    def add_client(self, key: str, client_id: str, ws: WebSocket) -> int:
        """Добавляет клиента. Возвращает количество участников."""
        session = self._sessions[key]
        session.clients[client_id] = ws
        session.touch()
        return len(session.clients)

    def remove_client(self, key: str, client_id: str) -> None:
        """Удаляет клиента. Пустая сессия остаётся (удалится по TTL)."""
        session = self._sessions.get(key)
        if session is None:
            return
        session.clients.pop(client_id, None)
        session.touch()
        # Не удаляем сразу — даём время на реконнект
        if not session.clients:
            logger.info("Сессия %s пуста, будет удалена через %ds", key, SESSION_TTL_EMPTY)

    def get_peer_ws(self, key: str, client_id: str) -> WebSocket | None:
        """Возвращает WebSocket собеседника."""
        session = self._sessions.get(key)
        if session is None:
            return None
        for cid, ws in session.clients.items():
            if cid != client_id:
                return ws
        return None