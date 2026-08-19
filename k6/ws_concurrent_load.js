/**
 * k6 WebSocket Concurrent Load Test — Skribbl App
 *
 * TRUE concurrency test: all VUs hold connections open simultaneously.
 * Each VU connects, creates a room, holds the connection for the test duration.
 *
 * Usage:
 *   k6 run --vus 100 --duration 1m k6/ws_concurrent_load.js
 *   k6 run --env HOST=192.168.0.5 --env PORT=80 --vus 5000 --duration 5m k6/ws_concurrent_load.js
 */

import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Custom metrics
const roomCreateLatency = new Trend('room_create_latency', true);
const roomsCreated = new Counter('rooms_created');
const messagesReceived = new Counter('messages_received');
const messagesSent = new Counter('messages_sent');
const connectionsFailed = new Counter('connections_failed');
const connectionsOpened = new Counter('connections_opened');

// Configuration
const HOST = __ENV.HOST || 'localhost';
const PORT = __ENV.PORT || '8000';
const WS_URL = `ws://${HOST}:${PORT}/ws`;

// Duration the socket stays open (slightly shorter than test duration)
const HOLD_SECONDS = parseInt(__ENV.HOLD_TIME || '240');

export const options = {
  thresholds: {
    'room_create_latency': ['p(95)<5000'],
    'connections_failed': ['count<100'],
  },
};

export default function () {
  const playerName = `k6_${__VU}_${__ITER}`;

  const response = ws.connect(WS_URL, null, function (socket) {
    connectionsOpened.add(1);
    let openTime = Date.now();
    let roomCreated = false;

    socket.on('open', function () {
      // Create a room immediately
      socket.send(JSON.stringify({
        type: 'create_room',
        payload: { name: playerName },
      }));
      messagesSent.add(1);
    });

    socket.on('message', function (data) {
      messagesReceived.add(1);
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'room_created' && !roomCreated) {
          roomCreated = true;
          roomsCreated.add(1);
          roomCreateLatency.add(Date.now() - openTime);
        }
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', payload: {} }));
          messagesSent.add(1);
        }
      } catch (e) {}
    });

    socket.on('error', function (e) {
      connectionsFailed.add(1);
    });

    // Keep alive: respond to heartbeat
    socket.setInterval(function () {
      socket.send(JSON.stringify({ type: 'pong', payload: {} }));
      messagesSent.add(1);
    }, 20000);

    // Periodic activity (chat message every 15-30s)
    socket.setInterval(function () {
      if (roomCreated) {
        socket.send(JSON.stringify({
          type: 'chat',
          payload: { text: `k6 ${__VU} alive` },
        }));
        messagesSent.add(1);
      }
    }, 15000 + Math.random() * 15000);

    // Close gracefully when hold time expires
    socket.setTimeout(function () {
      socket.close();
    }, HOLD_SECONDS * 1000);
  });

  // This runs AFTER the socket closes
  const success = response && response.status === 101;
  check(response, {
    'WebSocket connected (101)': (r) => r && r.status === 101,
  });

  if (!success) {
    connectionsFailed.add(1);
  }
}
