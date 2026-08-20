"""
Lightweight coordination server for k6 load tests.

Enables k6 VUs to share room codes across the process boundary.
Host VUs POST their room_code, joiner VUs GET the code by room index.

Usage:
    python k6/coord_server.py
    python k6/coord_server.py --port 9090

This should be started BEFORE running the k6 test.
Uses asyncio for high concurrency (handles 1000+ VUs polling simultaneously).
"""

import argparse
import asyncio
import json
from aiohttp import web


# Thread-safe room code storage (asyncio is single-threaded, so dict is safe)
_rooms: dict[int, str] = {}


async def handle_get_room(request: web.Request) -> web.Response:
    """GET /rooms/{index} — retrieve room code for a given room index."""
    try:
        room_index = int(request.match_info['index'])
    except (ValueError, KeyError):
        return web.json_response({'error': 'Invalid room index'}, status=400)

    code = _rooms.get(room_index)
    if code:
        return web.json_response({'room_code': code, 'room_index': room_index})
    else:
        return web.json_response(
            {'error': 'Room not yet created', 'room_index': room_index}, status=404
        )


async def handle_list_rooms(request: web.Request) -> web.Response:
    """GET /rooms — list all rooms (for debugging)."""
    return web.json_response({'rooms': {str(k): v for k, v in _rooms.items()}, 'count': len(_rooms)})


async def handle_post_room(request: web.Request) -> web.Response:
    """POST /rooms/{index} — publish room code for a given room index."""
    try:
        room_index = int(request.match_info['index'])
    except (ValueError, KeyError):
        return web.json_response({'error': 'Invalid room index'}, status=400)

    try:
        data = await request.json()
        room_code = data.get('room_code')
    except (json.JSONDecodeError, AttributeError):
        return web.json_response({'error': 'Invalid JSON body'}, status=400)

    if not room_code:
        return web.json_response({'error': 'Missing room_code'}, status=400)

    _rooms[room_index] = room_code
    return web.json_response({
        'status': 'published',
        'room_index': room_index,
        'room_code': room_code,
    })


async def handle_delete_room(request: web.Request) -> web.Response:
    """DELETE /rooms/{index} — remove a room code (for cleanup)."""
    try:
        room_index = int(request.match_info['index'])
    except (ValueError, KeyError):
        return web.json_response({'error': 'Invalid room index'}, status=400)

    removed = _rooms.pop(room_index, None)
    if removed:
        return web.json_response({'status': 'removed', 'room_index': room_index})
    else:
        return web.json_response({'error': 'Room not found'}, status=404)


async def handle_delete_all_rooms(request: web.Request) -> web.Response:
    """DELETE /rooms — clear all rooms."""
    _rooms.clear()
    return web.json_response({'status': 'all rooms cleared'})


async def handle_health(request: web.Request) -> web.Response:
    """GET /health — health check."""
    return web.json_response({'status': 'ok', 'rooms_tracked': len(_rooms)})


async def handle_reset(request: web.Request) -> web.Response:
    """POST /reset or GET /reset — clear all rooms."""
    _rooms.clear()
    return web.json_response({'status': 'reset'})


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get('/rooms/{index}', handle_get_room)
    app.router.add_get('/rooms', handle_list_rooms)
    app.router.add_post('/rooms/{index}', handle_post_room)
    app.router.add_delete('/rooms/{index}', handle_delete_room)
    app.router.add_delete('/rooms', handle_delete_all_rooms)
    app.router.add_get('/health', handle_health)
    app.router.add_get('/reset', handle_reset)
    app.router.add_post('/reset', handle_reset)
    return app


def main():
    parser = argparse.ArgumentParser(description='k6 load test coordination server')
    parser.add_argument('--port', type=int, default=9090, help='Port to listen on (default: 9090)')
    parser.add_argument('--host', type=str, default='0.0.0.0', help='Host to bind to (default: 0.0.0.0)')
    args = parser.parse_args()

    print(f"[coord] Coordination server listening on {args.host}:{args.port}")
    print(f"[coord] Endpoints:")
    print(f"[coord]   GET  /rooms/{{index}}  — poll for room code")
    print(f"[coord]   POST /rooms/{{index}}  — publish room code")
    print(f"[coord]   GET  /rooms          — list all rooms")
    print(f"[coord]   GET  /health         — health check")
    print(f"[coord]   POST /reset          — clear all rooms")
    print(f"[coord]")
    print(f"[coord] Using aiohttp async server (handles 1000+ concurrent connections)")
    print(f"[coord]")
    print(f"[coord] Start your k6 test with: k6 run --env COORD_PORT={args.port} k6/ws_mixed_workload.js")

    app = create_app()
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == '__main__':
    main()
