# backend/main.py
"""FastAPI сигналинг-сервер для WebRTC видеомоста."""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from session_manager import SessionManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
logger = logging.getLogger("signaling")

MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "10"))
WS_PING_INTERVAL = 20
WS_PONG_TIMEOUT = 45  # закрываем WS если pong не приходил столько секунд

sessions = SessionManager(max_sessions=MAX_SESSIONS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    sessions.start_cleanup_loop()
    yield


app = FastAPI(title="Video Bridge Signaling", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN", "*")],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    Конфигурация ICE-серверов.
    Google STUN убран — в РФ он нестабилен.
    TURN выдаётся в четырёх транспортах для пробивания любых фаерволов.
    """
    server_ip = os.getenv("SERVER_IP", "127.0.0.1")
    server_domain = os.getenv("SERVER_DOMAIN", server_ip)
    turn_user = os.getenv("TURN_USERNAME", "testuser")
    turn_pass = os.getenv("TURN_PASSWORD", "testpassword")

    return {
        "iceServers": [
            {"urls": f"stun:{server_ip}:3478"},
            {
                "urls": f"turn:{server_ip}:3478?transport=udp",
                "username": turn_user,
                "credential": turn_pass,
            },
            {
                "urls": f"turn:{server_ip}:3478?transport=tcp",
                "username": turn_user,
                "credential": turn_pass,
            },
            # TURN over TLS — пробивает DPI и фильтры, где UDP/TCP 3478 заблокированы
            {
                "urls": f"turns:{server_domain}:5349?transport=tcp",
                "username": turn_user,
                "credential": turn_pass,
            },
        ]
    }


@app.post("/api/sessions")
def create_session():
    key = sessions.create()
    if key is None:
        return {"error": "limit", "message": "Достигнут лимит одновременных сессий"}
    logger.info("Сессия создана: %s  (всего: %d/%d)", key, sessions.count, MAX_SESSIONS)
    return {"sessionKey": key}


# ── WebSocket сигналинг ──────────────────────────────────────────────

@app.websocket("/ws/{session_key}/{client_id}")
async def signaling(ws: WebSocket, session_key: str, client_id: str):
    if not sessions.ensure(session_key):
        await ws.close(code=4002, reason="Session limit reached")
        return

    if sessions.is_full_for(session_key, client_id):
        await ws.close(code=4001, reason="Session is full")
        return

    is_reconnect = sessions.has_client(session_key, client_id)
    await ws.accept()
    count = sessions.add_client(session_key, client_id, ws)

    # Роль стабильна: зависит от лексикографического сравнения id
    polite = sessions.is_polite(session_key, client_id)
    action = "reconnect" if is_reconnect else "join"
    logger.info(
        "[%s] +%s  %s  polite=%s  (участников: %d, сессий: %d/%d)",
        session_key, client_id, action, polite, count, sessions.count, MAX_SESSIONS,
    )

    # polite=None значит пира ещё нет — назначим, когда придёт peer_joined
    await safe_send_json(ws, {"type": "role", "polite": polite})

    peer_ws = sessions.get_peer_ws(session_key, client_id)
    if peer_ws:
        peer_id = sessions.get_peer_id(session_key, client_id)
        # Сообщаем обоим о роли — у каждого своя polite-позиция
        await safe_send_json(peer_ws, {
            "type": "peer_joined",
            "polite": sessions.is_polite(session_key, peer_id),
        })

    last_pong = time.monotonic()
    ping_task = asyncio.create_task(
        _keepalive(ws, session_key, client_id, lambda: last_pong)
    )

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type", "unknown")

            if msg_type == "pong":
                last_pong = time.monotonic()
                continue

            logger.info("[%s] %s → %s", session_key, client_id, msg_type)

            peer_ws = sessions.get_peer_ws(session_key, client_id)
            if peer_ws:
                sent = await safe_send_json(peer_ws, data)
                if not sent:
                    logger.warning("[%s] Не удалось переслать %s → peer", session_key, msg_type)
    except WebSocketDisconnect:
        logger.info("[%s] -%s  отключился", session_key, client_id)
    except Exception as exc:
        logger.error("[%s] -%s  ошибка: %s", session_key, client_id, exc)
    finally:
        ping_task.cancel()
        sessions.remove_client(session_key, client_id)
        logger.info("Сессий: %d/%d", sessions.count, MAX_SESSIONS)

        peer_ws = sessions.get_peer_ws(session_key, client_id)
        if peer_ws:
            await safe_send_json(peer_ws, {"type": "peer_disconnected"})


async def _keepalive(ws: WebSocket, session_key: str, client_id: str, get_last_pong):
    """Шлёт ping, закрывает WS если клиент не отвечает pong дольше таймаута."""
    try:
        while True:
            await asyncio.sleep(WS_PING_INTERVAL)
            if time.monotonic() - get_last_pong() > WS_PONG_TIMEOUT:
                logger.info("[%s] %s не отвечает pong, закрываю", session_key, client_id)
                await ws.close(code=1001)
                break
            sent = await safe_send_json(ws, {"type": "ping"})
            if not sent:
                await ws.close()
                break
    except asyncio.CancelledError:
        pass