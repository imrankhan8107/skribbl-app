# Apache JMeter Performance Testing for Skribbl App

Production-grade performance test suite covering WebSocket game flows, HTTP health/assets, spike testing, and sustained connection validation.

## Prerequisites

1. **Java 8+** installed (Java 11+ recommended)
2. **Apache JMeter 5.6+** installed — [Download](https://jmeter.apache.org/download_jmeter.cgi)
3. **JMeter WebSocket Samplers plugin** installed:
   - Open JMeter → Options → Plugins Manager → Available Plugins
   - Search for **"WebSocket Samplers by Peter Doornbosch"**
   - Install and restart JMeter
   - Or manually download from: https://bitbucket.org/pjtr/jmeter-websocket-samplers/downloads/
4. JMeter accessible via one of:
   - `JMETER_HOME` environment variable set to your installation folder, OR
   - JMeter's `bin` folder added to your system `PATH` (so `jmeter` command works directly)
   ```cmd
   REM Option A: environment variable
   SET JMETER_HOME=C:\apache-jmeter-5.6.3
   
   REM Option B: add to PATH (already done if 'jmeter --version' works)
   ```
5. Your Skribbl app running and accessible (local or deployed)

## Test Plans

| File | Description |
|------|-------------|
| `skribbl_websocket_test.jmx` | WebSocket load test: room creation, join (shared codes), chat, drawing, guessing, reactions, heartbeat, spike |
| `skribbl_e2e_game_flow.jmx` | **Full E2E game lifecycle**: create → join → start → word selection → draw → guess → turn end → game over → rematch |
| `skribbl_http_health.jmx` | HTTP load test: health endpoint, frontend SPA serving, static assets, cache validation, error handling |
| `run_test.bat` | Automated runner with named profiles (smoke/load/stress/spike) and test types (ws/http/e2e/all) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              WebSocket Load Test Structure                    │
├─────────────────────────────────────────────────────────────┤
│  setUp TG ──► Creates rooms, shares codes via props          │
│       │                                                      │
│       ▼                                                      │
│  TG1 (Creators) ──► Full room lifecycle (no game state)      │
│  TG2 (Joiners)  ──► Consumes room codes, lobby actions       │
│  TG3 (Sustained)──► Long-lived heartbeat connections         │
│  TG4 (Spike)    ──► Mid-test burst (50% mark)                │
│       │                                                      │
│       ▼                                                      │
│  tearDown TG ──► Cleans up shared state                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              E2E Game Flow Test Structure                     │
├─────────────────────────────────────────────────────────────┤
│  TG1 (Hosts) ──► Create room → configure → wait for joins   │
│       │          → start_game → play turns (draw/guess)      │
│       │          → game_over → rematch                       │
│       │                                                      │
│       ▼  (room codes shared via JMeter properties)           │
│                                                              │
│  TG2 (Joiners) ──► Join room → wait game_started            │
│       │            → play turns (drawer or guesser role)     │
│       │            → game_over → receive rematch             │
│       │                                                      │
│       ▼                                                      │
│  tearDown TG ──► Cleanup properties                          │
│                                                              │
│  Coordination: Hosts poll for joiner count before starting.  │
│  Joiners signal arrival via synchronized property increment. │
│  Each player handles BOTH drawer and guesser roles based on  │
│  what messages the server sends (word_choices = drawer).     │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Patterns

- **setUp/tearDown Thread Groups** for proper test lifecycle
- **Shared room codes** via JMeter properties (setUp creates rooms, TG2 joins them)
- **If Controllers** for error recovery (skip remaining steps on failure)
- **Transaction Controllers** for accurate composite response times
- **Constant Throughput Timers** for rate-based pacing
- **Duration Assertions** on WebSocket handshake and HTTP responses
- **Gaussian Random Timers** for realistic think-time distribution
- **Spike Thread Group** fires at 50% duration mark with 3s ramp (stress test)

## Quick Start

### Smoke Test (quick validation)
```cmd
run_test.bat --profile smoke
```

### E2E Game Flow (full game lifecycle)
```cmd
run_test.bat --profile smoke --test e2e
```

### Standard Load Test
```cmd
run_test.bat --profile load
```

### Full Suite (WebSocket + E2E + HTTP)
```cmd
run_test.bat --profile load --test all
```

### Against Deployed Environment
```cmd
run_test.bat --host myapp.azurecontainerapps.io --port 443 --profile stress --test all
```

## Test Profiles

| Profile | Rooms | Players/Room | Sustained | Duration | Use Case |
|---------|-------|--------------|-----------|----------|----------|
| `smoke` | 2 | 2 | 5 | 30s | CI/CD gate, sanity check |
| `load` | 10 | 4 | 20 | 180s | Standard capacity validation |
| `stress` | 25 | 6 | 50 | 300s | Find breaking point |
| `spike` | 50 | 4 | 30 | 60s | Sudden traffic burst handling |
| `soak` | 20 | 5 | 20 | 3600s (1hr) | Memory leak / endurance detection |

## Running Manually

### GUI Mode (for debugging/developing tests)
```cmd
%JMETER_HOME%\bin\jmeter.bat -t jmeter\skribbl_websocket_test.jmx
```

### Non-GUI Mode (for actual load testing)
```cmd
%JMETER_HOME%\bin\jmeter.bat -n ^
    -t jmeter\skribbl_websocket_test.jmx ^
    -JHOST=localhost ^
    -JPORT=8000 ^
    -JROOMS=10 ^
    -JPLAYERS_PER_ROOM=4 ^
    -JRAMP_UP=30 ^
    -JDURATION=180 ^
    -JSUSTAINED_THREADS=20 ^
    -l jmeter\results\result.jtl ^
    -e -o jmeter\results\report
```

## Parameters

### WebSocket Test (`skribbl_websocket_test.jmx`)

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `localhost` | Server hostname |
| `PORT` | `8000` | Server port |
| `WS_PATH` | `/ws` | WebSocket endpoint path |
| `PROTOCOL` | `ws` | Protocol (`ws` or `wss`) |
| `ROOMS` | `10` | Number of rooms to create |
| `PLAYERS_PER_ROOM` | `4` | Joiners per room |
| `RAMP_UP` | `30` | Ramp-up period (seconds) |
| `DURATION` | `180` | Test duration (seconds) |
| `SUSTAINED_THREADS` | `20` | Long-lived connection count |
| `CONNECT_TIMEOUT` | `5000` | WebSocket connect timeout (ms) |
| `READ_TIMEOUT` | `10000` | WebSocket read timeout (ms) |

### HTTP Test (`skribbl_http_health.jmx`)

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `localhost` | Server hostname |
| `PORT` | `8000` | Server port |
| `PROTOCOL` | `http` | Protocol (`http` or `https`) |
| `THREADS` | `100` | Concurrent virtual users |
| `RAMP_UP` | `10` | Ramp-up period (seconds) |
| `DURATION` | `120` | Test duration (seconds) |
| `TARGET_RPS` | `500` | Target requests per second (shared across threads) |

### E2E Game Flow Test (`skribbl_e2e_game_flow.jmx`)

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `localhost` | Server hostname |
| `PORT` | `8000` | Server port |
| `WS_PATH` | `/ws` | WebSocket endpoint path |
| `GAME_SESSIONS` | `5` | Number of concurrent game rooms |
| `PLAYERS_PER_GAME` | `3` | Players per room (1 host + N-1 joiners) |
| `NUM_ROUNDS` | `2` | Rounds per game |
| `TURN_DURATION` | `30` | Turn duration in seconds (server config) |
| `CONNECT_TIMEOUT` | `5000` | WebSocket connect timeout (ms) |
| `READ_TIMEOUT` | `10000` | Standard read timeout (ms) |
| `GAME_READ_TIMEOUT` | `20000` | Extended timeout for game state transitions (ms) |

## Test Scenarios Covered

### E2E Game Flow Test (Full Lifecycle)

| Scenario | What It Tests |
|----------|---------------|
| **Room Create + Join** | Host creates room, joiners connect and join using shared room code |
| **Settings Configuration** | Host updates `num_rounds`, `turn_duration` before starting |
| **Game Start** | Host calls `start_game` after all players join → `game_started` broadcast |
| **Word Selection** | Drawer receives `word_choices`, sends `select_word` → `turn_started` broadcast |
| **Drawing (Drawer Role)** | Drawer sends `stroke` messages at realistic pace during turn |
| **Guessing (Guesser Role)** | Guessers send `guess` messages, receive `chat_message` (wrong) or `guess_correct` |
| **Turn Rotation** | All players handle both drawer and guesser roles across turns |
| **Hint Updates** | Server sends `hint_update` at 40% and 70% of turn duration |
| **Turn End** | `turn_ended` broadcast with scores when timer expires or all guess correctly |
| **Game Over** | `game_over` with final leaderboard after all rounds complete |
| **Rematch** | Host sends `rematch` → `rematch_started` broadcast to all |
| **Graceful Exit** | All players send `leave_room` and close connections cleanly |

### WebSocket Load Test (Throughput Focus)

| Scenario | What It Tests |
|----------|---------------|
| **Room Creation** | WS handshake time, `create_room` → `room_created` latency |
| **Room Join** | Cross-thread room code sharing, `join_room` → `room_joined` |
| **Settings Update** | Host `update_settings` → `settings_updated` broadcast |
| **Lobby Chat** | `chat` → `chat_message` broadcast latency |
| **Drawing Strokes** | High-frequency `stroke` messages (30-100ms intervals) |
| **Guessing** | `guess` message handling under load |
| **Reactions** | Emoji `reaction` broadcast |
| **Ready Toggle** | `toggle_ready` → `player_list` broadcast |
| **Heartbeat** | Long-lived connections responding to server pings |
| **Spike** | Sudden burst of 5×ROOMS connections with 3s ramp |
| **Graceful Leave** | `leave_room` before close |

### HTTP Test

| Scenario | What It Tests |
|----------|---------------|
| **Health Check** | `/health` response time < 500ms |
| **Frontend Serving** | SPA `index.html` delivery < 2s |
| **Static Assets** | JS/CSS bundles with cache header validation |
| **SPA Fallback** | Client-side routing paths return 200 |
| **Error Handling** | 404s and invalid methods return quickly |

## Interpreting Results

After running with `-e -o`, open the HTML report (`report/index.html`) for:

- **APDEX Score** — Application Performance Index (target: > 0.9)
- **Response Time Percentiles** — P50, P90, P95, P99
- **Throughput** — Messages/second or Requests/second
- **Error Rate** — Should be < 1% for load profile, < 5% for stress
- **Response Time Over Time** — Look for degradation under sustained load
- **Active Threads Over Time** — Verify ramp-up/spike patterns
- **Connect Time** — WebSocket handshake latency distribution

### Error Classification

The E2E test automatically classifies errors into categories (logged at test end in `jmeter.log`):

| Category | Meaning | Counts As Real Error? |
|----------|---------|----------------------|
| **Infrastructure** | Connection refused, timeout, network failure | ✅ Yes |
| **Application** | Server returned error response (ROOM_FULL, etc.) | ✅ Yes |
| **Sampler/Config** | JMeter configuration issue (missing connection) | ⚠️ Test issue |
| **Assertion Mismatch** | Response received but content didn't match expected | ❌ Not a real error |

The **Real Error Rate** (infrastructure + application) is what matters for pass/fail decisions. The JMeter-reported error rate includes assertion mismatches which inflate the number.

### Auto-Stop

The test automatically stops if the **infrastructure error rate** exceeds the threshold (default: 25%). This prevents wasting time when the server is clearly overloaded. Configure via:
```cmd
-JERROR_THRESHOLD_PCT=20
```

### Success Criteria (suggested SLAs)

| Metric | Smoke | Load | Stress |
|--------|-------|------|--------|
| Error rate | 0% | < 1% | < 5% |
| WS Handshake P95 | < 500ms | < 1s | < 3s |
| Chat broadcast P95 | < 200ms | < 500ms | < 2s |
| Health endpoint P99 | < 100ms | < 200ms | < 500ms |
| Stroke latency P95 | < 100ms | < 300ms | < 1s |

## CI/CD Integration

Use the smoke profile as a deployment gate:

```yaml
# GitHub Actions example
- name: Run Performance Smoke Test
  run: |
    jmeter/run_test.bat --profile smoke --test all
  env:
    JMETER_HOME: ${{ env.JMETER_HOME }}
```

For Jenkins or Azure Pipelines, use the JTL output with the Performance Plugin:
```cmd
run_test.bat --profile load --test ws
REM Upload jmeter/results/load_*/ws/results.jtl to your CI dashboard
```

## Tips

- **Always run in non-GUI mode** for accurate results (GUI adds overhead)
- **Start with smoke**, verify it passes, then move to load/stress
- **Monitor server-side metrics** alongside JMeter — CPU, memory, open file descriptors, event loop lag
- **WebSocket plugin note**: The "WebSocket Samplers by Peter Doornbosch" plugin handles WS framing. Don't confuse it with other WS plugins.
- **Spike test timing**: TG4 fires at `DURATION/2` — adjust delay if you want earlier/later bursts
- **Debug mode**: Enable "View Results Tree" listener in GUI mode to inspect individual messages
- **Distributed testing**: For >500 concurrent connections, run JMeter in distributed mode across multiple machines

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Connection refused` | Ensure the app is running on the specified host:port |
| `WebSocket handshake failed` | Check that the WS path is correct (`/ws`) |
| `SETUP_FAILED` room codes | Server may be rejecting connections — check server logs |
| `NO_ROOMS_AVAILABLE` in TG2 | setUp thread group failed — run in GUI with View Results Tree enabled |
| High error rate in spike | Expected behavior — documents the server's burst capacity limit |
| `OutOfMemoryError` in JMeter | Increase heap: set `HEAP=-Xms1g -Xmx4g` in `jmeter.bat` |
