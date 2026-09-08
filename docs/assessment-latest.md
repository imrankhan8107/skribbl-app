# Current Standing Assessment (corrected & load-test-grounded)

> This revision corrects factual errors in the prior assessment and reprioritizes
> the scaling plan against the **measured** EC2 load-test results (see
> `docs/performance-test-report.md`, Addenda 1–5). The architecture praise stands;
> several claims about the code and the scaling priorities did not, and have been
> fixed here.

---

## Architecture & Design: strong

**Strengths (accurate):**

- **Connection-terminating gateway + gRPC multiplexing (NOT a transparent proxy).**
  The primary path terminates client WebSockets in the gateway (`SessionRegistry`
  + per-session `writePump`) and multiplexes each room onto a **single gRPC
  `RoomStream`** to the owning worker (1 stream/room, not 1 per player). The
  bidirectional WS→WS proxy (`handleWebSocketProxy`) exists only as the
  **degraded fallback** path when gRPC is unavailable — not normal operation.
  (The prior assessment described the fallback path as the primary design.)

- **Join-path caching.** `ownerCache` (room→worker), `liveCache` (worker
  liveness), and the least-loaded-worker cache collapse per-connection Redis
  round-trips from 2–3 to ~0 in steady state.

- **Class-aware backpressure.** `FanOutDispatcher` classifies `broadcast_lossy` /
  `targeted_lossy` (strokes) vs must-deliver control; a full client `SendCh`
  drops lossy strokes but **evicts a queued stroke to make room for a control
  message**, so `game_over`/`turn_started` are never dropped. Load-verified:
  `fanout_dropped.control` went from ~5.87M (indiscriminate) to ~42 after this
  fix.

- **Fallback & resilience.** `FallbackHandler` + `MessageBuffer` (500-msg FIFO,
  overflow-drop) + exponential-backoff reconnect in `lifecycle.go`.

- **Observability.** Prometheus + `/health` counters: `grpc_streams_active`,
  `fanout_delivered/dropped{class}`, `send_dropped/queued{type}`,
  `grpc_stream_errors`. These were the instruments that drove the debugging.

**Real concerns:**

- **`SessionRegistry` is per-gateway, in-memory** (`map[string]*PlayerSession`).
  It does **not** share state via Redis. This is the crux that makes multi-gateway
  non-trivial (see Scaling). The prior assessment incorrectly implied state is
  already shared, making HA look nearly free — it is not.
- Worker discovery via a static `-backends` list / Redis registry — fine now,
  needs dynamic discovery for autoscaling.
- Dual worker protocol (gRPC 50051 primary + HTTP 8000 legacy/fallback) — a
  deliberate design, but added operational surface.

---

## Code Quality: good

- Clean module separation: `main.go`, `multiplexer.go`, `fanout.go`,
  `receiver.go`, `lifecycle.go`, `fallback.go`, `buffer.go`, `resolver.go`,
  `stream_manager.go`, `metrics.go`. Atomics for metrics/state; trace logging
  gated behind `TRACE_ENABLED` to keep the hot path allocation-free.
- Python backend is well-structured (async, Redis pub/sub for cross-worker).

**Improvements:** `log.Fatalf` on Redis failure at startup (a retry/backoff would
be more resilient); `multiplexer.go` and `room_manager.py` are large and could be
split.

---

## Testing & Validation

- **Backend: 267 tests** (unit + Hypothesis property-based + gRPC integration) — all passing.
- **Frontend: Vitest component/reducer tests.**
- **Gateway: `session_test.go` exists and passes** — so the prior claim of "no Go
  unit tests" is **incorrect**. However, coverage is **thin**: only the session
  registry is directly unit-tested. `Multiplexer`, `FanOutDispatcher`,
  `FallbackHandler`, `MessageBuffer`, and `lifecycle` reconnection are **not**
  directly unit-tested. That coverage gap is the real, valid risk.

---

## Deployment & Infrastructure

- Docker Compose (Redis + scalable Python workers + Go gateway serving frontend +
  WS on a single origin, port 9000). Terraform for OCI + Azure. Health endpoints.
