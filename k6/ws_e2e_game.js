/**
 * k6 WebSocket E2E Game Load Test — Skribbl App (Standalone)
 *
 * Each VU creates its own room and plays a solo game through the full lifecycle.
 * No coordination server needed — each VU is independent.
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
 * Lifecycle per VU:
 *   Connect → create_room → toggle_ready → start_game → play rounds → game_over
 *
 * Usage:
 *   k6 run k6/ws_e2e_game.js
 *   k6 run --env HOST=localhost --env PORT=8000 --env VUS=100 k6/ws_e2e_game.js
 *   k6 run --env HOST=192.168.0.5 --env PORT=80 --env VUS=500 k6/ws_e2e_game.js
 */

import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import exec from 'k6/execution';

// ─── Custom Metrics ─────────────────────────────────────────────────────────

// Connection metrics
const wsConnectRtt = new Trend('ws_connect_rtt', true);
const connectionSuccess = new Rate('ws_connection_success');
const connectionFailures = new Counter('ws_connection_failures');

// Room lifecycle metrics
const roomCreateRtt = new Trend('room_create_rtt', true);
const roomsCreated = new Counter('rooms_created');
const roomCreateFailures = new Counter('room_create_failures');

// Game lifecycle metrics
const gameStartRtt = new Trend('game_start_rtt', true);
const gamesStarted = new Counter('games_started');
const gamesCompleted = new Counter('games_completed');
const gamesAborted = new Counter('games_aborted');
const gameCompletionRate = new Rate('game_completion_rate');

// Turn/round metrics
const wordSelectionRtt = new Trend('word_selection_rtt', true);
const turnsPlayed = new Counter('turns_played');

// Message metrics
const messagesSent = new Counter('messages_sent');
const messagesReceived = new Counter('messages_received');
const drawingEventsSent = new Counter('drawing_events_sent');
const guessesSent = new Counter('guesses_sent');
const correctGuesses = new Counter('correct_guesses');
const chatMessagesSent = new Counter('chat_messages_sent');

// Broadcast latency
const guessBroadcastRtt = new Trend('guess_broadcast_rtt', true);
const drawBroadcastRtt = new Trend('draw_broadcast_rtt', true);

// Error & disconnect metrics
const disconnects = new Counter('disconnects');
const errorCount = new Counter('errors');
const activeConnections = new Gauge('active_connections');

// ─── Configuration ──────────────────────────────────────────────────────────

const HOST = __ENV.HOST || 'localhost';
const PORT = __ENV.PORT || '8000';
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const TARGET_VUS = parseInt(__ENV.VUS || '50');
const NUM_ROUNDS = parseInt(__ENV.NUM_ROUNDS || '3');
const TURN_DURATION = parseInt(__ENV.TURN_DURATION || '80');
const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || '1');
const HOLD_SECONDS = Math.min(
  NUM_ROUNDS * PLAYERS_PER_ROOM * (TURN_DURATION + 20) + 120,
  parseInt(__ENV.HOLD_TIME || '300')
);

// ─── k6 Options ─────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    game_sessions: {
      executor: 'per-vu-iterations',
      vus: TARGET_VUS,
      iterations: 1,
      maxDuration: '15m',
    },
  },
  thresholds: {
    ws_connect_rtt: ['p(95)<5000', 'p(99)<10000'],
    room_create_rtt: ['p(95)<3000'],
    game_start_rtt: ['p(95)<3000'],
    ws_connection_success: ['rate>0.95'],
    game_completion_rate: ['rate>0.70'],
    errors: ['count<50'],
  },
};

// ─── Word lists for guessing simulation ─────────────────────────────────────

const GUESS_WORDS = [
  'cat', 'dog', 'house', 'tree', 'car', 'sun', 'moon', 'fish',
  'bird', 'boat', 'star', 'flower', 'mountain', 'river', 'cloud',
  'book', 'chair', 'table', 'phone', 'guitar', 'piano', 'clock',
  'bridge', 'castle', 'dragon', 'elephant', 'butterfly', 'rainbow',
  'umbrella', 'bicycle', 'airplane', 'lighthouse', 'snowman', 'pizza',
];

