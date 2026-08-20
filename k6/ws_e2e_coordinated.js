/**
 * k6 WebSocket E2E Coordinated Game Load Test — Skribbl App
 *
 * SOLVES THE CORE PROBLEM: True multi-player room coordination.
 *
 * Architecture:
 *   - Uses a lightweight HTTP coordination server (k6/coord_server.py)
 *   - Host creates room → POST /coord/rooms/{roomIndex} with room_code
 *   - Joiners poll GET /coord/rooms/{roomIndex} until room_code is available
 *   - Then joiners send join_room with the actual code
 *   - Full game lifecycle plays out with synchronized players
 *
 * k6 v2.2.0 FIX:
 *   sleep() inside ws.connect() does NOT yield to WebSocket event handlers.
 *   This script uses a PURELY EVENT-DRIVEN STATE MACHINE pattern:
 *   - ALL game logic lives inside socket.on('message') callbacks
 *   - socket.setTimeout() for timeouts
 *   - socket.setInterval() for periodic actions (drawing, guessing, polling)
 *   - NO sleep() calls inside the ws.connect() callback
 *
 * Room topology:
 *   VU 1-5   → Room 0 (VU 1 = host, VU 2-5 = joiners)
 *   VU 6-10  → Room 1 (VU 6 = host, VU 7-10 = joiners)
 *   VU 11-15 → Room 2 (VU 11 = host, VU 12-15 = joiners)
 *   ...
 *
 * Test levels:
 *   Baseline:        50 VUs  → 10 rooms  × 5 players
 *   Normal:         250 VUs  → 50 rooms  × 5 players
 *   Production-like: 500 VUs → 100 rooms × 5 players
 *   Stress:        1000 VUs  → 200 rooms × 5 players
 *
 * Prerequisites:
 *   1. Start coordination server: python k6/coord_server.py
 *   2. Start your Skribbl app: python -m uvicorn backend.main:app --port 8000
 *   3. Run: k6 run k6/ws_e2e_coordinated.js
 *
 * Usage:
 *   k6 run k6/ws_e2e_coordinated.js
 *   k6 run --env VUS=250 --env COORD_PORT=9090 k6/ws_e2e_coordinated.js
 *   k6 run --env VUS=500 --env HOST=prod.example.com k6/ws_e2e_coordinated.js
 */

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import exec from 'k6/execution';

// ─── Custom Metrics ─────────────────────────────────────────────────────────

// Connection
const wsConnectRtt = new Trend('ws_connect_rtt', true);
const connectionSuccess = new Rate('ws_connection_success');
const connectionFailures = new Counter('ws_connection_failures');

// Room lifecycle
const roomCreateRtt = new Trend('room_create_rtt', true);
const roomJoinRtt = new Trend('room_join_rtt', true);
const roomsCreated = new Counter('rooms_created');
const roomCreateFailures = new Counter('room_create_failures');
const roomsJoined = new Counter('rooms_joined');
const roomJoinFailures = new Counter('room_join_failures');

// Game lifecycle
const gameStartRtt = new Trend('game_start_rtt', true);
const gamesStarted = new Counter('games_started');
const gamesCompleted = new Counter('games_completed');
const gamesAborted = new Counter('games_aborted');
const gameCompletionRate = new Rate('game_completion_rate');

// Turn metrics
const wordSelectionRtt = new Trend('word_selection_rtt', true);
const turnsPlayed = new Counter('turns_played');

// Message throughput
const messagesSent = new Counter('messages_sent');
const messagesReceived = new Counter('messages_received');
const drawingEventsSent = new Counter('drawing_events_sent');
const guessesSent = new Counter('guesses_sent');
const correctGuesses = new Counter('correct_guesses');
const chatMessagesSent = new Counter('chat_messages_sent');

// Broadcast latency
const guessBroadcastRtt = new Trend('guess_broadcast_rtt', true);
const drawBroadcastRtt = new Trend('draw_broadcast_rtt', true);

// Errors & health
const disconnects = new Counter('disconnects');
const errorCount = new Counter('errors');
const activeConnections = new Gauge('active_connections');

