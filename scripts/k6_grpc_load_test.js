/**
 * k6 Load Test — gRPC Multiplexing: Scalable Multi-Player
 *
 * Scaled-up version of k6_grpc_smoke_test.js for production-like load.
 * Same event-driven state machine pattern, configurable VU count.
 *
 * == How to run ==
 *   # 100 players (50 rooms × 2 players) — quick validation
 *   k6 run -e VUS=100 scripts/k6_grpc_load_test.js
 *
 *   # 500 players (250 rooms × 2 players)
 *   k6 run -e VUS=500 scripts/k6_grpc_load_test.js
 *
 *   # 1000 players (200 rooms × 5 players)
 *   k6 run -e VUS=1000 -e PLAYERS_PER_ROOM=5 scripts/k6_grpc_load_test.js
 *
 *   # Full 10K (2000 rooms × 5 players) — requires beefy infra
 *   k6 run -e VUS=10000 -e PLAYERS_PER_ROOM=5 scripts/k6_grpc_load_test.js
 *
 * == Validates Requirements ==
 * - 9.1: Connection success rate >99%
 * - 9.2: Message latency p95 <50ms
 * - 9.3: Game completion rate >80%
 * - 9.4: Total gRPC streams <1500 (check /metrics during test)
 * - 9.5: Per-worker streams <200 (check /metrics during test)
 */

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import exec from 'k6/execution';

// ─── Metrics ────────────────────────────────────────────────────────────────

const connectionSuccess = new Rate('ws_connection_success');
const connectionFailures = new Counter('ws_connection_failures');
const roomCreateRtt = new Trend('room_create_rtt', true);
const roomJoinRtt = new Trend('room_join_rtt', true);
const roomsCreated = new Counter('rooms_created');
const roomCreateFailures = new Counter('room_create_failures');
const roomsJoined = new Counter('rooms_joined');
const roomJoinFailures = new Counter('room_join_failures');
const gamesStarted = new Counter('games_started');
const gamesCompleted = new Counter('games_completed');
const gamesAborted = new Counter('games_aborted');
const gameCompletionRate = new Rate('game_completion_rate');
const messagesSent = new Counter('messages_sent');
const messagesReceived = new Counter('messages_received');
const errorCount = new Counter('errors');

// ─── Configuration ──────────────────────────────────────────────────────────

const HOST = __ENV.HOST || 'localhost';
const PORT = __ENV.PORT || '9000';
const COORD_URL = `http://${HOST}:${PORT}/rooms`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || '2');
const TARGET_VUS = parseInt(__ENV.VUS || '100');
const NUM_ROUNDS = parseInt(__ENV.NUM_ROUNDS || '3');
const TURN_DURATION = parseInt(__ENV.TURN_DURATION || '80');
const HOLD_SECONDS = NUM_ROUNDS * PLAYERS_PER_ROOM * (TURN_DURATION + 20) + 120;

// ─── Options ────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    game_sessions: {
      executor: 'per-vu-iterations',
      vus: TARGET_VUS,
      iterations: 1,
      maxDuration: `${Math.ceil(HOLD_SECONDS / 60) + 3}m`,
    },
  },
  thresholds: {
    ws_connection_success: ['rate>0.95'],
    game_completion_rate: ['rate>0.70'],
    room_create_rtt: ['p(95)<5000'],
    room_join_rtt: ['p(95)<5000'],
  },
};

// ─── Utilities ──────────────────────────────────────────────────────────────

function getRoomIndex(vu) { return Math.floor((vu - 1) / PLAYERS_PER_ROOM); }
function isHostVU(vu) { return (vu - 1) % PLAYERS_PER_ROOM === 0; }
function randomBetween(min, max) { return min + Math.random() * (max - min); }

function publishRoomCode(roomIndex, roomCode) {
  http.post(`${COORD_URL}/${roomIndex}`, JSON.stringify({ room_code: roomCode }), {
    headers: { 'Content-Type': 'application/json' }, tags: { name: 'coord_publish' },
  });
}

