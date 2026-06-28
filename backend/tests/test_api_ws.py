import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def test_ice_config_shape(main_module):
    with TestClient(main_module.app) as client:
        response = client.get("/api/ice-config")

    assert response.status_code == 200
    body = response.json()
    assert body["ttl"] == 3600
    assert body["iceServers"][0]["urls"] == "stun:127.0.0.1:3478"
    assert body["iceServers"][1]["urls"] == "turn:127.0.0.1:3478?transport=udp"
    assert body["iceServers"][2]["urls"] == "turn:127.0.0.1:3478?transport=tcp"
    assert body["iceServers"][1]["username"]
    assert body["iceServers"][1]["credential"]


def test_create_session(main_module):
    with TestClient(main_module.app) as client:
        response = client.post("/api/sessions")

    assert response.status_code == 200
    body = response.json()
    assert len(body["sessionKey"]) == 8


def test_websocket_roles_relay_and_hangup(main_module):
    with TestClient(main_module.app) as client:
        with client.websocket_connect("/ws/room1/clientA") as a:
            assert a.receive_json() == {"type": "role", "polite": None}

            with client.websocket_connect("/ws/room1/clientB") as b:
                assert b.receive_json() == {"type": "role", "polite": False}
                assert a.receive_json() == {"type": "peer_joined", "polite": True}

                b.send_json({"type": "media-state", "camera": False, "mic": True})
                assert a.receive_json() == {
                    "type": "media-state",
                    "camera": False,
                    "mic": True,
                }

                b.send_json({"type": "hangup"})
                assert a.receive_json() == {"type": "peer_left"}


def test_websocket_rejects_invalid_ids(main_module):
    with TestClient(main_module.app) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/bad!/clientA") as ws:
                ws.receive_json()

    assert exc_info.value.code == 4003


def test_websocket_rejects_third_distinct_client(main_module):
    with TestClient(main_module.app) as client:
        with client.websocket_connect("/ws/room1/clientA") as a:
            assert a.receive_json()["type"] == "role"
            with client.websocket_connect("/ws/room1/clientB") as b:
                assert b.receive_json()["type"] == "role"
                assert a.receive_json()["type"] == "peer_joined"

                with pytest.raises(WebSocketDisconnect) as exc_info:
                    with client.websocket_connect("/ws/room1/clientC") as c:
                        c.receive_json()

    assert exc_info.value.code == 4001


def test_invalid_websocket_message_is_ignored_and_connection_stays_usable(main_module):
    with TestClient(main_module.app) as client:
        with client.websocket_connect("/ws/room1/clientA") as a:
            assert a.receive_json()["type"] == "role"
            with client.websocket_connect("/ws/room1/clientB") as b:
                assert b.receive_json()["type"] == "role"
                assert a.receive_json()["type"] == "peer_joined"

                b.send_json({"type": "media-state", "camera": "not-bool", "mic": True})
                b.send_json({"type": "media-state", "camera": True, "mic": False})

                assert a.receive_json() == {
                    "type": "media-state",
                    "camera": True,
                    "mic": False,
                }


def test_websocket_rate_limit_closes_spammy_client(main_module):
    with TestClient(main_module.app) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/room1/clientA") as ws:
                assert ws.receive_json()["type"] == "role"
                for _ in range(main_module.WS_BUCKET_CAPACITY + 1):
                    ws.send_json({"type": "pong"})
                ws.receive_json()

    assert exc_info.value.code == 4008


def test_reconnect_same_client_does_not_emit_peer_disconnected_from_stale_ws(main_module):
    with TestClient(main_module.app) as client:
        old = client.websocket_connect("/ws/room1/clientA")
        old_ws = old.__enter__()
        try:
            assert old_ws.receive_json()["type"] == "role"
            with client.websocket_connect("/ws/room1/clientB") as peer:
                assert peer.receive_json()["type"] == "role"
                assert old_ws.receive_json()["type"] == "peer_joined"

                with client.websocket_connect("/ws/room1/clientA") as new_ws:
                    assert new_ws.receive_json()["type"] == "role"
                    assert peer.receive_json()["type"] == "peer_joined"
                    old.__exit__(None, None, None)
                    old = None

                    new_ws.send_json({"type": "media-state", "camera": True, "mic": False})
                    assert peer.receive_json() == {
                        "type": "media-state",
                        "camera": True,
                        "mic": False,
                    }
        finally:
            if old is not None:
                old.__exit__(None, None, None)