// ─── Configuration ──────────────────────────────────────────────────────────

const HOST = __ENV.HOST || 'localhost';
const PORT = __ENV.PORT || '8000';
const COORD_HOST = __ENV.COORD_HOST || 'localhost';
const COORD_PORT = __ENV.COORD_PORT || '9090';
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const COORD_URL = `http://${COORD_HOST}:${COORD_PORT}`;
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || '5');
const TARGET_VUS = parseInt(__ENV.VUS || '50');
const NUM_ROUNDS = parseInt(__ENV.NUM_ROUNDS || '3');
const TURN_DURATION = parseInt(__ENV.TURN_DURATION || '80');
const HOLD_SECONDS = Math.min(
  NUM_ROUNDS * PLAYERS_PER_ROOM * (TURN_DURATION + 20) + 180,
  parseInt(__ENV.HOLD_TIME || '600')
);

// ─── k6 Options ─────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    game_sessions: {
      executor: 'per-vu-iterations',
      vus: TARGET_VUS,
      iterations: 1,
      maxDuration: '20m',
    },
  },
  thresholds: {
    ws_connect_rtt: ['p(95)<5000', 'p(99)<10000'],
    room_create_rtt: ['p(95)<3000'],
    room_join_rtt: ['p(95)<5000'],
    game_start_rtt: ['p(95)<5000'],
    ws_connection_success: ['rate>0.95'],
    game_completion_rate: ['rate>0.70'],
    errors: ['count<50'],
  },
};

// ─── Word lists for guessing ────────────────────────────────────────────────

const GUESS_WORDS = [
  'cat', 'dog', 'house', 'tree', 'car', 'sun', 'moon', 'fish',
  'bird', 'boat', 'star', 'flower', 'mountain', 'river', 'cloud',
  'book', 'chair', 'table', 'phone', 'guitar', 'piano', 'clock',
  'bridge', 'castle', 'dragon', 'elephant', 'butterfly', 'rainbow',
  'umbrella', 'bicycle', 'airplane', 'lighthouse', 'snowman', 'pizza',
];

// ─── Utilities ──────────────────────────────────────────────────────────────

function getRoomIndex(vu) {
  return Math.floor((vu - 1) / PLAYERS_PER_ROOM);
}

function isHostVU(vu) {
  return (vu - 1) % PLAYERS_PER_ROOM === 0;
}

function getPlayerIndexInRoom(vu) {
  return (vu - 1) % PLAYERS_PER_ROOM;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function generateStrokePoints(numPoints) {
  const points = [];
  let x = Math.random() * 800;
  let y = Math.random() * 600;
  const angle = Math.random() * Math.PI * 2;
  const speed = 1 + Math.random() * 3;

  for (let i = 0; i < numPoints; i++) {
    x += Math.cos(angle + i * 0.1) * speed + (Math.random() - 0.5) * 2;
    y += Math.sin(angle + i * 0.1) * speed + (Math.random() - 0.5) * 2;
    x = Math.max(0, Math.min(800, x));
    y = Math.max(0, Math.min(600, y));
    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return points;
}

// ─── Coordination helpers (used OUTSIDE ws.connect for joiners) ─────────────

function publishRoomCode(roomIndex, roomCode) {
  const res = http.post(`${COORD_URL}/rooms/${roomIndex}`, JSON.stringify({ room_code: roomCode }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'coord_publish' },
  });
  return res.status === 200;
}

function pollRoomCode(roomIndex, timeoutMs) {
  const start = Date.now();
  const maxRetries = Math.ceil(timeoutMs / 500);

  for (let i = 0; i < maxRetries; i++) {
    const res = http.get(`${COORD_URL}/rooms/${roomIndex}`, {
      tags: { name: 'coord_poll' },
    });

    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.room_code) {
          return body.room_code;
        }
      } catch (e) {
        // Parse error, retry
      }
    }

    if (Date.now() - start >= timeoutMs) break;
    sleep(0.5);
  }
  return null;
}

// ─── Main Test Function ─────────────────────────────────────────────────────

