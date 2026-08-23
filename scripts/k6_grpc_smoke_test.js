/**
 * k6 Smoke Test — gRPC Multiplexing (Event-Driven Pattern)
 *
 * Based on the proven ws_e2e_coordinated.js pattern:
 * - sleep() does NOT yield to WS events in k6 v2.x
 * - ALL logic lives inside socket.on('message') callbacks
 * - socket.setTimeout/setInterval for timed actions
 * - Coordination via gateway's /rooms/{index} endpoint
 *
 * == How to run ==
 *   python -m uvicorn backend.main:app --port 8000
 *   cd gateway; go run . --backends localhost:8000
 *   k6 run scripts/k6_grpc_smoke_test.js
 */

import ws from "k6/ws";
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";
import exec from "k6/execution";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_URL = __ENV.WS_URL || "ws://localhost:9000/ws";
const COORD_BASE = __ENV.COORD_BASE || "http://localhost:9000/rooms";
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || "2", 10);
const TARGET_VUS = parseInt(__ENV.VUS || "20", 10);
const NUM_ROUNDS = 1;
const TURN_DURATION = 30;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const connectionSuccessRate = new Rate("connection_success_rate");
const messageLatency = new Trend("message_latency", true);
const createRoomLatency = new Trend("create_room_latency", true);
const joinRoomLatency = new Trend("join_room_latency", true);
const gameCompletionRate = new Rate("game_completion_rate");
const gamesStarted = new Counter("games_started");
const gamesCompleted = new Counter("games_completed");
const errors = new Counter("errors");

// ---------------------------------------------------------------------------
// Options — single scenario, VUs split into hosts/joiners by ID
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    game_sessions: {
      executor: "per-vu-iterations",
      vus: TARGET_VUS,
      iterations: 1,
      maxDuration: "10m",
    },
  },
  thresholds: {
    connection_success_rate: ["rate > 0.95"],
    message_latency: ["p(95) < 100"],
    game_completion_rate: ["rate > 0.50"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoomIndex(vu) {
  return Math.floor((vu - 1) / PLAYERS_PER_ROOM);
}

function isHostVU(vu) {
  return (vu - 1) % PLAYERS_PER_ROOM === 0;
}

function publishRoomCode(roomIndex, roomCode) {
  http.post(
    `${COORD_BASE}/${roomIndex}`,
    JSON.stringify({ room_code: roomCode }),
    { headers: { "Content-Type": "application/json" } }
  );
}

function pollRoomCode(roomIndex, timeoutMs) {
  const start = Date.now();
  const maxRetries = Math.ceil(timeoutMs / 500);
  for (let i = 0; i < maxRetries; i++) {
    const res = http.get(`${COORD_BASE}/${roomIndex}`);
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.room_code) return body.room_code;
      } catch (e) {}
    }
    if (Date.now() - start >= timeoutMs) break;
    // sleep is OK here — we're OUTSIDE ws.connect
    __sleep(0.5);
  }
  return null;
}

// k6 sleep import
import { sleep as __sleep } from "k6";

// ---------------------------------------------------------------------------
// Main Test — VU role determined by ID
// ---------------------------------------------------------------------------

