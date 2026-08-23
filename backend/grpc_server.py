"""gRPC Server — GameServiceServicer for bidirectional Room_Stream RPCs.

Runs alongside FastAPI on the same asyncio event loop using grpc.aio.
Receives GameMessage envelopes from the gateway, dispatches through existing
room_manager and game_engine logic, and yields BroadcastMessages back via
a per-stream asyncio.Queue.

Each gRPC-connected player gets a VirtualTransport that implements the same
send_text(data) interface as FastAPI's WebSocket, so existing broadcast logic
works without modification.

On stream context cancellation, all VirtualTransports for the stream's
players are cleaned up and players are marked as disconnected.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import AsyncIterator

import grpc
import grpc.aio

from backend.proto import game_pb2
from backend.proto import game_pb2_grpc
from backend.proto.game_pb2 import BroadcastMessage, GameMessage
from backend.virtual_transport import VirtualTransport
from backend.grpc_metrics import increment_streams, decrement_streams

logger = logging.getLogger(__name__)

# gRPC port from environment (default 50051)
GRPC_PORT = int(os.environ.get("GRPC_PORT", "50051"))


class GameServiceServicer(game_pb2_grpc.GameServiceServicer):
    """Handles RoomStream RPCs from the gateway.

    Each RoomStream corresponds to one room. The servicer:
    1. Receives GameMessage envelopes on the request_iterator
    2. Extracts player_id, room_code, message_type, and JSON payload
    3. Creates a VirtualTransport for each new player_id seen on the stream
    4. Dispatches the message through the existing ws_handler dispatch logic
    5. Drains a per-stream asyncio.Queue of outbound BroadcastMessages
    6. Cleans up VirtualTransports on stream context cancellation
    """

    async def RoomStream(
        self,
        request_iterator: AsyncIterator[GameMessage],
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[BroadcastMessage]:
        """Process a bidirectional stream for a single room.

        Args:
            request_iterator: Async iterator of incoming GameMessage envelopes.
            context: The gRPC servicer context for this stream.

        Yields:
            BroadcastMessage envelopes to send back to the gateway.
        """
        # Per-stream queue for outbound BroadcastMessages
        send_queue: asyncio.Queue[BroadcastMessage | None] = asyncio.Queue()

        # Track VirtualTransports created for players on this stream
        # player_id -> VirtualTransport
        transports: dict[str, VirtualTransport] = {}

        # Track player_id -> room_code for cleanup
        player_rooms: dict[str, str] = {}

        # Track this stream in the grpc_streams_serving gauge
        increment_streams()

        # Launch the inbound message processing coroutine
        inbound_task = asyncio.create_task(
            self._process_inbound(request_iterator, context, send_queue, transports, player_rooms)
        )

        try:
            # Yield outbound BroadcastMessages from the queue
            while True:
                # Check if context has been cancelled
                if context.cancelled():
                    break

                try:
                    # Wait for a message with a timeout so we can check cancellation
                    msg = await asyncio.wait_for(send_queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                # None is the sentinel to stop yielding
                if msg is None:
                    break

                yield msg

        except asyncio.CancelledError:
            pass
        finally:
            # Decrement the grpc_streams_serving gauge
            decrement_streams()

            # Cancel the inbound processing task
            inbound_task.cancel()
            try:
                await inbound_task
            except asyncio.CancelledError:
                pass

            # Clean up all VirtualTransports for this stream
            await self._cleanup_stream(transports, player_rooms)

    async def _process_inbound(
        self,
        request_iterator: AsyncIterator[GameMessage],
        context: grpc.aio.ServicerContext,
        send_queue: asyncio.Queue,
        transports: dict[str, VirtualTransport],
        player_rooms: dict[str, str],
    ) -> None:
        """Process incoming GameMessage envelopes from the gateway.

        Extracts fields, creates VirtualTransports for new players,
        and dispatches through existing game logic.

        Args:
            request_iterator: Async iterator of incoming GameMessages.
            context: The gRPC servicer context.
            send_queue: The per-stream outbound queue.
            transports: Dict tracking player_id -> VirtualTransport.
            player_rooms: Dict tracking player_id -> room_code.
        """
        from backend import game_engine
        from backend.ws_handler import room_manager

        # Track actual player_ids assigned by room_manager for cleanup
        # (identity messages like create_room/join_room generate new UUIDs)
        self._assigned_player_ids = getattr(self, '_assigned_player_ids', set())

        try:
            async for game_msg in request_iterator:
                if context.cancelled():
                    break

                player_id = game_msg.player_id
                room_code = game_msg.room_code
                message_type = game_msg.message_type
                payload_bytes = game_msg.payload

                # Parse JSON payload
                try:
                    payload = json.loads(payload_bytes) if payload_bytes else {}
                except (json.JSONDecodeError, UnicodeDecodeError):
                    # Send error back to the specific player
                    error_msg = BroadcastMessage(
                        room_code=room_code,
                        message_type="error",
                        payload=json.dumps(
                            {"code": "INVALID_PAYLOAD", "message": "Invalid JSON in payload"}
                        ).encode("utf-8"),
                        target_player_ids=[player_id],
                    )
                    await send_queue.put(error_msg)
                    continue

                # Create or retrieve VirtualTransport for this player
                if player_id not in transports:
                    transport = VirtualTransport(player_id, room_code, send_queue)
                    transports[player_id] = transport
                    player_rooms[player_id] = room_code

                transport = transports[player_id]

                # Dispatch the message through existing game logic
                try:
                    result = await self._dispatch_message(
                        player_id, room_code, message_type, payload, transport, send_queue, room_manager, game_engine
                    )
                    # Track actual player_ids assigned by identity messages
                    if result and isinstance(result, dict):
                        assigned_id = result.get("payload", {}).get("player_id")
                        if assigned_id and assigned_id != player_id:
                            # Register the assigned player_id for cleanup
                            player_rooms[assigned_id] = result.get("payload", {}).get("room_code", room_code)
                            transports[assigned_id] = transport
                except Exception as exc:
                    logger.exception(
                        "Error dispatching gRPC message type '%s' for player %s: %s",
                        message_type, player_id, exc,
                    )
                    error_msg = BroadcastMessage(
                        room_code=room_code,
                        message_type="error",
                        payload=json.dumps(
                            {"code": "INTERNAL_ERROR", "message": "An internal error occurred"}
                        ).encode("utf-8"),
                        target_player_ids=[player_id],
                    )
                    await send_queue.put(error_msg)

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.exception("Error in gRPC inbound processing: %s", exc)
        finally:
            # Signal the outbound loop to stop
            await send_queue.put(None)

    async def _dispatch_message(
        self,
        player_id: str,
        room_code: str,
        message_type: str,
        payload: dict,
        transport: VirtualTransport,
        send_queue: asyncio.Queue,
        room_manager,
        game_engine,
    ) -> None:
        """Dispatch a single GameMessage through the existing game logic.

        Mirrors the dispatch logic in ws_handler._handle_local_message but
        uses VirtualTransport instead of a real WebSocket. For identity
        messages (create_room, join_room, reconnect), registers the player's
        VirtualTransport as their websocket in the room.

        Args:
            player_id: The player's UUID.
            room_code: The room code.
            message_type: The action type string.
            payload: The parsed JSON payload dict.
            transport: The VirtualTransport for this player.
            send_queue: The per-stream outbound queue.
            room_manager: The RoomManager singleton.
            game_engine: The game_engine module.
        """
        from backend.models import RoomState

        if message_type == "create_room":
            name = payload.get("name", "")
            result = await room_manager.create_room(name, transport)
            # Send the result back to the player via transport
            await transport.send_json(result)
            return result

        elif message_type == "join_room":
            name = payload.get("name", "")
            rc = payload.get("room_code", room_code) or room_code
            result = await room_manager.join_room(name, rc, transport)
            await transport.send_json(result)
            return result

        elif message_type == "reconnect":
            name = payload.get("name", "")
            rc = payload.get("room_code", room_code) or room_code
            result = await room_manager.handle_reconnect(name, rc, transport)
            # On successful reconnect, the transport is now set as the player's websocket
            await transport.send_json(result)
            return result

        elif message_type == "update_settings":
            settings = payload if isinstance(payload, dict) else {}
            result = await room_manager.update_settings(player_id, settings)
            if result.get("type") == "error":
                await transport.send_json(result)

        elif message_type == "start_game":
            result = await room_manager.start_game(player_id)
            if result.get("type") == "error":
                await transport.send_json(result)
            else:
                room = room_manager._find_room_by_player(player_id)
                if room is not None:
                    await game_engine.start_turn(room, room_manager)

        elif message_type == "select_word":
            word = payload.get("word", "")
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                await game_engine.handle_word_selection(room, player_id, word, room_manager)

        elif message_type == "guess":
            text = payload.get("text", "")
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                await game_engine.handle_guess(room, player_id, text, room_manager)

        elif message_type == "chat":
            text = payload.get("text", "")
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                if room.state == RoomState.LOBBY:
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

        elif message_type == "stroke":
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                await room_manager.broadcast(room.code, {
                    "type": "stroke",
                    "payload": payload,
                })

        elif message_type == "fill":
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                await room_manager.broadcast(room.code, {
                    "type": "fill",
                    "payload": payload,
                })

        elif message_type == "clear_canvas":
            room = room_manager._find_room_by_player(player_id)
            if room is not None:
                await room_manager.broadcast(room.code, {
                    "type": "clear_canvas",
                    "payload": {},
                })

        elif message_type == "kick_player":
            target_id = payload.get("target_player_id", "")
            result = await room_manager.kick_player(player_id, target_id)
            if result.get("type") == "error":
                await transport.send_json(result)

        elif message_type == "leave_room":
            result = await room_manager.leave_room(player_id)
            await transport.send_json(result)

        elif message_type == "reaction":
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

        elif message_type == "toggle_ready":
            result = await room_manager.toggle_ready(player_id)
            if result.get("type") == "error":
                await transport.send_json(result)

        elif message_type == "rematch":
            result = await room_manager.handle_rematch(player_id)
            if result.get("type") == "error":
                await transport.send_json(result)

        elif message_type == "end_game_now":
            room = room_manager._find_room_by_player(player_id)
            if room and room.host_id == player_id:
                task = getattr(room, '_insufficient_players_task', None)
                if task and not task.done():
                    task.cancel()
                    room._insufficient_players_task = None
                await room_manager._end_game_insufficient_players_immediate(room)
            elif room:
                await transport.send_json({
                    "type": "error",
                    "payload": {"code": "PERMISSION_DENIED", "message": "Only the host can end the game"},
                })

        else:
            await transport.send_json({
                "type": "error",
                "payload": {"code": "UNKNOWN_MESSAGE", "message": f"Unknown message type: {message_type}"},
            })

    async def _cleanup_stream(
        self,
        transports: dict[str, VirtualTransport],
        player_rooms: dict[str, str],
    ) -> None:
        """Clean up all VirtualTransports on stream context cancellation.

        Marks all gRPC-connected players on this stream as disconnected
        via the room_manager disconnect handler.

        Args:
            transports: Dict of player_id -> VirtualTransport.
            player_rooms: Dict of player_id -> room_code.
        """
        from backend import game_engine
        from backend.ws_handler import room_manager

        for player_id in list(transports.keys()):
            try:
                await room_manager.handle_disconnect(player_id, game_engine)
            except Exception as exc:
                logger.warning(
                    "Error cleaning up gRPC player %s on stream close: %s",
                    player_id, exc,
                )

        transports.clear()
        player_rooms.clear()


async def start_grpc_server(port: int = GRPC_PORT) -> grpc.aio.Server:
    """Create and start a grpc.aio server with the GameServiceServicer.

    Runs on the same asyncio event loop as FastAPI/uvicorn.

    Args:
        port: The port to listen on (default from GRPC_PORT env var or 50051).

    Returns:
        The started grpc.aio.Server instance.
    """
    server = grpc.aio.server()
    game_pb2_grpc.add_GameServiceServicer_to_server(GameServiceServicer(), server)
    listen_addr = f"[::]:{port}"
    server.add_insecure_port(listen_addr)
    await server.start()
    logger.info("gRPC server started on %s", listen_addr)
    return server


async def run_grpc_server(port: int = GRPC_PORT) -> None:
    """Start the gRPC server and wait for termination.

    Convenience coroutine for standalone operation or integration testing.

    Args:
        port: The port to listen on (default from GRPC_PORT env var or 50051).
    """
    server = await start_grpc_server(port)
    try:
        await server.wait_for_termination()
    except asyncio.CancelledError:
        await server.stop(grace=5)
        logger.info("gRPC server stopped gracefully")
