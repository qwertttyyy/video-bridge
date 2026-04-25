"""
Эфемерные TURN-креды (REST API механизм coturn).

Схема:
    username = "<unix_expiry_timestamp>:<arbitrary_user>"
    credential = base64(HMAC-SHA1(secret, username))

Coturn запускается с:
    --use-auth-secret --static-auth-secret=<TURN_SECRET>

Когда клиент подключается к TURN с такими username/credential,
coturn проверяет HMAC и срок действия. Утечка кредов
ограничена временем жизни (TURN_CRED_TTL).
"""

import base64
import hmac
import hashlib
import time


def generate_turn_credentials(
    secret: str,
    ttl_seconds: int = 3600,
    user_label: str = "vbridge",
) -> tuple[str, str]:
    """Возвращает (username, credential) для использования в RTCPeerConnection iceServers."""
    expiry = int(time.time()) + ttl_seconds
    username = f"{expiry}:{user_label}"
    digest = hmac.new(
        secret.encode("utf-8"),
        username.encode("utf-8"),
        hashlib.sha1,
    ).digest()
    credential = base64.b64encode(digest).decode("ascii")
    return username, credential