export default function () {
  const vu = exec.vu.idInTest;
  const roomIndex = getRoomIndex(vu);
  const isHost = isHostVU(vu);
  const playerName = `k6_${isHost ? "host" : "join"}_vu${vu}_r${roomIndex}`;

  // --- Pre-connection: joiners poll for room code BEFORE connecting ---
  let coordRoomCode = null;

  if (isHost) {
    // Small stagger for hosts
    __sleep(roomIndex * 0.2);
  } else {
    // Joiners wait for room to be created, then poll
    __sleep(2 + roomIndex * 0.3);
    coordRoomCode = pollRoomCode(roomIndex, 15000);
    if (!coordRoomCode) {
      errors.add(1);
      connectionSuccessRate.add(false);
      gameCompletionRate.add(false);
      return;
    }
  }

  // --- WebSocket connection ---
  let gameCompleted = false;
  const connectStart = Date.now();

  const res = ws.connect(WS_URL, { tags: { role: isHost ? "host" : "joiner" } }, function (socket) {
    connectionSuccessRate.add(true);

    let state = "connecting";
    let roomCode = coordRoomCode;
    let playerId = null;
    let playerCount = 0;
    let gameStartTime = 0;

    function sendMsg(type, payload) {
      socket.send(JSON.stringify({ type, payload }));
    }

    // ── On open: send first message ──
    socket.on("open", function () {
      if (isHost) {
        sendMsg("create_room", { name: playerName });
      } else {
        sendMsg("join_room", { name: playerName, room_code: roomCode });
      }
    });

    // ── Message handler: event-driven state machine ──
    socket.on("message", function (data) {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }

      // Handle ping
      if (msg.type === "ping") {
        sendMsg("pong", {});
        return;
      }

      switch (state) {
        case "connecting":
          if (msg.type === "room_created" && msg.payload) {
            roomCode = msg.payload.room_code;
            playerId = msg.payload.player_id;
            createRoomLatency.add(Date.now() - connectStart);
            messageLatency.add(Date.now() - connectStart);
            state = "lobby";

            // Publish room code for joiners
            publishRoomCode(roomIndex, roomCode);

            // Update settings for short game
            sendMsg("update_settings", { num_rounds: NUM_ROUNDS, turn_duration: TURN_DURATION });

            // Toggle ready
            socket.setTimeout(function () {
              sendMsg("toggle_ready", {});
            }, 500);

          } else if (msg.type === "room_joined" && msg.payload) {
            playerId = msg.payload.player_id;
            joinRoomLatency.add(Date.now() - connectStart);
            messageLatency.add(Date.now() - connectStart);
            state = "lobby";

            // Toggle ready
            socket.setTimeout(function () {
              sendMsg("toggle_ready", {});
            }, 1000);

          } else if (msg.type === "error") {
            errors.add(1);
            socket.close();
          }
          break;

        case "lobby":
          if (msg.type === "player_list" && msg.payload) {
            playerCount = msg.payload.players.length;

            // Host starts game when room is full
            if (isHost && playerCount >= PLAYERS_PER_ROOM) {
              socket.setTimeout(function () {
                gameStartTime = Date.now();
                sendMsg("start_game", {});
                gamesStarted.add(1);
                state = "waiting_start";
              }, 2000);
            }
          } else if (msg.type === "game_started" || msg.type === "turn_started" || msg.type === "word_choices") {
            state = "playing";
            handlePlayingMsg(msg);
          }
          break;

        case "waiting_start":
          if (msg.type === "game_started" || msg.type === "turn_started" || msg.type === "word_choices") {
            state = "playing";
            handlePlayingMsg(msg);
          } else if (msg.type === "error") {
            errors.add(1);
            socket.close();
          }
          break;

        case "playing":
          handlePlayingMsg(msg);
          break;
      }

      function handlePlayingMsg(m) {
        if (m.type === "word_choices" && m.payload) {
          // Auto-select first word
          const choices = m.payload.choices;
          if (choices && choices.length > 0) {
            socket.setTimeout(function () {
              sendMsg("select_word", { word: choices[0] });
            }, 1000);
          }
        } else if (m.type === "game_over") {
          gameCompleted = true;
          gamesCompleted.add(1);
          gameCompletionRate.add(true);
          socket.close();
        } else if (m.type === "turn_started") {
          // Send activity during turn
          const isDrawer = m.payload && m.payload.drawer_id === playerId;
          if (isDrawer) {
            // Draw strokes
            socket.setInterval(function () {
              if (state === "playing") {
                sendMsg("stroke", {
                  points: [[Math.random()*800, Math.random()*600],[Math.random()*800, Math.random()*600]],
                  color: "#000000", size: 3
                });
              }
            }, 2000);
          } else {
            // Send guesses
            socket.setInterval(function () {
              if (state === "playing") {
                sendMsg("guess", { text: "word_" + Math.floor(Math.random() * 100) });
              }
            }, 3000);
          }
        }
      }
    });

    socket.on("error", function (e) {
      errors.add(1);
    });

    // ── Session timeout — just close after 5 minutes, let game finish naturally ──
    socket.setTimeout(function () {
      if (!gameCompleted) {
        socket.close();
      }
    }, 300000);
  });

  // Post-connection
  check(res, { "WS connected": (r) => r && r.status === 101 });

  if (!res || res.status !== 101) {
    connectionSuccessRate.add(false);
    gameCompletionRate.add(false);
    return;
  }

  if (!gameCompleted) {
    gameCompletionRate.add(false);
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

export function setup() {
  const res = http.get("http://localhost:9000/health");
  console.log(`Gateway: ${res.body}`);
  console.log(`Config: ${TARGET_VUS} VUs, ${TARGET_VUS/PLAYERS_PER_ROOM} rooms, ${PLAYERS_PER_ROOM} players/room`);
  console.log(`Game: ${NUM_ROUNDS} round(s), ${TURN_DURATION}s turns`);
  return {};
}

export function teardown() {
  console.log("Done. Check thresholds above.");
}
