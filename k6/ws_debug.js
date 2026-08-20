/**
 * Minimal WebSocket debug test — using setTimeout pattern.
 */
import ws from 'k6/ws';
import { check } from 'k6';

const HOST = __ENV.HOST || 'localhost';
const PORT = __ENV.PORT || '80';
const WS_URL = `ws://${HOST}:${PORT}/ws`;

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const res = ws.connect(WS_URL, {}, function (socket) {
    let received = [];

    socket.on('open', function () {
      console.log('[DEBUG] WebSocket connected');
      socket.send(JSON.stringify({ type: 'create_room', payload: { name: 'debug_test' } }));
      console.log('[DEBUG] Sent create_room');
    });

    socket.on('message', function (data) {
      console.log(`[DEBUG] Received: ${data}`);
      received.push(data);
      // Close after first message
      socket.close();
    });

    socket.on('error', function (e) {
      console.log(`[DEBUG] Error: ${e}`);
    });

    socket.on('close', function () {
      console.log(`[DEBUG] Closed. Total messages received: ${received.length}`);
    });

    // Use setTimeout to keep connection alive (k6's way to wait for messages)
    socket.setTimeout(function () {
      console.log(`[DEBUG] Timeout reached. Received ${received.length} messages`);
      if (received.length === 0) {
        socket.close();
      }
    }, 10000);
  });

  check(res, { 'status is 101': (r) => r && r.status === 101 });
}