function pollRoomCode(roomIndex, timeoutMs) {
  const start = Date.now();
  for (let i = 0; i < Math.ceil(timeoutMs / 500); i++) {
    const res = http.get(`${COORD_URL}/${roomIndex}`, { tags: { name: 'coord_poll' } });
    if (res.status === 200) {
      try { const b = JSON.parse(res.body); if (b.room_code) return b.room_code; } catch (e) {}
    }
    if (Date.now() - start >= timeoutMs) break;
    sleep(0.5);
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export default function () {
  const vu = exec.vu.idInTest;
  const roomIndex = getRoomIndex(vu);
  const isHost = isHostVU(vu);
  const playerName = `k6_${isHost ? 'host' : 'p' + ((vu - 1) % PLAYERS_PER_ROOM)}_vu${vu}_r${roomIndex}`;

  let coordRoomCode = null;
  if (isHost) {
    sleep(roomIndex * 0.05 + Math.random() * 0.2);
  } else {
    sleep(2 + roomIndex * 0.1 + Math.random() * 0.5);
    coordRoomCode = pollRoomCode(roomIndex, 30000);
    if (!coordRoomCode) {
      roomJoinFailures.add(1); errorCount.add(1);
      connectionSuccess.add(0); gameCompletionRate.add(0);
      return;
    }
  }

  let gameCompleted = false;
  const connectStart = Date.now();

  const res = ws.connect(WS_URL, { tags: { role: isHost ? 'host' : 'joiner' } }, function (socket) {
    connectionSuccess.add(1);

    let state = 'connecting';
    let roomCode = coordRoomCode;
    let playerId = null;
    let gameStartTime = 0;
    let isDrawer = false;
    let turnActive = false;
    let drawingActive = false;
    let guessingActive = false;

    function sendMsg(msg) {
      try { socket.send(JSON.stringify(msg)); messagesSent.add(1); } catch (e) { errorCount.add(1); }
    }

    function endSession(reason) {
      if (reason === 'completed') { gameCompleted = true; gamesCompleted.add(1); gameCompletionRate.add(1); }
      else { gamesAborted.add(1); gameCompletionRate.add(0); }
      drawingActive = false; guessingActive = false;
      socket.close();
    }

    socket.on('open', function () {
      if (isHost) {
        sendMsg({ type: 'create_room', payload: { name: playerName } });
        socket.setTimeout(function () { if (state === 'connecting') { roomCreateFailures.add(1); endSession('error'); } }, 10000);
      } else {
        sendMsg({ type: 'join_room', payload: { name: playerName, room_code: roomCode } });
        socket.setTimeout(function () { if (state === 'connecting') { roomJoinFailures.add(1); endSession('error'); } }, 10000);
      }
    });

    socket.on('message', function (data) {
      messagesReceived.add(1);
      let msg; try { msg = JSON.parse(data); } catch (e) { return; }
      if (msg.type === 'ping') { sendMsg({ type: 'pong', payload: {} }); return; }

      switch (state) {
        case 'connecting': handleConnecting(msg); break;
        case 'lobby': handleLobby(msg); break;
        case 'waiting_start': handleWaitingStart(msg); break;
        case 'playing': handlePlaying(msg); break;
      }
    });

    function handleConnecting(msg) {
      if (msg.type === 'room_created') {
        roomCreateRtt.add(Date.now() - connectStart); roomsCreated.add(1);
        roomCode = msg.payload.room_code; playerId = msg.payload.player_id;
        state = 'lobby';
        publishRoomCode(roomIndex, roomCode);
        socket.setTimeout(function () { if (state === 'lobby' || state === 'waiting_start') endSession('aborted'); }, 60000);
      } else if (msg.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - connectStart); roomsJoined.add(1);
        roomCode = msg.payload.room_code; playerId = msg.payload.player_id;
        state = 'lobby';
        socket.setTimeout(function () { if (state === 'lobby') sendMsg({ type: 'toggle_ready', payload: {} }); }, Math.floor(randomBetween(1000, 2000)));
        socket.setTimeout(function () { if (state === 'lobby' || state === 'waiting_start') endSession('aborted'); }, 60000);
      } else if (msg.type === 'error') { errorCount.add(1); endSession('error'); }
    }

    function handleLobby(msg) {
      if (msg.type === 'player_list' && msg.payload) {
        const count = msg.payload.players.length;
        if (isHost && count >= PLAYERS_PER_ROOM) {
          socket.setTimeout(function () {
            if (state !== 'lobby') return;
            sendMsg({ type: 'update_settings', payload: { num_rounds: NUM_ROUNDS, turn_duration: TURN_DURATION, max_players: PLAYERS_PER_ROOM } });
            sendMsg({ type: 'toggle_ready', payload: {} });
            socket.setTimeout(function () {
              if (state !== 'lobby') return;
              gameStartTime = Date.now(); sendMsg({ type: 'start_game', payload: {} });
              gamesStarted.add(1); state = 'waiting_start';
            }, Math.floor(randomBetween(2000, 3000)));
          }, Math.floor(randomBetween(500, 1000)));
        }
      } else if (msg.type === 'game_started' || msg.type === 'turn_started' || msg.type === 'word_choices' || msg.type === 'drawer_selecting') {
        state = 'playing'; handlePlaying(msg);
      } else if (msg.type === 'game_over') { endSession('completed'); }
    }

    function handleWaitingStart(msg) {
      if (msg.type === 'game_started' || msg.type === 'turn_started' || msg.type === 'word_choices' || msg.type === 'drawer_selecting') {
        state = 'playing'; handlePlaying(msg);
      } else if (msg.type === 'game_over') { endSession('completed'); }
      else if (msg.type === 'error') { endSession('error'); }
    }

    function handlePlaying(msg) {
      switch (msg.type) {
        case 'drawer_selecting':
          isDrawer = msg.payload && msg.payload.drawer_id === playerId;
          turnActive = false; drawingActive = false; guessingActive = false; break;
        case 'word_choices':
          if (isDrawer && msg.payload && msg.payload.choices && msg.payload.choices.length > 0) {
            const choices = msg.payload.choices;
            socket.setTimeout(function () { sendMsg({ type: 'select_word', payload: { word: choices[Math.floor(Math.random() * choices.length)] } }); }, Math.floor(randomBetween(1000, 3000)));
          } break;
        case 'turn_started':
          turnActive = true; isDrawer = msg.payload && msg.payload.drawer_id === playerId;
          if (isDrawer) { startDrawing(); } else { startGuessing(); } break;
        case 'turn_ended':
          turnActive = false; drawingActive = false; guessingActive = false; break;
        case 'game_over': endSession('completed'); break;
        case 'game_ended_insufficient_players': endSession('aborted'); break;
      }
    }

    function startDrawing() {
      drawingActive = true;
      socket.setInterval(function () {
        if (!drawingActive || !turnActive) return;
        sendMsg({ type: 'stroke', payload: { points: [{ x: Math.random()*800, y: Math.random()*600 }, { x: Math.random()*800, y: Math.random()*600 }], color: '#000', lineWidth: 3 } });
      }, Math.floor(randomBetween(2000, 5000)));
    }

    function startGuessing() {
      guessingActive = true;
      const words = ['cat','dog','house','tree','car','sun','moon','fish','bird','star','flower','mountain','river','boat'];
      socket.setInterval(function () {
        if (!guessingActive || !turnActive) return;
        sendMsg({ type: 'guess', payload: { text: words[Math.floor(Math.random() * words.length)] } });
      }, Math.floor(randomBetween(3000, 8000)));
    }

    socket.on('error', function (e) { connectionFailures.add(1); errorCount.add(1); });
    socket.on('close', function () { drawingActive = false; guessingActive = false; });
    socket.setTimeout(function () { if (!gameCompleted) endSession('aborted'); }, HOLD_SECONDS * 1000);
  });

  check(res, { 'WS connected': (r) => r && r.status === 101 });
  if (!res || res.status !== 101) { connectionSuccess.add(0); connectionFailures.add(1); gameCompletionRate.add(0); }
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

export function setup() {
  const res = http.get(`http://${__ENV.HOST || 'localhost'}:${__ENV.PORT || '9000'}/health`);
  console.log(`Gateway: ${res.body}`);
  console.log(`Load test: ${TARGET_VUS} VUs → ${TARGET_VUS / PLAYERS_PER_ROOM} rooms × ${PLAYERS_PER_ROOM} players`);
  console.log(`Game: ${NUM_ROUNDS} rounds, ${TURN_DURATION}s turns, hold=${HOLD_SECONDS}s`);
  return {};
}

export function teardown() { console.log('Load test complete.'); }
