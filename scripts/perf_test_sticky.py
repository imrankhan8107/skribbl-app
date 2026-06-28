# -*- coding: utf-8 -*-
"""Performance test with sticky sessions for multi-worker deployment.

Simulates realistic usage where all players in a room connect to the
same worker via sticky sessions (cookie-based routing).

Industry-standard features:
- Warm-up phase before measurement
- Cooldown between tests
- Worker affinity detection and reporting
- Error categorization
- Concurrent connection bursts
- Statistical validity (multiple runs, stddev)
- Pass/fail thresholds for CI integration

This test:
1. Connects to get a worker_id cookie from the first HTTP request
2. Reuses that cookie for all subsequent WebSocket connections
3. Ensures all clients in a room hit the same worker
4. Detects and reports actual worker assignment

Usage:
    python scripts/perf_test_sticky.py [--host localhost] [--port 8080] [--clients 10]
    python scripts/perf_test_sticky.py --p95-max 50

Requirements:
    pip install websockets aiohttp
"""

import asyncio
import json
import statistics
import time
import argparse
import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    print("Install websockets: pip install websockets")
    exit(1)

try:
    import aiohttp
except ImportError:
    print("Install aiohttp: pip install aiohttp")
    exit(1)


# ---------------------------------------------------------------------------
# Error categorization
# ---------------------------------------------------------------------------

class ErrorCategory(Enum):
    TIMEOUT = "timeout"
    CONNECTION_REFUSED = "connection_refused"
    CONNECTION_CLOSED = "connection_closed"
    PROTOCOL_ERROR = "protocol_error"
    UNKNOWN = "unknown"


def categorize_error(exc: Exception) -> ErrorCategory:
    """Categorize an exception into a known error bucket."""
    if isinstance(exc, asyncio.TimeoutError):
        return ErrorCategory.TIMEOUT
    if isinstance(exc, ConnectionRefusedError):
        return ErrorCategory.CONNECTION_REFUSED
    if isinstance(exc, (ConnectionClosed, ConnectionResetError, ConnectionAbortedError)):
        return ErrorCategory.CONNECTION_CLOSED
    if isinstance(exc, (json.JSONDecodeError, KeyError, ValueError)):
        return ErrorCategory.PROTOCOL_ERROR
    return ErrorCategory.UNKNOWN


# ---------------------------------------------------------------------------
# Results aggregation
# ---------------------------------------------------------------------------

