"""Unit and integration tests for Worker Graceful Drain and State Durability."""

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport

from backend.main import app
from backend.models import GameConfig, Player, Room, RoomState, TurnState
from backend import redis_pubsub
from backend.room_manager import RoomManager


@pytest.fixture
def room_mgr():
    mgr = RoomManager()
    return mgr


@pytest.mark.asyncio
async def test_room_snapshot_and_restoration_lobby(room_mgr):
    """Test serializing a room in lobby state and reconstructing it."""
    room = Room(code="SNAP01", host_id="host_123", config=GameConfig(num_rounds=5, turn_duration=90))
    p1 = Player(id="host_123", name="Alice", score=150, is_ready=True, is_connected=True)
    p2 = Player(id="p2_456", name="Bob", score=80, is_ready=False, is_connected=True)
    room.add_player(p1)
    room.add_player(p2)
    room_mgr.rooms[room.code] = room
    room_mgr._player_to_room[p1.id] = room.code
    room_mgr._player_to_room[p2.id] = room.code

    # Create snapshot
    snapshot = room_mgr.snapshot_room(room)
    assert snapshot["code"] == "SNAP01"
    assert snapshot["host_id"] == "host_123"
    assert snapshot["state"] == "lobby"
    assert len(snapshot["players"]) == 2
    assert snapshot["config"]["num_rounds"] == 5
    assert snapshot["config"]["turn_duration"] == 90

    # Restore in a fresh manager instance
    fresh_mgr = RoomManager()
    restored_room = fresh_mgr.restore_room(snapshot)

    assert restored_room.code == "SNAP01"
    assert restored_room.host_id == "host_123"
    assert restored_room.state == RoomState.LOBBY
    assert restored_room.config.num_rounds == 5
    assert restored_room.config.turn_duration == 90
    assert len(restored_room.players) == 2

    alice = restored_room.get_player("host_123")
    assert alice is not None
    assert alice.name == "Alice"
    assert alice.score == 150
    assert alice.is_ready is True
    # Connections start disconnected until reconnect
    assert alice.is_connected is False

    bob = restored_room.get_player("p2_456")
    assert bob is not None
    assert bob.name == "Bob"
    assert bob.score == 80

    # Index lookup
    assert fresh_mgr._player_to_room.get("host_123") == "SNAP01"
    assert fresh_mgr._player_to_room.get("p2_456") == "SNAP01"


@pytest.mark.asyncio
async def test_room_snapshot_and_restoration_playing_turn(room_mgr):
    """Test serializing a room with an active turn and restoring it."""
    room = Room(code="TURN01", host_id="p1", state=RoomState.PLAYING, current_round=2, drawer_index=0)
    p1 = Player(id="p1", name="Alice", score=200)
    p2 = Player(id="p2", name="Bob", score=100)
    room.add_player(p1)
    room.add_player(p2)
    room.used_words = {"cat", "dog"}
    room.turn = TurnState(
        drawer_id="p1",
        word="apple",
        hint=["a", "_", "_", "_", "e"],
        start_time=time.time() - 10,
        word_choices=["apple", "banana", "cherry"],
        guess_order=["p2"],
    )

    snapshot = room_mgr.snapshot_room(room)
    assert snapshot["turn"] is not None
    assert snapshot["turn"]["word"] == "apple"
    assert snapshot["turn"]["drawer_id"] == "p1"
    assert snapshot["turn"]["guess_order"] == ["p2"]
    assert "cat" in snapshot["used_words"]

    # Restore in fresh manager
    fresh_mgr = RoomManager()
    restored = fresh_mgr.restore_room(snapshot)
    assert restored.state == RoomState.PLAYING
    assert restored.current_round == 2
    assert restored.turn is not None
    assert restored.turn.word == "apple"
    assert restored.turn.drawer_id == "p1"
    assert restored.turn.guess_order == ["p2"]
    assert "cat" in restored.used_words


@pytest.mark.asyncio
async def test_worker_draining_rejects_create_room(room_mgr):
    """Verify that create_room rejects when worker is in draining mode."""
    with patch("backend.redis_pubsub.is_worker_draining", return_value=True):
        res = await room_mgr.create_room("Alice", AsyncMock())
        assert res.get("type") == "error"
        assert res["payload"]["code"] == "WORKER_DRAINING"


