/**
 * k6 Mixed Workload — Production-Grade Multiplayer Load Test
 *
 * TRUE multi-player simulation with coordinated room joining:
 * - 8 VUs form one room via coordination server (actual join_room calls)
 * - Host creates room, publishes code → joiners poll and join
 * - Full game lifecycle: lobby → ready → start → rounds → game_over
 * - Realistic drawing traffic with measured broadcast fan-out
 * - Mixed user behaviors: drawers, guessers, idle, spectators
 * - Standalone users: lobby chatters + reconnectors
 *
 * k6 v2.2.0 FIX:
 *   sleep() inside ws.connect() does NOT yield to WebSocket event handlers.
 *   This script uses a PURELY EVENT-DRIVEN STATE MACHINE pattern:
 *   - ALL game logic lives inside socket.on('message') callbacks
 *   - socket.setTimeout() for delays (word selection think time, timeouts)
 *   - socket.setInterval() for periodic actions (drawing, guessing, heartbeat)
 *   - Flag-based interval control (no socket.clearInterval in k6)
 *   - NO sleep() calls inside the ws.connect() callback
 *
 * Room topology (per 8-VU group):
 *   Position 0: Host/Drawer — creates room, starts game, sends strokes
 *   Position 1-5: Guessers — join room, submit guesses, chat, reactions
 *   Position 6: Idle — joins room, toggles ready, minimal interaction
 *   Position 7: Spectator — joins room, only receives broadcasts
 *
 * VU distribution for 1000 VUs:
 *   800 room players → 100 rooms × 8 players
 *   100 lobby chatters (standalone)
 *   100 reconnectors (standalone)
 *
 * Expected broadcast load at 500 room-VUs:
 *   ~62 rooms × 1 drawer × 5 strokes/sec × 7 recipients = ~2,170 msg/sec fan-out
 *
 * Prerequisites:
 *   1. App: python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
 *   2. Coord: python k6/coord_server.py --port 9090
 *   3. Run: k6 run k6/ws_mixed_workload.js
 *
 * Usage:
 *   k6 run k6/ws_mixed_workload.js
 *   k6 run --env VUS=1000 --env DURATION=5m k6/ws_mixed_workload.js
 *   k6 run --env HOST=192.168.0.5 --env PORT=80 --env VUS=500 k6/ws_mixed_workload.js
 */

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import exec from 'k6/execution';

// ════════════════════════════════════════════════════════════════════════════
// METRICS — Separated by lifecycle phase with independent timestamps
// ════════════════════════════════════════════════════════════════════════════

// Connection
const wsConnectRtt = new Trend('ws_connect_rtt', true);
const connectionSuccess = new Rate('connection_success');
const connectionFailureRate = new Rate('connection_failure_rate');
const connectionsOpened = new Counter('connections_opened');
const connectionsFailed = new Counter('connections_failed');

// Room lifecycle
const roomCreateRtt = new Trend('room_create_rtt', true);
const roomJoinRtt = new Trend('room_join_rtt', true);
const roomsCreated = new Counter('rooms_created');
const roomCreateFailures = new Counter('room_create_failures');
const joinsSucceeded = new Counter('joins_succeeded');
const joinFailures = new Counter('join_failures');

// Game lifecycle
const gameStartRtt = new Trend('game_start_rtt', true);
const gamesStarted = new Counter('games_started');
const gamesCompleted = new Counter('games_completed');
const gamesAborted = new Counter('games_aborted');
const gameCompletionRate = new Rate('game_completion_rate');

// Turn metrics
const wordSelectionRtt = new Trend('word_selection_rtt', true);
const turnsPlayed = new Counter('turns_played');

// Broadcast latency — SEPARATE timestamps per message type
const strokeBroadcastRtt = new Trend('stroke_broadcast_rtt', true);
const chatBroadcastRtt = new Trend('chat_broadcast_rtt', true);
const guessBroadcastRtt = new Trend('guess_broadcast_rtt', true);

// Throughput
const strokesSent = new Counter('strokes_sent');
const strokesReceived = new Counter('strokes_received');
const guessesSent = new Counter('guesses_sent');
const correctGuesses = new Counter('correct_guesses');
const chatsSent = new Counter('chats_sent');
const messagesSent = new Counter('messages_sent');
const messagesReceived = new Counter('messages_received');
const broadcastMessages = new Counter('broadcast_messages');