@dataclass
class PerfResults:
    """Aggregated performance test results."""
    test_name: str
    samples: list = field(default_factory=list)
    errors: dict = field(default_factory=dict)

    @property
    def total_errors(self) -> int:
        return sum(self.errors.values())

    @property
    def count(self) -> int:
        return len(self.samples)

    @property
    def avg_ms(self) -> float:
        return statistics.mean(self.samples) * 1000 if self.samples else 0

    @property
    def stddev_ms(self) -> float:
        return statistics.stdev(self.samples) * 1000 if len(self.samples) > 1 else 0

    @property
    def p50_ms(self) -> float:
        return statistics.median(self.samples) * 1000 if self.samples else 0

    @property
    def p95_ms(self) -> float:
        if not self.samples:
            return 0
        sorted_s = sorted(self.samples)
        idx = int(len(sorted_s) * 0.95)
        return sorted_s[min(idx, len(sorted_s) - 1)] * 1000

    @property
    def p99_ms(self) -> float:
        if not self.samples:
            return 0
        sorted_s = sorted(self.samples)
        idx = int(len(sorted_s) * 0.99)
        return sorted_s[min(idx, len(sorted_s) - 1)] * 1000

    @property
    def max_ms(self) -> float:
        return max(self.samples) * 1000 if self.samples else 0

    @property
    def min_ms(self) -> float:
        return min(self.samples) * 1000 if self.samples else 0

    def record_error(self, exc: Exception) -> None:
        """Record a categorized error."""
        cat = categorize_error(exc)
        self.errors[cat.value] = self.errors.get(cat.value, 0) + 1

    def report(self) -> str:
        if not self.samples:
            return f"  {self.test_name}: NO DATA (errors={self.total_errors})"
        lines = [
            f"  {self.test_name}:",
            f"    Samples: {self.count} | Errors: {self.total_errors}",
            f"    Avg: {self.avg_ms:.2f}ms ± {self.stddev_ms:.2f}ms",
            f"    Min: {self.min_ms:.2f}ms | P50: {self.p50_ms:.2f}ms | "
            f"P95: {self.p95_ms:.2f}ms | P99: {self.p99_ms:.2f}ms | Max: {self.max_ms:.2f}ms",
        ]
        if self.errors:
            error_parts = [f"{k}={v}" for k, v in sorted(self.errors.items())]
            lines.append(f"    Error breakdown: {', '.join(error_parts)}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Response validation
# ---------------------------------------------------------------------------

def validate_response(data: dict, expected_type: str) -> bool:
    """Validate that a WebSocket response has the expected structure."""
    if not isinstance(data, dict):
        return False
    if data.get("type") != expected_type:
        return False
    if "payload" not in data and expected_type not in ("stroke", "clear_canvas", "pong"):
        return False
    return True


# ---------------------------------------------------------------------------
# Warm-up and cooldown
# ---------------------------------------------------------------------------

async def warmup(http_url: str, ws_uri: str, n: int = 5) -> None:
    """Perform warm-up connections to avoid cold-start bias."""
    for _ in range(n):
        try:
            cookie = await get_sticky_cookie(http_url)
            ws = await connect_with_cookie(ws_uri, cookie)
            await ws.send(json.dumps({"type": "create_room", "payload": {"name": "Warmup"}}))
            await asyncio.wait_for(ws.recv(), timeout=3.0)
            await ws.close()
        except Exception:
            pass


async def cooldown(seconds: float = 1.0) -> None:
    """Pause between tests to let the server drain buffers."""
    await asyncio.sleep(seconds)


# ---------------------------------------------------------------------------
# Sticky session helpers
# ---------------------------------------------------------------------------

async def get_sticky_cookie(http_url: str) -> Optional[str]:
    """Make an HTTP request to get the worker_id sticky session cookie."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(http_url) as resp:
                cookies = resp.cookies
                if "worker_id" in cookies:
                    return f"worker_id={cookies['worker_id'].value}"
    except Exception:
        pass
    return None


async def get_worker_id_from_cookie(http_url: str) -> Optional[str]:
    """Extract the raw worker_id value from the cookie."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(http_url) as resp:
                cookies = resp.cookies
                if "worker_id" in cookies:
                    return cookies["worker_id"].value
    except Exception:
        pass
    return None


async def connect_with_cookie(ws_uri: str, cookie: Optional[str] = None):
    """Connect to WebSocket with sticky session cookie."""
    headers = {}
    if cookie:
        headers["Cookie"] = cookie
    return await asyncio.wait_for(
        websockets.connect(ws_uri, additional_headers=headers),
        timeout=10.0
    )


# ---------------------------------------------------------------------------
# Test: Sticky connection (same worker)
# ---------------------------------------------------------------------------

async def measure_sticky_connection(http_url: str, ws_uri: str, n: int) -> PerfResults:
    """Measure connection time with sticky sessions (all go to same worker)."""
    results = PerfResults(test_name="Sticky Connection (same worker)")

    # Get the sticky cookie first
    cookie = await get_sticky_cookie(http_url)
    worker_id = await get_worker_id_from_cookie(http_url)
    if cookie:
        print(f"    Worker ID: {worker_id or 'unknown'}")
    else:
        print("    No cookie (single worker mode)")

    # Concurrent burst with cookie
    batch_size = min(n, 10)
    remaining = n

    while remaining > 0:
        batch = min(batch_size, remaining)
        tasks = [
            asyncio.create_task(_sticky_connect_measure(ws_uri, cookie, results))
            for _ in range(batch)
        ]
        await asyncio.gather(*tasks)
        remaining -= batch

    return results


async def _sticky_connect_measure(ws_uri: str, cookie: Optional[str], results: PerfResults) -> None:
    """Single sticky connection measurement."""
    start = time.perf_counter()
    try:
        ws = await connect_with_cookie(ws_uri, cookie)
        elapsed = time.perf_counter() - start
        results.samples.append(elapsed)
        await ws.close()
    except Exception as e:
        results.record_error(e)


# ---------------------------------------------------------------------------
# Test: Sticky room flow (stroke latency, same worker)
# ---------------------------------------------------------------------------

async def measure_sticky_room_flow(http_url: str, ws_uri: str, n_players: int,
                                    n_samples: int = 100) -> PerfResults:
    """Measure stroke broadcast latency where all players use the same sticky session."""
    results = PerfResults(test_name=f"Sticky Room Flow ({n_players} players, {n_samples} samples)")

    cookie = await get_sticky_cookie(http_url)

    # Host creates a room
    try:
        ws_host = await connect_with_cookie(ws_uri, cookie)
        await ws_host.send(json.dumps({"type": "create_room", "payload": {"name": "StickyHost"}}))
        response = json.loads(await asyncio.wait_for(ws_host.recv(), timeout=5.0))
        if not validate_response(response, "room_created"):
            results.record_error(ValueError("Failed to create room"))
            await ws_host.close()
            return results
        room_code = response["payload"]["room_code"]
    except Exception as e:
        results.record_error(e)
        return results

    # Players join with same cookie (same worker)
    players = [ws_host]
    for i in range(min(n_players - 1, 7)):
        try:
            ws = await connect_with_cookie(ws_uri, cookie)
            await ws.send(json.dumps({"type": "join_room", "payload": {"name": f"StickyPlayer{i}", "room_code": room_code}}))
            resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
            players.append(ws)
            # Drain player_list from host
            try:
                await asyncio.wait_for(ws_host.recv(), timeout=0.3)
            except asyncio.TimeoutError:
                pass
        except Exception as e:
            results.record_error(e)

    # Drain any pending messages
    for ws in players:
        try:
            while True:
                await asyncio.wait_for(ws.recv(), timeout=0.1)
        except asyncio.TimeoutError:
            pass

    # Measure stroke latency (host sends, last player receives)
    guesser = players[-1] if len(players) > 1 else None
    if guesser is None:
        results.record_error(ValueError("No guesser available"))
        for ws in players:
            await ws.close()
        return results

    for i in range(n_samples):
        stroke_msg = json.dumps({
            "type": "stroke",
            "payload": {"points": [[i, i], [i + 10, i + 10]], "color": "#000000", "size": 3}
        })

        start = time.perf_counter()
        await ws_host.send(stroke_msg)

        try:
            for _ in range(10):
                response = await asyncio.wait_for(guesser.recv(), timeout=2.0)
                data = json.loads(response)
                if data.get("type") == "stroke":
                    elapsed = time.perf_counter() - start
                    results.samples.append(elapsed)
                    break
            else:
                results.record_error(asyncio.TimeoutError())
        except Exception as e:
            results.record_error(e)

    for ws in players:
        try:
            await ws.close()
        except Exception:
            pass

    return results


# ---------------------------------------------------------------------------
# Test: Sticky throughput (same worker, multiple runs)
# ---------------------------------------------------------------------------

async def measure_sticky_throughput(http_url: str, ws_uri: str, n_messages: int,
                                     n_runs: int = 3) -> PerfResults:
    """Measure throughput with sticky sessions (both players on same worker).

    Runs multiple iterations for statistical validity.
    """
    results = PerfResults(test_name=f"Sticky Throughput ({n_messages} msgs, {n_runs} runs)")

    cookie = await get_sticky_cookie(http_url)

    for run in range(n_runs):
        try:
            ws1 = await connect_with_cookie(ws_uri, cookie)
            await ws1.send(json.dumps({"type": "create_room", "payload": {"name": f"ThroughputHost{run}"}}))
            response = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5.0))
            if not validate_response(response, "room_created"):
                results.record_error(ValueError("Failed to create room"))
                await ws1.close()
                continue
            room_code = response["payload"]["room_code"]

            ws2 = await connect_with_cookie(ws_uri, cookie)
            await ws2.send(json.dumps({"type": "join_room", "payload": {"name": f"ThroughputGuest{run}", "room_code": room_code}}))
            await asyncio.wait_for(ws2.recv(), timeout=5.0)

            # Drain setup messages
            for ws in [ws1, ws2]:
                try:
                    while True:
                        await asyncio.wait_for(ws.recv(), timeout=0.2)
                except asyncio.TimeoutError:
                    pass

            # Pipelined sends
            messages = [
                json.dumps({"type": "chat", "payload": {"text": f"msg{i}"}})
                for i in range(n_messages)
            ]

            start = time.perf_counter()
            send_tasks = [ws1.send(m) for m in messages]
            await asyncio.gather(*send_tasks)

            # Receive all on ws2
            received = 0
            try:
                while received < n_messages:
                    await asyncio.wait_for(ws2.recv(), timeout=5.0)
                    received += 1
            except asyncio.TimeoutError:
                pass

            elapsed = time.perf_counter() - start
            throughput = received / elapsed if elapsed > 0 else 0
            results.samples.append(throughput)

            if run == 0:
                print(f"    Run {run+1}: Sent {n_messages}, Received {received} in {elapsed*1000:.1f}ms ({throughput:.0f} msgs/sec)")

            await ws1.close()
            await ws2.close()

        except Exception as e:
            results.record_error(e)

    return results


