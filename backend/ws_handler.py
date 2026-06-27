"""WebSocket Handler — Connection lifecycle and message dispatch.

Manages the raw WebSocket connection for each client. On connect, starts
a heartbeat task and awaits an `identify` message (player name + action).
On disconnect, stops the heartbeat and delegates to RoomManager for cleanup.

All message handlers are wrapped in try/except to prevent unhandled exceptions
from crashing the connection or mutating room state.
"""

import json
import logging
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

from backend import game_engine
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

    Args:
        websocket: The FastAPI WebSocket connection.
    """
    await websocket.accept()

    player_id: str | None = None
    heartbeat_task = start_heartbeat(websocket)

    try:
        # Main message loop
        async for raw in websocket.iter_text():
            try:
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
                    await websocket.send_json(result)

                elif msg_type == "join_room":
                    name = payload.get("name", "")
                    room_code = payload.get("room_code", "")
                    result = await room_manager.join_room(name, room_code, websocket)
                    if result.get("type") == "room_joined":
                        player_id = result["payload"]["player_id"]
                    await websocket.send_json(result)

                elif msg_type == "reconnect":
                    name = payload.get("name", "")
                    room_code = payload.get("room_code", "")
                    result = await room_manager.handle_reconnect(name, room_code, websocket)
                    if result.get("type") == "reconnected":
                        player_id = result["payload"]["player_id"]
                    await websocket.send_json(result)

                elif msg_type == "update_settings":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    settings = payload if isinstance(payload, dict) else {}
                    result = await room_manager.update_settings(player_id, settings)
                    # settings_updated is already broadcast by room_manager
                    if result.get("type") == "error":
                        await websocket.send_json(result)

                elif msg_type == "start_game":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    result = await room_manager.start_game(player_id)
                    if result.get("type") == "error":
                        await websocket.send_json(result)
                    else:
                        # Game started successfully — start the first turn
                        room = room_manager._find_room_by_player(player_id)
                        if room is not None:
                            await game_engine.start_turn(room, room_manager)

                elif msg_type == "select_word":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    word = payload.get("word", "")
                    room = room_manager._find_room_by_player(player_id)
                    if room is not None:
                        await game_engine.handle_word_selection(room, player_id, word, room_manager)

                elif msg_type == "guess":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    text = payload.get("text", "")
                    room = room_manager._find_room_by_player(player_id)
                    if room is not None:
                        await game_engine.handle_guess(room, player_id, text, room_manager)

                elif msg_type == "chat":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
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
                    if player_id is None:
                        continue
                    room = room_manager._find_room_by_player(player_id)
                    if room is not None:
                        # Broadcast stroke data to all other players in the room
                        await room_manager.broadcast(room.code, {
                            "type": "stroke",
                            "payload": payload,
                        })

                elif msg_type == "fill":
                    if player_id is None:
                        continue
                    room = room_manager._find_room_by_player(player_id)
                    if room is not None:
                        # Broadcast fill data to all other players in the room
                        await room_manager.broadcast(room.code, {
                            "type": "fill",
                            "payload": payload,
                        })

                elif msg_type == "clear_canvas":
                    if player_id is None:
                        continue
                    room = room_manager._find_room_by_player(player_id)
                    if room is not None:
                        # Broadcast clear_canvas to all players in the room
                        await room_manager.broadcast(room.code, {
                            "type": "clear_canvas",
                            "payload": {},
                        })

                elif msg_type == "kick_player":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    target_id = payload.get("target_player_id", "")
                    result = await room_manager.kick_player(player_id, target_id)
                    if result.get("type") == "error":
                        await websocket.send_json(result)

                elif msg_type == "leave_room":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    result = await room_manager.leave_room(player_id)
                    await websocket.send_json(result)
                    if result.get("type") == "left_room":
                        player_id = None  # Reset player_id since they left

                elif msg_type == "reaction":
                    if player_id is None:
                        continue
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
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    result = await room_manager.toggle_ready(player_id)
                    if result.get("type") == "error":
                        await websocket.send_json(result)

                elif msg_type == "pong":
                    # Application-level pong for heartbeat — no action needed
                    pass

                elif msg_type == "rematch":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
                    result = await room_manager.handle_rematch(player_id)
                    if result.get("type") == "error":
                        await websocket.send_json(result)

                elif msg_type == "end_game_now":
                    if player_id is None:
                        await _send_error(websocket, "GAME_NOT_ACTIVE", "Not identified")
                        continue
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
                await room_manager.handle_disconnect(player_id, game_engine)
            except Exception as exc:
                logger.exception("Error during disconnect handling: %s", exc)


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
