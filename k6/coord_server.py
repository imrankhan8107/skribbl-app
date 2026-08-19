"""
Lightweight coordination server for k6 load tests.

Enables k6 VUs to share room codes across the process boundary.
Host VUs POST their room_code, joiner VUs GET the code by room index.

Usage:
    python k6/coord_server.py
    python k6/coord_server.py --port 9090

This should be started BEFORE running the k6 test.
It's intentionally minimal — no dependencies beyond Python stdlib.
"""

import argparse
import json
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler


# Thread-safe room code storage
_rooms: dict[int, str] = {}
_lock = threading.Lock()


class CoordHandler(BaseHTTPRequestHandler):
    """HTTP handler for room code coordination."""

    def do_GET(self):
        """GET /rooms/{index} — retrieve room code for a given room index."""
        if self.path.startswith('/rooms/'):
            try:
                room_index = int(self.path.split('/rooms/')[1])
            except (ValueError, IndexError):
                self._respond(400, {'error': 'Invalid room index'})
                return

            with _lock:
                code = _rooms.get(room_index)

            if code:
                self._respond(200, {'room_code': code, 'room_index': room_index})
            else:
                self._respond(404, {'error': 'Room not yet created', 'room_index': room_index})

        elif self.path == '/rooms':
            # List all rooms (for debugging)
            with _lock:
                snapshot = dict(_rooms)
            self._respond(200, {'rooms': snapshot, 'count': len(snapshot)})

        elif self.path == '/health':
            self._respond(200, {'status': 'ok', 'rooms_tracked': len(_rooms)})

        elif self.path == '/reset':
            with _lock:
                _rooms.clear()
            self._respond(200, {'status': 'reset'})

        else:
            self._respond(404, {'error': 'Not found'})

    def do_POST(self):
        """POST /rooms/{index} — publish room code for a given room index."""
        if self.path.startswith('/rooms/'):
            try:
                room_index = int(self.path.split('/rooms/')[1])
            except (ValueError, IndexError):
                self._respond(400, {'error': 'Invalid room index'})
                return

            # Read body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            try:
                data = json.loads(body)
                room_code = data.get('room_code')
            except (json.JSONDecodeError, AttributeError):
                self._respond(400, {'error': 'Invalid JSON body'})
                return

            if not room_code:
                self._respond(400, {'error': 'Missing room_code'})
                return

            with _lock:
                _rooms[room_index] = room_code

            self._respond(200, {
                'status': 'published',
                'room_index': room_index,
                'room_code': room_code,
            })

        elif self.path == '/reset':
            with _lock:
                _rooms.clear()
            self._respond(200, {'status': 'reset'})

        else:
            self._respond(404, {'error': 'Not found'})

    def do_DELETE(self):
        """DELETE /rooms/{index} — remove a room code (for cleanup)."""
        if self.path.startswith('/rooms/'):
            try:
                room_index = int(self.path.split('/rooms/')[1])
            except (ValueError, IndexError):
                self._respond(400, {'error': 'Invalid room index'})
                return

            with _lock:
                removed = _rooms.pop(room_index, None)

            if removed:
                self._respond(200, {'status': 'removed', 'room_index': room_index})
            else:
                self._respond(404, {'error': 'Room not found'})

        elif self.path == '/rooms':
            with _lock:
                _rooms.clear()
            self._respond(200, {'status': 'all rooms cleared'})

        else:
            self._respond(404, {'error': 'Not found'})

    def _respond(self, status: int, body: dict):
        """Send a JSON response."""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, format, *args):
        """Suppress default request logging for cleaner output."""
        pass


def main():
    parser = argparse.ArgumentParser(description='k6 load test coordination server')
    parser.add_argument('--port', type=int, default=9090, help='Port to listen on (default: 9090)')
    parser.add_argument('--host', type=str, default='0.0.0.0', help='Host to bind to (default: 0.0.0.0)')
    args = parser.parse_args()

    server = HTTPServer((args.host, args.port), CoordHandler)
    print(f"[coord] Coordination server listening on {args.host}:{args.port}")
    print(f"[coord] Endpoints:")
    print(f"[coord]   GET  /rooms/{{index}}  — poll for room code")
    print(f"[coord]   POST /rooms/{{index}}  — publish room code")
    print(f"[coord]   GET  /rooms          — list all rooms")
    print(f"[coord]   GET  /health         — health check")
    print(f"[coord]   POST /reset          — clear all rooms")
    print(f"[coord]")
    print(f"[coord] Start your k6 test with: k6 run --env COORD_PORT={args.port} k6/ws_e2e_coordinated.js")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[coord] Shutting down.")
        server.shutdown()


if __name__ == '__main__':
    main()
