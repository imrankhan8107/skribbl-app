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
 * Requirements vs what this script enforces. The k6 THRESHOLDS are looser
 * engineering guardrails (so exploratory runs fail only on real regressions);
 * the REQUIREMENT values are checked in handleSummary() and printed as
 * ACCEPTANCE PASS/FAIL. Run with STRICT=1 to make the thresholds equal the
 * requirements (hard acceptance mode).
 * - 9.1: Connection success >99%   (acceptance; guardrail >95%, or >99% STRICT)
 * - 9.2: Message latency p95 <50ms (acceptance == guardrail; measured on the
 *        toggle_ready -> player_list round trip — a real request/response pair,
 *        NOT inter-message gaps, though see the correlation caveat in metrics)
 * - 9.3: Game completion >80%      (acceptance; guardrail >70%, or >80% STRICT)
 * - 9.4: Total gRPC streams <1500 (check /metrics during test)
 * - 9.5: Per-worker streams <200 (check /metrics during test)
 *
 * NOTE: handleSummary() imports the k6-summary jslib over HTTPS. On an
 * air-gapped/offline runner, bundle it first with `k6 archive` and run the
 * resulting .tar (`k6 run archive.tar`) so the fetch happens once at build time.
 *
 * == Live-connection curve (50k/100k experiments) ==
 * A k6 Gauge only keeps its last value and VUs don't share memory, so there is
 * no single in-script "active connections" number. Run with a streaming output
 * and derive it: active(t) = ws_connections_opened - ws_connections_closed, or
 * sum the per-VU ws_socket_open (0/1) gauge in your backend.
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
import { Counter, Trend, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ─── Metrics ────────────────────────────────────────────────────────────────

// Connection metrics. connectionSuccess is per-VU INITIAL connect only (a
// redirect reconnect does not add another sample), so it reads as a true
// per-player connection-success rate rather than per-socket-open.
const connectionSuccess = new Rate('ws_connection_success');
const connectionFailures = new Counter('ws_connection_failures');
// ws_open_rtt = time from the WebSocket constructor to the `open` event. NOT
// pure TCP/TLS/HTTP-101 latency — it's the full "constructor → open" wall time,
// which is what actually matters to a player waiting to be connected.
const wsOpenRtt = new Trend('ws_open_rtt', true); // connectStart -> onopen
const redirectsFollowed = new Counter('redirects_followed');
// Live-connection observability via lifetime COUNTERS only.
//
// We intentionally do NOT expose a per-VU "socket open" gauge. A k6 Gauge keeps
// only its last value and VUs don't share memory, so it can't sum to a real
// concurrency number; worse, during a redirect a VU briefly holds two sockets
// (new one opens before the old one's close fires), so a per-VU 0/1 gauge would
// race and report 0 while a socket is still open. Counters don't have that
// problem: every open increments opened, every close increments closed, and
//   active(t) = ws_connections_opened - ws_connections_closed
// computed in your streaming backend (--out experimental-prometheus-rw / json)
// is exact regardless of redirect overlap.
const wsConnectionsOpened = new Counter('ws_connections_opened');
const wsConnectionsClosed = new Counter('ws_connections_closed');
const wsConnectionDuration = new Trend('ws_connection_duration', true);
// Request/response latency, correlated on toggle_ready → player_list (the one
// round trip EVERY vu performs in the lobby). Validates the "message latency
// p95 <50ms" requirement — NOT inter-message arrival gaps.
//
// CORRELATION CAVEAT: the client protocol has no request_id echo (the gateway
// parses only {type,payload} and forwards payload opaquely; player_list carries
// no id — verified in gateway/multiplexer.go clientMessage). So this measures
// "first player_list after MY toggle_ready", which is an APPROXIMATION: it holds
// as long as the server responds to a player's toggle_ready with a player_list
// before that player observes an unrelated player_list broadcast. Under this
// game's flow that's true in the lobby, but it is not a protocol-guaranteed
// exact match. For a 10/10 measurement, add a request_id to the toggle_ready/
// player_list pair in the real protocol and match on it here.
const messageLatency = new Trend('message_latency', true);
const roomCreateRtt = new Trend('room_create_rtt', true);
const roomJoinRtt = new Trend('room_join_rtt', true);
const roomsCreated = new Counter('rooms_created');
const roomCreateFailures = new Counter('room_create_failures');
const roomsJoined = new Counter('rooms_joined');
const roomJoinFailures = new Counter('room_join_failures');
// gameStartRequests = host sent start_game; gamesStarted = server actually
// began (game_started/turn_started seen). Under load these diverge.
const gameStartRequests = new Counter('game_start_requests');
const gamesStarted = new Counter('games_started');
const gamesCompleted = new Counter('games_completed');
const gamesAborted = new Counter('games_aborted');
// NOTE: this is a PER-PLAYER (per-VU session) rate, not per-game — every player
// in a room completes/aborts together, so N players => N samples for 1 game.
// Named accordingly to avoid the earlier "game completion" misreading.
const sessionCompletionRate = new Rate('player_session_completion_rate');
// True per-GAME completion: only the host records one sample per room.
const gameCompletionRate = new Rate('game_completion_rate');
const messagesSent = new Counter('messages_sent');
const messagesReceived = new Counter('messages_received');
// errors = grand total (kept for backwards-compat / a single at-a-glance number).
// The categorized counters below let you see WHERE failures concentrate — e.g. a
// spike in errors_connect points at the LB/gateway accept path, errors_timeout at
// slow game progression, errors_protocol at a server-emitted error frame.
const errorCount = new Counter('errors');
const errorsConnect = new Counter('errors_connect');   // socket error/close, coord discovery failure
const errorsRoom = new Counter('errors_room');          // create/join failed or timed out
const errorsProtocol = new Counter('errors_protocol');  // server sent an `error` message frame
const errorsGame = new Counter('errors_game');          // game aborted mid-play (e.g. insufficient players)
const errorsTimeout = new Counter('errors_timeout');    // client patience/lobby/start timers fired

// recordError bumps the grand-total AND the category, so callers have one call
// site and both metrics stay in sync.
function recordError(category) {
  errorCount.add(1);
  switch (category) {
    case 'connect': errorsConnect.add(1); break;
    case 'room': errorsRoom.add(1); break;
    case 'protocol': errorsProtocol.add(1); break;
    case 'game': errorsGame.add(1); break;
    case 'timeout': errorsTimeout.add(1); break;
  }
}

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
// Stroke config — simulate a drawer dragging on the canvas. STROKE_HZ strokes/
// sec per active drawer. Pick a profile to match what you're claiming:
//   STROKE_HZ=0   connection/session test (no drawing traffic)
//   STROKE_HZ=5   realistic-ish drawing workload
//   STROKE_HZ=15  heavy drawing
//   STROKE_HZ=30  stress test — deliberately hammers the fan-out path
// Default is 30 (stress). Do NOT report a 30Hz run as "production-like" unless
// real user telemetry supports ~30 strokes/sec; label results by profile.
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

// ─── Acceptance targets (the REQUIREMENTS, checked in handleSummary) ─────────
// These are the numbers the header claims to validate. Thresholds above are the
// looser guardrails; these are the real bar.
const ACCEPT_CONN_SUCCESS = 0.99; // 9.1
const ACCEPT_MSG_LAT_P95_MS = 50;  // 9.2
const ACCEPT_GAME_COMPLETION = 0.80; // 9.3

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
  // THRESHOLDS = engineering GUARDRAILS (warning floor), NOT the acceptance
  // targets. They are deliberately looser than the requirements so exploratory
  // scaling runs fail only on a genuine regression, not on a near-miss. The
  // ACCEPTANCE TARGETS (9.1 >99%, 9.2 <50ms, 9.3 >80%) are checked separately in
  // handleSummary() below and printed as ACCEPTANCE PASS/FAIL, so a green k6 run
  // can never be mistaken for "met the requirement".
  //
  // To run these as HARD acceptance criteria instead, set STRICT=1 (tightens the
  // guardrails to the requirement values).
  thresholds: (function () {
    const strict = __ENV.STRICT === '1';
    return {
      ws_connection_success: [`rate>${strict ? 0.99 : 0.95}`],
      // Per-game completion (host-tracked) is the meaningful success signal.
      game_completion_rate: [`rate>${strict ? 0.80 : 0.70}`],
      player_session_completion_rate: [`rate>${strict ? 0.80 : 0.70}`],
      room_create_rtt: ['p(95)<5000'],
      room_join_rtt: ['p(95)<5000'],
      // 9.2 latency ceiling is the same in both modes — 50ms is the requirement
      // and there's no looser "guardrail" story for latency worth telling.
      message_latency: ['p(95)<50'],
    };
  })(),
};