// Player lifecycle
const playersJoined = new Counter('players_joined');
const playersDisconnected = new Counter('players_disconnected');

// Reconnection
const reconnectsAttempted = new Counter('reconnects_attempted');
const reconnectsSucceeded = new Counter('reconnects_succeeded');
const reconnectRtt = new Trend('reconnect_rtt', true);

// Errors
const errorCount = new Counter('errors');
const messageErrors = new Counter('message_errors');
const activeConnections = new Gauge('active_connections');

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const HOST = __ENV.HOST || 'localhost';
const PORT = __ENV.PORT || '8000';
const COORD_HOST = __ENV.COORD_HOST || 'localhost';
const COORD_PORT = __ENV.COORD_PORT || '9090';
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const COORD_URL = `http://${COORD_HOST}:${COORD_PORT}`;
const ROOM_SIZE = parseInt(__ENV.ROOM_SIZE || '8');
const TARGET_VUS = parseInt(__ENV.VUS || '100');
const HOLD_SECONDS = parseInt(__ENV.HOLD_TIME || '300');

// VU distribution: 80% room players, 10% lobby chatters, 10% reconnectors
const ROOM_PLAYER_RATIO = parseFloat(__ENV.ROOM_RATIO || '0.80');
const LOBBY_RATIO = parseFloat(__ENV.LOBBY_RATIO || '0.10');
// Remaining goes to reconnectors

// Derived: how many VUs are room players (must be multiple of ROOM_SIZE)
const ROOM_VUS = Math.floor(TARGET_VUS * ROOM_PLAYER_RATIO / ROOM_SIZE) * ROOM_SIZE;
const LOBBY_VUS = Math.floor(TARGET_VUS * LOBBY_RATIO);
// Remaining VUs are reconnectors (used for documentation; role assigned via getVURole())
const RECONNECTOR_VUS = TARGET_VUS - ROOM_VUS - LOBBY_VUS; // eslint-disable-line no-unused-vars

// ════════════════════════════════════════════════════════════════════════════
// K6 OPTIONS
// ════════════════════════════════════════════════════════════════════════════

export const options = {
  scenarios: {
    mixed_workload: {
      executor: 'per-vu-iterations',
      vus: TARGET_VUS,
      iterations: 1,
      maxDuration: '20m',
    },
  },
  thresholds: {
    // Latency thresholds
    ws_connect_rtt: ['p(95)<5000', 'p(99)<10000'],
    room_create_rtt: ['p(95)<3000'],
    room_join_rtt: ['p(95)<3000'],
    stroke_broadcast_rtt: ['p(95)<300', 'p(99)<500'],
    chat_broadcast_rtt: ['p(95)<5000'],
    guess_broadcast_rtt: ['p(95)<3000'],
    game_start_rtt: ['p(95)<5000'],
    // Rate thresholds (proportional, not absolute)
    connection_success: ['rate>0.95'],
    connection_failure_rate: ['rate<0.05'],
    game_completion_rate: ['rate>0.60'],
  },
};

// ════════════════════════════════════════════════════════════════════════════
// WORD LISTS
// ════════════════════════════════════════════════════════════════════════════

const GUESS_WORDS = [
  'cat', 'dog', 'house', 'tree', 'car', 'sun', 'moon', 'fish',
  'bird', 'boat', 'star', 'flower', 'mountain', 'river', 'cloud',
  'book', 'chair', 'table', 'phone', 'guitar', 'piano', 'clock',
  'bridge', 'castle', 'dragon', 'elephant', 'butterfly', 'rainbow',
  'umbrella', 'bicycle', 'airplane', 'lighthouse', 'snowman', 'pizza',
  'rocket', 'penguin', 'diamond', 'volcano', 'tornado', 'octopus',
];

const CHAT_MESSAGES = [
  'hmm maybe it\'s a thing?', 'is it an animal?', 'nice drawing!',
  'I have no idea lol', 'almost got it!', 'this is hard',
  'wait I think I know', 'good luck everyone', 'great round!',
  '👀', 'lmao', 'oh I see it now', 'what is that??',
];

