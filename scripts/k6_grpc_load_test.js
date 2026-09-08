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

// Uses the modern k6/websockets module (event-loop / async), NOT the legacy
// blocking k6/ws. The old ws.connect() blocked each VU's goroutine for the whole
// session, which serialized connection ESTABLISHMENT under a large burst and
// capped reliable concurrency (~11k here) with client-side SYN retransmits even
// though the server and OS were idle. k6/websockets drives sockets on the event
// loop so 15k+ connections can be established without blocking VUs.
import { WebSocket } from 'k6/websockets';
import { setTimeout, setInterval, clearInterval } from 'k6/timers';
import http from 'k6/http';
import { sleep } from 'k6';
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
// Coordination runs on a SEPARATE gateway port (default 9100) that bypasses
// nginx, so load-test coord HTTP does not contend with WebSocket upgrades at the
// LB. Set COORD_PORT=0 to fall back to the data-plane PORT (single-gateway / no
// nginx setups). Coord is Redis-backed, so any gateway's coord port works.
const COORD_PORT = __ENV.COORD_PORT || '9100';
const COORD_HOST_PORT = COORD_PORT === '0' ? PORT : COORD_PORT;
const COORD_URL = `http://${HOST}:${COORD_HOST_PORT}/rooms`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || '2');
const TARGET_VUS = parseInt(__ENV.VUS || '100');
const NUM_ROUNDS = parseInt(__ENV.NUM_ROUNDS || '3');
const TURN_DURATION = parseInt(__ENV.TURN_DURATION || '80');
// Stroke storm config — simulate a real drawer dragging on the canvas.
// STROKE_HZ strokes/sec per active drawer (default 30 ≈ requestAnimationFrame-ish).
// Set STROKE_HZ=0 to restore the old low-rate behaviour.
const STROKE_HZ = parseInt(__ENV.STROKE_HZ || '30');
const STROKE_POINTS = parseInt(__ENV.STROKE_POINTS || '4'); // points batched per stroke msg
// Arrival ramp: spread VU connection starts over RAMP_SECONDS instead of all at
// once. The default per-vu-iterations executor starts every VU simultaneously,
// which creates a synthetic thundering-herd of connects that real traffic never
// produces (players arrive gradually). Set RAMP_SECONDS>0 to model realistic
// gradual arrival: VU n waits (n/TARGET_VUS)*RAMP_SECONDS before connecting.
// 0 = legacy all-at-once behaviour.
const RAMP_SECONDS = parseInt(__ENV.RAMP_SECONDS || '0');
// HOLD_SECONDS is the client's patience window: how long a VU waits for its
// game to reach `game_over` before giving up and marking the session `aborted`.
// It MUST comfortably exceed the real wall-clock length of a full game, or the
// game_completion_rate metric measures the harness's patience instead of the
// server.
//
// A full game is NUM_ROUNDS * PLAYERS_PER_ROOM turns. Each turn costs more than
// TURN_DURATION: the drawer bot waits ~1-3s to pick a word (up to 15s auto-
// select), plus drawer_selecting → word_choices → select_word round trips and
// turn_ended → next-turn transitions. Observed overhead is ~25-45s/turn under
// concurrent load, not the 20s the previous formula budgeted — which timed out
// the slowest ~40% of games right at the ceiling. Budget 45s/turn of slack plus
// a 180s fixed buffer for the lobby→start handshake and graceful finish.
const PER_TURN_SLACK = parseInt(__ENV.PER_TURN_SLACK || '45');
const HOLD_FIXED_BUFFER = parseInt(__ENV.HOLD_FIXED_BUFFER || '180');

// Room-formation robustness. Previously the host only started once it saw ALL
// PLAYERS_PER_ROOM players. Under a ramp, a room's players are different VUs
// with staggered start times, so a predictable fraction of rooms never assembled
// all N in time and aborted at the 60s lobby timeout — capping completion at
// ~73% REGARDLESS of server load (a harness ceiling, not a server limit).
//
// Instead, start once MIN_PLAYERS_TO_START are present, after a START_GRACE_MS
// window that lets stragglers join. This mirrors a real host and makes
// game_completion_rate track SERVER capacity. Set MIN_PLAYERS_TO_START =
// PLAYERS_PER_ROOM to restore the old strict behaviour.
const MIN_PLAYERS_TO_START = parseInt(__ENV.MIN_PLAYERS_TO_START || '2');
const START_GRACE_MS = parseInt(__ENV.START_GRACE_MS || '8000');
const HOLD_SECONDS =
  NUM_ROUNDS * PLAYERS_PER_ROOM * (TURN_DURATION + PER_TURN_SLACK) + HOLD_FIXED_BUFFER;