// ─── Utilities ──────────────────────────────────────────────────────────────

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function generateStrokePoints(numPoints) {
  const points = [];
  let x = Math.random() * 800;
  let y = Math.random() * 600;
  const dx = (Math.random() - 0.5) * 4;
  const dy = (Math.random() - 0.5) * 4;

  for (let i = 0; i < numPoints; i++) {
    x += dx + (Math.random() - 0.5) * 2;
    y += dy + (Math.random() - 0.5) * 2;
    x = Math.max(0, Math.min(800, x));
    y = Math.max(0, Math.min(600, y));
    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return points;
}

// ─── Main Test Function ─────────────────────────────────────────────────────

export default function () {
  const vu = exec.vu.idInTest;
  const playerName = `k6_solo_vu${vu}`;

  const connectStart = Date.now();

  const res = ws.connect(WS_URL, { tags: { room: `solo_${vu}`, role: 'solo' } }, function (socket) {
    wsConnectRtt.add(Date.now() - connectStart);
    connectionSuccess.add(1);
    activeConnections.add(1);

    // ══════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════

    let state = 'connecting'; // connecting | lobby | waiting_start | playing | game_over | error
    let roomCode = null;
    let playerId = null;
    let isDrawer = false;
    let currentWord = null;
    let turnActive = false;
    let gameCompleted = false;

    // Timing state
    let roomCreateStart = 0;
    let gameStartTime = 0;
    let wordSelectStart = 0;
    let lastGuessStart = 0;
    let lastStrokeStart = 0;

    // Interval references (controlled via flags)
    let drawingInterval = null;
    let guessingInterval = null;
    let heartbeatInterval = null;

    // Drawing/guessing state
    let strokesRemaining = 0;
    let guessesRemaining = 0;
    let currentTurnDuration = TURN_DURATION;

    // ══════════════════════════════════════════════════════════════════════════
    // FLAGS — Control intervals (k6 doesn't have socket.clearInterval)
    // ══════════════════════════════════════════════════════════════════════════

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

    // ══════════════════════════════════════════════════════════════════════════
    // SOCKET OPEN — Create room immediately
    // ══════════════════════════════════════════════════════════════════════════

    socket.on('open', function () {
      roomCreateStart = Date.now();
      sendMsg({ type: 'create_room', payload: { name: playerName } });

      // Timeout: if no room_created in 10s, fail
      socket.setTimeout(function () {
        if (state === 'connecting') {
          console.log(`[VU${vu}] Timeout waiting for room_created`);
          roomCreateFailures.add(1);
          endSession('error');
        }
      }, 10000);

      // Heartbeat interval
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

        // Solo player: ready up after a short delay, then start game
        socket.setTimeout(function () {
          if (state === 'lobby') {
            sendMsg({ type: 'toggle_ready', payload: {} });

            // Start game after toggling ready
            socket.setTimeout(function () {
              if (state === 'lobby') {
                gameStartTime = Date.now();
                sendMsg({ type: 'start_game', payload: {} });
                gamesStarted.add(1);
                state = 'waiting_start';
              }
            }, Math.floor(randomBetween(1000, 2000)));
          }
        }, Math.floor(randomBetween(500, 1500)));

        // Timeout: if game hasn't started in 30s, abort
        socket.setTimeout(function () {
          if (state === 'lobby' || state === 'waiting_start') {
            console.log(`[VU${vu}] Timeout waiting for game to start`);
            endSession('aborted');
          }
        }, 30000);

      } else if (msg.type === 'error') {
        console.log(`[VU${vu}] Error during connecting: ${JSON.stringify(msg.payload)}`);
        roomCreateFailures.add(1);
        endSession('error');
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE: lobby
    // ══════════════════════════════════════════════════════════════════════════

    function handleLobby(msg) {
      if (msg.type === 'drawer_selecting' || msg.type === 'turn_started') {
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
        console.log(`[VU${vu}] Error in lobby: ${JSON.stringify(msg.payload)}`);
        endSession('error');
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE: waiting_start
    // ══════════════════════════════════════════════════════════════════════════

    function handleWaitingStart(msg) {
      if (msg.type === 'drawer_selecting' || msg.type === 'turn_started') {
        gameStartRtt.add(Date.now() - gameStartTime);
        state = 'playing';
        handlePlaying(msg);
      } else if (msg.type === 'game_over') {
        gameCompleted = true;
        gamesCompleted.add(1);
        gameCompletionRate.add(1);
        endSession('completed');
      } else if (msg.type === 'error') {
        console.log(`[VU${vu}] Error starting game: ${JSON.stringify(msg.payload)}`);
        gameCompletionRate.add(0);
        endSession('error');
      }
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
          // Drawer selects a word after 1-3s think time
          if (isDrawer && msg.payload.choices && msg.payload.choices.length > 0) {
            wordSelectStart = Date.now();
            const choices = msg.payload.choices;
            socket.setTimeout(function () {
              if (state === 'playing') {
                const word = choices[Math.floor(Math.random() * choices.length)];
                sendMsg({ type: 'select_word', payload: { word: word } });
                currentWord = word;
              }
            }, Math.floor(randomBetween(1000, 3000)));
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
          if (lastStrokeStart > 0) {
            drawBroadcastRtt.add(Date.now() - lastStrokeStart);
            lastStrokeStart = 0;
          }
          break;

        case 'chat_message':
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
          guessingActive = false;
          break;

        case 'hint_update':
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
          break;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DRAWING — Periodic stroke simulation via setInterval
    // ══════════════════════════════════════════════════════════════════════════

    function startDrawing(duration) {
      const numStrokes = Math.floor(randomBetween(4, 10));
      const drawingTime = duration * 0.6;
      const strokeIntervalMs = Math.floor((drawingTime / numStrokes) * 1000);
      strokesRemaining = numStrokes;
      drawingActive = true;

      drawingInterval = socket.setInterval(function () {
        if (!drawingActive || !turnActive || state !== 'playing' || strokesRemaining <= 0) {
          drawingActive = false;
          // Occasional fill at end
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

        const numPoints = Math.floor(randomBetween(20, 100));
        const points = generateStrokePoints(numPoints);
        const colors = ['#000000', '#FF0000', '#0000FF', '#00FF00', '#FFFF00'];
        const widths = [2, 4, 6, 8];

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
      const numGuesses = Math.floor(randomBetween(3, 8));
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
      if (!sessionEnded) {
        endSession('aborted');
      }
    }, HOLD_SECONDS * 1000);
  });

  // ── Post-connection check ──

  check(res, {
    'WebSocket handshake succeeded (101)': (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    connectionSuccess.add(0);
    connectionFailures.add(1);
  }
}
