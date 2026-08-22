# Implementation Plan: Direct Worker Routing

## Overview

Eliminate nginx from the WebSocket path by implementing Redis-based service discovery. The Go gateway resolves worker container addresses from Redis and dials them directly. Ordered for incremental development — each task is independently testable.

## Tasks

- [x] 1. Implement worker address registration functions in `backend/redis_pubsub.py`: add `register_worker_address(hostname, port)` that stores `{WORKER_ID: "hostname:port"}` in Redis hash `worker_addresses` and sets `worker_alive:{WORKER_ID}` with 30s TTL; add `unregister_worker_address()` that removes both entries; modify `report_worker_load()` to also refresh address and liveness key in the same heartbeat cycle. Call `register_worker_address()` on startup in `backend/main.py` lifespan using `os.environ.get("HOSTNAME", "localhost")` and `unregister_worker_address()` on shutdown before `shutdown_redis()`. Verify with `python -m pytest backend/tests/ -v`. Requirements: 1.1, 1.2, 1.3, 1.5, 7.1, 7.2, 7.3, 7.4.

- [x] 2. Implement worker liveness and graceful shutdown verification: ensure the periodic load reporter (every 10s) refreshes the liveness key; verify `worker_alive:{WORKER_ID}` has 30s TTL after startup; test that stopping a worker via SIGTERM removes its entry from `worker_addresses` and deletes `worker_alive`; test crash scenario (kill -9) and verify `worker_alive` expires after 30s. Requirements: 1.4, 5.1, 5.4.

- [x] 3. Create `gateway/resolver.go` with `WorkerResolver` struct: implement `Resolve(ctx, workerID) (string, error)` with 5s cache TTL (check local `sync.Map` cache first, fetch from Redis `worker_addresses` hash on miss/stale); implement `IsAlive(ctx, workerID) (bool, error)` that checks `EXISTS worker_alive:{workerID}`; implement `Evict(workerID)` to remove from local cache; implement `StartCleanup(ctx)` background goroutine that prunes stale entries every 10s. Initialize in `main()` with Redis client and 5s TTL. Build with `go build -o gateway.exe .`. Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6.

- [x] 4. Replace `workerIDToAddr()` with resolver-based address resolution: change the function body to call `gw.resolver.Resolve(ctx, workerID)` instead of returning `gw.backends[0]`; add `resolver *WorkerResolver` field to `Gateway` struct; update `routeConnection()` to use resolved addresses for both `create_room` (least-loaded) and `join_room` (room owner) paths; keep `gw.backends` as fallback for round-robin when Redis is unavailable. Build and run `python gateway/test_proxy.py` smoke test. Requirements: 3.1, 3.2, 3.3, 9.1, 9.2, 9.3, 9.4.

- [x] 5. Implement `dialWithFallback()` in gateway: resolve target worker address, check liveness, dial with 5s timeout; on failure evict from cache and try least-loaded alternative worker; limit to max 2 attempts (primary + 1 fallback) with no duplicate worker IDs; on final failure return `BACKEND_UNAVAILABLE` error; log each failure with worker_id and address; replace the current retry loop in `HandleWebSocket()` with this function. Build and verify. Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 3.5.

- [x] 6. Update Docker Compose for direct networking: add named network `skribbl-net` to `docker-compose.yml`; add `networks: [skribbl-net]` to all services; add gateway service with `build: ./gateway`, port 9000, `REDIS_URL` env var; ensure `app` service only uses `expose: ["8000"]` (no host port mapping); create `nginx-static.conf` serving only static frontend assets; update nginx volume to use `nginx-static.conf`; test with `docker compose up --build --scale app=3` and verify gateway reaches workers by hostname. Requirements: 6.1, 6.2, 6.3, 6.4, 6.5.

- [ ] 7. Integration test — direct routing end-to-end: start stack with `--scale app=12`; verify `redis-cli HGETALL worker_addresses` shows 12 entries; verify `redis-cli KEYS worker_alive:*` shows 12 keys; run smoke test through gateway; run k6 at 1000 VUs for 100% success + <500ms room latency p95; run k6 at 5000 VUs targeting >95% success + <100ms dial time median; check gateway logs for no `DIAL_FAILED` entries; verify nginx logs show no WebSocket upgrades. Requirements: 3.4, 8.1, 8.2, 8.3, 8.4, 8.5.

- [ ] 8. Fallback and liveness integration test: start with 3 workers, create a room, kill the owning worker; wait 30s then join — verify gateway falls back; verify gateway logs show `DIAL_FAILED` for dead worker + `DIAL_OK` for fallback; verify `worker_addresses` no longer shows dead worker after 30s; stop Redis and verify gateway uses round-robin fallback; restart Redis and verify Redis-based routing resumes. Requirements: 4.1, 4.2, 5.2, 5.3, 9.1.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "tasks": [1, 3],
      "description": "Foundation — Python registration + Go resolver (parallel)"
    },
    {
      "tasks": [2, 4],
      "description": "Verification + wiring — liveness tests + replace workerIDToAddr"
    },
    {
      "tasks": [5, 6],
      "description": "Routing + infra — dialWithFallback + Docker networking"
    },
    {
      "tasks": [7, 8],
      "description": "Validation — integration tests + fallback tests"
    }
  ]
}
```

## Notes

- Tasks 1-2 (Python) and Tasks 3-5 (Go) can be developed in parallel
- Task 6 (Docker) should be done before integration tests but can overlap with 3-5
- Each task produces a buildable/testable artifact — no task leaves the system in a broken state
- The gateway `--backends` flag is kept as a fallback even after direct routing is implemented
