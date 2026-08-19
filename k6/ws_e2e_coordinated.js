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
const COORD_PORT = __ENV.COORD_PORT || '9090';
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const COORD_URL = `http://${HOST}:${COORD_PORT}`;
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || '5');
const TARGET_VUS = parseInt(__ENV.VUS || '50');
const NUM_ROUNDS = parseInt(__ENV.NUM_ROUNDS || '3');
const TURN_DURATION = parseInt(__ENV.TURN_DURATION || '80');

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

// ─── Coordination helpers ───────────────────────────────────────────────────

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

  // Stagger connections: hosts first, joiners wait
  if (!isHost) {
    sleep(2 + playerIndex * 0.5 + Math.random() * 0.5);
  }

  const connectStart = Date.now();

  const res = ws.connect(WS_URL, { tags: { room: `room_${roomIndex}`, role: isHost ? 'host' : 'joiner' } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    activeConnections.add(1);

    // ── Per-VU State ──
    let roomCode = null;
    let playerId = null;
    let gameState = 'connecting'; // connecting | lobby | playing | game_over | error
    let isDrawer = false;
    let currentWord = null;
    let turnActive = false;
    let gameCompleted = false;
    let messageQueue = [];

    // ── Message Processing ──
    socket.on('message', function (data) {
      messagesReceived.add(1);
      try {
        const msg = JSON.parse(data);
        messageQueue.push(msg);
        processMessage(msg);
      } catch (e) {
        errorCount.add(1);
      }
    });

    function processMessage(msg) {
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
          break;
        case 'drawer_selecting':
          isDrawer = msg.payload.drawer_id === playerId;
          break;
        case 'word_choices':
          break; // handled in game loop
        case 'word_assigned':
          currentWord = msg.payload.word;
          break;
        case 'turn_started':
          turnActive = true;
          isDrawer = msg.payload.drawer_id === playerId;
          turnsPlayed.add(1);
          break;
        case 'turn_ended':
          turnActive = false;
          isDrawer = false;
          currentWord = null;
          break;
        case 'guess_correct':
          correctGuesses.add(1);
          break;
        case 'game_over':
          gameState = 'game_over';
          gameCompleted = true;
          gamesCompleted.add(1);
          gameCompletionRate.add(1);
          break;
        case 'game_ended_insufficient_players':
          gameState = 'game_over';
          gamesAborted.add(1);
          gameCompletionRate.add(0);
          break;
        case 'error':
          errorCount.add(1);
          break;
        case 'ping':
          sendMsg({ type: 'pong', payload: {} });
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
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const idx = messageQueue.findIndex((m) => m.type === type);
        if (idx !== -1) {
          return messageQueue.splice(idx, 1)[0];
        }
        sleep(0.1);
      }
      return null;
    }

    function waitForAny(types, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const idx = messageQueue.findIndex((m) => types.includes(m.type));
        if (idx !== -1) {
          return messageQueue.splice(idx, 1)[0];
        }
        sleep(0.1);
      }
      return null;
    }

    function drain(type) {
      const found = messageQueue.filter((m) => m.type === type);
      messageQueue = messageQueue.filter((m) => m.type !== type);
      return found;
    }

    function isGameOver() {
      return gameState === 'game_over' || gameState === 'error';
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FLOW START
    // ══════════════════════════════════════════════════════════════════════════

    socket.on('open', function () {
      if (isHost) {
        runHostFlow();
      } else {
        runJoinerFlow();
      }
    });

    // ── HOST FLOW ──
    function runHostFlow() {
      // Step 1: Create room
      const t0 = Date.now();
      sendMsg({ type: 'create_room', payload: { name: playerName } });

      const resp = waitFor('room_created', 10000);
      if (!resp) {
        roomCreateFailures.add(1);
        errorCount.add(1);
        gameState = 'error';
        return;
      }
      roomCreateRtt.add(Date.now() - t0);
      roomsCreated.add(1);
      roomCode = resp.payload.room_code;
      playerId = resp.payload.player_id;
      gameState = 'lobby';

      // Step 2: Publish room code to coordination server
      publishRoomCode(roomIndex, roomCode);

      // Step 3: Wait for joiners (watch player_list updates)
      const joinWaitStart = Date.now();
      while (Date.now() - joinWaitStart < 30000) {
        const plMsg = drain('player_list');
        if (plMsg.length > 0) {
          const last = plMsg[plMsg.length - 1];
          if (last.payload.players.length >= PLAYERS_PER_ROOM) {
            break;
          }
        }
        sleep(0.5);
      }

      // Step 4: Ready up
      sleep(randomBetween(0.5, 1.5));
      sendMsg({ type: 'toggle_ready', payload: {} });

      // Step 5: Wait briefly for all to ready, then start
      sleep(randomBetween(2, 4));

      const startT = Date.now();
      sendMsg({ type: 'start_game', payload: {} });
      gamesStarted.add(1);

      const startResp = waitForAny(['drawer_selecting', 'turn_started', 'error'], 10000);
      if (startResp && startResp.type !== 'error') {
        gameStartRtt.add(Date.now() - startT);
        gameState = 'playing';
      } else {
        errorCount.add(1);
        gameCompletionRate.add(0);
        gameState = 'error';
        return;
      }

      // Step 6: Play the game
      runGameLoop();
    }

    // ── JOINER FLOW ──
    function runJoinerFlow() {
      // Step 1: Poll coordination server for room code
      const code = pollRoomCode(roomIndex, 20000);
      if (!code) {
        // Fallback: create own room (degraded mode)
        roomJoinFailures.add(1);
        const t0 = Date.now();
        sendMsg({ type: 'create_room', payload: { name: playerName } });
        const resp = waitForAny(['room_created', 'error'], 10000);
        if (resp && resp.type === 'room_created') {
          roomJoinRtt.add(Date.now() - t0);
          roomCode = resp.payload.room_code;
          playerId = resp.payload.player_id;
          gameState = 'lobby';
        } else {
          errorCount.add(1);
          gameState = 'error';
          return;
        }
        // Can't truly play multiplayer without coordination — hold connection
        sleep(60);
        return;
      }

      // Step 2: Join the room
      const t0 = Date.now();
      sendMsg({ type: 'join_room', payload: { name: playerName, room_code: code } });

      const resp = waitForAny(['room_joined', 'error'], 10000);
      if (resp && resp.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - t0);
        roomsJoined.add(1);
        roomCode = resp.payload.room_code;
        playerId = resp.payload.player_id;
        gameState = 'lobby';
      } else {
        roomJoinFailures.add(1);
        errorCount.add(1);
        gameState = 'error';
        return;
      }

      // Step 3: Ready up
      sleep(randomBetween(1, 3));
      sendMsg({ type: 'toggle_ready', payload: {} });

      // Step 4: Wait for game start
      const startMsg = waitForAny(['drawer_selecting', 'turn_started', 'game_over'], 60000);
      if (startMsg && startMsg.type !== 'game_over') {
        gameState = 'playing';
        processMessage(startMsg);
      } else if (startMsg && startMsg.type === 'game_over') {
        processMessage(startMsg);
        return;
      } else {
        // Timeout waiting for game start
        errorCount.add(1);
        gameState = 'error';
        return;
      }

      // Step 5: Play the game
      runGameLoop();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GAME LOOP — Full lifecycle simulation
    // ══════════════════════════════════════════════════════════════════════════

    function runGameLoop() {
      const maxDuration = (NUM_ROUNDS * PLAYERS_PER_ROOM * (TURN_DURATION + 25) + 120) * 1000;
      const loopStart = Date.now();

      while (!isGameOver() && Date.now() - loopStart < maxDuration) {
        const msg = waitForAny(
          [
            'drawer_selecting', 'word_choices', 'word_assigned',
            'turn_started', 'turn_ended', 'hint_update',
            'game_over', 'game_ended_insufficient_players',
            'guess_correct', 'chat_message', 'ping',
          ],
          3000
        );

        if (!msg) {
          sleep(0.3);
          continue;
        }

        processMessage(msg);

        if (isGameOver()) break;

        // ── Role-based behavior ──
        if (msg.type === 'word_choices' && isDrawer) {
          doWordSelection(msg.payload.choices);
        } else if (msg.type === 'turn_started') {
          if (isDrawer) {
            doDrawing(msg.payload.duration);
          } else {
            doGuessing(msg.payload.duration);
          }
        }
      }

      if (!gameCompleted && !isGameOver()) {
        gamesAborted.add(1);
        gameCompletionRate.add(0);
      }
    }

    // ── WORD SELECTION (Drawer) ──
    function doWordSelection(choices) {
      // Simulate think time (1-5 seconds, usually fast)
      sleep(randomBetween(1, 4));

      if (isGameOver()) return;

      const word = choices[Math.floor(Math.random() * choices.length)];
      const t0 = Date.now();
      sendMsg({ type: 'select_word', payload: { word: word } });
      currentWord = word;

      const confirmation = waitFor('turn_started', 8000);
      if (confirmation) {
        wordSelectionRtt.add(Date.now() - t0);
        processMessage(confirmation);
      }
    }

    // ── DRAWING (Drawer) ──
    function doDrawing(duration) {
      // Simulate 4-10 strokes across ~60% of the turn duration
      const drawingTime = duration * 0.6;
      const numStrokes = Math.floor(randomBetween(4, 10));
      const strokeInterval = drawingTime / numStrokes;

      for (let i = 0; i < numStrokes; i++) {
        if (isGameOver() || !turnActive) break;

        // Generate stroke
        const numPoints = Math.floor(randomBetween(15, 80));
        const points = generateStrokePoints(numPoints);
        const colors = ['#000000', '#FF0000', '#0000FF', '#00FF00', '#FFA500', '#800080'];
        const widths = [2, 3, 5, 8, 12];

        const t0 = Date.now();
        sendMsg({
          type: 'stroke',
          payload: {
            points: points,
            color: colors[Math.floor(Math.random() * colors.length)],
            lineWidth: widths[Math.floor(Math.random() * widths.length)],
          },
        });
        drawingEventsSent.add(1);

        // Wait for stroke broadcast (measures server fan-out time)
        const echo = waitFor('stroke', 1500);
        if (echo) {
          drawBroadcastRtt.add(Date.now() - t0);
        }

        // Pause between strokes
        sleep(randomBetween(strokeInterval * 0.3, strokeInterval * 1.0));

        // Check for turn/game end
        const endMsgs = drain('turn_ended');
        if (endMsgs.length > 0) { turnActive = false; break; }
        const overMsgs = drain('game_over');
        if (overMsgs.length > 0) { processMessage(overMsgs[0]); break; }
      }

      // Occasional fill
      if (turnActive && !isGameOver() && Math.random() < 0.2) {
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
    }

    // ── GUESSING (Non-drawer) ──
    function doGuessing(duration) {
      // Submit 4-10 guesses spread across the turn
      const numGuesses = Math.floor(randomBetween(4, 10));
      const guessWindow = duration * 0.75;
      const interval = guessWindow / numGuesses;

      for (let i = 0; i < numGuesses; i++) {
        if (isGameOver() || !turnActive) break;

        // Think time
        sleep(randomBetween(interval * 0.4, interval * 1.2));

        if (isGameOver() || !turnActive) break;

        // Pick a guess
        const guess = GUESS_WORDS[Math.floor(Math.random() * GUESS_WORDS.length)];
        const t0 = Date.now();
        sendMsg({ type: 'guess', payload: { text: guess } });
        guessesSent.add(1);

        // Wait for response (chat_message = wrong, guess_correct = right)
        const resp = waitForAny(['chat_message', 'guess_correct'], 2000);
        if (resp) {
          guessBroadcastRtt.add(Date.now() - t0);
          if (resp.type === 'guess_correct') {
            // We guessed correctly — stop guessing this turn
            break;
          }
        }

        // Check turn/game end
        const ends = drain('turn_ended');
        if (ends.length > 0) { turnActive = false; processMessage(ends[0]); break; }
        const overs = drain('game_over');
        if (overs.length > 0) { processMessage(overs[0]); break; }
      }

      // Emoji reactions
      if (!isGameOver() && Math.random() < 0.3) {
        const emojis = ['👍', '😂', '🔥', '❤️', '👏', '😮'];
        sendMsg({
          type: 'reaction',
          payload: { emoji: emojis[Math.floor(Math.random() * emojis.length)] },
        });
      }
    }

    // ── Heartbeat ──
    socket.setInterval(function () {
      sendMsg({ type: 'pong', payload: {} });
    }, 25000);

    // ── Hold connection for full game duration ──
    const holdTime = NUM_ROUNDS * PLAYERS_PER_ROOM * (TURN_DURATION + 20) + 180;
    sleep(Math.min(holdTime, parseInt(__ENV.HOLD_TIME || '600')));

    socket.on('error', function () {
      connectionFailures.add(1);
      errorCount.add(1);
    });

    socket.on('close', function () {
      activeConnections.add(-1);
      disconnects.add(1);
    });
  });

  check(res, {
    'WebSocket handshake 101': (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    connectionSuccess.add(0);
    connectionFailures.add(1);
  }
}
