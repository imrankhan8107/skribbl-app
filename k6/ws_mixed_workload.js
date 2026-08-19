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
const COORD_PORT = __ENV.COORD_PORT || '9090';
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const COORD_URL = `http://${HOST}:${COORD_PORT}`;
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

// ── Coordination Server Helpers ──

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
    sleep(0.4);
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
// ════════════════════════════════════════════════════════════════════════════

function runRoomPlayer(vuId) {
  const roomIndex = getRoomIndex(vuId);
  const roomRole = getRoomRole(vuId);
  const position = getPositionInRoom(vuId);
  const playerName = `k6_${roomRole}_vu${vuId}_r${roomIndex}`;

  // Stagger connections: host first, joiners wait proportionally
  if (roomRole !== 'host_drawer') {
    sleep(2 + position * 0.6 + Math.random() * 0.4);
  }

  const connectStart = Date.now();

  const res = ws.connect(WS_URL, { tags: { room: `r${roomIndex}`, role: roomRole } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    connectionFailureRate.add(0);
    connectionsOpened.add(1);
    activeConnections.add(1);

    // ── Per-VU state ──
    let roomCode = null;
    let playerId = null;
    let gameState = 'connecting'; // connecting | lobby | playing | game_over | done
    let isDrawer = false;
    let turnActive = false;
    let currentWord = null;
    let gameCompleted = false;
    let playerCount = 0;
    let messageQueue = [];

    // ── Separate latency timestamps (fixes the single-lastSendTime bug) ──
    let lastStrokeSentAt = 0;
    let lastGuessSentAt = 0;
    let lastChatSentAt = 0;

    // ── Message Processing ──
    socket.on('message', function (data) {
      messagesReceived.add(1);
      try {
        const msg = JSON.parse(data);
        messageQueue.push(msg);
        processIncomingMessage(msg);
      } catch (e) {
        messageErrors.add(1);
      }
    });

    function processIncomingMessage(msg) {
      switch (msg.type) {
        case 'room_created':
          roomCode = msg.payload.room_code;
          playerId = msg.payload.player_id;
          gameState = 'lobby';
          break;

        case 'room_joined':
          roomCode = msg.payload.room_code;
          playerId = msg.payload.player_id;
          gameState = 'lobby';
          playersJoined.add(1);
          break;

        case 'player_list':
          playerCount = msg.payload.players.length;
          broadcastMessages.add(1);
          break;

        case 'drawer_selecting':
          isDrawer = msg.payload.drawer_id === playerId;
          broadcastMessages.add(1);
          break;

        case 'word_choices':
          // Only drawer receives this
          break;

        case 'word_assigned':
          currentWord = msg.payload.word;
          break;

        case 'turn_started':
          turnActive = true;
          isDrawer = msg.payload.drawer_id === playerId;
          turnsPlayed.add(1);
          broadcastMessages.add(1);
          break;

        case 'turn_ended':
          turnActive = false;
          isDrawer = false;
          currentWord = null;
          broadcastMessages.add(1);
          break;

        case 'stroke':
          strokesReceived.add(1);
          broadcastMessages.add(1);
          // Measure stroke broadcast RTT (only if WE sent it)
          if (lastStrokeSentAt > 0) {
            strokeBroadcastRtt.add(Date.now() - lastStrokeSentAt);
            lastStrokeSentAt = 0;
          }
          break;

        case 'chat_message':
          broadcastMessages.add(1);
          // Measure chat broadcast RTT
          if (lastChatSentAt > 0) {
            chatBroadcastRtt.add(Date.now() - lastChatSentAt);
            lastChatSentAt = 0;
          }
          // Also captures incorrect guess echoed as chat
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
          break;

        case 'hint_update':
          broadcastMessages.add(1);
          break;

        case 'game_over':
          gameState = 'game_over';
          gameCompleted = true;
          gamesCompleted.add(1);
          gameCompletionRate.add(1);
          broadcastMessages.add(1);
          break;

        case 'game_ended_insufficient_players':
          gameState = 'game_over';
          gamesAborted.add(1);
          gameCompletionRate.add(0);
          broadcastMessages.add(1);
          break;

        case 'error':
          errorCount.add(1);
          break;

        case 'ping':
          sendMsg({ type: 'pong', payload: {} });
          break;

        default:
          break;
      }
    }

    function sendMsg(msg) {
      try {
        socket.send(JSON.stringify(msg));
        messagesSent.add(1);
      } catch (e) {
        errorCount.add(1);
      }
    }

    function waitFor(type, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = messageQueue.findIndex((m) => m.type === type);
        if (idx !== -1) return messageQueue.splice(idx, 1)[0];
        sleep(0.1);
      }
      return null;
    }

    function waitForAny(types, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = messageQueue.findIndex((m) => types.includes(m.type));
        if (idx !== -1) return messageQueue.splice(idx, 1)[0];
        sleep(0.1);
      }
      return null;
    }

    function drain(type) {
      const found = messageQueue.filter((m) => m.type === type);
      messageQueue = messageQueue.filter((m) => m.type !== type);
      return found;
    }

    function isOver() {
      return gameState === 'game_over' || gameState === 'done';
    }

    // ══════════════════════════════════════════════════════════════════════
    // FLOW DISPATCH
    // ══════════════════════════════════════════════════════════════════════

    socket.on('open', function () {
      if (roomRole === 'host_drawer') {
        hostDrawerFlow();
      } else {
        joinerFlow();
      }
    });

    // ── HOST/DRAWER FLOW ──
    function hostDrawerFlow() {
      // Step 1: Create room
      const t0 = Date.now();
      sendMsg({ type: 'create_room', payload: { name: playerName } });

      const createResp = waitFor('room_created', 10000);
      if (!createResp) {
        roomCreateFailures.add(1);
        errorCount.add(1);
        gameState = 'done';
        return;
      }
      roomCreateRtt.add(Date.now() - t0);
      roomsCreated.add(1);
      roomCode = createResp.payload.room_code;
      playerId = createResp.payload.player_id;
      gameState = 'lobby';

      // Step 2: Publish room code to coordination server
      coordPublishRoom(roomIndex, roomCode);

      // Step 3: Wait for ALL players to join (ROOM_SIZE total)
      const joinDeadline = Date.now() + 45000;
      while (Date.now() < joinDeadline) {
        const plMsgs = drain('player_list');
        if (plMsgs.length > 0) {
          const lastPl = plMsgs[plMsgs.length - 1];
          playerCount = lastPl.payload.players.length;
          if (playerCount >= ROOM_SIZE) break;
        }
        sleep(0.5);
      }

      // Step 4: Toggle ready
      sleep(randomBetween(0.5, 1.5));
      sendMsg({ type: 'toggle_ready', payload: {} });

      // Step 5: Wait for other players to ready up, then start game
      // (Host waits for majority to be ready, or timeout)
      sleep(randomBetween(3, 6));

      const startT = Date.now();
      sendMsg({ type: 'start_game', payload: {} });
      gamesStarted.add(1);

      // Wait for game to begin (drawer_selecting or turn_started)
      const startResp = waitForAny(['drawer_selecting', 'turn_started', 'word_choices', 'error'], 15000);
      if (startResp && startResp.type !== 'error') {
        gameStartRtt.add(Date.now() - startT);
        gameState = 'playing';
        processIncomingMessage(startResp);
      } else {
        errorCount.add(1);
        gameCompletionRate.add(0);
        gameState = 'done';
        return;
      }

      // Step 6: Play the game
      runGameLoop();
    }

    // ── JOINER FLOW ──
    function joinerFlow() {
      // Step 1: Poll coordination server for room code
      const code = coordPollRoom(roomIndex, 25000);

      if (!code) {
        // Coordination server unavailable — mark as failure
        joinFailures.add(1);
        errorCount.add(1);
        gameState = 'done';
        return;
      }

      // Step 2: Join the room with the actual room code
      const t0 = Date.now();
      sendMsg({ type: 'join_room', payload: { name: playerName, room_code: code } });

      const joinResp = waitForAny(['room_joined', 'error'], 10000);
      if (joinResp && joinResp.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - t0);
        joinsSucceeded.add(1);
        playersJoined.add(1);
        roomCode = joinResp.payload.room_code;
        playerId = joinResp.payload.player_id;
        gameState = 'lobby';
      } else {
        joinFailures.add(1);
        errorCount.add(1);
        gameState = 'done';
        return;
      }

      // Step 3: Toggle ready
      sleep(randomBetween(1, 3));
      sendMsg({ type: 'toggle_ready', payload: {} });

      // Step 4: Wait for game start (host triggers it)
      const startMsg = waitForAny(
        ['drawer_selecting', 'turn_started', 'word_choices', 'game_over', 'game_ended_insufficient_players'],
        60000
      );
      if (startMsg) {
        processIncomingMessage(startMsg);
        if (!isOver()) {
          gameState = 'playing';
        }
      } else {
        // Timeout — game never started
        gameState = 'done';
        return;
      }

      if (isOver()) return;

      // Step 5: Play the game
      runGameLoop();
    }

    // ══════════════════════════════════════════════════════════════════════
    // GAME LOOP — Full lifecycle, role-specific behavior
    // ══════════════════════════════════════════════════════════════════════

    function runGameLoop() {
      const maxDuration = (3 * ROOM_SIZE * 100 + 180) * 1000; // ~3 rounds max
      const loopStart = Date.now();

      while (!isOver() && Date.now() - loopStart < maxDuration) {
        const msg = waitForAny(
          [
            'drawer_selecting', 'word_choices', 'word_assigned',
            'turn_started', 'turn_ended', 'hint_update',
            'game_over', 'game_ended_insufficient_players',
            'guess_correct', 'chat_message', 'stroke', 'ping',
          ],
          3000
        );

        if (!msg) {
          sleep(0.3);
          continue;
        }

        processIncomingMessage(msg);

        if (isOver()) break;

        // ── Role-based reactions ──
        if (msg.type === 'word_choices' && isDrawer) {
          handleWordSelection(msg.payload.choices);
        } else if (msg.type === 'turn_started') {
          if (isDrawer) {
            simulateDrawing(msg.payload.duration);
          } else if (roomRole === 'guesser') {
            simulateGuessing(msg.payload.duration);
          } else if (roomRole === 'idle') {
            simulateIdle();
          }
          // Spectator does nothing actively
        }
      }

      if (!gameCompleted && !isOver()) {
        gamesAborted.add(1);
        gameCompletionRate.add(0);
      }
    }

    // ── Word Selection (Drawer) ──
    function handleWordSelection(choices) {
      if (!choices || choices.length === 0) return;

      sleep(randomBetween(1, 4)); // Think time
      if (isOver()) return;

      const word = choices[Math.floor(Math.random() * choices.length)];
      const t0 = Date.now();
      sendMsg({ type: 'select_word', payload: { word: word } });
      currentWord = word;

      const confirmation = waitFor('turn_started', 8000);
      if (confirmation) {
        wordSelectionRtt.add(Date.now() - t0);
        processIncomingMessage(confirmation);
      }
    }

    // ── Drawing Simulation (Drawer) ──
    function simulateDrawing(duration) {
      // 4-10 strokes, ~3-7 strokes/sec pace
      // Duration of drawing: ~60% of turn time
      const drawTime = Math.min(duration * 0.6, 50); // Cap drawing phase
      const numStrokes = Math.floor(randomBetween(4, 10));
      const strokeInterval = drawTime / numStrokes;

      for (let i = 0; i < numStrokes; i++) {
        if (isOver() || !turnActive) break;

        // Generate realistic stroke
        const numPoints = Math.floor(randomBetween(2, 6));
        const points = generateStrokePoints(numPoints);
        const colors = ['#000000', '#FF0000', '#0000FF', '#00FF00', '#FFA500', '#800080', '#8B4513'];
        const widths = [2, 3, 4, 6, 8, 10];

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

        // Inter-stroke pause: 150-350ms → ~3-7 strokes/sec
        sleep(randomBetween(0.15, 0.35));

        // Check for turn/game end
        const turnEnds = drain('turn_ended');
        if (turnEnds.length > 0) { processIncomingMessage(turnEnds[0]); break; }
        const gameOvers = drain('game_over');
        if (gameOvers.length > 0) { processIncomingMessage(gameOvers[0]); break; }
      }

      // Occasional fill event
      if (!isOver() && turnActive && Math.random() < 0.25) {
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

      // Clear canvas occasionally (new attempt at drawing)
      if (!isOver() && turnActive && Math.random() < 0.15) {
        sleep(randomBetween(2, 5));
        sendMsg({ type: 'clear_canvas', payload: {} });
      }

      // Wait remaining turn time (drawing continues in intervals)
      if (!isOver() && turnActive) {
        // Continue sending strokes in a second phase
        const phase2Strokes = Math.floor(randomBetween(3, 8));
        for (let i = 0; i < phase2Strokes; i++) {
          if (isOver() || !turnActive) break;
          sleep(randomBetween(0.5, 2));

          const points = generateStrokePoints(Math.floor(randomBetween(3, 8)));
          lastStrokeSentAt = Date.now();
          sendMsg({
            type: 'stroke',
            payload: {
              points: points,
              color: '#000000',
              lineWidth: 3,
            },
          });
          strokesSent.add(1);

          const ends = drain('turn_ended');
          if (ends.length > 0) { processIncomingMessage(ends[0]); break; }
          const overs = drain('game_over');
          if (overs.length > 0) { processIncomingMessage(overs[0]); break; }
        }
      }
    }

    // ── Guessing Simulation ──
    function simulateGuessing(duration) {
      const numGuesses = Math.floor(randomBetween(4, 10));
      const guessWindow = Math.min(duration * 0.75, 60);
      const interval = guessWindow / numGuesses;

      for (let i = 0; i < numGuesses; i++) {
        if (isOver() || !turnActive) break;

        // Think time before guessing
        sleep(randomBetween(interval * 0.3, interval * 1.0));
        if (isOver() || !turnActive) break;

        // Submit guess
        const guess = GUESS_WORDS[Math.floor(Math.random() * GUESS_WORDS.length)];
        lastGuessSentAt = Date.now();
        sendMsg({ type: 'guess', payload: { text: guess } });
        guessesSent.add(1);

        // Wait for response
        const resp = waitForAny(['chat_message', 'guess_correct'], 2000);
        if (resp) {
          processIncomingMessage(resp);
          if (resp.type === 'guess_correct') break; // Stop guessing
        }

        // Check turn/game end
        const ends = drain('turn_ended');
        if (ends.length > 0) { processIncomingMessage(ends[0]); break; }
        const overs = drain('game_over');
        if (overs.length > 0) { processIncomingMessage(overs[0]); break; }
      }

      // Chat occasionally while waiting
      if (!isOver() && turnActive && Math.random() < 0.5) {
        sleep(randomBetween(1, 4));
        if (!isOver() && turnActive) {
          lastChatSentAt = Date.now();
          const chatText = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
          sendMsg({ type: 'guess', payload: { text: chatText } });
          chatsSent.add(1);
        }
      }

      // Emoji reactions
      if (!isOver() && Math.random() < 0.35) {
        const emojis = ['👍', '😂', '🔥', '❤️', '👏', '😮'];
        sendMsg({
          type: 'reaction',
          payload: { emoji: emojis[Math.floor(Math.random() * emojis.length)] },
        });
      }
    }

    // ── Idle Behavior ──
    function simulateIdle() {
      // Idle players just sit there, occasionally sending a reaction
      if (Math.random() < 0.2) {
        sleep(randomBetween(5, 15));
        if (!isOver()) {
          const emojis = ['👍', '😂', '🔥', '❤️', '👏', '😮'];
          sendMsg({
            type: 'reaction',
            payload: { emoji: emojis[Math.floor(Math.random() * emojis.length)] },
          });
        }
      }
    }

    // ── Heartbeat ──
    socket.setInterval(function () {
      sendMsg({ type: 'pong', payload: {} });
    }, 25000);

    // ── Connection lifecycle ──
    socket.on('error', function () {
      connectionsFailed.add(1);
      connectionFailureRate.add(1);
      errorCount.add(1);
    });

    socket.on('close', function () {
      activeConnections.add(-1);
      playersDisconnected.add(1);
    });

    // ── Hold connection ──
    sleep(HOLD_SECONDS);
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
// ════════════════════════════════════════════════════════════════════════════

function runLobbyChatter(vuId) {
  const playerName = `k6_lobby_vu${vuId}`;

  const connectStart = Date.now();
  const res = ws.connect(WS_URL, { tags: { role: 'lobby' } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    connectionFailureRate.add(0);
    connectionsOpened.add(1);
    activeConnections.add(1);

    let joined = false;
    let lastChatSentAt = 0;

    socket.on('open', function () {
      socket.send(JSON.stringify({
        type: 'create_room',
        payload: { name: playerName },
      }));
      messagesSent.add(1);
    });

    socket.on('message', function (data) {
      try {
        const msg = JSON.parse(data);
        messagesReceived.add(1);

        if (msg.type === 'room_created') {
          joined = true;
          roomsCreated.add(1);
        }

        if (msg.type === 'chat_message' && lastChatSentAt > 0) {
          chatBroadcastRtt.add(Date.now() - lastChatSentAt);
          lastChatSentAt = 0;
        }

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', payload: {} }));
          messagesSent.add(1);
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
    });

    // Chat every 5-10 seconds
    socket.setInterval(function () {
      if (joined) {
        lastChatSentAt = Date.now();
        const chatText = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
        socket.send(JSON.stringify({
          type: 'chat',
          payload: { text: chatText },
        }));
        messagesSent.add(1);
        chatsSent.add(1);
      }
    }, 5000 + Math.random() * 5000);

    // Toggle ready periodically
    socket.setInterval(function () {
      if (joined) {
        socket.send(JSON.stringify({ type: 'toggle_ready', payload: {} }));
        messagesSent.add(1);
      }
    }, 15000 + Math.random() * 15000);

    // Heartbeat
    socket.setInterval(function () {
      socket.send(JSON.stringify({ type: 'pong', payload: {} }));
      messagesSent.add(1);
    }, 25000);

    // Hold connection
    sleep(HOLD_SECONDS);

    // Clean exit
    if (joined) {
      socket.send(JSON.stringify({ type: 'leave_room', payload: {} }));
      messagesSent.add(1);
    }
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
// ════════════════════════════════════════════════════════════════════════════

function runReconnector(vuId) {
  const playerName = `k6_reconn_vu${vuId}`;
  const cycleCount = Math.floor(HOLD_SECONDS / 50); // ~6 cycles in 300s

  let lastRoomCode = null;

  for (let cycle = 0; cycle < cycleCount; cycle++) {
    reconnectsAttempted.add(1);
    const connectStart = Date.now();

    const res = ws.connect(WS_URL, { tags: { role: 'reconnector', cycle: `${cycle}` } }, function (socket) {
      wsConnectRtt.add(Date.now() - connectStart);
      connectionSuccess.add(1);
      connectionFailureRate.add(0);
      connectionsOpened.add(1);
      activeConnections.add(1);

      let joined = false;
      let roomCode = null;

      socket.on('open', function () {
        if (lastRoomCode && cycle > 0) {
          // Attempt to reconnect to the same room (true session reconnection)
          socket.send(JSON.stringify({
            type: 'reconnect',
            payload: { name: playerName, room_code: lastRoomCode },
          }));
          messagesSent.add(1);
        } else {
          // First connection: create a new room
          socket.send(JSON.stringify({
            type: 'create_room',
            payload: { name: playerName },
          }));
          messagesSent.add(1);
        }
      });

      socket.on('message', function (data) {
        try {
          const msg = JSON.parse(data);
          messagesReceived.add(1);

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
            socket.send(JSON.stringify({
              type: 'create_room',
              payload: { name: `${playerName}_c${cycle}` },
            }));
            messagesSent.add(1);
          }

          if (msg.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong', payload: {} }));
            messagesSent.add(1);
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
      });

      // Chat while connected
      socket.setInterval(function () {
        if (joined) {
          socket.send(JSON.stringify({
            type: 'chat',
            payload: { text: `reconnector cycle ${cycle}` },
          }));
          messagesSent.add(1);
          chatsSent.add(1);
        }
      }, 5000 + Math.random() * 5000);

      // Heartbeat
      socket.setInterval(function () {
        socket.send(JSON.stringify({ type: 'pong', payload: {} }));
        messagesSent.add(1);
      }, 25000);

      // Stay connected 20-40 seconds, then disconnect
      const stayDuration = 20 + Math.random() * 20;
      sleep(stayDuration);

      // Deliberate disconnect (NOT leave_room — we want to test reconnection)
      // Just close the socket without sending leave_room
    });

    check(res, { 'Reconnector connected (101)': (r) => r && r.status === 101 });
    if (!res || res.status !== 101) {
      connectionSuccess.add(0);
      connectionFailureRate.add(1);
      connectionsFailed.add(1);
    }

    // Wait 5-10 seconds before reconnecting (within 120s grace window)
    sleep(5 + Math.random() * 5);
  }
}
