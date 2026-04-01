"""FastAPI сигналинг-сервер для WebRTC видеомоста."""

import asyncio
import logging
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from session_manager import SessionManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
logger = logging.getLogger("signaling")

MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "10"))
WS_PING_INTERVAL = 20  # секунд между пингами
WS_PING_TIMEOUT = 10  # секунд ожидания понга

app = FastAPI(title="Video Bridge Signaling")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN", "*")],
    allow_methods=["*"],
    allow_headers=["*"],
)

sessions = SessionManager(max_sessions=MAX_SESSIONS)


@app.on_event("startup")
async def on_startup():
    sessions.start_cleanup_loop()


async def safe_send_json(ws: WebSocket, data: dict) -> bool:
    """Отправляет JSON в WebSocket. Возвращает False при ошибке."""
    try:
        await ws.send_json(data)
        return True
    except Exception:
        return False


# ── REST ─────────────────────────────────────────────────────────────

@app.get("/api/ice-config")
def ice_config():
    """Конфигурация ICE-серверов для RTCPeerConnection."""
    server_ip = os.getenv("SERVER_IP", "127.0.0.1")
    turn_user = os.getenv("TURN_USERNAME", "testuser")
    turn_pass = os.getenv("TURN_PASSWORD", "testpassword")

    return {
        "iceServers": [
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": "stun:stun1.l.google.com:19302"},
            {"urls": f"stun:{server_ip}:3478"},
            {
                "urls": f"turn:{server_ip}:3478",
                "username": turn_user,
                "credential": turn_pass,
            },
            {
                "urls": f"turn:{server_ip}:3478?transport=tcp",
                "username": turn_user,
                "credential": turn_pass,
            },
        ]
    }


@app.post("/api/sessions")
def create_session():
    """Создаёт сессию, возвращает ключ."""
    key = sessions.create()
    if key is None:
        return {"error": "limit", "message": "Достигнут лимит одновременных сессий"}
    logger.info("Сессия создана: %s  (всего: %d/%d)", key, sessions.count, MAX_SESSIONS)
    return {"sessionKey": key}


# ── WebSocket сигналинг ──────────────────────────────────────────────

@app.websocket("/ws/{session_key}/{client_id}")
async def signaling(ws: WebSocket, session_key: str, client_id: str):
    """Обмен SDP offer/answer и ICE-кандидатами между двумя участниками."""

    if not sessions.ensure(session_key):
        await ws.close(code=4002, reason="Session limit reached")
        return

    if sessions.is_full_for(session_key, client_id):
        await ws.close(code=4001, reason="Session is full")
        return

    is_reconnect = sessions.has_client(session_key, client_id)
    await ws.accept()
    count = sessions.add_client(session_key, client_id, ws)

    role = "caller" if count == 1 else "callee"
    action = "reconnect" if is_reconnect else "join"
    logger.info(
        "[%s] +%s  %s  роль=%s  (участников: %d, сессий: %d/%d)",
        session_key, client_id, action, role, count, sessions.count, MAX_SESSIONS,
    )

    await safe_send_json(ws, {"type": "role", "role": role})

    peer_ws = sessions.get_peer_ws(session_key, client_id)
    if peer_ws:
        await safe_send_json(peer_ws, {"type": "peer_joined"})

    # Фоновый keepalive — пингует клиента чтобы NAT/proxy не убили соединение
    ping_task = asyncio.create_task(_keepalive(ws, session_key, client_id))

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type", "unknown")

            # Клиентский pong — просто игнорируем
            if msg_type == "pong":
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


async def _keepalive(ws: WebSocket, session_key: str, client_id: str):
    """Периодически шлёт ping чтобы держать соединение живым."""
    try:
        while True:
            await asyncio.sleep(WS_PING_INTERVAL)
            sent = await safe_send_json(ws, {"type": "ping"})
            if not sent:
                logger.info("[%s] %s keepalive failed, closing", session_key, client_id)
                await ws.close()
                break
    except asyncio.CancelledError:
        pass