- `ulimits nofile` set on workers; the gateway container FD limit was measured at
  32768 (fine for the loads tested).

---

## What the load tests actually proved (UPDATED — horizontal gateways + harness fix)

> **Major correction (2026-09-08):** the earlier "~5–6k/node, gateway fan-out is
> a hard wall at ~35k msg/s" conclusion was based on a **single gateway process**
> AND a **flawed k6 harness** that capped completion at ~73% for reasons that had
> nothing to do with the server. Both have been fixed and re-measured. The wall
> was *per-process*, not per-node; horizontal gateways scale past it, and the
> "73% ceiling" was a test artifact.

### The harness ceiling was fake

Completion sat at a suspiciously stable ~72–73% across *every* prior run
regardless of load or gateway count. Root cause: the k6 arrival ramp staggered
**per VU**, smearing a single room's 5 players across the whole ramp, and joiner
sleeps grew proportional to room index (up to +150s at 1500 rooms). Rooms never
assembled their full roster in time and aborted. Fixing the ramp to be **per-room**
(a room's whole roster arrives together) took completion to **100% at 7500** with
higher throughput than any prior run. The server was never the limiter.

### Measured on a single **c5a.8xlarge** (32 vCPU/62 GB), in-VPC k6, 2 balanced gateways behind nginx:

| Workload | Result |
|----------|--------|
| **7500 @ 5 Hz** | **100% completion**, 0 drops, join/create p95 ≤ 8ms, 63.9k msg/s |
| **10000 @ 5 Hz** | **98.5% completion**; small connect-burst stress (116 WS fails, coord-HTTP timeouts); game plane healthy |
| **10000 @ 20 Hz storm, 2 gateways** | 98.5% completion but fan-out SATURATED: ~525M strokes dropped (lossy), 453 control drops, gateways ~900–976% each. The 2-gateway edge. |
| **10000 @ 20 Hz storm, 4 gateways** | **100% completion; lossy drops cut ~99% (525M → 4.6M), control drops 0**, per-gateway CPU halved to ~250–300% avg. Doubling gateways cleared the saturation — near-linear scaling. |
| Control plane (connect/create/join) | Sub-10ms p95 at 7500; degrades to ~270–536ms p95 only during the 10k arrival burst |

### The bottleneck is per-PROCESS fan-out CPU, and it scales horizontally

- A single gateway process caps at **~5.6 cores (~556%)** — the old "wall."
- **Two balanced gateways reached ~1780% combined peak (~18 cores)** at 10k/20Hz
  — **~3.2× the single-process ceiling.** Splitting genuinely parallelizes the
  syscall-bound fan-out across cores, exactly as the pprof profile predicted.
- **Class-aware backpressure works as designed under saturation:** at 10k/20Hz the
  gateways shed 525M lossy strokes (drawings degrade) to keep games running —
  98.5% still completed. Control drops stayed 0 until the very edge (453 at peak),
  the signal that you've pushed one gateway past its individual ceiling.

### Room ownership balances across gateways

`create_room` connections now carry a high-cardinality `?cid` folded into the
nginx consistent-hash, so creators (and thus room ownership) spread across
gateways even from a single k6 source IP. Balance improved from ~1.8× (700/392%)
to ~1.2× (590/458%). Joiners are pinned by `?room`; misroutes self-heal via
`redirect` → `?gw` reconnect.

Key empirical findings that must inform any scaling plan:
- **The join-latency "failures" were the home load generator's network**, not the
  server. In-VPC k6 gave `room_join_rtt` **8.59s → 22ms (~390x)**. The server's
  control plane is not a bottleneck.
- **Worker count did not move the ceiling** (10→12 workers: no change). Redis sat
  at ~9% CPU. So worker/Redis scaling is **not** the current limiter.
- **The single limiter is gateway fan-out CPU (~35k msg/s).** At saturation the
  gateway hit ~562% CPU (≈5.6 of 16 cores) while several workers were idle.
- **Stroke coalescing helps the storm but ~nothing at realistic load** — at 5 Hz,
  strokes arrive slower than any sane flush window, so there's little to batch.

---

## Scaling Plan — reprioritized by the evidence

The prior plan front-loaded service discovery, Kubernetes HPA, and Redis Cluster.
Your data shows **none of those is the current bottleneck.** Reordered:

### Tier 0 — Raise the fan-out ceiling (this is the actual limiter)

**Critical measured fact:** on a large host (24 workers, 62 GB, many cores) at
7500/5 Hz, the **gateway process pegged at ~500–556% CPU (~5–6 cores) while 10+
cores sat idle**, workers averaged ~25%, and Redis ~1.6%. A bigger box alone does
**not** raise the ceiling.

**pprof result (30s CPU profile at 7500/5 Hz) — the cause is SYSCALL/NETWORK I/O, not locks:**
- `internal/runtime/syscall.Syscall6` = **43.5% flat** — raw syscall time dominates.
- `net.(*conn).Write` -> `syscall.write` = **~29% cum** — per-message socket writes (WebSocket fan-out writePump->WriteMessage ~15%, plus gRPC frame writes).
- `syscall.read` ~13%; scheduler churn (findRunnable/schedule/futex) ~25% from juggling thousands of I/O-blocked goroutines.
- `SessionRegistry`/`GetByRoom` **does not appear** — the RWMutex is NOT the bottleneck (lock-sharding theory disproven).
- `FanOutDispatcher.Deliver` 1.8%, `enqueueNonBlocking` 1.3%, JSON unmarshal 5% — fan-out logic and parsing are cheap.

**Conclusion:** the gateway is bound by the rate one process can push **write()
syscalls** for thousands of sockets at ~35k msg/s. Fix by reducing
syscalls-per-message (batching) or parallelizing across processes (horizontal).

| Task | Priority | Notes |
|------|----------|-------|
| **Gateway writePump write-coalescing** | Now | When multiple messages are queued in a session's SendCh, drain and combine them into ONE WriteMessage call. Directly cuts the dominant ~29% write-syscall cost. Pure gateway-side; frame as a batched envelope the frontend can iterate. Highest-leverage single fix. |
| **Stroke coalescing on the worker** | High | Fewer messages generated -> fewer downstream writes. Complements writePump batching. (Earlier rated low based on fan-out *logic* cost; the profile shows the cost is the *syscall per write*, which batching cuts directly — so it IS worthwhile.) |
| **Horizontal gateways behind an LB** | ✅ Path A implemented | Definitive lever & path to 100K+: more processes = more parallel syscall throughput across cores. **Path A (room-sticky routing) is now in place:** each gateway has a stable `GATEWAY_ID`, claims `room_gateway:<CODE>` in Redis on create, and redirects misrouted joiners (`type:"redirect"` → client reconnects with `?gw=<owner>`) so a room's players converge on one gateway and fan-out stays fully in-process. nginx consistent-hashes on `?gw`/`?room`/client-addr; added `/live` + `/ready` probes. Fan-out path unchanged (per-gateway). **Path B (Redis pub/sub relay)** remains an additive follow-on reusing the same `room_gateway` primitive if any-gateway connectivity is ever needed. |
| ~~Shard SessionRegistry lock~~ | Disproven | pprof shows the lock is not in the hot path; the cost is socket write/read syscalls. Do not pursue. |
| ~~Vertical: bigger instance~~ | Downgraded | Gateway didn't use extra cores on a larger host (556% on a many-core box). |

### Tier 1 — Cheap, correct hardening (do now)

| Task | Priority | Notes |
|------|----------|-------|
| **Alerting** | 🔴 Now | `fanout_dropped{class=control} > 0` (must stay 0 — game-breaking), `fanout_dropped{class=lossy}` rate (saturation signal), `grpc_streams_active` vs cap, `grpc_fallback_activations_total`, `send_dropped`, Redis CPU. Metrics already exist. |
| **Gateway `/ready` + `/live` endpoints** | 🟡 High | For LB/k8s probes. `/ready` checks Redis + ≥1 healthy worker. |
| **Structured logging (slog/JSON)** | 🟡 Med | Correlate by room_code/worker_id/player_id. |
| **Gateway startup resilience** | 🟡 Med | Replace `log.Fatalf` on Redis failure with retry/backoff. |

### Tier 2 — Fill the real test gap

| Task | Priority | Notes |
|------|----------|-------|
| **Go unit tests for Multiplexer/FanOut/Fallback/Buffer/lifecycle** | 🟡 High | `session_test.go` exists; extend coverage to the untested core. This is the genuine testing risk (not "zero tests"). |

### Tier 3 — State durability

| Task | Priority | Notes |
|------|----------|-------|
| **Graceful worker drain + room migration** | 🟡 High | In-memory rooms are lost on worker restart; drain on SIGTERM + snapshot to Redis. Needed before worker autoscaling. |
| **Redis persistence (RDB/AOF)** | 🟡 High | Redis is the registry; persist it. |
| **Session TTLs** | 🟡 Med | Auto-cleanup abandoned sessions (120s grace). |

### Tier 4 — Eventual, NOT current bottlenecks (deprioritized vs prior plan)

| Task | Priority | Why deprioritized |
|------|----------|-------------------|
| Worker service discovery (Consul/etcd) | 🟢 Later | Real for autoscaling, but worker count isn't the limiter today. |
| Kubernetes HPA | 🟢 Later | Useful ops, but scaling workers didn't move the ceiling. |
| Redis Cluster | 🟢 Later | Redis at ~9% CPU under load; single instance is fine at current scale. |
| CDN / frontend caching | 🟢 Later | Good for global static delivery; unrelated to the fan-out ceiling. |

### Optimizations — repriced against data

| Task | Prior rating | Corrected | Why |
|------|--------------|-----------|-----|
| Message batching / stroke coalescing | Medium | **Low for realistic load** | Helps the 30 Hz storm (~1.5–3x); **~negligible at realistic 5 Hz** (strokes too sparse to batch). |
| Binary protocol (MessagePack/CBOR) | Medium | **Low–Med** | Cuts encode cost, but the ceiling is msg *count*/fan-out CPU, not payload size; large cross-stack change. |
| WebSocket compression | High | **Low** | CPU-for-bandwidth trade; bandwidth wasn't the limit (fan-out CPU was). Could *worsen* the CPU-bound gateway. |

---

## Corrected verdict (updated 2026-09-08)

A genuinely strong, well-architected real-time system whose scaling story is now
**validated end-to-end**:

- **The old "~5–6k/node hard wall" was a per-PROCESS limit, not per-node.**
  Horizontal gateways (Path A: room-sticky routing) scale past it — 2 balanced
  gateways delivered ~3.2× the single-process fan-out throughput.
- **Realistic 5 Hz load: 100% completion at 7500, 98.5% at 10000** on one
  32-vCPU box with two gateways — with the earlier harness artifact removed.
- **20 Hz storm at 10000 is the real fan-out edge** — gateways saturate (~18
  cores combined), lossy backpressure sheds strokes to protect completion (98.5%),
  and control drops appear only at the very peak.
- **Path A is B-ready:** the `room_gateway` ownership key + gateway registry are
  the exact primitives a future Redis pub/sub relay (Path B) would reuse.

Correct next steps: (1) **more gateway replicas** (now 4 in compose/nginx) and
eventually **gateways on separate instances** for true multi-box scaling; (2)
cheap hardening (alerting on `fanout_dropped.control > 0`, Go test coverage for
the new routing/ownership logic, Redis persistence, graceful drain). Service
discovery, HPA, and Redis Cluster remain eventual, not current, limiters.

### Corrections applied vs the prior version
1. "Transparent proxy" → it's a connection-terminating gRPC multiplexer; WS proxy is fallback-only.
2. "No Go unit tests" → `session_test.go` exists and passes; the real issue is thin coverage of the other components.
3. "SessionRegistry shares state via Redis" → it is per-instance in-memory; multi-gateway needs sticky routing or a Redis relay.
4. Test counts updated (267 backend).
5. Scaling reprioritized to the measured bottleneck (gateway fan-out CPU) over generic best-practices ordering; coalescing/compression repriced down for realistic load.