@pytest.mark.asyncio
async def test_drain_active_rooms_saves_snapshot(room_mgr):
    """Verify drain_active_rooms iterates local rooms, broadcasts, and saves snapshots."""
    room1 = Room(code="DRN001", host_id="p1")
    p1 = Player(id="p1", name="Alice")
    room1.add_player(p1)
    room_mgr.rooms["DRN001"] = room1

    with patch("backend.redis_pubsub.save_room_snapshot", new_callable=AsyncMock) as mock_save, \
         patch.object(room_mgr, "broadcast", new_callable=AsyncMock) as mock_bcast:

        count = await room_mgr.drain_active_rooms()
        assert count == 1
        mock_bcast.assert_called_once()
        bcast_args = mock_bcast.call_args[0]
        assert bcast_args[0] == "DRN001"
        assert bcast_args[1]["type"] == "worker_draining"

        mock_save.assert_called_once()
        save_args = mock_save.call_args[0]
        assert save_args[0] == "DRN001"
        assert save_args[1]["code"] == "DRN001"


@pytest.mark.asyncio
async def test_join_room_restores_from_snapshot_when_not_in_memory(room_mgr):
    """Verify join_room adopts and restores a room from Redis snapshot."""
    fake_snapshot = {
        "code": "REST01",
        "host_id": "host_p",
        "state": "lobby",
        "current_round": 0,
        "drawer_index": 0,
        "config": {"num_rounds": 3, "turn_duration": 80, "max_players": 8},
        "players": [{"id": "host_p", "name": "HostPlayer", "score": 0, "is_ready": True}],
    }

    with patch("backend.redis_pubsub.is_redis_enabled", return_value=True), \
         patch("backend.redis_pubsub.get_room_worker_with_ttl", return_value=None), \
         patch("backend.redis_pubsub.get_room_snapshot", new_callable=AsyncMock, return_value=fake_snapshot), \
         patch("backend.redis_pubsub.delete_room_snapshot", new_callable=AsyncMock) as mock_del_snap, \
         patch("backend.redis_pubsub.register_room_with_ttl", new_callable=AsyncMock), \
         patch("backend.redis_pubsub.register_room_worker", new_callable=AsyncMock), \
         patch("backend.redis_pubsub.subscribe_room", new_callable=AsyncMock), \
         patch("backend.redis_pubsub.publish_to_room", new_callable=AsyncMock):

        mock_ws = AsyncMock()
        res = await room_mgr.join_room("Bob", "REST01", mock_ws)
        assert res.get("type") == "room_joined"
        assert "REST01" in room_mgr.rooms
        mock_del_snap.assert_called_once_with("REST01")


@pytest.mark.asyncio
async def test_handle_reconnect_restores_from_snapshot(room_mgr):
    """Verify handle_reconnect adopts and restores room from Redis snapshot."""
    fake_snapshot = {
        "code": "RECN01",
        "host_id": "p1",
        "state": "lobby",
        "current_round": 0,
        "drawer_index": 0,
        "config": {"num_rounds": 3, "turn_duration": 80, "max_players": 8},
        "players": [{"id": "p1", "name": "Alice", "score": 50, "is_ready": True, "is_connected": False}],
    }

    with patch("backend.redis_pubsub.is_redis_enabled", return_value=True), \
         patch("backend.redis_pubsub.get_room_snapshot", new_callable=AsyncMock, return_value=fake_snapshot), \
         patch("backend.redis_pubsub.delete_room_snapshot", new_callable=AsyncMock) as mock_del_snap, \
         patch("backend.redis_pubsub.register_room_with_ttl", new_callable=AsyncMock), \
         patch("backend.redis_pubsub.register_room_worker", new_callable=AsyncMock), \
         patch("backend.redis_pubsub.subscribe_room", new_callable=AsyncMock), \
         patch("backend.redis_pubsub.publish_to_room", new_callable=AsyncMock):

        mock_ws = AsyncMock()
        res = await room_mgr.handle_reconnect("Alice", "RECN01", mock_ws)
        assert res.get("type") == "reconnected"
        assert res["payload"]["player_id"] == "p1"
        assert res["payload"]["score"] == 50
        mock_del_snap.assert_called_once_with("RECN01")


@pytest.mark.asyncio
async def test_health_and_ready_endpoints():
    """Verify /health and /ready response codes during normal vs draining state."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Normal state
        with patch("backend.redis_pubsub.is_worker_draining", return_value=False):
            res = await ac.get("/ready")
            assert res.status_code == 200
            assert res.json()["ready"] is True

            health_res = await ac.get("/health")
            assert health_res.status_code == 200
            assert health_res.json()["status"] == "ok"
            assert health_res.json()["draining"] is False

        # Draining state
        with patch("backend.redis_pubsub.is_worker_draining", return_value=True):
            res_drain = await ac.get("/ready")
            assert res_drain.status_code == 503
            assert res_drain.json()["ready"] is False

            health_drain = await ac.get("/health")
            assert health_drain.status_code == 200
            assert health_drain.json()["status"] == "draining"
            assert health_drain.json()["draining"] is True

