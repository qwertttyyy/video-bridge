import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Path, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from dependencies import get_session_manager
from rate_limit import TokenBucket
from schemas import ws_message_adapter
from session_manager import SessionManager
from turn_credentials import generate_turn_credentials

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
logger = logging.getLogger("signaling")


# ── Конфигурация и валидация переменных окружения ────────────────────

def _required_env(name: str) -> str:
    """Падаем на старте при отсутствии обязательной переменной."""
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Переменная окружения {name} не задана. "
            f"Проверьте .env (см. .env.example)."
        )
    return value


SERVER_IP = _required_env("SERVER_IP")
SERVER_DOMAIN = _required_env("SERVER_DOMAIN")
TURN_SECRET = _required_env("TURN_SECRET")
TURN_REALM = os.getenv("TURN_REALM", SERVER_DOMAIN)
FRONTEND_ORIGIN = _required_env("FRONTEND_ORIGIN")
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "10"))
SESSIONS_RATE_LIMIT = os.getenv("SESSIONS_RATE_LIMIT", "10/minute")
TURN_CRED_TTL = int(os.getenv("TURN_CRED_TTL", "3600"))


# ── Параметры WS keepalive и rate limit ──────────────────────────────

WS_PING_INTERVAL = 20
WS_PONG_TIMEOUT = 45

# Token bucket: 60 сообщений запасом, средний RPS 30.
# SDP+ICE на одно подключение ~50 сообщений за пару секунд → проходит.
# Спам 1000/сек — режется.
WS_BUCKET_CAPACITY = 60
WS_BUCKET_REFILL_PER_SEC = 30.0


# ── Валидация ключей сессии и client_id ──────────────────────────────

# uuid4().hex[:8] и uuid().slice(0,8) — 4-64 символа из base36+подмножества.
# Расширяем до безопасного класса символов.
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")


def _validate_id(value: str, label: str) -> None:
    if not _KEY_RE.fullmatch(value):
        raise ValueError(f"{label} имеет недопустимый формат")


# ── Lifespan и DI ────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    sessions = SessionManager(max_sessions=MAX_SESSIONS)
    sessions.start_cleanup_loop()

    # Подменяем заглушку из dependencies.py на реальный экземпляр.
    app.dependency_overrides[get_session_manager] = lambda: sessions

    logger.info(
        "Старт: MAX_SESSIONS=%d, FRONTEND_ORIGIN=%s, REALM=%s",
        MAX_SESSIONS, FRONTEND_ORIGIN, TURN_REALM,
    )
    try:
        yield
    finally:
        await sessions.stop_cleanup_loop()


# ── slowapi ──────────────────────────────────────────────────────────

limiter = Limiter(key_func=get_remote_address)


# ── App ──────────────────────────────────────────────────────────────