// ════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════════════════

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function generateStrokePoints(numPoints) {
  const points = [];
  let x = Math.random() * 800;
  let y = Math.random() * 600;
  const angle = Math.random() * Math.PI * 2;
  const speed = 1.5 + Math.random() * 3;
  const curve = (Math.random() - 0.5) * 0.15;

  for (let i = 0; i < numPoints; i++) {
    x += Math.cos(angle + i * curve) * speed + (Math.random() - 0.5) * 1.5;
    y += Math.sin(angle + i * curve) * speed + (Math.random() - 0.5) * 1.5;
    x = Math.max(0, Math.min(800, x));
    y = Math.max(0, Math.min(600, y));
    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return points;
}

// ── Coordination Server Helpers (used OUTSIDE ws.connect) ──

function coordPublishRoom(roomIndex, roomCode) {
  try {
    const res = http.post(
      `${COORD_URL}/rooms/${roomIndex}`,
      JSON.stringify({ room_code: roomCode }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'coord' }, timeout: '5s' }
    );
    return res.status === 200;
  } catch (e) {
    return false;
  }
}

function coordPollRoom(roomIndex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = http.get(`${COORD_URL}/rooms/${roomIndex}`, {
        tags: { name: 'coord' }, timeout: '3s',
      });
      if (res.status === 200) {
        const body = JSON.parse(res.body);
        if (body.room_code) return body.room_code;
      }
    } catch (e) {
      // Coordination server not available — will fall back
    }
    sleep(0.4); // sleep OK here — OUTSIDE ws.connect
  }
  return null;
}

// ── VU Role Assignment ──

function getVURole(vuId) {
  // First ROOM_VUS are room players
  if (vuId <= ROOM_VUS) return 'room_player';
  // Next LOBBY_VUS are lobby chatters
  if (vuId <= ROOM_VUS + LOBBY_VUS) return 'lobby_chatter';
  // Rest are reconnectors
  return 'reconnector';
}

function getRoomIndex(vuId) {
  // Only for room_player VUs (vuId 1..ROOM_VUS)
  return Math.floor((vuId - 1) / ROOM_SIZE);
}

function getPositionInRoom(vuId) {
  return (vuId - 1) % ROOM_SIZE;
}

