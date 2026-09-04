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

## What the load tests actually proved (the part the prior assessment lacked)

Full campaign in `docs/performance-test-report.md`. Single **c5a.4xlarge**
(16 vCPU/32 GB), load driven from an **in-VPC** k6 generator (private IP):

| Workload | Result |
|----------|--------|
| Worst-case **30 Hz storm** | ~3000 concurrent clean; gateway CPU-saturated by 5000 |
| Realistic **~5 Hz** | **~5000–6000 concurrent** (97% @ 5000; knee at 7500 = 73%) |
| **Bottleneck** | **Gateway fan-out CPU, saturating at ~35k msg/s** — independent of arrival pattern, worker count, and how the volume is produced |
| Control plane (connect/create/join) | **Never the limiter** — sub-10ms p95 even at 7500 |

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
cores sat idle**, workers averaged ~25%, and Redis ~1.6%. So the single gateway
process **cannot use more than ~5–6 cores for fan-out** — meaning a bigger box
alone does **not** raise the ceiling. The limit is intra-process, not host
capacity.

| Task | Priority | Notes |
|------|----------|-------|
| **Profile the gateway (pprof) under 7500 load** | 🔴 Now | Confirm *why* fan-out caps at ~5–6 cores. Prime suspect: contention on the single `SessionRegistry` `RWMutex` (`GetByRoom`/`GetByPlayer` on every fan-out, writers on every join/leave). Other candidates: per-room receiver goroutine pace, gRPC recv. **Measure before optimizing** — do not guess. Add `net/http/pprof` if not present (~5 lines). |
| **Shard the SessionRegistry lock (if profile confirms)** | 🔴 Likely | Per-room or striped locks so fan-out scales across all host cores. If confirmed, this is the single-node win that lets one gateway use the whole box. |
| **Horizontal gateways behind an LB** | 🔴 Next | The definitive lever & path to 100K+, and it works regardless of the per-process cap (each instance gets its own ~5–6 core budget). **Non-trivial:** `SessionRegistry` is per-instance, so players of one room on different gateways break fan-out. Requires EITHER (A) room-sticky routing at the LB (~1–2 days) OR (B) Redis cross-gateway broadcast relay reusing existing pub/sub (~3–5 days). |
| ~~Vertical: bigger instance~~ | ⬇️ Downgraded | Measured: the gateway didn't use extra cores on a larger host (556% on a many-core box). A bigger box alone does **not** raise the ceiling; only more effective cores-per-process (lock sharding) or more gateway processes do. |

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

## Corrected verdict

A genuinely strong, well-architected real-time system. Load testing validated it
end-to-end and pinned a **single, clear bottleneck: gateway fan-out CPU
(~35k msg/s → ~5–6k concurrent players/node at realistic load)**, with the control
plane and workers having ample headroom. The correct next steps are (1) raise
fan-out capacity — bigger gateway instance now, horizontal gateways next (harder
than it looks because `SessionRegistry` is per-instance) — and (2) cheap hardening
(alerting, `/ready`/`/live`, Go test coverage, Redis persistence, graceful drain).
Service discovery, HPA, Redis Cluster, and coalescing/compression are **eventual**
items, not current limiters, and should not be front-loaded.

### Corrections applied vs the prior version
1. "Transparent proxy" → it's a connection-terminating gRPC multiplexer; WS proxy is fallback-only.
2. "No Go unit tests" → `session_test.go` exists and passes; the real issue is thin coverage of the other components.
3. "SessionRegistry shares state via Redis" → it is per-instance in-memory; multi-gateway needs sticky routing or a Redis relay.
4. Test counts updated (267 backend).
5. Scaling reprioritized to the measured bottleneck (gateway fan-out CPU) over generic best-practices ordering; coalescing/compression repriced down for realistic load.