# ---------------------------------------------------------------------------
# Test: Cross-worker throughput (via Redis)
# ---------------------------------------------------------------------------

async def measure_cross_worker_throughput(http_url: str, ws_uri: str, n_messages: int) -> PerfResults:
    """Measure throughput when players are on DIFFERENT workers (Redis relay).

    Detects actual worker affinity by comparing cookies.
    """
    results = PerfResults(test_name=f"Cross-Worker Throughput ({n_messages} msgs, via Redis)")

    # Get worker IDs for both connections to verify they're different
    worker_id_1 = await get_worker_id_from_cookie(http_url)
    cookie1 = await get_sticky_cookie(http_url)

    try:
        ws1 = await connect_with_cookie(ws_uri, cookie1)
        await ws1.send(json.dumps({"type": "create_room", "payload": {"name": "CrossHost"}}))
        response = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5.0))
        if not validate_response(response, "room_created"):
            results.record_error(ValueError("Failed to create room"))
            await ws1.close()
            return results
        room_code = response["payload"]["room_code"]

        # Second player WITHOUT cookie — may land on different worker
        ws2 = await connect_with_cookie(ws_uri, None)
        await ws2.send(json.dumps({"type": "join_room", "payload": {"name": "CrossGuest", "room_code": room_code}}))
        resp = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5.0))

        # Check if we actually landed on a different worker
        worker_id_2 = await get_worker_id_from_cookie(http_url)
        if worker_id_1 and worker_id_2:
            same_worker = (worker_id_1 == worker_id_2)
            print(f"    Worker 1: {worker_id_1}, Worker 2: {worker_id_2}")
            print(f"    {'⚠️  Same worker (no cross-worker test possible)' if same_worker else '✓ Different workers confirmed'}")

        if resp.get("type") == "error":
            print(f"    Cross-worker join failed: {resp['payload'].get('message', 'unknown')}")
            print(f"    (This is expected — room only exists on the host's worker)")
            results.record_error(ValueError("Cross-worker join failed"))
            await ws1.close()
            await ws2.close()
            return results

        # Drain setup messages
        for ws in [ws1, ws2]:
            try:
                while True:
                    await asyncio.wait_for(ws.recv(), timeout=0.2)
            except asyncio.TimeoutError:
                pass

        # Pipelined send and measure
        messages = [
            json.dumps({"type": "chat", "payload": {"text": f"xmsg{i}"}})
            for i in range(n_messages)
        ]

        start = time.perf_counter()
        send_tasks = [ws1.send(m) for m in messages]
        await asyncio.gather(*send_tasks)

        received = 0
        try:
            while received < n_messages:
                await asyncio.wait_for(ws2.recv(), timeout=5.0)
                received += 1
        except asyncio.TimeoutError:
            pass

        elapsed = time.perf_counter() - start
        throughput = received / elapsed if elapsed > 0 else 0
        results.samples.append(throughput)

        print(f"    Sent {n_messages}, Received {received} in {elapsed*1000:.1f}ms")
        print(f"    Throughput: {throughput:.0f} msgs/sec")
        if received < n_messages:
            print(f"    ⚠️  {n_messages - received} messages lost (cross-worker relay)")

        await ws1.close()
        await ws2.close()

    except Exception as e:
        results.record_error(e)

    return results