function getRoomRole(vuId) {
  const pos = getPositionInRoom(vuId);
  if (pos === 0) return 'host_drawer';
  if (pos <= 5) return 'guesser';
  if (pos === 6) return 'idle';
  return 'spectator';
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════

export default function () {
  const vuId = exec.vu.idInTest;
  const topRole = getVURole(vuId);

  switch (topRole) {
    case 'room_player':
      runRoomPlayer(vuId);
      break;
    case 'lobby_chatter':
      runLobbyChatter(vuId);
      break;
    case 'reconnector':
      runReconnector(vuId);
      break;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROOM PLAYER — Coordinated multiplayer with true room joining
// (Event-driven state machine — NO sleep() inside ws.connect)
// ════════════════════════════════════════════════════════════════════════════

function runRoomPlayer(vuId) {
  const roomIndex = getRoomIndex(vuId);
  const roomRole = getRoomRole(vuId);
  const position = getPositionInRoom(vuId);
  const playerName = `k6${roomRole[0]}${position}_${vuId}`;

  // ── Pre-connection coordination (sleep OK here — OUTSIDE ws.connect) ──

  let coordRoomCode = null;

  if (roomRole !== 'host_drawer') {
    // Stagger connections: joiners wait proportionally
    sleep(2 + position * 0.6 + Math.random() * 0.4);

    // Poll coordination server BEFORE connecting to WebSocket
    coordRoomCode = coordPollRoom(roomIndex, 25000);
    if (!coordRoomCode) {
      joinFailures.add(1);
      errorCount.add(1);
      connectionSuccess.add(0);
      connectionFailureRate.add(1);
      return;
    }
  }

  // ── WebSocket connection ──

  const connectStart = Date.now();
  const wsUrl = `${WS_URL}?room=${roomIndex}`;

  const res = ws.connect(wsUrl, { tags: { room: `r${roomIndex}`, role: roomRole } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    connectionFailureRate.add(0);
    connectionsOpened.add(1);
    activeConnections.add(1);

    // ══════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════

    let state = 'connecting'; // connecting | lobby | waiting_start | playing | game_over | error
    let roomCode = coordRoomCode;
    let playerId = null;
    let isDrawer = false;
    let currentWord = null;
    let turnActive = false;
    let gameCompleted = false;
    let playerCount = 0;

    // Timing state (separate timestamps per message type)
    let roomCreateStart = 0;
    let roomJoinStart = 0;
    let gameStartTime = 0;
    let wordSelectStart = 0;
    let lastStrokeSentAt = 0;
    let lastGuessSentAt = 0;
    let lastChatSentAt = 0;

    // Drawing/guessing state
    let strokesRemaining = 0;
    let guessesRemaining = 0;
    let currentTurnDuration = 80;

    // ══════════════════════════════════════════════════════════════════════
    // FLAGS — Control intervals (k6 doesn't have socket.clearInterval)
    // ══════════════════════════════════════════════════════════════════════

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

    // ══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════════

    function sendMsg(msg) {
      try {
        socket.send(JSON.stringify(msg));
        messagesSent.add(1);
      } catch (e) {
        errorCount.add(1);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SOCKET OPEN — Send initial message based on role
    // ══════════════════════════════════════════════════════════════════════

    socket.on('open', function () {
      if (roomRole === 'host_drawer') {
        // Host: create the room
        roomCreateStart = Date.now();
        sendMsg({ type: 'create_room', payload: { name: playerName } });

        // Timeout: if no room_created in 10s, fail
        socket.setTimeout(function () {
          if (state === 'connecting') {
            console.log(`[HOST VU${vuId}] Timeout waiting for room_created`);
            roomCreateFailures.add(1);
            endSession('error');
          }
        }, 10000);
      } else {
        // Joiner: join with the room code we already have from coord server
        roomJoinStart = Date.now();
        sendMsg({ type: 'join_room', payload: { name: playerName, room_code: roomCode } });

        // Timeout: if no room_joined in 10s, fail
        socket.setTimeout(function () {
          if (state === 'connecting') {
            console.log(`[JOINER VU${vuId}] Timeout waiting for room_joined`);
            joinFailures.add(1);
            endSession('error');
          }
        }, 10000);
      }

      // ── Heartbeat interval ──
      socket.setInterval(function () {
        if (heartbeatActive) sendMsg({ type: 'pong', payload: {} });
      }, 25000);
    });

    // ══════════════════════════════════════════════════════════════════════
    // MESSAGE HANDLER — The State Machine
    // ══════════════════════════════════════════════════════════════════════

    socket.on('message', function (data) {
      messagesReceived.add(1);

      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        messageErrors.add(1);
        return;
      }

      // Always handle ping
      if (msg.type === 'ping') {
        sendMsg({ type: 'pong', payload: {} });
        return;
      }

      // State machine dispatch
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
          break;
      }
    });

    // ══════════════════════════════════════════════════════════════════════
    // STATE: connecting
    // ══════════════════════════════════════════════════════════════════════

    function handleConnecting(msg) {
      if (msg.type === 'room_created') {
        roomCreateRtt.add(Date.now() - roomCreateStart);
        roomsCreated.add(1);
        roomCode = msg.payload.room_code;
        playerId = msg.payload.player_id;
        state = 'lobby';

        // Publish room code to coordination server for joiners
        coordPublishRoom(roomIndex, roomCode);

        // Host waits for players to join, then readies up and starts game
        // Timeout: if game hasn't started in 60s, abort
        socket.setTimeout(function () {
          if (state === 'lobby' || state === 'waiting_start') {
            console.log(`[HOST VU${vuId}] Timeout waiting for game to start`);
            endSession('aborted');
          }
        }, 60000);

      } else if (msg.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - roomJoinStart);
        joinsSucceeded.add(1);
        playersJoined.add(1);
        roomCode = msg.payload.room_code;
        playerId = msg.payload.player_id;
        state = 'lobby';

        // Joiner readies up after 1-3s
        socket.setTimeout(function () {
          if (state === 'lobby') {
            sendMsg({ type: 'toggle_ready', payload: {} });
          }
        }, Math.floor(randomBetween(1000, 3000)));

        // Timeout: if game hasn't started in 60s, abort
        socket.setTimeout(function () {
          if (state === 'lobby' || state === 'waiting_start') {
            console.log(`[JOINER VU${vuId}] Timeout waiting for game to start`);
            endSession('aborted');
          }
        }, 60000);

      } else if (msg.type === 'error') {
        console.log(`[VU${vuId}] Error during connecting: ${JSON.stringify(msg.payload)}`);
        if (roomRole === 'host_drawer') roomCreateFailures.add(1);
        else joinFailures.add(1);
        endSession('error');
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // STATE: lobby
    // ══════════════════════════════════════════════════════════════════════

    function handleLobby(msg) {
      if (msg.type === 'player_list') {
        playerCount = msg.payload.players.length;
        broadcastMessages.add(1);

        // Host: when room is full, ready up and start game
        if (roomRole === 'host_drawer' && playerCount >= ROOM_SIZE) {
          socket.setTimeout(function () {
            if (state === 'lobby') {
              sendMsg({ type: 'toggle_ready', payload: {} });

              // Start game after players have had time to ready up
              socket.setTimeout(function () {
                if (state === 'lobby') {
                  gameStartTime = Date.now();
                  sendMsg({ type: 'start_game', payload: {} });
                  gamesStarted.add(1);
                  state = 'waiting_start';
                }
              }, Math.floor(randomBetween(3000, 6000)));
            }
          }, Math.floor(randomBetween(500, 1500)));
        }
      } else if (msg.type === 'drawer_selecting' || msg.type === 'turn_started' || msg.type === 'word_choices') {
        // Game started
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
        console.log(`[VU${vuId}] Error in lobby: ${JSON.stringify(msg.payload)}`);
        endSession('error');
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // STATE: waiting_start (host sent start_game, waiting for confirmation)
    // ══════════════════════════════════════════════════════════════════════

    function handleWaitingStart(msg) {
      if (msg.type === 'drawer_selecting' || msg.type === 'turn_started' || msg.type === 'word_choices') {
        gameStartRtt.add(Date.now() - gameStartTime);
        state = 'playing';
        handlePlaying(msg);
      } else if (msg.type === 'game_over') {
        gameCompleted = true;
        gamesCompleted.add(1);
        gameCompletionRate.add(1);
        endSession('completed');
      } else if (msg.type === 'game_ended_insufficient_players') {
        gamesAborted.add(1);
        gameCompletionRate.add(0);
        endSession('aborted');
      } else if (msg.type === 'error') {
        console.log(`[VU${vuId}] Error starting game: ${JSON.stringify(msg.payload)}`);
        gameCompletionRate.add(0);
        endSession('error');
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // STATE: playing
    // ══════════════════════════════════════════════════════════════════════

    function handlePlaying(msg) {
      switch (msg.type) {
        case 'drawer_selecting':
          isDrawer = msg.payload.drawer_id === playerId;
          turnActive = false;
          clearGameIntervals();
          broadcastMessages.add(1);
          break;

        case 'word_choices':
          // Drawer selects a word after 1-4s think time
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
          currentTurnDuration = msg.payload.duration || 80;
          broadcastMessages.add(1);

          if (wordSelectStart > 0) {
            wordSelectionRtt.add(Date.now() - wordSelectStart);
            wordSelectStart = 0;
          }

          if (isDrawer) {
            startDrawing(currentTurnDuration);
          } else if (roomRole === 'guesser') {
            startGuessing(currentTurnDuration);
          } else if (roomRole === 'idle') {
            startIdle();
          }
          // Spectator does nothing actively
          break;

        case 'turn_ended':
          turnActive = false;
          isDrawer = false;
          currentWord = null;
          clearGameIntervals();
          broadcastMessages.add(1);
          break;

        case 'stroke':
          strokesReceived.add(1);
          broadcastMessages.add(1);
          if (lastStrokeSentAt > 0) {
            strokeBroadcastRtt.add(Date.now() - lastStrokeSentAt);
            lastStrokeSentAt = 0;
          }
          break;

        case 'chat_message':
          broadcastMessages.add(1);
          if (lastChatSentAt > 0) {
            chatBroadcastRtt.add(Date.now() - lastChatSentAt);
            lastChatSentAt = 0;
          }
          if (lastGuessSentAt > 0) {
            guessBroadcastRtt.add(Date.now() - lastGuessSentAt);
            lastGuessSentAt = 0;
          }
          break;

        case 'guess_correct':
          correctGuesses.add(1);
          broadcastMessages.add(1);
          if (lastGuessSentAt > 0) {
            guessBroadcastRtt.add(Date.now() - lastGuessSentAt);
            lastGuessSentAt = 0;
          }
          // Stop guessing — we got it right
          guessingActive = false;
          break;

        case 'hint_update':
          broadcastMessages.add(1);
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
          errorCount.add(1);
          break;

        case 'player_list':
        case 'score_update':
        case 'reaction':
          broadcastMessages.add(1);
          break;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // DRAWING — Periodic stroke simulation via setInterval
    // ══════════════════════════════════════════════════════════════════════

    function startDrawing(duration) {
      const numStrokes = Math.floor(randomBetween(6, 14));
      const drawingTime = duration * 0.6;
      const strokeIntervalMs = Math.floor((drawingTime / numStrokes) * 1000);
      strokesRemaining = numStrokes;
      drawingActive = true;

      const colors = ['#000000', '#FF0000', '#0000FF', '#00FF00', '#FFA500', '#800080', '#8B4513'];
      const widths = [2, 3, 4, 6, 8, 10];

      socket.setInterval(function () {
        if (!drawingActive || !turnActive || state !== 'playing' || strokesRemaining <= 0) {
          if (drawingActive && strokesRemaining <= 0) {
            drawingActive = false;
            // Occasional fill at end
            if (turnActive && state === 'playing' && Math.random() < 0.25) {
              sendMsg({
                type: 'fill',
                payload: {
                  x: Math.floor(Math.random() * 800),
                  y: Math.floor(Math.random() * 600),
                  color: '#FFFFFF',
                },
              });
              strokesSent.add(1);
            }
            // Occasional clear canvas
            if (turnActive && state === 'playing' && Math.random() < 0.15) {
              sendMsg({ type: 'clear_canvas', payload: {} });
            }
          }
          return;
        }

        const numPoints = Math.floor(randomBetween(2, 8));
        const points = generateStrokePoints(numPoints);

        lastStrokeSentAt = Date.now();
        sendMsg({
          type: 'stroke',
          payload: {
            points: points,
            color: colors[Math.floor(Math.random() * colors.length)],
            lineWidth: widths[Math.floor(Math.random() * widths.length)],
          },
        });
        strokesSent.add(1);
        strokesRemaining--;
      }, strokeIntervalMs);
    }

    // ══════════════════════════════════════════════════════════════════════
    // GUESSING — Periodic guess simulation via setInterval
    // ══════════════════════════════════════════════════════════════════════

    function startGuessing(duration) {
      const numGuesses = Math.floor(randomBetween(4, 10));
      const guessWindow = duration * 0.75;
      const guessIntervalMs = Math.floor((guessWindow / numGuesses) * 1000);
      guessesRemaining = numGuesses;
      guessingActive = true;

      socket.setInterval(function () {
        if (!guessingActive || !turnActive || state !== 'playing' || guessesRemaining <= 0) {
          if (guessingActive && guessesRemaining <= 0) {
            guessingActive = false;
            // Emoji reaction at end
            if (state === 'playing' && Math.random() < 0.35) {
              const emojis = ['👍', '😂', '🔥', '❤️', '👏', '😮'];
              sendMsg({
                type: 'reaction',
                payload: { emoji: emojis[Math.floor(Math.random() * emojis.length)] },
              });
            }
            // Occasional chat while waiting
            if (state === 'playing' && turnActive && Math.random() < 0.5) {
              lastChatSentAt = Date.now();
              const chatText = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
              sendMsg({ type: 'guess', payload: { text: chatText } });
              chatsSent.add(1);
            }
          }
          return;
        }

        const guess = GUESS_WORDS[Math.floor(Math.random() * GUESS_WORDS.length)];
        lastGuessSentAt = Date.now();
        sendMsg({ type: 'guess', payload: { text: guess } });
        guessesSent.add(1);
        guessesRemaining--;
      }, guessIntervalMs);
    }

    // ══════════════════════════════════════════════════════════════════════
    // IDLE — Occasional reaction via setTimeout
    // ══════════════════════════════════════════════════════════════════════

    function startIdle() {
      if (Math.random() < 0.2) {
        socket.setTimeout(function () {
          if (state === 'playing' && turnActive) {
            const emojis = ['👍', '😂', '🔥', '❤️', '👏', '😮'];
            sendMsg({
              type: 'reaction',
              payload: { emoji: emojis[Math.floor(Math.random() * emojis.length)] },
            });
          }
        }, Math.floor(randomBetween(5000, 15000)));
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ERROR & CLOSE HANDLERS
    // ══════════════════════════════════════════════════════════════════════

    socket.on('error', function () {
      connectionsFailed.add(1);
      connectionFailureRate.add(1);
      errorCount.add(1);
    });

    socket.on('close', function () {
      activeConnections.add(-1);
      playersDisconnected.add(1);
      drawingActive = false;
      guessingActive = false;
      heartbeatActive = false;
    });

    // ══════════════════════════════════════════════════════════════════════
    // SESSION TIMEOUT — Keep connection alive for max game duration
    // ══════════════════════════════════════════════════════════════════════

    socket.setTimeout(function () {
      if (!sessionEnded) {
        endSession('aborted');
      }
    }, HOLD_SECONDS * 1000);
  });

  check(res, {
    'Room player connected (101)': (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    connectionSuccess.add(0);
    connectionFailureRate.add(1);
    connectionsFailed.add(1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LOBBY CHATTER — Creates room, chats, toggles ready, never starts game
// (Event-driven — NO sleep() inside ws.connect)
// ════════════════════════════════════════════════════════════════════════════

function runLobbyChatter(vuId) {
  const playerName = `k6lob_${vuId}`;

  const connectStart = Date.now();
  const res = ws.connect(WS_URL, { tags: { role: 'lobby' } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    connectionFailureRate.add(0);
    connectionsOpened.add(1);
    activeConnections.add(1);

    let joined = false;
    let lastChatSentAt = 0;
    let chatActive = true;
    let readyActive = true;

    socket.on('open', function () {
      sendMsg({ type: 'create_room', payload: { name: playerName } });

      // Session timeout — close after HOLD_TIME
      socket.setTimeout(function () {
        chatActive = false;
        readyActive = false;
        if (joined) {
          sendMsg({ type: 'leave_room', payload: {} });
        }
        socket.close();
      }, HOLD_SECONDS * 1000);
    });

    socket.on('message', function (data) {
      messagesReceived.add(1);
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'room_created') {
          joined = true;
          roomsCreated.add(1);
        }

        if (msg.type === 'chat_message' && lastChatSentAt > 0) {
          chatBroadcastRtt.add(Date.now() - lastChatSentAt);
          lastChatSentAt = 0;
        }

        if (msg.type === 'ping') {
          sendMsg({ type: 'pong', payload: {} });
        }
      } catch (e) {
        messageErrors.add(1);
      }
    });

    socket.on('error', function () {
      connectionsFailed.add(1);
      connectionFailureRate.add(1);
      errorCount.add(1);
    });

    socket.on('close', function () {
      activeConnections.add(-1);
      chatActive = false;
      readyActive = false;
    });

    function sendMsg(msg) {
      try {
        socket.send(JSON.stringify(msg));
        messagesSent.add(1);
      } catch (e) {
        errorCount.add(1);
      }
    }

    // Chat every 5-10 seconds
    socket.setInterval(function () {
      if (!chatActive || !joined) return;
      lastChatSentAt = Date.now();
      const chatText = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
      sendMsg({ type: 'chat', payload: { text: chatText } });
      chatsSent.add(1);
    }, 5000 + Math.floor(Math.random() * 5000));

    // Toggle ready periodically
    socket.setInterval(function () {
      if (!readyActive || !joined) return;
      sendMsg({ type: 'toggle_ready', payload: {} });
    }, 15000 + Math.floor(Math.random() * 15000));

    // Heartbeat
    socket.setInterval(function () {
      sendMsg({ type: 'pong', payload: {} });
    }, 25000);
  });

  check(res, { 'Lobby chatter connected (101)': (r) => r && r.status === 101 });
  if (!res || res.status !== 101) {
    connectionSuccess.add(0);
    connectionFailureRate.add(1);
    connectionsFailed.add(1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RECONNECTOR — True session reconnection (same room, same name)
// Loop OUTSIDE ws.connect with sleep between cycles.
// Each cycle is event-driven inside ws.connect (NO sleep inside).
// ════════════════════════════════════════════════════════════════════════════

function runReconnector(vuId) {
  const playerName = `k6rec_${vuId}`;
  const cycleCount = Math.floor(HOLD_SECONDS / 50); // ~6 cycles in 300s

  let lastRoomCode = null;

  for (let cycle = 0; cycle < cycleCount; cycle++) {
    reconnectsAttempted.add(1);
    const connectStart = Date.now();
    const stayDuration = Math.floor(randomBetween(20, 40));

    const res = ws.connect(WS_URL, { tags: { role: 'reconnector', cycle: `${cycle}` } }, function (socket) {
      wsConnectRtt.add(Date.now() - connectStart);
      connectionSuccess.add(1);
      connectionFailureRate.add(0);
      connectionsOpened.add(1);
      activeConnections.add(1);

      let joined = false;
      let roomCode = null;
      let chatActive = true;

      socket.on('open', function () {
        if (lastRoomCode && cycle > 0) {
          // Attempt to reconnect to the same room
          sendMsg({ type: 'reconnect', payload: { name: playerName, room_code: lastRoomCode } });
        } else {
          // First connection: create a new room
          sendMsg({ type: 'create_room', payload: { name: playerName } });
        }

        // Session timeout — close after stayDuration seconds
        socket.setTimeout(function () {
          chatActive = false;
          // Deliberate disconnect (NOT leave_room — we want to test reconnection)
          socket.close();
        }, stayDuration * 1000);
      });

      socket.on('message', function (data) {
        messagesReceived.add(1);
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'room_created' && !joined) {
            joined = true;
            roomCode = msg.payload.room_code;
            lastRoomCode = roomCode;
            roomsCreated.add(1);
            if (cycle === 0) {
              roomCreateRtt.add(Date.now() - connectStart);
            } else {
              reconnectRtt.add(Date.now() - connectStart);
              reconnectsSucceeded.add(1);
            }
          }

          if (msg.type === 'reconnected' && !joined) {
            joined = true;
            roomCode = msg.payload.room_code;
            reconnectRtt.add(Date.now() - connectStart);
            reconnectsSucceeded.add(1);
          }

          if (msg.type === 'error' && !joined) {
            // Reconnect failed (room may have been cleaned up) — create new room
            sendMsg({ type: 'create_room', payload: { name: `${playerName}c${cycle}` } });
          }

          if (msg.type === 'ping') {
            sendMsg({ type: 'pong', payload: {} });
          }
        } catch (e) {
          messageErrors.add(1);
        }
      });

      socket.on('error', function () {
        connectionsFailed.add(1);
        connectionFailureRate.add(1);
        errorCount.add(1);
      });

      socket.on('close', function () {
        activeConnections.add(-1);
        playersDisconnected.add(1);
        chatActive = false;
      });

      function sendMsg(msg) {
        try {
          socket.send(JSON.stringify(msg));
          messagesSent.add(1);
        } catch (e) {
          errorCount.add(1);
        }
      }

      // Chat while connected
      socket.setInterval(function () {
        if (!chatActive || !joined) return;
        sendMsg({ type: 'chat', payload: { text: `reconnector cycle ${cycle}` } });
        chatsSent.add(1);
      }, 5000 + Math.floor(Math.random() * 5000));

      // Heartbeat
      socket.setInterval(function () {
        if (!chatActive) return;
        sendMsg({ type: 'pong', payload: {} });
      }, 25000);
    });

    check(res, { 'Reconnector connected (101)': (r) => r && r.status === 101 });
    if (!res || res.status !== 101) {
      connectionSuccess.add(0);
      connectionFailureRate.add(1);
      connectionsFailed.add(1);
    }

    // Wait 5-10 seconds before reconnecting (within 120s grace window)
    // sleep() is fine here — OUTSIDE ws.connect
    sleep(5 + Math.random() * 5);
  }
}
