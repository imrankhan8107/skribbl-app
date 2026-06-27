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
import random
import string
import time
from uuid import uuid4

from backend.models import GameConfig, Player, Room, RoomState
from backend import redis_pubsub

logger = logging.getLogger(__name__)


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
                await redis_pubsub.remove_room_worker(room_code)
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
            await redis_pubsub.register_room_worker(room_code)
            await redis_pubsub.subscribe_room(room_code)

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

        # Check room exists
        room = self.rooms.get(room_code)
        if room is None:
            return {
                "type": "error",
                "payload": {"code": "ROOM_NOT_FOUND", "message": "Room not found"},
            }

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

        First sends to all LOCAL connected players, then publishes to Redis
        so other workers can relay the message to their local clients.

        Args:
            room_code: The room code to broadcast to.
            message: The message dict to serialize and send.
        """
        room = self.rooms.get(room_code)
        if room is None:
            return

        # Step 1: Send to all local connected players
        data = json.dumps(message)
        for player in room.players:
            if player.is_connected and player.websocket is not None:
                try:
                    await player.websocket.send_text(data)
                except Exception:
                    # If sending fails, mark player as disconnected but don't
                    # remove them here to avoid modifying the list during iteration
                    pass

        # Step 2: Publish to Redis for cross-worker relay (no-op if Redis not configured)
        if redis_pubsub.is_redis_enabled():
            try:
                await redis_pubsub.publish_to_room(room_code, message)
            except Exception as e:
                logger.error("Failed to publish to Redis for room %s: %s", room_code, e)

    async def handle_redis_message(self, channel: str, data: dict) -> None:
        """Handle a message received from Redis pub/sub (from another worker).

        Forwards the message to local clients connected to the room.
        This is the callback passed to redis_pubsub.init_redis().

        Args:
            channel: The Redis channel (format: "room:<room_code>")
            data: The message payload containing 'source_worker' and 'message'.
        """
        # Extract room code from channel name (e.g., "room:ABC123" -> "ABC123")
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
                    await player.websocket.send_text(json_data)
                except Exception:
                    pass

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