// The scenario's overall maxDuration must also cover the arrival ramp: the last
// VU starts RAMP_SECONDS in and still needs a full HOLD_SECONDS to play.
const SCENARIO_SECONDS = HOLD_SECONDS + RAMP_SECONDS;

// ─── Options ────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    game_sessions: {
      executor: 'per-vu-iterations',
      vus: TARGET_VUS,
      iterations: 1,
      maxDuration: `${Math.ceil(SCENARIO_SECONDS / 60) + 3}m`,
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

// pollRoomCode discovers a room's code published by its host, against the
// DEDICATED coord port (bypasses nginx). Polls at a steady ~800ms with light
// jitter to de-sync the herd. A 404 just means "host hasn't published yet" —
// normal, so it's tagged separately and simply retried rather than treated as a
// hard failure. (Earlier: a fixed 500ms poll THROUGH nginx stormed the LB at
// 15k; over-aggressive 4s backoff then starved joiners. Fix is the dedicated
// port + a sane steady interval, not extreme backoff.)
function pollRoomCode(roomIndex, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = http.get(`${COORD_URL}/${roomIndex}`, { tags: { name: 'coord_poll' } });
    if (res.status === 200) {
      try { const b = JSON.parse(res.body); if (b.room_code) return b.room_code; } catch (e) {}
    }
    sleep(0.8 + Math.random() * 0.4); // ~0.8-1.2s, jittered
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export default function () {
  const vu = exec.vu.idInTest;
  const roomIndex = getRoomIndex(vu);
  const isHost = isHostVU(vu);
  const playerName = `k6_${isHost ? 'host' : 'p' + ((vu - 1) % PLAYERS_PER_ROOM)}_vu${vu}_r${roomIndex}`;

  // Arrival ramp — staggered BY ROOM, not by VU. All PLAYERS_PER_ROOM VUs of a
  // room share the same ramp offset so a room's whole roster arrives together
  // (within ~a second), rather than being smeared across the entire ramp. The
  // previous per-VU ramp spread a single room's 5 players across RAMP_SECONDS,
  // so late players joined after the game had already started/aborted — the
  // real cause of the completion ceiling (NOT the server).
  const totalRooms = Math.max(1, Math.ceil(TARGET_VUS / PLAYERS_PER_ROOM));
  if (RAMP_SECONDS > 0) {
    // Base offset for this room, plus a tiny per-player jitter so the host still
    // lands slightly before its joiners.
    const roomOffset = (roomIndex / totalRooms) * RAMP_SECONDS;
    sleep(roomOffset);
  }

  let coordRoomCode = null;
  if (isHost) {
    // Host connects first; small fixed jitter, independent of room index.
    sleep(Math.random() * 0.2);
  } else {
    // Joiners wait a short, CONSTANT window for the host to create+publish the
    // room code (not proportional to roomIndex, which grew to 150s+ at high room
    // counts and stranded late rooms). Then poll the coord endpoint.
    sleep(1 + Math.random() * 0.5);
    coordRoomCode = pollRoomCode(roomIndex, 30000);
    if (!coordRoomCode) {
      roomJoinFailures.add(1); errorCount.add(1);
      connectionSuccess.add(0); gameCompletionRate.add(0);
      return;
    }
  }

  let gameCompleted = false;
  const connectStart = Date.now();

  // Room-sticky routing (Path A): joiners include ?room=CODE so nginx
  // consistent-hashes them onto the gateway that owns the room. Hosts
  // (create_room) connect plain — no room exists yet. If a joiner still lands on
  // a non-owning gateway, the server replies with a `redirect`; we reconnect
  // pinned to the owner via ?gw=<id>. redirectGw carries that pin across the
  // reconnect. At most a couple of redirects, so a small bounded loop suffices.
  let redirectGw = null;
  let redirectAttempts = 0;

  function buildWsUrl() {
    const params = [];
    if (redirectGw) {
      params.push(`gw=${encodeURIComponent(redirectGw)}`);
    } else if (!isHost && coordRoomCode) {
      params.push(`room=${encodeURIComponent(coordRoomCode)}`);
    } else {
      // Host / create_room: high-cardinality cid so creators spread across
      // gateways at the LB hash instead of all landing on one (single source IP).
      params.push(`cid=${vu}-${Math.random().toString(36).slice(2)}`);
    }
    return params.length ? `${WS_URL}?${params.join('&')}` : WS_URL;
  }

  // Per-VU session state (persists across a redirect reconnect).
  let state = 'connecting';
  let roomCode = coordRoomCode;
  let playerId = null;
  let isDrawer = false;
  let turnActive = false;
  let drawingActive = false;
  let guessingActive = false;
  let startArmed = false;
  let strokeTimer = null;
  let guessTimer = null;
  let sessionEnded = false;

  // Open the socket (async, event-loop driven). runConnection wires all handlers
  // and returns immediately; the k6/websockets event loop keeps the VU iteration
  // alive until the socket closes and all timers are cleared.
  function runConnection() {
    const socket = new WebSocket(buildWsUrl());

    function sendMsg(msg) {
      try { socket.send(JSON.stringify(msg)); messagesSent.add(1); } catch (e) { errorCount.add(1); }
    }

    function stopLoops() {
      drawingActive = false; guessingActive = false;
      if (strokeTimer !== null) { clearInterval(strokeTimer); strokeTimer = null; }
      if (guessTimer !== null) { clearInterval(guessTimer); guessTimer = null; }
    }

    function endSession(reason) {
      if (sessionEnded) return;
      sessionEnded = true;
      if (reason === 'completed') { gameCompleted = true; gamesCompleted.add(1); gameCompletionRate.add(1); }
      else { gamesAborted.add(1); gameCompletionRate.add(0); }
      stopLoops();
      try { socket.close(); } catch (e) { /* ignore */ }
    }

    socket.onopen = function () {
      connectionSuccess.add(1);
      if (isHost) {
        sendMsg({ type: 'create_room', payload: { name: playerName } });
        setTimeout(function () { if (state === 'connecting') { roomCreateFailures.add(1); endSession('error'); } }, 10000);
      } else {
        sendMsg({ type: 'join_room', payload: { name: playerName, room_code: roomCode } });
        setTimeout(function () { if (state === 'connecting') { roomJoinFailures.add(1); endSession('error'); } }, 10000);
      }
      // Overall session patience timer.
      setTimeout(function () { if (!gameCompleted) endSession('aborted'); }, HOLD_SECONDS * 1000);
    };

    socket.onerror = function (e) {
      connectionFailures.add(1); errorCount.add(1);
      connectionSuccess.add(0); gameCompletionRate.add(0);
    };

    socket.onclose = function () { stopLoops(); };

    socket.onmessage = function (e) {
      messagesReceived.add(1);
      let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'ping') { sendMsg({ type: 'pong', payload: {} }); return; }
      if (msg.type === 'redirect') {
        // Owning gateway is elsewhere — pin and reconnect (bounded).
        if (msg.payload && msg.payload.gateway_id && redirectAttempts < 3) {
          redirectGw = msg.payload.gateway_id;
          redirectAttempts++;
          try { socket.close(); } catch (er) { /* ignore */ }
          runConnection(); // reconnect to the owning gateway
          return;
        }
        try { socket.close(); } catch (er) { /* ignore */ }
        return;
      }

      switch (state) {
        case 'connecting': handleConnecting(msg); break;
        case 'lobby': handleLobby(msg); break;
        case 'waiting_start': handleWaitingStart(msg); break;
        case 'playing': handlePlaying(msg); break;
      }
    };

    function handleConnecting(msg) {
      if (msg.type === 'room_created') {
        roomCreateRtt.add(Date.now() - connectStart); roomsCreated.add(1);
        roomCode = msg.payload.room_code; playerId = msg.payload.player_id;
        state = 'lobby';
        publishRoomCode(roomIndex, roomCode);
        setTimeout(function () { if (state === 'lobby' || state === 'waiting_start') endSession('aborted'); }, 60000);
      } else if (msg.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - connectStart); roomsJoined.add(1);
        roomCode = msg.payload.room_code; playerId = msg.payload.player_id;
        state = 'lobby';
        setTimeout(function () { if (state === 'lobby') sendMsg({ type: 'toggle_ready', payload: {} }); }, Math.floor(randomBetween(1000, 2000)));
        setTimeout(function () { if (state === 'lobby' || state === 'waiting_start') endSession('aborted'); }, 60000);
      } else if (msg.type === 'error') { errorCount.add(1); endSession('error'); }
    }

    function handleLobby(msg) {
      if (msg.type === 'player_list' && msg.payload) {
        const count = msg.payload.players.length;
        // Arm the start sequence ONCE when the minimum is present, then wait a
        // grace window for the rest of the roster to arrive before starting.
        if (isHost && !startArmed && count >= MIN_PLAYERS_TO_START) {
          startArmed = true;
          sendMsg({ type: 'update_settings', payload: { num_rounds: NUM_ROUNDS, turn_duration: TURN_DURATION, max_players: PLAYERS_PER_ROOM } });
          sendMsg({ type: 'toggle_ready', payload: {} });
          setTimeout(function () {
            if (state !== 'lobby') return;
            sendMsg({ type: 'start_game', payload: {} });
            gamesStarted.add(1); state = 'waiting_start';
          }, START_GRACE_MS);
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
          turnActive = false; stopLoops(); break;
        case 'word_choices':
          if (isDrawer && msg.payload && msg.payload.choices && msg.payload.choices.length > 0) {
            const choices = msg.payload.choices;
            setTimeout(function () { sendMsg({ type: 'select_word', payload: { word: choices[Math.floor(Math.random() * choices.length)] } }); }, Math.floor(randomBetween(1000, 3000)));
          } break;
        case 'turn_started':
          turnActive = true; isDrawer = msg.payload && msg.payload.drawer_id === playerId;
          if (isDrawer) { startDrawing(); } else { startGuessing(); } break;
        case 'turn_ended':
          turnActive = false; stopLoops(); break;
        case 'game_over': endSession('completed'); break;
        case 'game_ended_insufficient_players': endSession('aborted'); break;
      }
    }

    function startDrawing() {
      drawingActive = true;
      if (STROKE_HZ <= 0) {
        strokeTimer = setInterval(function () {
          if (!drawingActive || !turnActive) return;
          sendMsg({ type: 'stroke', payload: { points: [{ x: Math.random()*800, y: Math.random()*600 }, { x: Math.random()*800, y: Math.random()*600 }], color: '#000', lineWidth: 3 } });
        }, Math.floor(randomBetween(2000, 5000)));
        return;
      }
      // Stroke storm: emit STROKE_HZ messages/sec, each carrying STROKE_POINTS
      // points — the real fan-out hot path (broadcast to all guessers).
      const intervalMs = Math.max(1, Math.floor(1000 / STROKE_HZ));
      let lastX = Math.random() * 800;
      let lastY = Math.random() * 600;
      strokeTimer = setInterval(function () {
        if (!drawingActive || !turnActive) return;
        const points = [];
        for (let i = 0; i < STROKE_POINTS; i++) {
          lastX = Math.max(0, Math.min(800, lastX + randomBetween(-15, 15)));
          lastY = Math.max(0, Math.min(600, lastY + randomBetween(-15, 15)));
          points.push({ x: lastX, y: lastY });
        }
        sendMsg({ type: 'stroke', payload: { points: points, color: '#000', lineWidth: 3 } });
      }, intervalMs);
    }

    function startGuessing() {
      guessingActive = true;
      const words = ['cat','dog','house','tree','car','sun','moon','fish','bird','star','flower','mountain','river','boat'];
      guessTimer = setInterval(function () {
        if (!guessingActive || !turnActive) return;
        sendMsg({ type: 'guess', payload: { text: words[Math.floor(Math.random() * words.length)] } });
      }, Math.floor(randomBetween(3000, 8000)));
    }
  }

  runConnection();
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

export function setup() {
  const res = http.get(`http://${__ENV.HOST || 'localhost'}:${__ENV.PORT || '9000'}/health`);
  console.log(`Gateway: ${res.body}`);
  console.log(`Load test: ${TARGET_VUS} VUs → ${TARGET_VUS / PLAYERS_PER_ROOM} rooms × ${PLAYERS_PER_ROOM} players`);
  console.log(`Game: ${NUM_ROUNDS} rounds, ${TURN_DURATION}s turns, hold=${HOLD_SECONDS}s`);
  if (STROKE_HZ > 0) {
    const rooms = TARGET_VUS / PLAYERS_PER_ROOM;
    const fanoutPerSec = rooms * STROKE_HZ * (PLAYERS_PER_ROOM - 1);
    console.log(`Stroke storm: ${STROKE_HZ} strokes/s/drawer × ${STROKE_POINTS} pts → ~${fanoutPerSec} broadcast writes/s at gateway (peak, all rooms drawing)`);
  } else {
    console.log('Stroke storm: DISABLED (legacy 2-5s stroke interval)');
  }
  return {};
}

export function teardown() { console.log('Load test complete.'); }
