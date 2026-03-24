# backend/main.py
"""FastAPI сигналинг-сервер для WebRTC видеомоста."""

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

app = FastAPI(title="Video Bridge Signaling")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN", "*")],
    allow_methods=["*"],
    allow_headers=["*"],
)

sessions = SessionManager(max_sessions=MAX_SESSIONS)


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

    # ensure — создаёт сессию если нет (для подключения по ссылке)
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
    logger.info("[%s] +%s  %s  роль=%s  (участников: %d, сессий: %d/%d)",
                session_key, client_id, action, role, count, sessions.count, MAX_SESSIONS)

    await ws.send_json({"type": "role", "role": role})

    peer_ws = sessions.get_peer_ws(session_key, client_id)
    if peer_ws:
        await peer_ws.send_json({"type": "peer_joined"})

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type", "unknown")
            logger.info("[%s] %s → %s", session_key, client_id, msg_type)

            peer_ws = sessions.get_peer_ws(session_key, client_id)
            if peer_ws:
                await peer_ws.send_json(data)
    except WebSocketDisconnect:
        logger.info("[%s] -%s  отключился", session_key, client_id)
        sessions.remove_client(session_key, client_id)
        logger.info("Сессий: %d/%d", sessions.count, MAX_SESSIONS)

        peer_ws = sessions.get_peer_ws(session_key, client_id)
        if peer_ws:
            await peer_ws.send_json({"type": "peer_disconnected"})
