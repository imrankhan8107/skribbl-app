"""Room Manager — Room CRUD and Player Management.

Owns the in-memory registry of all active Room objects. Responsible for:
- Generating unique Room_Code values (6-character alphanumeric, uppercase)
- Adding/removing players
- Host reassignment on host disconnect
- Broadcasting player-list updates
- Disconnection handling with 120-second grace window
- Reconnection handling within the grace window
- Cross-worker message relay via Redis pub/sub (when REDIS_URL is set)
"""

import asyncio
import json
import logging
import os
import random
import string
import time
from uuid import uuid4

from backend.models import GameConfig, Player, Room, RoomState
from backend import redis_pubsub
from backend.virtual_transport import VirtualTransport

logger = logging.getLogger(__name__)

# Gate [trace] logs behind the TRACE_ENABLED env flag (default OFF).
_TRACE_ENABLED = os.environ.get("TRACE_ENABLED", "false").lower() in ("true", "1", "yes")


# Hard cap on players per room regardless of config
MAX_PLAYERS_HARD_CAP = 12

# Display name constraints
MIN_NAME_LENGTH = 1
MAX_NAME_LENGTH = 20


class RoomManager:
    """Manages all active rooms in memory."""

    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}  # room_code -> Room
        self._player_to_room: dict[str, str] = {}  # player_id -> room_code (O(1) lookup)

    def _generate_room_code(self) -> str:
        """Generate a unique 6-character alphanumeric uppercase room code."""
        while True:
            code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
            if code not in self.rooms:
                return code

    async def _delete_room(self, room_code: str) -> None:
        """Delete a room and clean up Redis registrations."""
        self.rooms.pop(room_code, None)
        if redis_pubsub.is_redis_enabled():
            try:
                await redis_pubsub.unsubscribe_room(room_code)
                await redis_pubsub.unregister_room_with_ttl(room_code)
                await redis_pubsub.remove_room_worker(room_code)
                await redis_pubsub.remove_room_info(room_code)
                # Report updated load after room deletion
                await redis_pubsub.report_worker_load(
                    len([r for r in self.rooms.values() if not r.is_proxy]),
                    sum(len(r.players) for r in self.rooms.values()),
                )
            except Exception as e:
                logger.error("Failed to clean up Redis for room %s: %s", room_code, e)

    def _validate_name(self, name: str) -> str | None:
        """Validate display name. Returns error message or None if valid."""
        if not isinstance(name, str):
            return "Display name must be a string"
        if len(name) < MIN_NAME_LENGTH or len(name) > MAX_NAME_LENGTH:
            return f"Display name must be between {MIN_NAME_LENGTH} and {MAX_NAME_LENGTH} characters"
        return None

    def _serialize_player(self, player: Player) -> dict:
        """Serialize a Player to a JSON-safe dict (excludes websocket)."""
        return {
            "id": player.id,
            "name": player.name,
            "score": player.score,
            "has_guessed": player.has_guessed,
            "is_connected": player.is_connected,
            "is_ready": player.is_ready,
        }

    def _serialize_config(self, config: GameConfig) -> dict:
        """Serialize a GameConfig to a JSON-safe dict."""
        return {
            "num_rounds": config.num_rounds,
            "turn_duration": config.turn_duration,
            "max_players": config.max_players,
        }

    async def create_room(self, name: str, websocket) -> dict:
        """Create a new room with the given player as host.

        Args:
            name: Display name for the host player.
            websocket: WebSocket connection for the host.

        Returns:
            A dict payload for the `room_created` message, or an error payload.
        """
        # Validate name
        name_error = self._validate_name(name)
        if name_error:
            return {
                "type": "error",
                "payload": {"code": "INVALID_NAME", "message": name_error},
            }

        # Generate room code and player ID
        room_code = self._generate_room_code()
        player_id = str(uuid4())

        # Create the host player
        host = Player(id=player_id, name=name, websocket=websocket)

        # Create the room
        room = Room(code=room_code, host_id=player_id)
        room.add_player(host)
        self.rooms[room_code] = room
        self._player_to_room[player_id] = room_code

        # Register room ownership and subscribe in Redis (no-op if not configured)
        if redis_pubsub.is_redis_enabled():
            await redis_pubsub.register_room_with_ttl(room_code)
            await redis_pubsub.register_room_worker(room_code)
            await redis_pubsub.subscribe_room(room_code)
            # Publish room info for cross-worker discovery
            await redis_pubsub.set_room_info(room_code, {
                "state": room.state.value,
                "player_count": len(room.players),
                "config": self._serialize_config(room.config),
                "host_id": player_id,
            })
            # Report updated load
            await redis_pubsub.report_worker_load(
                len([r for r in self.rooms.values() if not r.is_proxy]),
                sum(len(r.players) for r in self.rooms.values()),
            )

        return {
            "type": "room_created",
            "payload": {
                "room_code": room_code,
                "player_id": player_id,
                "config": self._serialize_config(room.config),
            },
        }

    async def join_room(self, name: str, room_code: str, websocket) -> dict:
        """Join an existing room.

        If the room exists locally and is owned by this worker, joins directly.
        If the room is on another worker (including when a proxy room already
        exists locally from a previous joiner), sends an RPC request to the
        owning worker to register the player, then tracks the player locally
        as a proxy.

        Args:
            name: Display name for the joining player.
            room_code: The room code to join.
            websocket: WebSocket connection for the player.

        Returns:
            A dict payload for the `room_joined` message, or an error payload.
        """
        # Validate name
        name_error = self._validate_name(name)
        if name_error:
            return {
                "type": "error",
                "payload": {"code": "INVALID_NAME", "message": name_error},
            }

        # Check room exists locally first
        room = self.rooms.get(room_code)
        if room is not None and not room.is_proxy:
            # Room is truly owned by this worker — join directly
            return await self._join_room_local(room, room_code, name, websocket)

        # Room is either not local or is a proxy (owned by another worker).
        # In both cases, route via RPC to the owning worker.
        if redis_pubsub.is_redis_enabled():
            owner_worker = None
            for _attempt in range(5):
                owner_worker = await redis_pubsub.get_room_worker_with_ttl(room_code)
                if owner_worker is not None:
                    break
                # Room may not be registered yet — brief wait
                await asyncio.sleep(0.3)
            if owner_worker is not None:
                return await self._join_room_remote(
                    room_code, name, websocket, owner_worker
                )

        return {
            "type": "error",
            "payload": {"code": "ROOM_NOT_FOUND", "message": "Room not found"},
        }

    async def _join_room_local(self, room, room_code: str, name: str, websocket) -> dict:
        """Join a room that exists on this worker."""
        # Check room is in lobby state
        if room.state != RoomState.LOBBY:
            return {
                "type": "error",
                "payload": {
                    "code": "ROOM_IN_PROGRESS",
                    "message": "Room is not accepting new players",
                },
            }

        # Check capacity — use the lower of config max_players and hard cap
        effective_max = min(room.config.max_players, MAX_PLAYERS_HARD_CAP)
        if len(room.players) >= effective_max:
            return {
                "type": "error",
                "payload": {"code": "ROOM_FULL", "message": "Room is full"},
            }

        # Create the new player
        player_id = str(uuid4())
        player = Player(id=player_id, name=name, websocket=websocket)
        room.add_player(player)
        self._player_to_room[player_id] = room_code

        # Update room info in Redis
        if redis_pubsub.is_redis_enabled():
            await redis_pubsub.set_room_info(room_code, {
                "state": room.state.value,
                "player_count": len(room.players),
                "config": self._serialize_config(room.config),
                "host_id": room.host_id,
            })

        # Broadcast updated player list to all existing players
        await self.broadcast(
            room_code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        return {
            "type": "room_joined",
            "payload": {
                "room_code": room_code,
                "player_id": player_id,
                "players": [self._serialize_player(p) for p in room.players],
                "config": self._serialize_config(room.config),
            },
        }

    async def _join_room_remote(self, room_code: str, name: str, websocket, owner_worker: str) -> dict:
        """Join a room that exists on another worker via Redis RPC.

        The player's WebSocket lives on this worker. We register the player
        on the owning worker (so it's part of the room's player list), but
        keep the WebSocket reference locally. Broadcasts from the owning
        worker reach us via Redis pub/sub.
        """
        from uuid import uuid4 as _uuid4

        # Generate player_id locally
        player_id = str(_uuid4())
        request_id = str(_uuid4())

        # Subscribe to this room's Redis channel so we receive broadcasts
        await redis_pubsub.subscribe_room(room_code)

        # Send RPC to the owning worker
        await redis_pubsub.publish_rpc_request(owner_worker, {
            "type": "join_room",
            "request_id": request_id,
            "room_code": room_code,
            "player_id": player_id,
            "player_name": name,
        })

        # Wait for response from the owning worker
        response = await redis_pubsub.wait_for_rpc_response(request_id, timeout=5.0)
        if response is None:
            await redis_pubsub.unsubscribe_room(room_code)
            return {
                "type": "error",
                "payload": {"code": "ROOM_NOT_FOUND", "message": "Room owner did not respond"},
            }

        if response.get("type") == "error":
            await redis_pubsub.unsubscribe_room(room_code)
            return response

        # Success — create a local proxy room to track this player's WebSocket
        # This allows broadcasts received from Redis to be forwarded to this client
        if room_code not in self.rooms:
            # Create a minimal proxy room (only used for WebSocket routing)
            proxy_room = Room(code=room_code, host_id=response["payload"].get("host_id", ""))
            proxy_room.state = RoomState.LOBBY
            proxy_room.is_proxy = True
            self.rooms[room_code] = proxy_room

        proxy_room = self.rooms[room_code]
        player = Player(id=player_id, name=name, websocket=websocket)
        proxy_room.add_player(player)
        self._player_to_room[player_id] = room_code

        return response

    async def remove_player(self, player_id: str) -> None:
        """Remove a player from their room, handling host reassignment and cleanup.

        Args:
            player_id: The ID of the player to remove.
        """
        # Find the room containing this player
        room = self._find_room_by_player(player_id)
        if room is None:
            return

        # Remove the player from the room
        room.remove_player(player_id)
        self._player_to_room.pop(player_id, None)

        # If no players remain, delete the room
        if not room.players:
            await self._delete_room(room.code)
            return

        # If the removed player was the host, reassign host
        if room.host_id == player_id:
            room.host_id = room.players[0].id

        # Broadcast updated player list to remaining players
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

    async def handle_disconnect(self, player_id: str, game_engine=None) -> None:
        """Handle a player disconnection with 120-second grace window.

        Marks the player as disconnected, schedules cleanup after 120 seconds,
        and handles game-specific logic (drawer disconnect, insufficient players).

        Args:
            player_id: The ID of the disconnecting player.
            game_engine: Optional game engine module for handling in-game disconnections.
        """
        room = self._find_room_by_player(player_id)
        if room is None:
            return

        player = next((p for p in room.players if p.id == player_id), None)
        if player is None:
            return

        # Mark player as disconnected
        player.is_connected = False
        player.disconnect_time = time.time()
        player.websocket = None

        # Handle lobby state: reassign host if needed
        if room.state == RoomState.LOBBY:
            if room.host_id == player_id:
                # Find next connected player to be host
                connected_players = [p for p in room.players if p.is_connected]
                if connected_players:
                    room.host_id = connected_players[0].id
                else:
                    # No connected players remain — delete room
                    # Cancel the cleanup task since we're removing everything
                    await self._delete_room(room.code)
                    return

        # Schedule cleanup task (120 seconds)
        async def cleanup_after_timeout():
            await asyncio.sleep(120)
            await self._permanently_remove_player(player_id)

        player.cleanup_task = asyncio.create_task(cleanup_after_timeout())

        # Broadcast updated player list
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        # Handle in-game disconnection scenarios
        if room.state in (RoomState.PLAYING, RoomState.WORD_SELECTION):
            # Check if the disconnecting player is the current drawer
            if room.turn is not None and room.turn.drawer_id == player_id:
                # Drawer disconnected — end turn immediately with 0 points
                if game_engine is not None:
                    from backend.models import TurnEndReason
                    await game_engine.end_turn(room, TurnEndReason.DRAWER_DISCONNECTED, self)
            else:
                # Guesser disconnected — check if < 2 connected players remain
                connected_count = sum(1 for p in room.players if p.is_connected)
                if connected_count < 2:
                    await self._end_game_insufficient_players(room)
                else:
                    # Check if all remaining connected guessers have guessed
                    if room.turn is not None and room.state == RoomState.PLAYING:
                        all_guessed = all(
                            p.has_guessed
                            for p in room.players
                            if p.id != room.turn.drawer_id and p.is_connected
                        )
                        if all_guessed:
                            if game_engine is not None:
                                from backend.models import TurnEndReason
                                await game_engine.end_turn(room, TurnEndReason.ALL_GUESSED, self)

    async def handle_reconnect(self, name: str, room_code: str, websocket) -> dict:
        """Handle a player reconnecting within the 120-second grace window.

        Matches by room_code and display name. Cancels the cleanup task,
        restores the player's connection, and broadcasts player_reconnected.

        Args:
            name: Display name of the reconnecting player.
            room_code: The room code to reconnect to.
            websocket: New WebSocket connection for the player.

        Returns:
            A dict payload for the reconnection response, or an error payload.
        """
        room = self.rooms.get(room_code)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "ROOM_NOT_FOUND", "message": "Room not found"},
            }

        # Find disconnected player matching name in this room
        player = next(
            (p for p in room.players if p.name == name and not p.is_connected),
            None,
        )
        if player is None:
            return {
                "type": "error",
                "payload": {
                    "code": "RECONNECT_FAILED",
                    "message": "No disconnected player with that name found in this room",
                },
            }

        # Cancel the cleanup task
        if player.cleanup_task is not None and not player.cleanup_task.done():
            player.cleanup_task.cancel()
            player.cleanup_task = None

        # Restore player connection
        player.is_connected = True
        player.disconnect_time = None
        player.websocket = websocket

        # Check if we should cancel the insufficient players countdown
        connected = sum(1 for p in room.players if p.is_connected)
        if connected >= 2:
            task = getattr(room, '_insufficient_players_task', None)
            if task and not task.done():
                task.cancel()
                room._insufficient_players_task = None
                await self.broadcast(room.code, {"type": "reconnect_resumed", "payload": {}})

        # Broadcast player_reconnected to all players
        await self.broadcast(
            room.code,
            {
                "type": "player_reconnected",
                "payload": {"player_id": player.id, "name": player.name},
            },
        )

        # Broadcast updated player list
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        return {
            "type": "reconnected",
            "payload": {
                "room_code": room_code,
                "player_id": player.id,
                "score": player.score,
                "players": [self._serialize_player(p) for p in room.players],
                "config": self._serialize_config(room.config),
                "state": room.state.value,
                "current_round": room.current_round,
                "host_id": room.host_id,
                "drawer_id": room.turn.drawer_id if room.turn else None,
                "hint": room.turn.hint if room.turn else [],
            },
        }

    async def _permanently_remove_player(self, player_id: str) -> None:
        """Permanently remove a player after the 120-second grace window expires.

        Removes the player record and all associated data from the room.
        Broadcasts updated player list. Ends the game if < 2 connected players remain.

        Args:
            player_id: The ID of the player to permanently remove.
        """
        room = self._find_room_by_player(player_id)
        if room is None:
            return

        # Remove the player from the room
        room.remove_player(player_id)
        self._player_to_room.pop(player_id, None)

        # If no players remain, delete the room
        if not room.players:
            await self._delete_room(room.code)
            return

        # If the removed player was the host, reassign host
        if room.host_id == player_id:
            connected_players = [p for p in room.players if p.is_connected]
            if connected_players:
                room.host_id = connected_players[0].id
            elif room.players:
                room.host_id = room.players[0].id

        # Broadcast updated player list
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        # Check if < 2 connected players remain during an active game
        if room.state in (RoomState.PLAYING, RoomState.WORD_SELECTION):
            connected_count = sum(1 for p in room.players if p.is_connected)
            if connected_count < 2:
                await self._end_game_insufficient_players(room)

    async def _end_game_insufficient_players(self, room: Room) -> None:
        """Start a 20-second countdown before ending the game due to insufficient connected players.

        If a player reconnects during the countdown, it will be cancelled.
        Broadcasts `waiting_for_reconnect` message to remaining players.

        Args:
            room: The Room instance.
        """
        # If already waiting, don't start another countdown
        if getattr(room, '_insufficient_players_task', None) is not None:
            return

        # Broadcast warning to remaining players
        await self.broadcast(room.code, {
            "type": "waiting_for_reconnect",
            "payload": {"seconds": 20},
        })

        # Schedule actual game end after 20 seconds
        async def end_after_wait():
            await asyncio.sleep(20)
            # Check again if still insufficient
            connected = sum(1 for p in room.players if p.is_connected)
            if connected < 2:
                # Actually end the game now
                await self._end_game_insufficient_players_immediate(room)
            room._insufficient_players_task = None

        room._insufficient_players_task = asyncio.create_task(end_after_wait())

    async def _end_game_insufficient_players_immediate(self, room: Room) -> None:
        """Immediately end the game due to insufficient connected players.

        Cancels any active turn timers and broadcasts game_ended_insufficient_players.

        Args:
            room: The Room instance.
        """
        # Cancel any active turn tasks
        if room.turn is not None:
            for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
                if task is not None and not task.done():
                    task.cancel()
            room.turn = None

        # Cancel auto-select task if present
        auto_select_task = getattr(room, '_auto_select_task', None)
        if auto_select_task is not None and not auto_select_task.done():
            auto_select_task.cancel()
            room._auto_select_task = None

        room.state = RoomState.GAME_OVER

        await self.broadcast(
            room.code,
            {"type": "game_ended_insufficient_players", "payload": {}},
        )

    async def broadcast(self, room_code: str, message: dict) -> None:
        """Send a JSON message to all connected players in a room.

        Sends sequentially with error tolerance — if one send fails,
        continues to the next player without blocking indefinitely.

        Args:
            room_code: The room code to broadcast to.
            message: The message dict to serialize and send.
        """
        if _TRACE_ENABLED:
            logger.info("[trace] BE_BROADCAST room=%s type=%s", room_code, message.get("type"))

        room = self.rooms.get(room_code)
        if room is None:
            return

        # Step 1: Send to all local connected players.
        # Serialize once and reuse for every recipient and (if needed) the Redis
        # relay. In the same pass, detect whether any player is remote — a remote
        # player is added by the owner's join_room RPC with websocket=None, so a
        # None websocket is our race-free signal that a cross-worker relay is
        # actually needed. All-local rooms (the common gateway-routed case) skip
        # the redundant publish + self-loopback entirely.
        data = json.dumps(message)
        local_recipients = 0
        has_remote_players = False

        # Fast path (gRPC/gateway mode): when local players are gRPC-backed
        # (VirtualTransport), the gateway owns connection fan-out. Instead of
        # emitting one targeted BroadcastMessage per player (P protobufs + P queue
        # puts + P gRPC frames for a P-player room), emit ONE room-wide message
        # (empty target list) per distinct stream queue. The gateway's
        # FanOutDispatcher then expands it to every session in the room on
        # already-serialized bytes.
        #
        # In the production gateway all players of a room share a single
        # RoomStream (one send_queue). An empty-target message tells the gateway
        # to expand it to every session in the room (GetByRoom). We can therefore
        # use this O(1) path ONLY when every connected gRPC player shares ONE
        # queue. If players span multiple streams (reconnect races, or the
        # multi-stream integration harness), emitting an empty-target message on
        # each queue would make the gateway double-deliver to every client — so
        # in that case we fall back to per-player targeted sends, which are
        # unambiguous.
        seen_queues: set[int] = set()
        single_queue_transport: VirtualTransport | None = None
        has_real_websocket = False
        for player in room.players:
            ws = player.websocket
            if ws is None:
                # websocket is None → player lives on another worker (proxy/remote).
                has_remote_players = True
                continue
            if not player.is_connected:
                continue
            local_recipients += 1
            if isinstance(ws, VirtualTransport):
                qid = id(ws._send_queue)
                if qid not in seen_queues:
                    seen_queues.add(qid)
                    single_queue_transport = ws
            else:
                has_real_websocket = True

        if len(seen_queues) == 1 and not has_real_websocket:
            # gRPC path, single shared stream (production invariant): ONE
            # room-wide fan-out message. Gateway expands to all room sessions.
            try:
                await single_queue_transport.send_room(data)
            except Exception:
                pass
        else:
            # FastAPI path (real WebSockets), mixed transports, or gRPC players
            # spanning multiple streams: write to each recipient individually.
            # For real WebSockets there is no multiplexer to expand a room-wide
            # message; for multi-stream gRPC, per-player targeted sends avoid the
            # double-delivery an empty-target message would cause.
            for player in room.players:
                ws = player.websocket
                if ws is not None and player.is_connected:
                    try:
                        # No per-send timeout: the gateway/uvicorn send is a
                        # non-blocking buffer write, and a 5s per-message timer
                        # only added task/timer churn on the hot path.
                        # Backpressure for genuinely slow clients belongs in a
                        # bounded per-conn queue, not a per-message timeout.
                        await ws.send_text(data)
                    except Exception:
                        # Send failed — skip this player, don't block others.
                        pass

        if _TRACE_ENABLED:
            logger.info(
                "[trace] BE_BROADCAST_LOCAL room=%s type=%s recipients=%d",
                room_code, message.get("type"), local_recipients,
            )

        # Step 2: Publish to Redis for cross-worker relay only when a remote
        # player is actually present. This eliminates the redundant second
        # json.dumps + PUBLISH + self-loopback json.loads/discard on every
        # broadcast for all-local rooms (no-op if Redis not configured).
        if has_remote_players and redis_pubsub.is_redis_enabled():
            try:
                await redis_pubsub.publish_to_room(room_code, message)
            except Exception as e:
                logger.error("Failed to publish to Redis for room %s: %s", room_code, e)

    async def handle_redis_message(self, channel: str, data: dict) -> None:
        """Handle a message received from Redis pub/sub (from another worker).

        Handles two types of messages:
        1. Room broadcasts: forwards to local clients connected to the room.
        2. RPC requests: processes cross-worker join requests.

        Args:
            channel: The Redis channel (format: "room:<room_code>" or "worker:<worker_id>")
            data: The message payload containing 'source_worker' and either 'message' or 'rpc'.
        """
        # Handle RPC requests (worker-to-worker)
        if "rpc" in data:
            await self._handle_rpc(data)
            return

        # Handle room broadcasts — extract room code from channel name
        room_code = channel.replace("room:", "", 1)

        message = data.get("message")
        if message is None:
            return

        # Find the room locally and forward to connected players
        room = self.rooms.get(room_code)
        if room is None:
            return

        json_data = json.dumps(message)
        for player in room.players:
            if player.is_connected and player.websocket is not None:
                try:
                    await asyncio.wait_for(player.websocket.send_text(json_data), timeout=5.0)
                except (asyncio.TimeoutError, Exception):
                    pass

    async def _handle_rpc(self, data: dict) -> None:
        """Handle an RPC request from another worker.

        Currently supports:
        - join_room: Add a player to a room owned by this worker.
        - forward_message: Process a forwarded player message on the owning worker.
        - player_disconnected: Handle a remote player's disconnection on the owning worker.
        """
        rpc = data.get("rpc", {})
        rpc_type = rpc.get("type")

        if rpc_type == "join_room":
            request_id = rpc.get("request_id")
            room_code = rpc.get("room_code")
            player_id = rpc.get("player_id")
            player_name = rpc.get("player_name")

            room = self.rooms.get(room_code)
            if room is None:
                response = {
                    "type": "error",
                    "payload": {"code": "ROOM_NOT_FOUND", "message": "Room not found on owner"},
                }
            elif room.state != RoomState.LOBBY:
                response = {
                    "type": "error",
                    "payload": {"code": "ROOM_IN_PROGRESS", "message": "Room is not accepting new players"},
                }
            elif len(room.players) >= min(room.config.max_players, MAX_PLAYERS_HARD_CAP):
                response = {
                    "type": "error",
                    "payload": {"code": "ROOM_FULL", "message": "Room is full"},
                }
            else:
                # Add the player to the room (no WebSocket — it's on the other worker)
                player = Player(id=player_id, name=player_name, websocket=None)
                player.is_connected = True  # Logically connected (via remote worker)
                room.add_player(player)
                self._player_to_room[player_id] = room_code

                # Update room info in Redis
                await redis_pubsub.set_room_info(room_code, {
                    "state": room.state.value,
                    "player_count": len(room.players),
                    "config": self._serialize_config(room.config),
                    "host_id": room.host_id,
                })

                # Broadcast player_list to local players
                await self.broadcast(room_code, {
                    "type": "player_list",
                    "payload": {
                        "players": [self._serialize_player(p) for p in room.players]
                    },
                })

                response = {
                    "type": "room_joined",
                    "payload": {
                        "room_code": room_code,
                        "player_id": player_id,
                        "players": [self._serialize_player(p) for p in room.players],
                        "config": self._serialize_config(room.config),
                        "host_id": room.host_id,
                    },
                }

            # Send response back via Redis
            if request_id:
                await redis_pubsub.set_rpc_response(request_id, response)

        elif rpc_type == "forward_message":
            await self._handle_forwarded_message(rpc)

        elif rpc_type == "player_disconnected":
            await self._handle_remote_disconnect(rpc)

    async def _handle_forwarded_message(self, rpc: dict) -> None:
        """Handle a message forwarded from a proxy worker.

        The proxy worker sends this RPC when a player connected to it sends
        a game message (guess, stroke, chat, etc.). We process it as if the
        player sent it directly on this worker.

        Args:
            rpc: The RPC payload containing room_code, player_id, and message.
        """
        from backend import game_engine as _game_engine

        room_code = rpc.get("room_code")
        player_id = rpc.get("player_id")
        message = rpc.get("message")

        if not room_code or not player_id or not message:
            return

        room = self.rooms.get(room_code)
        if room is None:
            return

        # Verify the player exists in this room
        player = room.get_player(player_id)
        if player is None:
            return

        msg_type = message.get("type")
        payload = message.get("payload", {})

        try:
            if msg_type == "guess":
                text = payload.get("text", "")
                await _game_engine.handle_guess(room, player_id, text, self)

            elif msg_type == "chat":
                text = payload.get("text", "")
                if room.state == RoomState.LOBBY:
                    if player:
                        await self.broadcast(room.code, {
                            "type": "chat_message",
                            "payload": {
                                "player_name": player.name,
                                "text": text,
                                "is_system": False,
                            },
                        })
                else:
                    await _game_engine.handle_chat(room, player_id, text, self)

            elif msg_type == "stroke":
                await self.broadcast(room.code, {
                    "type": "stroke",
                    "payload": payload,
                })

            elif msg_type == "fill":
                await self.broadcast(room.code, {
                    "type": "fill",
                    "payload": payload,
                })

            elif msg_type == "clear_canvas":
                await self.broadcast(room.code, {
                    "type": "clear_canvas",
                    "payload": {},
                })

            elif msg_type == "toggle_ready":
                await self.toggle_ready(player_id)

            elif msg_type == "start_game":
                result = await self.start_game(player_id)
                if result.get("type") != "error":
                    # Game started successfully — start the first turn
                    await _game_engine.start_turn(room, self)

            elif msg_type == "select_word":
                word = payload.get("word", "")
                await _game_engine.handle_word_selection(room, player_id, word, self)

            elif msg_type == "reaction":
                emoji = payload.get("emoji", "")
                await self.broadcast(room.code, {
                    "type": "reaction",
                    "payload": {
                        "player_name": player.name if player else "Unknown",
                        "emoji": emoji,
                    },
                })

            elif msg_type == "leave_room":
                await self.remove_player(player_id)

            elif msg_type == "kick_player":
                target_id = payload.get("target_player_id", "")
                await self.kick_player(player_id, target_id)

            elif msg_type == "update_settings":
                settings = payload if isinstance(payload, dict) else {}
                await self.update_settings(player_id, settings)

            elif msg_type == "rematch":
                await self.handle_rematch(player_id)

            elif msg_type == "end_game_now":
                if room.host_id == player_id:
                    task = getattr(room, '_insufficient_players_task', None)
                    if task and not task.done():
                        task.cancel()
                        room._insufficient_players_task = None
                    await self._end_game_insufficient_players_immediate(room)

        except Exception as exc:
            logger.exception(
                "Error handling forwarded message type '%s' for player %s in room %s: %s",
                msg_type, player_id, room_code, exc
            )

    async def _handle_remote_disconnect(self, rpc: dict) -> None:
        """Handle a remote player's disconnection reported by a proxy worker.

        When a player disconnects from the proxy worker, that worker sends
        this RPC to the owning worker so the player can be properly marked
        as disconnected and the grace window/cleanup can begin.

        Args:
            rpc: The RPC payload containing room_code and player_id.
        """
        from backend import game_engine as _game_engine

        room_code = rpc.get("room_code")
        player_id = rpc.get("player_id")

        if not room_code or not player_id:
            return

        room = self.rooms.get(room_code)
        if room is None:
            return

        player = room.get_player(player_id)
        if player is None:
            return

        # Delegate to existing disconnect handling logic
        await self.handle_disconnect(player_id, _game_engine)

    def _find_room_by_player(self, player_id: str) -> Room | None:
        """O(1) lookup of room containing a player via index, with linear fallback."""
        room_code = self._player_to_room.get(player_id)
        if room_code is not None:
            return self.rooms.get(room_code)
        # Fallback: linear scan (for rooms created outside normal flow, e.g., tests)
        for room in self.rooms.values():
            if room.get_player(player_id) is not None:
                self._player_to_room[player_id] = room.code  # cache for next time
                return room
            # Also check the list directly in case players_by_id wasn't populated
            for player in room.players:
                if player.id == player_id:
                    room.players_by_id[player_id] = player  # fix the index
                    self._player_to_room[player_id] = room.code
                    return room
        return None

    def get_room(self, room_code: str) -> Room | None:
        """Get a room by its code."""
        return self.rooms.get(room_code)

    def get_player(self, player_id: str) -> Player | None:
        """O(1) player lookup across all rooms."""
        room = self._find_room_by_player(player_id)
        if room is None:
            return None
        return room.get_player(player_id)

    async def update_settings(self, player_id: str, settings_dict: dict) -> dict:
        """Update game settings for the room. Only the host can update settings.

        Args:
            player_id: The ID of the player requesting the update.
            settings_dict: A dict with optional keys: num_rounds, turn_duration, max_players.

        Returns:
            A dict payload for the `settings_updated` message, or an error payload.
        """
        # Find the room containing this player
        room = self._find_room_by_player(player_id)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Player is not in a room"},
            }

        # Check that the player is the host
        if room.host_id != player_id:
            return {
                "type": "error",
                "payload": {"code": "PERMISSION_DENIED", "message": "Only the host can update settings"},
            }

        # Check that the room is in LOBBY state
        if room.state != RoomState.LOBBY:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Settings can only be changed in the lobby"},
            }

        # Validate settings ranges
        if "num_rounds" in settings_dict:
            num_rounds = settings_dict["num_rounds"]
            if not isinstance(num_rounds, int) or num_rounds < 2 or num_rounds > 10:
                return {
                    "type": "error",
                    "payload": {"code": "INVALID_SETTINGS", "message": "num_rounds must be between 2 and 10"},
                }

        if "turn_duration" in settings_dict:
            turn_duration = settings_dict["turn_duration"]
            if not isinstance(turn_duration, int) or turn_duration < 30 or turn_duration > 180:
                return {
                    "type": "error",
                    "payload": {"code": "INVALID_SETTINGS", "message": "turn_duration must be between 30 and 180"},
                }

        if "max_players" in settings_dict:
            max_players = settings_dict["max_players"]
            if not isinstance(max_players, int) or max_players < 2 or max_players > 12:
                return {
                    "type": "error",
                    "payload": {"code": "INVALID_SETTINGS", "message": "max_players must be between 2 and 12"},
                }

        # Apply valid settings
        if "num_rounds" in settings_dict:
            room.config.num_rounds = settings_dict["num_rounds"]
        if "turn_duration" in settings_dict:
            room.config.turn_duration = settings_dict["turn_duration"]
        if "max_players" in settings_dict:
            room.config.max_players = settings_dict["max_players"]

        # Broadcast settings_updated to all players in the room
        await self.broadcast(
            room.code,
            {
                "type": "settings_updated",
                "payload": {"config": self._serialize_config(room.config)},
            },
        )

        return {
            "type": "settings_updated",
            "payload": {"config": self._serialize_config(room.config)},
        }

    async def handle_rematch(self, player_id: str) -> dict:
        """Handle a rematch request from the host.

        Resets all game state and transitions the room back to LOBBY.
        Only the host can initiate a rematch, and only from GAME_OVER state.

        Args:
            player_id: The ID of the player requesting the rematch.

        Returns:
            A dict payload for the `rematch_started` message, or an error payload.
        """
        # Find the room containing this player
        room = self._find_room_by_player(player_id)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Player is not in a room"},
            }

        # Check that the player is the host
        if room.host_id != player_id:
            return {
                "type": "error",
                "payload": {"code": "PERMISSION_DENIED", "message": "Only the host can initiate a rematch"},
            }

        # Check that the room is in GAME_OVER state
        if room.state != RoomState.GAME_OVER:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Rematch can only be initiated from game over state"},
            }

        # Reset all player scores to 0 and has_guessed to False
        for player in room.players:
            player.score = 0
            player.has_guessed = False

        # Reset round counter and drawer index
        room.current_round = 0
        room.drawer_index = 0

        # Clear used_words and word_pool
        room.used_words = set()
        room.word_pool = []

        # Clear turn state
        room.turn = None

        # Transition room to LOBBY
        room.state = RoomState.LOBBY

        # Build the rematch_started payload with lobby state
        payload = {
            "players": [self._serialize_player(p) for p in room.players],
            "config": self._serialize_config(room.config),
        }

        # Broadcast rematch_started to all players
        await self.broadcast(
            room.code,
            {"type": "rematch_started", "payload": payload},
        )

        return {
            "type": "rematch_started",
            "payload": payload,
        }

    async def kick_player(self, host_player_id: str, target_player_id: str) -> dict:
        """Kick a player from the room. Only the host can kick, and only in LOBBY state.

        Args:
            host_player_id: The ID of the host player initiating the kick.
            target_player_id: The ID of the player to kick.

        Returns:
            A dict payload for the success message, or an error payload.
        """
        # Find the room containing the host
        room = self._find_room_by_player(host_player_id)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Player is not in a room"},
            }

        # Validate the requester is the host
        if room.host_id != host_player_id:
            return {
                "type": "error",
                "payload": {"code": "PERMISSION_DENIED", "message": "Only the host can kick players"},
            }

        # Validate room is in LOBBY state
        if room.state != RoomState.LOBBY:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Players can only be kicked in the lobby"},
            }

        # Validate target is in the room
        target = room.get_player(target_player_id)
        if target is None:
            return {
                "type": "error",
                "payload": {"code": "PLAYER_NOT_FOUND", "message": "Target player not found in room"},
            }

        # Cannot kick the host
        if target_player_id == room.host_id:
            return {
                "type": "error",
                "payload": {"code": "PERMISSION_DENIED", "message": "Cannot kick the host"},
            }

        # Send kicked message to the target player's websocket
        if target.websocket is not None and target.is_connected:
            try:
                kicked_msg = json.dumps({
                    "type": "kicked",
                    "payload": {"message": "You have been kicked by the host"},
                })
                await target.websocket.send_text(kicked_msg)
            except Exception:
                pass

        # Remove the target player from the room
        room.remove_player(target_player_id)
        self._player_to_room.pop(target_player_id, None)

        # Broadcast updated player list to remaining players
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        return {
            "type": "player_kicked",
            "payload": {"target_player_id": target_player_id},
        }

    async def leave_room(self, player_id: str) -> dict:
        """Allow a player to voluntarily leave the room in LOBBY state.

        Args:
            player_id: The ID of the player leaving.

        Returns:
            A dict payload for the `left_room` message, or an error payload.
        """
        # Find the room containing this player
        room = self._find_room_by_player(player_id)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Player is not in a room"},
            }

        # Validate room is in LOBBY state
        if room.state != RoomState.LOBBY:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Can only leave during lobby phase"},
            }

        # Check if this player is the host
        was_host = room.host_id == player_id

        # Remove the player from the room
        room.remove_player(player_id)
        self._player_to_room.pop(player_id, None)

        # If no players remain, delete the room
        if not room.players:
            await self._delete_room(room.code)
            return {
                "type": "left_room",
                "payload": {},
            }

        # If player was host, reassign host to next player
        if was_host:
            room.host_id = room.players[0].id

        # Broadcast updated player list to remaining players
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        return {
            "type": "left_room",
            "payload": {},
        }

    async def toggle_ready(self, player_id: str) -> dict:
        """Toggle a player's ready status in the lobby.

        Args:
            player_id: The ID of the player toggling their ready status.

        Returns:
            A dict payload for success, or an error payload.
        """
        room = self._find_room_by_player(player_id)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Player is not in a room"},
            }

        # Only allow in lobby state
        if room.state != RoomState.LOBBY:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Ready toggle only available in lobby"},
            }

        player = room.get_player(player_id)
        if player is None:
            return {
                "type": "error",
                "payload": {"code": "PLAYER_NOT_FOUND", "message": "Player not found"},
            }

        # Toggle the is_ready field
        player.is_ready = not player.is_ready

        # Broadcast updated player list
        await self.broadcast(
            room.code,
            {
                "type": "player_list",
                "payload": {
                    "players": [self._serialize_player(p) for p in room.players]
                },
            },
        )

        return {
            "type": "ready_toggled",
            "payload": {"is_ready": player.is_ready},
        }

    async def start_game(self, player_id: str) -> dict:
        """Start the game. Only the host can start the game.

        Args:
            player_id: The ID of the player requesting to start the game.

        Returns:
            A dict payload for the `game_started` message, or an error payload.
        """
        # Find the room containing this player
        room = self._find_room_by_player(player_id)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Player is not in a room"},
            }

        # Check that the player is the host
        if room.host_id != player_id:
            return {
                "type": "error",
                "payload": {"code": "PERMISSION_DENIED", "message": "Only the host can start the game"},
            }

        # Check that the room is in LOBBY state
        if room.state != RoomState.LOBBY:
            return {
                "type": "error",
                "payload": {"code": "GAME_NOT_ACTIVE", "message": "Game can only be started from the lobby"},
            }

        # Check that there are at least 2 players
        if len(room.players) < 2:
            return {
                "type": "error",
                "payload": {"code": "INSUFFICIENT_PLAYERS", "message": "At least 2 players are required to start the game"},
            }

        # Reset all is_ready flags when game starts
        for player in room.players:
            player.is_ready = False

        # Transition room state to WORD_SELECTION
        room.state = RoomState.WORD_SELECTION
        room.current_round = 1

        # Build game_started payload
        payload = {
            "drawer_id": room.players[room.drawer_index].id,
            "round": room.current_round,
            "total_rounds": room.config.num_rounds,
        }

        # Broadcast game_started to all players
        await self.broadcast(
            room.code,
            {"type": "game_started", "payload": payload},
        )

        return {
            "type": "game_started",
            "payload": payload,
        }
