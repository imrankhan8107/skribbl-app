"""Virtual Transport — Adapter routing send_text() through gRPC Room_Stream.

Implements the same awaitable send_text(data) / send_json(data) interface as
FastAPI's WebSocket, so existing broadcast logic (room_manager.broadcast,
game_engine targeted sends) works without modification for gRPC-connected
players.

Messages are enqueued as BroadcastMessage protobufs onto a per-stream
asyncio.Queue. The queue serializes writes from concurrent coroutines,
preventing interleaved frames on the shared gRPC stream.
"""

from __future__ import annotations

import asyncio
import json
import logging

from backend.proto.game_pb2 import BroadcastMessage

logger = logging.getLogger(__name__)
# Ensure trace logs are visible in Docker — uvicorn's default config may
# otherwise suppress INFO-level records from this module's logger.
logger.setLevel(logging.INFO)


class VirtualTransport:
    """Routes send_text() calls through the gRPC Room_Stream as BroadcastMessages.

    Each VirtualTransport is bound to a single player within a room. When
    game logic calls send_text(data), the transport wraps the payload in a
    targeted BroadcastMessage and enqueues it on the shared stream queue.

    The per-stream asyncio.Queue guarantees that concurrent send_text() calls
    from different coroutines are serialized — no interleaved frames.

    Attributes:
        player_id: The player this transport is bound to.
        room_code: The room this transport belongs to.
    """

    def __init__(self, player_id: str, room_code: str, send_queue: asyncio.Queue) -> None:
        """Initialize VirtualTransport.

        Args:
            player_id: UUID of the player this transport targets.
            room_code: 6-char room code for the room.
            send_queue: Shared per-stream asyncio.Queue for outbound
                        BroadcastMessage serialization.
        """
        self.player_id = player_id
        self.room_code = room_code
        self._send_queue = send_queue

    async def send_text(self, data: str) -> None:
        """Enqueue a targeted BroadcastMessage for this player.

        This is the primary interface used by room_manager.broadcast() and
        game_engine targeted sends. It is awaitable and serializes writes
        through the shared queue to prevent interleaved frames.

        Args:
            data: The string payload (typically JSON) to deliver to the player.
        """
        try:
            parsed = json.loads(data)
            extracted_type = parsed.get("type", "?") if isinstance(parsed, dict) else "?"
        except (ValueError, TypeError):
            extracted_type = "?"
        logger.info(
            "[trace] VT_SEND player=%s room=%s type=%s",
            self.player_id, self.room_code, extracted_type,
        )

        msg = BroadcastMessage(
            room_code=self.room_code,
            message_type="targeted",
            payload=data.encode("utf-8"),
            target_player_ids=[self.player_id],
        )
        await self._send_queue.put(msg)

    async def send_json(self, data: dict) -> None:
        """Serialize a dict to JSON and send via the gRPC stream.

        Convenience method matching the FastAPI WebSocket.send_json() interface.

        Args:
            data: Dictionary to serialize and send.
        """
        await self.send_text(json.dumps(data))
