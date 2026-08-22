"""WebSocket Handler — Connection lifecycle and message dispatch.

Manages the raw WebSocket connection for each client. On connect, starts
a heartbeat task and awaits an `identify` message (player name + action).
On disconnect, stops the heartbeat and delegates to RoomManager for cleanup.

All message handlers are wrapped in try/except to prevent unhandled exceptions
from crashing the connection or mutating room state.

Cross-worker proxy support:
When a player joins a room owned by another worker, the local room is marked
as a proxy (room.is_proxy = True). All subsequent game messages from that
player are forwarded to the owning worker via Redis RPC rather than processed
locally. Broadcasts from the owner reach this worker via Redis pub/sub and
are forwarded to the player's WebSocket by the existing handle_redis_message.
"""

import json
import logging
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

from backend import game_engine
from backend import redis_pubsub
from backend.heartbeat import start_heartbeat, stop_heartbeat
from backend.models import RoomState
from backend.room_manager import RoomManager

logger = logging.getLogger(__name__)

# Singleton RoomManager instance shared across all connections
room_manager = RoomManager()


async def websocket_handler(websocket: WebSocket) -> None:
    """Main WebSocket handler for a single client connection.

    Accepts the connection, starts heartbeat monitoring, awaits the
    identify message, then enters the message dispatch loop.

    For proxy connections (player's room owned by another worker), all game
    messages are forwarded to the owning worker via Redis RPC.

    Args:
        websocket: The FastAPI WebSocket connection.
    """
    await websocket.accept()

    player_id: str | None = None
    room_code: str | None = None
    heartbeat_task = start_heartbeat(websocket)

    try:
        # Main message loop
        async for raw in websocket.iter_text():
            try:
                # Guard against oversized messages (prevents JSON parsing DoS)
                if len(raw) > 65536:
                    await _send_error(websocket, "MESSAGE_TOO_LARGE", "Message exceeds 64KB limit")
                    continue
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send_error(websocket, "INVALID_MESSAGE", "Invalid JSON")
                continue

            msg_type = msg.get("type")
            payload = msg.get("payload", {})

            try:
                # Dispatch based on message type
                if msg_type == "create_room":
                    name = payload.get("name", "")
                    result = await room_manager.create_room(name, websocket)
                    if result.get("type") == "room_created":
                        player_id = result["payload"]["player_id"]
                        room_code = result["payload"]["room_code"]
                    await websocket.send_json(result)

                elif msg_type == "join_room":
                    name = payload.get("name", "")
                    rc = payload.get("room_code", "")
                    result = await room_manager.join_room(name, rc, websocket)
                    if result.get("type") == "room_joined":
                        player_id = result["payload"]["player_id"]
                        room_code = result["payload"]["room_code"]
                    await websocket.send_json(result)

                elif msg_type == "reconnect":
                    name = payload.get("name", "")
                    rc = payload.get("room_code", "")
                    result = await room_manager.handle_reconnect(name, rc, websocket)
                    if result.get("type") == "reconnected":
                        player_id = result["payload"]["player_id"]
                        room_code = result["payload"]["room_code"]
                    await websocket.send_json(result)

                elif msg_type == "pong":
                    # Application-level pong for heartbeat — always handle locally
                    pass

                else:
                    # All other messages require an identified player
                    if player_id is None:
                        # Check if it's a known message type that needs auth
                        known_types = {
                            "update_settings", "start_game", "select_word",
                            "guess", "chat", "stroke", "fill", "clear_canvas",
                            "kick_player", "leave_room", "reaction",
                            "toggle_ready", "rematch", "end_game_now",
                        }
                        if msg_type not in known_types:
                            await _send_error(websocket, "UNKNOWN_MESSAGE", f"Unknown message type: {msg_type}")
                        else:
                            await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue

                    # Check if this is a proxy connection — forward to owning worker
                    if room_code and _is_proxy_connection(room_code):
                        await _forward_to_owner(room_code, player_id, msg)
                        continue

                    # Local handling — room is owned by this worker
                    left = await _handle_local_message(
                        websocket, player_id, msg_type, payload
                    )
                    if left:
                        player_id = None
                        room_code = None

            except Exception as exc:
                # Catch-all for handler exceptions — log and send error without mutating state
                logger.exception("Error handling message type '%s': %s", msg_type, exc)
                await _send_error(websocket, "INTERNAL_ERROR", "An internal error occurred")

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("WebSocket connection error: %s", exc)
    finally:
        # Stop heartbeat task
        stop_heartbeat(heartbeat_task)

        # Handle disconnect if player was identified
        if player_id is not None:
            try:
                # If proxy connection, notify the owning worker of the disconnect
                if room_code and _is_proxy_connection(room_code):
                    await _notify_owner_disconnect(room_code, player_id)
                    # Also clean up the local proxy room's player entry
                    room = room_manager.rooms.get(room_code)
                    if room:
                        room.remove_player(player_id)
                        room_manager._player_to_room.pop(player_id, None)
                        # If no local players remain in the proxy room, clean it up
                        if not room.players:
                            await redis_pubsub.unsubscribe_room(room_code)
                            room_manager.rooms.pop(room_code, None)
                else:
                    await room_manager.handle_disconnect(player_id, game_engine)
            except Exception as exc:
                logger.exception("Error during disconnect handling: %s", exc)