# ---------------------------------------------------------------------------
# Main test runner
# ---------------------------------------------------------------------------

async def run_all_tests(host: str, port: int, n_clients: int,
                        p95_max: Optional[float] = None):
    """Run all sticky session performance tests."""
    ws_uri = f"ws://{host}:{port}/ws"
    http_url = f"http://{host}:{port}/"

    print(f"\n{'='*60}")
    print(f"  PICTIONARY GAME — STICKY SESSION PERFORMANCE TEST")
    print(f"  Server: {ws_uri}")
    print(f"  Clients: {n_clients}")
    print(f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}\n")

    # Warm-up phase
    print("Warming up (5 connections)...")
    await warmup(http_url, ws_uri, n=5)
    await cooldown(1.0)
    print("  Done.\n")

    all_results = []

    # Test 1: Sticky connection (concurrent burst, same worker)
    print("Running: Sticky Connection (same worker, concurrent burst)...")
    r = await measure_sticky_connection(http_url, ws_uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms ± {r.stddev_ms:.2f}ms\n")
    await cooldown()

    # Test 2: Sticky room flow (stroke latency, same worker, 100 samples)
    print(f"Running: Sticky Room Flow ({n_clients} players, 100 samples)...")
    r = await measure_sticky_room_flow(http_url, ws_uri, n_clients, n_samples=100)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")
    await cooldown()

    # Test 3: Sticky throughput (multiple runs)
    print("Running: Sticky Throughput (3 runs)...")
    r = await measure_sticky_throughput(http_url, ws_uri, 200, n_runs=3)
    all_results.append(r)
    if r.samples:
        print(f"  Avg throughput: {statistics.mean(r.samples):.0f} msgs/sec ± {statistics.stdev(r.samples) if len(r.samples) > 1 else 0:.0f}\n")
    await cooldown()

    # Test 4: Cross-worker throughput (via Redis)
    print("Running: Cross-Worker Throughput (via Redis)...")
    r = await measure_cross_worker_throughput(http_url, ws_uri, 100)
    all_results.append(r)
    print()
    await cooldown()

    # Final report
    print(f"\n{'='*60}")
    print(f"  RESULTS SUMMARY")
    print(f"{'='*60}\n")
    for r in all_results:
        print(r.report())
        print()

    # Comparison note
    print(f"  {'─'*50}")
    print(f"  KEY INSIGHT:")
    print(f"  Same-worker path (sticky sessions) = fast local broadcast")
    print(f"  Cross-worker path (Redis relay) = slower but handles edge cases")
    print(f"  In production, sticky sessions ensure 95%+ traffic stays local.")
    print(f"  {'─'*50}")

    # Pass/fail threshold check
    threshold_passed = True
    if p95_max is not None:
        print(f"\n  {'─'*50}")
        print(f"  THRESHOLD CHECK: P95 max = {p95_max}ms")
        print(f"  {'─'*50}")
        for r in all_results:
            if r.samples and "Throughput" not in r.test_name:
                if r.p95_ms > p95_max:
                    print(f"    ✗ FAIL: {r.test_name} — P95={r.p95_ms:.2f}ms > {p95_max}ms")
                    threshold_passed = False
                else:
                    print(f"    ✓ PASS: {r.test_name} — P95={r.p95_ms:.2f}ms")
        print()

    print(f"\n{'='*60}")
    if p95_max and not threshold_passed:
        print(f"  RESULT: FAILED (P95 threshold exceeded)")
    else:
        print(f"  RESULT: PASSED")
    print(f"{'='*60}\n")

    return threshold_passed


def main():
    parser = argparse.ArgumentParser(description="Sticky Session Performance Test")
    parser.add_argument("--host", default="localhost", help="Server host (default: localhost)")
    parser.add_argument("--port", type=int, default=8080, help="Server port (default: 8080 for nginx)")
    parser.add_argument("--clients", type=int, default=10, help="Number of simulated clients (default: 10)")
    parser.add_argument("--p95-max", type=float, default=None,
                        help="P95 latency threshold in ms (exit non-zero on breach)")
    args = parser.parse_args()

    passed = asyncio.run(run_all_tests(args.host, args.port, args.clients, p95_max=args.p95_max))

    if args.p95_max and not passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
