import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

logger = logging.getLogger("signaling")

SESSION_TTL_EMPTY = 300       # Пустая сессия живёт 5 минут
SESSION_TTL_INACTIVE = 3600   # Неактивная сессия — 1 час
CLEANUP_INTERVAL = 60         # Проверка каждую минуту


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


@dataclass(frozen=True)
class RegisterResult:
    """Результат атомарной регистрации клиента в сессии."""
    ok: bool
    error: str | None        # None | "limit" | "full"
    count: int               # участников в сессии после регистрации
    peer_id: str | None      # id собеседника, если есть
    is_reconnect: bool


class SessionManager:
    """
    Хранилище активных сессий.

    Все операции, меняющие состояние, идут под одним asyncio.Lock —
    это исключает race в is_full/add_client между конкурентными
    WebSocket-соединениями. Операции in-memory быстрые,
    одна блокировка на менеджер не становится узким местом.
    """

    def __init__(self, max_sessions: int = 10) -> None:
        self._sessions: dict[str, Session] = {}
        self._max_sessions = max_sessions
        self._lock = asyncio.Lock()
        self._cleanup_task: asyncio.Task | None = None

    @property
    def count(self) -> int:
        return len(self._sessions)

    @property
    def limit_reached(self) -> bool:
        return self.count >= self._max_sessions

    @property
    def max_sessions(self) -> int:
        return self._max_sessions

    # ── Жизненный цикл ────────────────────────────────────────────

    def start_cleanup_loop(self) -> None:
        """Вызвать при старте приложения."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop_cleanup_loop(self) -> None:
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL)
            async with self._lock:
                self._remove_expired()

    def _remove_expired(self) -> None:
        now = time.monotonic()
        expired = [k for k, s in self._sessions.items() if s.is_expired(now)]
        for key in expired:
            logger.info("Сессия %s удалена по TTL", key)
            del self._sessions[key]

    # ── Создание ──────────────────────────────────────────────────

    async def create(self) -> str | None:
        """Создаёт новую пустую сессию. Возвращает ключ или None при лимите."""
        async with self._lock:
            if self.limit_reached:
                return None
            key = uuid.uuid4().hex[:8]
            self._sessions[key] = Session(key=key)
            return key

    # ── Регистрация участника ────────────────────────────────────

    async def register_client(
        self,
        key: str,
        client_id: str,
        ws: WebSocket,
    ) -> RegisterResult:
        """
        Атомарно: гарантирует существование сессии, проверяет
        полноту и регистрирует клиента. Все три действия —
        под одним локом, так что параллельные соединения
        не могут оба пройти проверку и оба зайти.
        """
        async with self._lock:
            session = self._sessions.get(key)

            # Сессии нет — пробуем создать
            if session is None:
                if self.limit_reached:
                    return RegisterResult(False, "limit", 0, None, False)
                session = Session(key=key)
                self._sessions[key] = session

            is_reconnect = client_id in session.clients

            # Реконнект того же client_id всегда разрешён
            if not is_reconnect and session.is_full:
                return RegisterResult(False, "full", len(session.clients), None, False)

            session.clients[client_id] = ws
            session.touch()

            peer_id = next(
                (cid for cid in session.clients if cid != client_id),
                None,
            )
            return RegisterResult(
                ok=True,
                error=None,
                count=len(session.clients),
                peer_id=peer_id,
                is_reconnect=is_reconnect,
            )

    async def remove_client(self, key: str, client_id: str) -> None:
        async with self._lock:
            session = self._sessions.get(key)
            if session is None:
                return
            session.clients.pop(client_id, None)
            session.touch()
            if not session.clients:
                logger.info(
                    "Сессия %s пуста, будет удалена через %ds",
                    key, SESSION_TTL_EMPTY,
                )

    # ── Чтение состояния ─────────────────────────────────────────

    def get_peer_ws(self, key: str, client_id: str) -> WebSocket | None:
        """Возвращает WebSocket собеседника. Чтение без лока — приемлемо для пересылки."""
        session = self._sessions.get(key)
        if session is None:
            return None
        for cid, ws in session.clients.items():
            if cid != client_id:
                return ws
        return None

    def get_peer_id(self, key: str, client_id: str) -> str | None:
        session = self._sessions.get(key)
        if session is None:
            return None
        for cid in session.clients:
            if cid != client_id:
                return cid
        return None

    def is_polite(self, key: str, client_id: str) -> bool | None:
        """
        polite-роль для Perfect Negotiation.
        Polite = id меньше, чем у пира. Стабильно при реконнекте.
        None, если пира в сессии ещё нет.
        """
        peer_id = self.get_peer_id(key, client_id)
        if peer_id is None:
            return None
        return client_id < peer_id