// ─── Utilities ──────────────────────────────────────────────────────────────

// Label a STROKE_HZ value so results are self-describing and defensible: don't
// call an aggressive 30Hz storm "production-like" unless you've measured that
// real drawers actually emit 30 strokes/sec.
function strokeProfileLabel(hz) {
  if (hz <= 0) return 'connection/session test';
  if (hz <= 5) return 'realistic-ish drawing';
  if (hz <= 15) return 'heavy drawing';
  return 'stress test (fan-out)';
}

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
      // Never discovered the room code -> this joiner can't even attempt a
      // connect. Count it as a room failure (host never published in time) and a
      // failed player connect.
      roomJoinFailures.add(1); recordError('room');
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
  // Explicit initial-connect outcome tracking. We record the per-player
  // success/failure sample EXACTLY once, and only from a definitive event:
  //   OPEN                       -> success (1)
  //   CLOSE/ERROR without OPEN   -> failure (0)
  // Using onerror alone was fragile: an error event racing ahead of a late
  // onopen could poison a genuinely-successful connect. So we split "did we ever
  // open?" (initialConnectSucceeded) from "have we scored it?"
  // (initialConnectOutcomeRecorded).
  let initialConnectOutcomeRecorded = false;
  let initialConnectSucceeded = false;
  let gameStartedCounted = false; // host-only, counts an actual server game-start once
  // Latency probe state: timestamp of our own outstanding toggle_ready, matched
  // to the next player_list we receive. Null when no toggle is in flight, so we
  // never attribute an unrelated player_list broadcast (someone else joining) to
  // our request.
  let pendingReadyAt = null;

  // Open the socket (async, event-loop driven). runConnection wires all handlers
  // and returns immediately; the k6/websockets event loop keeps the VU iteration
  // alive until the socket closes and all timers are cleared.
  function runConnection() {
    const socket = new WebSocket(buildWsUrl());
    let socketOpenedAt = null;   // for connection-duration on this socket
    let socketClosedCounted = false; // guard: count each socket close once

    function sendMsg(msg) {
      try { socket.send(JSON.stringify(msg)); messagesSent.add(1); } catch (e) { recordError('connect'); }
    }

    // Send a toggle_ready and arm the latency probe. The matching player_list
    // (see onmessage) records message_latency and disarms.
    function sendReady() {
      pendingReadyAt = Date.now();
      sendMsg({ type: 'toggle_ready', payload: {} });
    }

    function stopLoops() {
      drawingActive = false; guessingActive = false;
      if (strokeTimer !== null) { clearInterval(strokeTimer); strokeTimer = null; }
      if (guessTimer !== null) { clearInterval(guessTimer); guessTimer = null; }
    }

    function endSession(reason) {
      if (sessionEnded) return;
      sessionEnded = true;
      const completed = reason === 'completed';
      if (completed) { gameCompleted = true; gamesCompleted.add(1); }
      else { gamesAborted.add(1); }
      // Per-PLAYER session outcome (every VU records one sample).
      sessionCompletionRate.add(completed ? 1 : 0);
      // Per-GAME outcome recorded ONCE per room, by the host only, so N players
      // in a room count as a single game — a true game-completion rate.
      if (isHost) { gameCompletionRate.add(completed ? 1 : 0); }
      stopLoops();
      try { socket.close(); } catch (e) { /* ignore */ }
    }

    socket.onopen = function () {
      socketOpenedAt = Date.now();
      // Live-connection accounting: every socket open (including redirect
      // reconnects) increments the lifetime counter. active(t) = opened - closed.
      wsConnectionsOpened.add(1);
      // Record per-PLAYER connection success + open RTT only for the INITIAL
      // connect, not for a redirect reconnect (which would double-count a single
      // player). OPEN is the definitive success signal.
      if (!initialConnectOutcomeRecorded) {
        initialConnectOutcomeRecorded = true;
        initialConnectSucceeded = true;
        connectionSuccess.add(1);
        wsOpenRtt.add(Date.now() - connectStart);
      }
      if (isHost) {
        sendMsg({ type: 'create_room', payload: { name: playerName } });
        setTimeout(function () { if (state === 'connecting') { roomCreateFailures.add(1); recordError('timeout'); endSession('error'); } }, 10000);
      } else {
        sendMsg({ type: 'join_room', payload: { name: playerName, room_code: roomCode } });
        setTimeout(function () { if (state === 'connecting') { roomJoinFailures.add(1); recordError('timeout'); endSession('error'); } }, 10000);
      }
      // Overall session patience timer — game never reached game_over in time.
      setTimeout(function () { if (!gameCompleted) { recordError('timeout'); endSession('aborted'); } }, HOLD_SECONDS * 1000);
    };

    // Both error and close route through the same outcome recorder. We do NOT
    // treat `error` itself as the definitive failure — only "closed/errored
    // WITHOUT ever opening". If this socket already opened (or a sibling attempt
    // did), an error here is a mid-session blip, counted as an error but not a
    // failed initial connect.
    function recordConnectFailureIfNeverOpened() {
      if (!initialConnectOutcomeRecorded && !initialConnectSucceeded) {
        initialConnectOutcomeRecorded = true;
        connectionSuccess.add(0);
      }
    }

    socket.onerror = function (e) {
      connectionFailures.add(1); recordError('connect');
      recordConnectFailureIfNeverOpened();
    };

    socket.onclose = function () {
      // Record this socket's lifetime + count the close, exactly once.
      if (!socketClosedCounted) {
        socketClosedCounted = true;
        wsConnectionsClosed.add(1);
        if (socketOpenedAt !== null) {
          wsConnectionDuration.add(Date.now() - socketOpenedAt);
        }
      }
      // A close before any open is also a definitive initial-connect failure.
      recordConnectFailureIfNeverOpened();
      stopLoops();
    };

    socket.onmessage = function (e) {
      messagesReceived.add(1);
      let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'ping') { sendMsg({ type: 'pong', payload: {} }); return; }
      // Request/response latency probe: the first player_list after OUR
      // toggle_ready is the server's response to that request. Record it and
      // disarm so unrelated player_list broadcasts (other players joining or
      // readying) are not miscounted as our round trip.
      if (msg.type === 'player_list' && pendingReadyAt !== null) {
        messageLatency.add(Date.now() - pendingReadyAt);
        pendingReadyAt = null;
      }
      if (msg.type === 'redirect') {
        // Owning gateway is elsewhere — pin and reconnect (bounded).
        if (msg.payload && msg.payload.gateway_id && redirectAttempts < 3) {
          redirectGw = msg.payload.gateway_id;
          redirectAttempts++;
          redirectsFollowed.add(1);
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
        setTimeout(function () { if (state === 'lobby' || state === 'waiting_start') { recordError('timeout'); endSession('aborted'); } }, 60000);
      } else if (msg.type === 'room_joined') {
        roomJoinRtt.add(Date.now() - connectStart); roomsJoined.add(1);
        roomCode = msg.payload.room_code; playerId = msg.payload.player_id;
        state = 'lobby';
        setTimeout(function () { if (state === 'lobby') sendReady(); }, Math.floor(randomBetween(1000, 2000)));
        setTimeout(function () { if (state === 'lobby' || state === 'waiting_start') { recordError('timeout'); endSession('aborted'); } }, 60000);
      } else if (msg.type === 'error') { recordError('protocol'); endSession('error'); }
    }

    function handleLobby(msg) {
      if (msg.type === 'player_list' && msg.payload) {
        const count = msg.payload.players.length;
        // Arm the start sequence ONCE when the minimum is present, then wait a
        // grace window for the rest of the roster to arrive before starting.
        if (isHost && !startArmed && count >= MIN_PLAYERS_TO_START) {
          startArmed = true;
          sendMsg({ type: 'update_settings', payload: { num_rounds: NUM_ROUNDS, turn_duration: TURN_DURATION, max_players: PLAYERS_PER_ROOM } });
          sendReady();
          setTimeout(function () {
            if (state !== 'lobby') return;
            sendMsg({ type: 'start_game', payload: {} });
            gameStartRequests.add(1); // request sent (not yet confirmed by server)
            state = 'waiting_start';
          }, START_GRACE_MS);
        }
      } else if (isGameStartSignal(msg.type)) {
        markGameStarted(msg.type); state = 'playing'; handlePlaying(msg);
      } else if (msg.type === 'game_over') { endSession('completed'); }
    }

    // Any of these means the game is underway from the CLIENT's point of view,
    // so we transition to 'playing' and recover state even if we missed the
    // literal game_started (dropped/reordered under load). But only the literal
    // game_started increments games_started (see markGameStarted), so that
    // metric means exactly "server emitted game_started", not "we inferred it".
    function isGameStartSignal(type) {
      return type === 'game_started' || type === 'turn_started' ||
             type === 'word_choices' || type === 'drawer_selecting';
    }

    // Count an ACTUAL server-confirmed game start once per room (host only).
    // STRICT: only the literal `game_started` message counts. The other signals
    // drive the state transition (resilience) but must not inflate games_started
    // when we never actually received game_started.
    function markGameStarted(type) {
      if (type !== 'game_started') return;
      if (isHost && !gameStartedCounted) { gameStartedCounted = true; gamesStarted.add(1); }
    }

    function handleWaitingStart(msg) {
      if (isGameStartSignal(msg.type)) {
        markGameStarted(msg.type); state = 'playing'; handlePlaying(msg);
      } else if (msg.type === 'game_over') { endSession('completed'); }
      else if (msg.type === 'error') { recordError('protocol'); endSession('error'); }
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
        case 'game_ended_insufficient_players': recordError('game'); endSession('aborted'); break;
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
  // Use ceil so the reported room count matches the actual per-VU room
  // assignment (getRoomIndex/totalRooms both ceil). A non-divisible VU count
  // otherwise mis-reports here (e.g. 1001/5 = 200.2 vs the real 201 rooms).
  const rooms = Math.max(1, Math.ceil(TARGET_VUS / PLAYERS_PER_ROOM));
  console.log(`Load test: ${TARGET_VUS} VUs → ${rooms} rooms × ${PLAYERS_PER_ROOM} players`);
  console.log(`Game: ${NUM_ROUNDS} rounds, ${TURN_DURATION}s turns, hold=${HOLD_SECONDS}s`);
  if (STROKE_HZ > 0) {
    const fanoutPerSec = rooms * STROKE_HZ * (PLAYERS_PER_ROOM - 1);
    console.log(`Stroke ${STROKE_HZ}Hz [${strokeProfileLabel(STROKE_HZ)}]: ${STROKE_HZ} strokes/s/drawer × ${STROKE_POINTS} pts → ~${fanoutPerSec} broadcast writes/s at gateway (peak, all rooms drawing)`);
  } else {
    console.log('Stroke 0Hz [connection/session test]: drawing disabled');
  }
  return {};
}

export function teardown() { console.log('Load test complete.'); }

// handleSummary appends an ACCEPTANCE report that checks the actual requirement
// values (99% / 50ms / 80%), independent of the looser guardrail thresholds. A
// green k6 run (guardrails passed) can still show ACCEPTANCE: FAIL here, so we
// never claim to "validate >99%" while only enforcing >95%.
export function handleSummary(data) {
  const m = data.metrics;
  const rate = (name) => (m[name] && m[name].values ? m[name].values.rate : undefined);
  const p95 = (name) => (m[name] && m[name].values ? m[name].values['p(95)'] : undefined);

  const checks = [
    { id: '9.1 connection success', got: rate('ws_connection_success'), target: ACCEPT_CONN_SUCCESS, cmp: 'gte', fmt: (v) => `${(v * 100).toFixed(2)}%`, targetFmt: `>=${(ACCEPT_CONN_SUCCESS * 100).toFixed(0)}%` },
    { id: '9.2 message latency p95', got: p95('message_latency'), target: ACCEPT_MSG_LAT_P95_MS, cmp: 'lte', fmt: (v) => `${v.toFixed(1)}ms`, targetFmt: `<=${ACCEPT_MSG_LAT_P95_MS}ms` },
    { id: '9.3 game completion', got: rate('game_completion_rate'), target: ACCEPT_GAME_COMPLETION, cmp: 'gte', fmt: (v) => `${(v * 100).toFixed(2)}%`, targetFmt: `>=${(ACCEPT_GAME_COMPLETION * 100).toFixed(0)}%` },
  ];

  let allPass = true;
  const lines = ['', '════ ACCEPTANCE (requirements, not guardrails) ════'];
  for (const c of checks) {
    let pass;
    if (c.got === undefined) { pass = false; }
    else if (c.cmp === 'gte') { pass = c.got >= c.target; }
    else { pass = c.got <= c.target; }
    allPass = allPass && pass;
    const gotStr = c.got === undefined ? 'no data' : c.fmt(c.got);
    lines.push(`  [${pass ? 'PASS' : 'FAIL'}] ${c.id}: ${gotStr} (target ${c.targetFmt})`);
  }
  lines.push(`  ── OVERALL ACCEPTANCE: ${allPass ? 'PASS' : 'FAIL'} ──`);
  lines.push('  (thresholds above are looser guardrails; run with STRICT=1 to enforce these as hard thresholds)');
  lines.push('');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + lines.join('\n'),
  };
}