def _is_proxy_connection(room_code: str) -> bool:
    """Check if a room is a proxy (owned by another worker).

    Args:
        room_code: The room code to check.

    Returns:
        True if the room exists locally and is marked as a proxy.
    """
    room = room_manager.rooms.get(room_code)
    return room is not None and room.is_proxy


async def _forward_to_owner(room_code: str, player_id: str, message: dict) -> None:
    """Forward a player's message to the owning worker via Redis RPC.

    Args:
        room_code: The room code the message is for.
        player_id: The player who sent the message.
        message: The original message dict from the client.
    """
    if redis_pubsub.is_redis_enabled():
        await redis_pubsub.forward_to_room_owner(room_code, player_id, message)


async def _notify_owner_disconnect(room_code: str, player_id: str) -> None:
    """Notify the owning worker that a proxy player has disconnected.

    Args:
        room_code: The room the player was in.
        player_id: The player who disconnected.
    """
    if not redis_pubsub.is_redis_enabled():
        return
    owner_worker = await redis_pubsub.get_room_worker(room_code)
    if owner_worker is None:
        return
    await redis_pubsub.publish_rpc_request(owner_worker, {
        "type": "player_disconnected",
        "room_code": room_code,
        "player_id": player_id,
    })


async def _handle_local_message(
    websocket: WebSocket, player_id: str, msg_type: str, payload: dict
) -> bool:
    """Handle a message for a player whose room is owned by this worker.

    This contains all the original local dispatch logic.

    Args:
        websocket: The player's WebSocket connection.
        player_id: The player's ID.
        msg_type: The message type string.
        payload: The message payload dict.

    Returns:
        True if the player left the room (caller should reset player_id).
    """
    if msg_type == "update_settings":
        settings = payload if isinstance(payload, dict) else {}
        result = await room_manager.update_settings(player_id, settings)
        # settings_updated is already broadcast by room_manager
        if result.get("type") == "error":
            await websocket.send_json(result)

    elif msg_type == "start_game":
        result = await room_manager.start_game(player_id)
        if result.get("type") == "error":
            await websocket.send_json(result)
        else:
            # Game started successfully — start the first turn
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                await game_engine.start_turn(room, room_manager)

    elif msg_type == "select_word":
        word = payload.get("word", "")
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            await game_engine.handle_word_selection(room, player_id, word, room_manager)

    elif msg_type == "guess":
        text = payload.get("text", "")
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            await game_engine.handle_guess(room, player_id, text, room_manager)

    elif msg_type == "chat":
        text = payload.get("text", "")
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            if room.state == RoomState.LOBBY:
                # In lobby, broadcast chat directly
                player = room.get_player(player_id)
                if player:
                    await room_manager.broadcast(room.code, {
                        "type": "chat_message",
                        "payload": {
                            "player_name": player.name,
                            "text": text,
                            "is_system": False,
                        },
                    })
            else:
                await game_engine.handle_chat(room, player_id, text, room_manager)

    elif msg_type == "stroke":
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            # Broadcast stroke data to all other players in the room
            await room_manager.broadcast(room.code, {
                "type": "stroke",
                "payload": payload,
            })

    elif msg_type == "fill":
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            # Broadcast fill data to all other players in the room
            await room_manager.broadcast(room.code, {
                "type": "fill",
                "payload": payload,
            })

    elif msg_type == "clear_canvas":
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            # Broadcast clear_canvas to all players in the room
            await room_manager.broadcast(room.code, {
                "type": "clear_canvas",
                "payload": {},
            })

    elif msg_type == "kick_player":
        target_id = payload.get("target_player_id", "")
        result = await room_manager.kick_player(player_id, target_id)
        if result.get("type") == "error":
            await websocket.send_json(result)

    elif msg_type == "leave_room":
        result = await room_manager.leave_room(player_id)
        await websocket.send_json(result)
        if result.get("type") == "left_room":
            return True  # Signal that player left

    elif msg_type == "reaction":
        room = room_manager._find_room_by_player(player_id)
        if room is not None:
            player = room.get_player(player_id)
            if player:
                emoji = payload.get("emoji", "")
                await room_manager.broadcast(room.code, {
                    "type": "reaction",
                    "payload": {
                        "player_name": player.name,
                        "emoji": emoji,
                    },
                })

    elif msg_type == "toggle_ready":
        result = await room_manager.toggle_ready(player_id)
        if result.get("type") == "error":
            await websocket.send_json(result)

    elif msg_type == "rematch":
        result = await room_manager.handle_rematch(player_id)
        if result.get("type") == "error":
            await websocket.send_json(result)

    elif msg_type == "end_game_now":
        room = room_manager._find_room_by_player(player_id)
        if room and room.host_id == player_id:
            task = getattr(room, '_insufficient_players_task', None)
            if task and not task.done():
                task.cancel()
                room._insufficient_players_task = None
            await room_manager._end_game_insufficient_players_immediate(room)
        elif room:
            await _send_error(websocket, "PERMISSION_DENIED", "Only the host can end the game")

    else:
        await _send_error(websocket, "UNKNOWN_MESSAGE", f"Unknown message type: {msg_type}")

    return False


async def _send_error(websocket: WebSocket, code: str, message: str) -> None:
    """Send an error message to the client.

    Args:
        websocket: The WebSocket connection.
        code: The error code string.
        message: A human-readable error description.
    """
    try:
        await websocket.send_json({
            "type": "error",
            "payload": {"code": code, "message": message},
        })
    except Exception:
        # Connection may already be closed
        pass
