"""Управление сессиями видеомоста в памяти."""

import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket


@dataclass
class Session:
    """Сессия видеосвязи между двумя участниками."""

    key: str
    clients: dict[str, WebSocket] = field(default_factory=dict)

    @property
    def is_full(self) -> bool:
        return len(self.clients) >= 2


class SessionManager:
    """Хранилище активных сессий. Данные живут в памяти процесса."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def create(self) -> str:
        """Создаёт сессию, возвращает её ключ."""
        key = uuid.uuid4().hex[:8]
        self._sessions[key] = Session(key=key)
        return key

    def exists(self, key: str) -> bool:
        return key in self._sessions

    def has_client(self, key: str, client_id: str) -> bool:
        session = self._sessions.get(key)
        return session is not None and client_id in session.clients

    def is_full_for(self, key: str, client_id: str) -> bool:
        """Сессия полна для данного клиента? Реконнект (тот же client_id) допускается."""
        session = self._sessions.get(key)
        if session is None:
            return True
        if client_id in session.clients:
            return False  # реконнект — всегда ок
        return session.is_full

    def add_client(self, key: str, client_id: str, ws: WebSocket) -> int:
        """Добавляет клиента в сессию. Возвращает количество участников после добавления."""
        session = self._sessions[key]
        session.clients[client_id] = ws
        return len(session.clients)

    def remove_client(self, key: str, client_id: str) -> None:
        """Удаляет клиента. Если сессия пуста — удаляет её."""
        session = self._sessions.get(key)
        if session is None:
            return
        session.clients.pop(client_id, None)
        if not session.clients:
            del self._sessions[key]

    def get_peer_ws(self, key: str, client_id: str) -> WebSocket | None:
        """Возвращает WebSocket собеседника (или None, если его нет)."""
        session = self._sessions.get(key)
        if session is None:
            return None
        for cid, ws in session.clients.items():
            if cid != client_id:
                return ws
        return None
