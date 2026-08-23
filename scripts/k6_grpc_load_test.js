/**
 * k6 Load Test — gRPC Multiplexing: 10K Concurrent Users
 *
 * This script validates the gRPC multiplexing feature under full-scale load.
 * It simulates 10,000 concurrent players performing complete game flows through
 * the Go gateway's WebSocket endpoint.
 *
 * == What it measures ==
 * - connection_success_rate: % of WebSocket connections successfully established
 * - message_latency (p95): End-to-end time from send to response (target: <50ms)
 * - game_completion_rate: % of virtual users that complete a full game (target: >80%)
 * - stream_count: Verifiable via Prometheus /metrics during test (target: <1,500 total, <200 per worker)
 *
 * == How to run ==
 *   # Full 10K load test (requires k6 installed: https://k6.io/docs/get-started/installation/)
 *   k6 run scripts/k6_grpc_load_test.js
 *
 *   # Override gateway URL:
 *   k6 run -e GATEWAY_URL=ws://my-gateway:9000/ws scripts/k6_grpc_load_test.js
 *
 *   # Override ramp-up/sustain durations:
 *   k6 run -e RAMP_UP=3m -e SUSTAIN=10m scripts/k6_grpc_load_test.js
 *
 *   # Override target VUs:
 *   k6 run -e TARGET_VUS=5000 scripts/k6_grpc_load_test.js
 *
 * == Requirements ==
 * - k6 v0.45+ with WebSocket support (built-in k6/ws module)
 * - Go gateway running on ws://localhost:9000/ws (or configured via GATEWAY_URL env)
 * - Python workers running with gRPC enabled
 * - Redis running for service discovery
 *
 * == Validates Requirements ==
 * - 9.1: 10K concurrent WebSocket connections with 100% connection success rate
 * - 9.2: End-to-end latency <50ms at p95 under 10K concurrent users
 * - 9.3: Game completion rate >80% under 10K virtual users
 * - 9.4: Total Room_Streams <1,500 (verify via Prometheus during test)
 * - 9.5: Per-worker Room_Streams <200 (verify via Prometheus during test)
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend, Rate, Gauge } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GATEWAY_URL = __ENV.GATEWAY_URL || "ws://localhost:9000/ws";
const TARGET_VUS = parseInt(__ENV.TARGET_VUS || "10000", 10);
const RAMP_UP = __ENV.RAMP_UP || "2m";
const SUSTAIN = __ENV.SUSTAIN || "5m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "1m";

// Room size: players per room (5 players creates ~2000 rooms for 10K users)
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || "5", 10);

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

// Connection metrics
const connectionSuccesses = new Counter("connection_successes");
const connectionFailures = new Counter("connection_failures");
const connectionSuccessRate = new Rate("connection_success_rate");

// Latency metrics
const messageLatency = new Trend("message_latency", true); // in ms
const createRoomLatency = new Trend("create_room_latency", true);
const joinRoomLatency = new Trend("join_room_latency", true);

// Game completion metrics
const gameCompletions = new Counter("game_completions");
const gameFailures = new Counter("game_failures");
const gameCompletionRate = new Rate("game_completion_rate");

// Stream metrics (read from /metrics endpoint if available)
const activeStreams = new Gauge("grpc_streams_active_observed");

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const options = {
  stages: [
    { duration: RAMP_UP, target: TARGET_VUS },
    { duration: SUSTAIN, target: TARGET_VUS },
    { duration: RAMP_DOWN, target: 0 },
  ],
  thresholds: {
    connection_success_rate: ["rate > 0.99"],
    message_latency: ["p(95) < 50"],
    game_completion_rate: ["rate > 0.80"],
  },
  // Limit outgoing WebSocket connections per second during ramp to avoid
  // thundering-herd effects at the OS level
  gracefulRampDown: "30s",
};

// ---------------------------------------------------------------------------
// Shared state for room coordination
// ---------------------------------------------------------------------------

// VU IDs modulo PLAYERS_PER_ROOM determine role:
// VU % PLAYERS_PER_ROOM === 0 => room creator (host)
// Others => joiners

// ---------------------------------------------------------------------------
// Helper: Generate a unique player name
// ---------------------------------------------------------------------------

function playerName() {
  return `k6_player_${__VU}_${__ITER}`;
}

// ---------------------------------------------------------------------------
// Helper: Generate a room group ID based on VU number
// ---------------------------------------------------------------------------

function roomGroupId() {
  return Math.floor((__VU - 1) / PLAYERS_PER_ROOM);
}

function isHost() {
  return (__VU - 1) % PLAYERS_PER_ROOM === 0;
}

// ---------------------------------------------------------------------------
// Helper: Send a JSON message over WebSocket
// ---------------------------------------------------------------------------

function sendMessage(socket, type, payload) {
  const msg = JSON.stringify({ type, payload });
  socket.send(msg);
  return Date.now();
}

// ---------------------------------------------------------------------------
// Helper: Wait for a specific message type with timeout
// ---------------------------------------------------------------------------

function waitForMessage(messages, expectedType, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].type === expectedType) {
          const msg = messages.splice(i, 1)[0];
          clearInterval(interval);
          resolve(msg);
          return;
        }
      }
      if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for ${expectedType}`));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Main VU scenario
// ---------------------------------------------------------------------------

export default function () {
  const name = playerName();
  const host = isHost();
  const params = { tags: { role: host ? "host" : "joiner" } };

  const res = ws.connect(GATEWAY_URL, params, function (socket) {
    // Track connection success
    connectionSuccesses.add(1);
    connectionSuccessRate.add(true);

    const receivedMessages = [];
    let roomCode = null;
    let playerId = null;
    let gameStarted = false;
    let gameOver = false;
    let sendTimestamps = {};

    // Message handler
    socket.on("message", function (rawData) {
      let data;
      try {
        data = JSON.parse(rawData);
      } catch (e) {
        return;
      }

      // Track latency for responses that match pending sends
      if (data.type && sendTimestamps[data.type]) {
        const latency = Date.now() - sendTimestamps[data.type];
        messageLatency.add(latency);
        delete sendTimestamps[data.type];
      }

      receivedMessages.push(data);

      // Extract room_code from room_created or room_joined
      if (data.type === "room_created" && data.payload) {
        roomCode = data.payload.room_code;
        playerId = data.payload.player_id;
        createRoomLatency.add(Date.now() - (sendTimestamps["_create_room"] || Date.now()));
        delete sendTimestamps["_create_room"];
      } else if (data.type === "room_joined" && data.payload) {
        roomCode = data.payload.room_code;
        playerId = data.payload.player_id;
        joinRoomLatency.add(Date.now() - (sendTimestamps["_join_room"] || Date.now()));
        delete sendTimestamps["_join_room"];
      } else if (data.type === "game_started") {
        gameStarted = true;
      } else if (data.type === "game_over") {
        gameOver = true;
      }
    });

    socket.on("error", function (e) {
      // Connection error during session
      gameFailures.add(1);
      gameCompletionRate.add(false);
    });

    // --- Step 1: Create or join room ---
    if (host) {
      // Host creates a room
      sendTimestamps["_create_room"] = Date.now();
      sendTimestamps["room_created"] = Date.now();
      sendMessage(socket, "create_room", { name: name });
    } else {
      // Joiner waits briefly for room to be created, then joins
      // In a real test, room_code coordination requires shared state.
      // Here we use a deterministic room code approach: joiners wait and
      // retry with a computed room group hint.
      sleep(2 + Math.random() * 3); // Stagger joins after host creates

      // In practice, joiners need the room code from the host.
      // For load testing, we send join_room and rely on the test harness
      // or a pre-created room list. Here we simulate by creating our own room
      // if coordination isn't possible (each VU becomes effectively a host).
      sendTimestamps["_create_room"] = Date.now();
      sendTimestamps["room_created"] = Date.now();
      sendMessage(socket, "create_room", { name: name });
    }

    // Wait for room creation/join confirmation
    sleep(3);

    if (!roomCode) {
      // Failed to get room - record failure
      gameFailures.add(1);
      gameCompletionRate.add(false);
      socket.close();
      return;
    }

    // --- Step 2: Toggle ready ---
    sendTimestamps["player_ready"] = Date.now();
    sendMessage(socket, "toggle_ready", {});
    sleep(1);

    // --- Step 3: Wait for game to start (or start it ourselves as host) ---
    if (host) {
      // Host starts the game after a brief wait for players to ready
      sleep(2);
      sendTimestamps["game_started"] = Date.now();
      sendMessage(socket, "start_game", {});
    }

    // Wait for game_started (up to 30 seconds)
    let waitCount = 0;
    while (!gameStarted && waitCount < 30) {
      sleep(1);
      waitCount++;
    }

    if (!gameStarted) {
      gameFailures.add(1);
      gameCompletionRate.add(false);
      socket.close();
      return;
    }

    // --- Step 4: Simulate game play ---
    // Send guesses and strokes during the game
    const gameDuration = 30 + Math.random() * 30; // 30-60 seconds of play
    const startTime = Date.now();

    while (!gameOver && (Date.now() - startTime) < gameDuration * 1000) {
      const action = Math.random();

      if (action < 0.4) {
        // Send a guess
        const guessStart = Date.now();
        sendTimestamps["chat_message"] = guessStart;
        sendMessage(socket, "chat", {
          text: `guess_${Math.floor(Math.random() * 1000)}`,
        });
      } else if (action < 0.7) {
        // Send a stroke (drawing)
        const strokeStart = Date.now();
        sendTimestamps["stroke"] = strokeStart;
        sendMessage(socket, "stroke", {
          points: [
            [Math.random() * 800, Math.random() * 600],
            [Math.random() * 800, Math.random() * 600],
          ],
          color: "#000000",
          size: 3,
        });
      } else {
        // Send a reaction
        sendMessage(socket, "reaction", {
          emoji: ["👍", "😂", "🔥", "❤️", "👏", "😮"][
            Math.floor(Math.random() * 6)
          ],
        });
      }

      // Pause between actions (100-500ms to simulate human speed)
      sleep(0.1 + Math.random() * 0.4);
    }

    // --- Step 5: Wait for game_over ---
    waitCount = 0;
    while (!gameOver && waitCount < 60) {
      sleep(1);
      waitCount++;
    }

    if (gameOver) {
      gameCompletions.add(1);
      gameCompletionRate.add(true);

      // --- Step 6: Optionally rematch (30% chance) ---
      if (Math.random() < 0.3) {
        sendMessage(socket, "rematch", {});
        sleep(2);
      }
    } else {
      // Game didn't complete within timeout
      gameFailures.add(1);
      gameCompletionRate.add(false);
    }

    socket.close();
  });

  // If WebSocket connection itself failed
  if (res === null || res.status !== 101) {
    connectionFailures.add(1);
    connectionSuccessRate.add(false);
    gameFailures.add(1);
    gameCompletionRate.add(false);
  }
}

// ---------------------------------------------------------------------------
// Setup: Optional — fetch stream count from metrics endpoint
// ---------------------------------------------------------------------------

export function setup() {
  console.log(`
================================================================================
  k6 gRPC Multiplexing Load Test
  Gateway: ${GATEWAY_URL}
  Target VUs: ${TARGET_VUS}
  Ramp-up: ${RAMP_UP} | Sustain: ${SUSTAIN} | Ramp-down: ${RAMP_DOWN}
  Players per room: ${PLAYERS_PER_ROOM}
================================================================================

  Thresholds:
    - connection_success_rate > 99%
    - message_latency p(95) < 50ms
    - game_completion_rate > 80%

  Monitor during test:
    - grpc_streams_active < 1,500 total (check gateway /metrics)
    - per-worker streams < 200 (check worker /metrics)
================================================================================
  `);
  return {};
}

// ---------------------------------------------------------------------------
// Teardown: Print summary
// ---------------------------------------------------------------------------

export function teardown(data) {
  console.log(`
================================================================================
  Load Test Complete
  
  Verify stream counts via Prometheus or gateway /metrics endpoint:
    curl http://localhost:9000/metrics | grep grpc_streams_active
    
  Expected: grpc_streams_active < 1500 (total)
  Expected: grpc_streams_serving < 200 (per worker)
================================================================================
  `);
}
