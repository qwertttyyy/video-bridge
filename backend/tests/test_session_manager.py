import time

import pytest

from session_manager import SESSION_TTL_EMPTY, SessionManager


@pytest.mark.asyncio
async def test_reconnect_stale_remove_does_not_drop_current_ws():
    manager = SessionManager(max_sessions=2)
    old_ws = object()
    new_ws = object()

    first = await manager.register_client("room1", "client1", old_ws)
    assert first.ok
    assert not first.is_reconnect

    second = await manager.register_client("room1", "client1", new_ws)
    assert second.ok
    assert second.is_reconnect
    assert second.previous_ws is old_ws
    assert manager.is_current_client_ws("room1", "client1", new_ws)

    removed_old = await manager.remove_client("room1", "client1", old_ws)
    assert removed_old is False
    assert manager.is_current_client_ws("room1", "client1", new_ws)

    removed_new = await manager.remove_client("room1", "client1", new_ws)
    assert removed_new is True
    assert not manager.is_current_client_ws("room1", "client1", new_ws)


@pytest.mark.asyncio
async def test_room_allows_two_distinct_clients_only():
    manager = SessionManager(max_sessions=2)

    first = await manager.register_client("room1", "client1", object())
    second = await manager.register_client("room1", "client2", object())
    third = await manager.register_client("room1", "client3", object())

    assert first.ok
    assert second.ok
    assert second.peer_id == "client1"
    assert third.ok is False
    assert third.error == "full"


@pytest.mark.asyncio
async def test_session_touch_prevents_empty_ttl_expiry():
    manager = SessionManager(max_sessions=1)
    key = await manager.create()
    session = manager._sessions[key]
    session.last_activity = time.monotonic() - SESSION_TTL_EMPTY - 1

    await manager.touch(key)

    assert not session.is_expired(time.monotonic())


@pytest.mark.asyncio
async def test_max_sessions_limit_applies_to_implicit_rooms():
    manager = SessionManager(max_sessions=1)

    first = await manager.register_client("room1", "client1", object())
    second = await manager.register_client("room2", "client2", object())

    assert first.ok
    assert second.ok is False
    assert second.error == "limit"


@pytest.mark.asyncio
async def test_remove_without_ws_keeps_backward_compatibility():
    manager = SessionManager(max_sessions=1)
    ws = object()
    await manager.register_client("room1", "client1", ws)

    removed = await manager.remove_client("room1", "client1")

    assert removed is True
    assert not manager.is_current_client_ws("room1", "client1", ws)