export default function () {
  const vu = exec.vu.idInTest;
  const roomIndex = getRoomIndex(vu);
  const isHost = isHostVU(vu);
  const playerIndex = getPlayerIndexInRoom(vu);
  const playerName = `k6_${isHost ? 'host' : 'p' + playerIndex}_vu${vu}_r${roomIndex}`;

  // ── Pre-connection coordination (sleep is fine OUTSIDE ws.connect) ──

  let coordRoomCode = null;

  if (!isHost) {
    // Stagger joiners: wait 2-5s after hosts connect
    sleep(2 + playerIndex * 0.5 + Math.random() * 0.5);

    // Poll coordination server BEFORE connecting to WebSocket
    coordRoomCode = pollRoomCode(roomIndex, 20000);
    if (!coordRoomCode) {
      console.log(`[JOINER VU${vu}] Failed to get room code from coord server`);
      roomJoinFailures.add(1);
      errorCount.add(1);
      connectionSuccess.add(0);
      return;
    }
  }

  // ── WebSocket connection ──

  const connectStart = Date.now();
  const wsUrl = `${WS_URL}?room=${roomIndex}`;

  const res = ws.connect(wsUrl, { tags: { room: `room_${roomIndex}`, role: isHost ? 'host' : 'joiner' } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    activeConnections.add(1);

    // ══════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════

    let state = 'connecting'; // connecting | lobby | waiting_start | playing | game_over | error
    let roomCode = coordRoomCode;
    let playerId = null;
    let isDrawer = false;
    let currentWord = null;
    let turnActive = false;
    let gameCompleted = false;

    // Timing state
    let roomCreateStart = 0;
    let roomJoinStart = 0;
    let gameStartTime = 0;
    let wordSelectStart = 0;
    let lastGuessStart = 0;
    let lastStrokeStart = 0;

    // Intervals (references kept for documentation, controlled via flags)
    let drawingInterval = null;
    let guessingInterval = null;
    let heartbeatInterval = null;

    // Drawing state
    let strokesRemaining = 0;
    let currentTurnDuration = TURN_DURATION;

    // Guessing state
    let guessesRemaining = 0;

    // ══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    function sendMsg(msg) {
      try {
        socket.send(JSON.stringify(msg));
        messagesSent.add(1);
      } catch (e) {
        errorCount.add(1);
      }
    }

    // Flags to control intervals (k6 doesn't support socket.clearInterval)
    let drawingActive = false;
    let guessingActive = false;
    let heartbeatActive = true;
    let sessionEnded = false;

    function clearGameIntervals() {
      drawingActive = false;
      guessingActive = false;
    }

    function endSession(reason) {
      if (sessionEnded) return;
      sessionEnded = true;
      clearGameIntervals();
      heartbeatActive = false;
      state = 'game_over';
      if (reason === 'completed') {
        // already recorded
      } else if (reason === 'aborted') {
        gamesAborted.add(1);
        gameCompletionRate.add(0);
      } else if (reason === 'error') {
        state = 'error';
        errorCount.add(1);
      }
      socket.close();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SOCKET OPEN — Send initial message
    // ══════════════════════════════════════════════════════════════════════════

    socket.on('open', function () {
      if (isHost) {
        // Host: create the room
        roomCreateStart = Date.now();
        sendMsg({ type: 'create_room', payload: { name: playerName } });

        // Timeout: if no room_created in 10s, fail
        socket.setTimeout(function () {
          if (state === 'connecting') {
            console.log(`[HOST VU${vu}] Timeout waiting for room_created`);
            roomCreateFailures.add(1);
            endSession('error');
          }
        }, 10000);
      } else {
        // Joiner: join with the room code we already have
        roomJoinStart = Date.now();
        sendMsg({ type: 'join_room', payload: { name: playerName, room_code: roomCode } });

        // Timeout: if no room_joined in 10s, fail
        socket.setTimeout(function () {
          if (state === 'connecting') {
            console.log(`[JOINER VU${vu}] Timeout waiting for room_joined`);
            roomJoinFailures.add(1);
            endSession('error');
          }
        }, 10000);
      }

      // ── Heartbeat interval ──
      heartbeatInterval = socket.setInterval(function () {
        if (heartbeatActive) sendMsg({ type: 'pong', payload: {} });
      }, 25000);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // MESSAGE HANDLER — The State Machine
    // ══════════════════════════════════════════════════════════════════════════

    socket.on('message', function (data) {
      messagesReceived.add(1);

      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        errorCount.add(1);
        return;
      }

      // ── Always handle ping ──
      if (msg.type === 'ping') {
        sendMsg({ type: 'pong', payload: {} });
        return;
      }

      // ── State machine dispatch ──
      switch (state) {
        case 'connecting':
          handleConnecting(msg);
          break;
        case 'lobby':
          handleLobby(msg);
          break;
        case 'waiting_start':
          handleWaitingStart(msg);
          break;
        case 'playing':
          handlePlaying(msg);
          break;
        case 'game_over':
        case 'error':
          // Ignore messages after game is done
          break;
      }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // STATE: connecting
    // ══════════════════════════════════════════════════════════════════════════

    function handleConnecting(msg) {
      if (msg.type === 'room_created') {
        roomCreateRtt.add(Date.now() - roomCreateStart);
        roomsCreated.add(1);
        roomCode = msg.payload.room_code;
        playerId = msg.payload.player_id;
        state = 'lobby';

        // Publish room code to coordination server for joiners
        publishRoomCode(roomIndex, roomCode);

        // Host waits in lobby for players to join
        // Set a timeout — if game hasn't started in 60s, abort
        socket.setTimeout(function () {
          if (state === 'lobby' || state === 'waiting_start') {
            console.log(`[HOST VU${vu}] Timeout waiting for game to start`);
            endSession('aborted');
          }
        }, 60000);

      } else if (msg.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - roomJoinStart);
        roomsJoined.add(1);
        roomCode = msg.payload.room_code;
        playerId = msg.payload.player_id;
        state = 'lobby';

        // Joiner readies up after a short delay (1-3s simulated via setTimeout)
        socket.setTimeout(function () {
          if (state === 'lobby') {
            sendMsg({ type: 'toggle_ready', payload: {} });
          }
        }, Math.floor(randomBetween(1000, 3000)));

        // Set a timeout — if game hasn't started in 60s, abort
        socket.setTimeout(function () {
          if (state === 'lobby' || state === 'waiting_start') {
            console.log(`[JOINER VU${vu}] Timeout waiting for game to start`);
            endSession('aborted');
          }
        }, 60000);

      } else if (msg.type === 'error') {
        console.log(`[VU${vu}] Error during connecting: ${JSON.stringify(msg.payload)}`);
        if (isHost) roomCreateFailures.add(1);
        else roomJoinFailures.add(1);
        endSession('error');
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE: lobby
    // ══════════════════════════════════════════════════════════════════════════

    function handleLobby(msg) {
      if (msg.type === 'player_list') {
        // Host: check if room is full, then ready up and start game
        if (isHost && msg.payload.players && msg.payload.players.length >= PLAYERS_PER_ROOM) {
          // Ready up after brief delay
          socket.setTimeout(function () {
            if (state === 'lobby') {
              sendMsg({ type: 'toggle_ready', payload: {} });

              // Start game after a short delay for all to be ready
              socket.setTimeout(function () {
                if (state === 'lobby') {
                  gameStartTime = Date.now();
                  sendMsg({ type: 'start_game', payload: {} });
                  gamesStarted.add(1);
                  state = 'waiting_start';
                }
              }, Math.floor(randomBetween(2000, 4000)));
            }
          }, Math.floor(randomBetween(500, 1500)));
        }
      } else if (msg.type === 'drawer_selecting' || msg.type === 'turn_started') {
        // Game started (possibly triggered by another event path)
        if (gameStartTime === 0) gameStartTime = Date.now();
        gameStartRtt.add(Date.now() - gameStartTime);
        state = 'playing';
        handlePlaying(msg);
      } else if (msg.type === 'game_over') {
        gameCompleted = true;
        gamesCompleted.add(1);
        gameCompletionRate.add(1);
        endSession('completed');
      } else if (msg.type === 'error') {
        console.log(`[VU${vu}] Error in lobby: ${JSON.stringify(msg.payload)}`);
        endSession('error');
      }
      // Ignore other messages in lobby (chat_message, etc.)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE: waiting_start (host sent start_game, waiting for confirmation)
    // ══════════════════════════════════════════════════════════════════════════

    function handleWaitingStart(msg) {
      if (msg.type === 'drawer_selecting' || msg.type === 'turn_started') {
        gameStartRtt.add(Date.now() - gameStartTime);
        state = 'playing';
        handlePlaying(msg);
      } else if (msg.type === 'error') {
        console.log(`[VU${vu}] Error starting game: ${JSON.stringify(msg.payload)}`);
        gameCompletionRate.add(0);
        endSession('error');
      } else if (msg.type === 'game_over') {
        gameCompleted = true;
        gamesCompleted.add(1);
        gameCompletionRate.add(1);
        endSession('completed');
      }
      // Timeout for waiting_start is covered by the 60s lobby timeout
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE: playing
    // ══════════════════════════════════════════════════════════════════════════

    function handlePlaying(msg) {
      switch (msg.type) {
        case 'drawer_selecting':
          isDrawer = msg.payload.drawer_id === playerId;
          turnActive = false;
          clearGameIntervals();
          break;

        case 'word_choices':
          // Drawer selects a word after 1-4s
          if (isDrawer && msg.payload.choices && msg.payload.choices.length > 0) {
            wordSelectStart = Date.now();
            const choices = msg.payload.choices;
            socket.setTimeout(function () {
              if (state === 'playing') {
                const word = choices[Math.floor(Math.random() * choices.length)];
                sendMsg({ type: 'select_word', payload: { word: word } });
                currentWord = word;
              }
            }, Math.floor(randomBetween(1000, 4000)));
          }
          break;

        case 'word_assigned':
          currentWord = msg.payload.word;
          break;

        case 'turn_started':
          turnActive = true;
          turnsPlayed.add(1);
          isDrawer = msg.payload.drawer_id === playerId;
          currentTurnDuration = msg.payload.duration || TURN_DURATION;

          if (wordSelectStart > 0) {
            wordSelectionRtt.add(Date.now() - wordSelectStart);
            wordSelectStart = 0;
          }

          if (isDrawer) {
            startDrawing(currentTurnDuration);
          } else {
            startGuessing(currentTurnDuration);
          }
          break;

        case 'turn_ended':
          turnActive = false;
          isDrawer = false;
          currentWord = null;
          clearGameIntervals();
          break;

        case 'stroke':
          // Received a stroke broadcast — measure latency if we sent it
          if (lastStrokeStart > 0) {
            drawBroadcastRtt.add(Date.now() - lastStrokeStart);
            lastStrokeStart = 0;
          }
          break;

        case 'chat_message':
          // Response to a guess (wrong guess echoed back)
          if (lastGuessStart > 0) {
            guessBroadcastRtt.add(Date.now() - lastGuessStart);
            lastGuessStart = 0;
          }
          chatMessagesSent.add(1);
          break;

        case 'guess_correct':
          correctGuesses.add(1);
          if (lastGuessStart > 0) {
            guessBroadcastRtt.add(Date.now() - lastGuessStart);
            lastGuessStart = 0;
          }
          // Stop guessing — we got it right
          guessingActive = false;
          break;

        case 'hint_update':
          // Informational, no action needed
          break;

        case 'game_over':
          gameCompleted = true;
          gamesCompleted.add(1);
          gameCompletionRate.add(1);
          endSession('completed');
          break;

        case 'game_ended_insufficient_players':
          gamesAborted.add(1);
          gameCompletionRate.add(0);
          endSession('aborted');
          break;

        case 'error':
          console.log(`[VU${vu}] Error during game: ${JSON.stringify(msg.payload)}`);
          endSession('error');
          break;

        case 'player_list':
        case 'score_update':
        case 'reaction':
          // Informational messages, no action needed
          break;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DRAWING — Periodic stroke simulation via setInterval
    // ══════════════════════════════════════════════════════════════════════════

    function startDrawing(duration) {
      // Simulate 4-10 strokes across ~60% of the turn duration
      const numStrokes = Math.floor(randomBetween(4, 10));
      const drawingTime = duration * 0.6;
      const strokeIntervalMs = Math.floor((drawingTime / numStrokes) * 1000);
      strokesRemaining = numStrokes;
      drawingActive = true;

      drawingInterval = socket.setInterval(function () {
        if (!drawingActive || !turnActive || state !== 'playing' || strokesRemaining <= 0) {
          drawingActive = false;
          // Occasional fill at end of drawing
          if (turnActive && state === 'playing' && strokesRemaining <= 0 && Math.random() < 0.2) {
            sendMsg({
              type: 'fill',
              payload: {
                x: Math.floor(Math.random() * 800),
                y: Math.floor(Math.random() * 600),
                color: '#FFFFFF',
              },
            });
            drawingEventsSent.add(1);
          }
          return;
        }

        // Generate and send a stroke
        const numPoints = Math.floor(randomBetween(15, 80));
        const points = generateStrokePoints(numPoints);
        const colors = ['#000000', '#FF0000', '#0000FF', '#00FF00', '#FFA500', '#800080'];
        const widths = [2, 3, 5, 8, 12];

        lastStrokeStart = Date.now();
        sendMsg({
          type: 'stroke',
          payload: {
            points: points,
            color: colors[Math.floor(Math.random() * colors.length)],
            lineWidth: widths[Math.floor(Math.random() * widths.length)],
          },
        });
        drawingEventsSent.add(1);
        strokesRemaining--;
      }, strokeIntervalMs);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GUESSING — Periodic guess simulation via setInterval
    // ══════════════════════════════════════════════════════════════════════════

    function startGuessing(duration) {
      // Submit 4-10 guesses spread across 75% of the turn
      const numGuesses = Math.floor(randomBetween(4, 10));
      const guessWindow = duration * 0.75;
      const guessIntervalMs = Math.floor((guessWindow / numGuesses) * 1000);
      guessesRemaining = numGuesses;
      guessingActive = true;

      guessingInterval = socket.setInterval(function () {
        if (!guessingActive || !turnActive || state !== 'playing' || guessesRemaining <= 0) {
          guessingActive = false;
          // Emoji reaction at end
          if (state === 'playing' && guessesRemaining <= 0 && Math.random() < 0.3) {
            const emojis = ['👍', '😂', '🔥', '❤️', '👏', '😮'];
            sendMsg({
              type: 'reaction',
              payload: { emoji: emojis[Math.floor(Math.random() * emojis.length)] },
            });
          }
          return;
        }

        // Pick and send a guess
        const guess = GUESS_WORDS[Math.floor(Math.random() * GUESS_WORDS.length)];
        lastGuessStart = Date.now();
        sendMsg({ type: 'guess', payload: { text: guess } });
        guessesSent.add(1);
        guessesRemaining--;
      }, guessIntervalMs);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ERROR & CLOSE HANDLERS
    // ══════════════════════════════════════════════════════════════════════════

    socket.on('error', function (e) {
      connectionFailures.add(1);
      errorCount.add(1);
      console.log(`[VU${vu}] WebSocket error: ${e}`);
    });

    socket.on('close', function () {
      activeConnections.add(-1);
      disconnects.add(1);
      drawingActive = false;
      guessingActive = false;
      heartbeatActive = false;
    });

    // ══════════════════════════════════════════════════════════════════════════
    // SESSION TIMEOUT — Keep connection alive for max game duration
    // ══════════════════════════════════════════════════════════════════════════

    socket.setTimeout(function () {
      if (state === 'playing' && !gameCompleted) {
        endSession('aborted');
      } else if (state !== 'game_over' && state !== 'error') {
        endSession('aborted');
      }
    }, HOLD_SECONDS * 1000);
  });

  // ── Post-connection check ──

  check(res, {
    'WebSocket handshake 101': (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    connectionSuccess.add(0);
    connectionFailures.add(1);
  }
}