app = FastAPI(title="Video Bridge Signaling", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ── Утилиты WS ───────────────────────────────────────────────────────

async def safe_send_json(ws: WebSocket, data: dict) -> bool:
    try:
        await ws.send_json(data)
        return True
    except Exception:
        return False


# ── REST ─────────────────────────────────────────────────────────────

@app.get("/api/ice-config")
def ice_config():
    """
    Конфигурация ICE-серверов для RTCPeerConnection.

    TURN-креды эфемерные: имя содержит unix-timestamp истечения,
    пароль — HMAC-SHA1 от имени и серверного секрета. Утечка
    кредов из браузера ограничена TURN_CRED_TTL.
    """
    username, credential = generate_turn_credentials(
        secret=TURN_SECRET,
        ttl_seconds=TURN_CRED_TTL,
    )
    return {
        "iceServers": [
            {"urls": f"stun:{SERVER_IP}:3478"},
            {
                "urls": f"turn:{SERVER_IP}:3478?transport=udp",
                "username": username,
                "credential": credential,
            },
            {
                "urls": f"turn:{SERVER_IP}:3478?transport=tcp",
                "username": username,
                "credential": credential,
            },
        ],
        # Подсказка фронту — когда пора запросить новый ice-config.
        "ttl": TURN_CRED_TTL,
    }


@app.post("/api/sessions")
@limiter.limit(SESSIONS_RATE_LIMIT)
async def create_session(
    request: Request,  # обязателен для slowapi
    sessions: SessionManager = Depends(get_session_manager),
):
    """Создаёт сессию. Возвращает ключ или ошибку лимита."""
    key = await sessions.create()
    if key is None:
        return {"error": "limit", "message": "Достигнут лимит одновременных сессий"}
    logger.info(
        "Сессия создана: %s  (всего: %d/%d)",
        key, sessions.count, sessions.max_sessions,
    )
    return {"sessionKey": key}


# ── WebSocket сигналинг ──────────────────────────────────────────────

@app.websocket("/ws/{session_key}/{client_id}")
async def signaling(
    ws: WebSocket,
    session_key: str = Path(..., min_length=4, max_length=64),
    client_id: str = Path(..., min_length=4, max_length=64),
    sessions: SessionManager = Depends(get_session_manager),
):
    """
    Обмен SDP offer/answer и ICE-кандидатами между двумя участниками.

    Защиты:
      — валидация формата session_key/client_id (regex)
      — атомарная регистрация в SessionManager (под локом)
      — token bucket на входящие сообщения от каждого клиента
      — Pydantic-валидация структуры сообщения
      — таймаут на отсутствие pong
    """

    # WebSocket нужно сначала accept(), иначе браузер не получит
    # наш кастомный код закрытия (4001/4002/4003) — увидит generic 1006.
    await ws.accept()

    # 1. Валидация форматов id (FastAPI Path не поддерживает regex напрямую — делаем вручную)
    try:
        _validate_id(session_key, "session_key")
        _validate_id(client_id, "client_id")
    except ValueError as exc:
        await ws.close(code=4003, reason=str(exc))
        return

    # 2. Атомарная регистрация
    result = await sessions.register_client(session_key, client_id, ws)
    if not result.ok:
        code = 4002 if result.error == "limit" else 4001
        reason = (
            "Session limit reached"
            if result.error == "limit"
            else "Session is full"
        )
        await ws.close(code=code, reason=reason)
        return

    # 3. Подсчёт роли (polite/impolite) — стабилен между реконнектами
    polite = sessions.is_polite(session_key, client_id)
    action = "reconnect" if result.is_reconnect else "join"
    logger.info(
        "[%s] +%s  %s  polite=%s  (участников: %d, сессий: %d/%d)",
        session_key, client_id, action, polite,
        result.count, sessions.count, sessions.max_sessions,
    )

    await safe_send_json(ws, {"type": "role", "polite": polite})

    # 4. Уведомить пира, что мы пришли
    peer_ws = sessions.get_peer_ws(session_key, client_id)
    if peer_ws and result.peer_id:
        await safe_send_json(peer_ws, {
            "type": "peer_joined",
            "polite": sessions.is_polite(session_key, result.peer_id),
        })

    # 5. Запустить keepalive и обработку сообщений
    last_pong = time.monotonic()
    bucket = TokenBucket(
        capacity=WS_BUCKET_CAPACITY,
        refill_rate=WS_BUCKET_REFILL_PER_SEC,
    )
    ping_task = asyncio.create_task(
        _keepalive(ws, session_key, client_id, lambda: last_pong)
    )

    hangup_sent = False

    try:
        while True:
            raw = await ws.receive_json()

            # Token bucket: ограничение спама
            if not bucket.try_consume():
                logger.warning(
                    "[%s] %s rate limit hit, закрываю",
                    session_key, client_id,
                )
                await ws.close(code=4008, reason="Too many messages")
                break

            # Pydantic-валидация
            try:
                msg = ws_message_adapter.validate_python(raw)
            except ValidationError as exc:
                logger.warning(
                    "[%s] %s невалидное сообщение: %s",
                    session_key, client_id, exc.errors()[0].get("msg", "?"),
                )
                continue

            msg_type = msg.type

            if msg_type == "pong":
                last_pong = time.monotonic()
                continue

            if msg_type == "hangup":
                # Явный hangup — пересылаем пиру peer_left и выходим из цикла.
                logger.info("[%s] %s hangup", session_key, client_id)
                peer_ws_local = sessions.get_peer_ws(session_key, client_id)
                if peer_ws_local:
                    await safe_send_json(peer_ws_local, {"type": "peer_left"})
                hangup_sent = True
                break

            logger.info("[%s] %s → %s", session_key, client_id, msg_type)

            # Пересылка пиру (без модификации payload)
            peer_ws = sessions.get_peer_ws(session_key, client_id)
            if peer_ws:
                sent = await safe_send_json(peer_ws, raw)
                if not sent:
                    logger.warning(
                        "[%s] не удалось переслать %s → peer",
                        session_key, msg_type,
                    )
    except WebSocketDisconnect:
        logger.info("[%s] -%s  отключился", session_key, client_id)
    except Exception as exc:
        logger.error("[%s] -%s  ошибка: %s", session_key, client_id, exc)
    finally:
        ping_task.cancel()
        await sessions.remove_client(session_key, client_id)
        logger.info("Сессий: %d/%d", sessions.count, sessions.max_sessions)

        peer_ws = sessions.get_peer_ws(session_key, client_id)
        if peer_ws and not hangup_sent:
            await safe_send_json(peer_ws, {"type": "peer_disconnected"})


async def _keepalive(
    ws: WebSocket,
    session_key: str,
    client_id: str,
    get_last_pong,
) -> None:
    """Шлёт ping, закрывает WS если pong не приходил дольше таймаута."""
    try:
        while True:
            await asyncio.sleep(WS_PING_INTERVAL)
            if time.monotonic() - get_last_pong() > WS_PONG_TIMEOUT:
                logger.info(
                    "[%s] %s не отвечает pong, закрываю",
                    session_key, client_id,
                )
                await ws.close(code=1001)
                break
            sent = await safe_send_json(ws, {"type": "ping"})
            if not sent:
                await ws.close()
                break
    except asyncio.CancelledError:
        pass
