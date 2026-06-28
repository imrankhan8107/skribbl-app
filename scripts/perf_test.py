# -*- coding: utf-8 -*-
"""Performance testing script for the Pictionary Game WebSocket server.

Simulates multiple concurrent WebSocket clients and measures:
- Connection establishment time (concurrent bursts)
- Message round-trip latency
- Room creation/join throughput
- Stroke broadcast latency under load
- Max concurrent connections
- Reconnection latency
- Full game round performance

Industry-standard features:
- Warm-up phase before measurement
- Cooldown between tests
- Concurrent load generation (asyncio.gather)
- Stepped ramp-up mode
- Error categorization (timeout vs connection vs protocol)
- Pass/fail thresholds for CI integration
- Statistical validity (configurable sample sizes)
- JSON response validation

Usage:
    python scripts/perf_test.py [--host localhost] [--port 8000] [--clients 10]
    python scripts/perf_test.py --ramp-up --p95-max 50

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
    errors: dict = field(default_factory=dict)  # ErrorCategory -> count

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
# Warm-up utility
# ---------------------------------------------------------------------------

async def warmup(uri: str, n: int = 5) -> None:
    """Perform warm-up connections to avoid cold-start bias."""
    for _ in range(n):
        try:
            ws = await websockets.connect(uri)
            await ws.send(json.dumps({"type": "create_room", "payload": {"name": "Warmup"}}))
            await asyncio.wait_for(ws.recv(), timeout=3.0)
            await ws.close()
        except Exception:
            pass


async def cooldown(seconds: float = 1.0) -> None:
    """Pause between tests to let the server drain buffers."""
    await asyncio.sleep(seconds)


# ---------------------------------------------------------------------------
# Test: Connection establishment (concurrent burst)
# ---------------------------------------------------------------------------

async def _single_connection(uri: str) -> float:
    """Establish a single connection and return elapsed time."""
    start = time.perf_counter()
    ws = await websockets.connect(uri)
    elapsed = time.perf_counter() - start
    await ws.close()
    return elapsed


async def measure_connection_time(uri: str, n: int) -> PerfResults:
    """Measure WebSocket connection establishment time with concurrent bursts."""
    results = PerfResults(test_name="Connection Establishment (concurrent)")

    # Run in batches of 10 to simulate concurrent bursts
    batch_size = min(n, 10)
    remaining = n

    while remaining > 0:
        batch = min(batch_size, remaining)
        tasks = []
        for _ in range(batch):
            tasks.append(asyncio.create_task(_connect_and_measure(uri, results)))
        await asyncio.gather(*tasks)
        remaining -= batch

    return results


async def _connect_and_measure(uri: str, results: PerfResults) -> None:
    """Connect, measure, close — used for concurrent burst."""
    start = time.perf_counter()
    try:
        ws = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
        elapsed = time.perf_counter() - start
        results.samples.append(elapsed)
        await ws.close()
    except Exception as e:
        results.record_error(e)


# ---------------------------------------------------------------------------
# Test: Room creation RTT
# ---------------------------------------------------------------------------

async def measure_room_creation(uri: str, n: int) -> PerfResults:
    """Measure room creation round-trip time."""
    results = PerfResults(test_name="Room Creation RTT")

    for i in range(n):
        try:
            ws = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            msg = json.dumps({"type": "create_room", "payload": {"name": f"PerfUser{i}"}})

            start = time.perf_counter()
            await ws.send(msg)
            response = await asyncio.wait_for(ws.recv(), timeout=5.0)
            elapsed = time.perf_counter() - start

            data = json.loads(response)
            if validate_response(data, "room_created"):
                results.samples.append(elapsed)
            else:
                results.record_error(ValueError(f"Unexpected response type: {data.get('type')}"))

            await ws.close()
        except Exception as e:
            results.record_error(e)

    return results


# ---------------------------------------------------------------------------
# Test: Join room RTT
# ---------------------------------------------------------------------------

async def measure_join_room(uri: str, n: int) -> PerfResults:
    """Measure join room round-trip time with multiple players joining same room."""
    results = PerfResults(test_name="Join Room RTT")

    try:
        ws_host = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
        await ws_host.send(json.dumps({"type": "create_room", "payload": {"name": "PerfHost"}}))
        response = json.loads(await asyncio.wait_for(ws_host.recv(), timeout=5.0))
        if not validate_response(response, "room_created"):
            results.record_error(ValueError("Failed to create host room"))
            return results
        room_code = response["payload"]["room_code"]
    except Exception as e:
        results.record_error(e)
        return results

    for i in range(min(n, 10)):  # Max 10 joins per room (game limit)
        try:
            ws = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            msg = json.dumps({"type": "join_room", "payload": {"name": f"Joiner{i}", "room_code": room_code}})

            start = time.perf_counter()
            await ws.send(msg)
            response = await asyncio.wait_for(ws.recv(), timeout=5.0)
            elapsed = time.perf_counter() - start

            data = json.loads(response)
            if validate_response(data, "room_joined"):
                results.samples.append(elapsed)
            else:
                results.record_error(ValueError(f"Unexpected response: {data.get('type')}"))

            await ws.close()
        except Exception as e:
            results.record_error(e)

    try:
        await ws_host.close()
    except Exception:
        pass

    return results


# ---------------------------------------------------------------------------
# Test: Stroke broadcast latency
# ---------------------------------------------------------------------------

async def measure_stroke_broadcast_latency(uri: str, n_clients: int, n_samples: int = 100) -> PerfResults:
    """Measure stroke broadcast latency: time from drawer send to guesser receive."""
    results = PerfResults(test_name=f"Stroke Broadcast Latency ({n_clients} clients, {n_samples} samples)")

    # Create room and join clients
    clients = []
    try:
        ws_host = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
        await ws_host.send(json.dumps({"type": "create_room", "payload": {"name": "DrawerHost"}}))
        response = json.loads(await asyncio.wait_for(ws_host.recv(), timeout=5.0))
        if not validate_response(response, "room_created"):
            results.record_error(ValueError("Failed to create room"))
            return results
        room_code = response["payload"]["room_code"]
        clients.append(ws_host)
    except Exception as e:
        results.record_error(e)
        return results

    for i in range(min(n_clients - 1, 7)):
        try:
            ws = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            await ws.send(json.dumps({"type": "join_room", "payload": {"name": f"Guesser{i}", "room_code": room_code}}))
            await asyncio.wait_for(ws.recv(), timeout=5.0)
            clients.append(ws)
            # Drain player_list broadcast from host
            try:
                await asyncio.wait_for(ws_host.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                pass
        except Exception as e:
            results.record_error(e)

    guesser = clients[-1] if len(clients) > 1 else None
    if guesser is None:
        results.record_error(ValueError("No guesser client available"))
        for ws in clients:
            await ws.close()
        return results

    # Drain any pending messages on guesser
    try:
        while True:
            await asyncio.wait_for(guesser.recv(), timeout=0.1)
    except asyncio.TimeoutError:
        pass

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

    for ws in clients:
        try:
            await ws.close()
        except Exception:
            pass

    return results


# ---------------------------------------------------------------------------
# Test: Concurrent connections
# ---------------------------------------------------------------------------

async def measure_concurrent_connections(uri: str, n: int) -> PerfResults:
    """Measure how many concurrent connections can be established."""
    results = PerfResults(test_name=f"Concurrent Connections (target={n})")
    connections = []

    start = time.perf_counter()

    # Open connections in concurrent batches of 20
    batch_size = 20
    for batch_start in range(0, n, batch_size):
        batch_end = min(batch_start + batch_size, n)
        tasks = [
            asyncio.create_task(_open_connection(uri))
            for _ in range(batch_end - batch_start)
        ]
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in batch_results:
            if isinstance(r, Exception):
                results.record_error(r)
            elif r is not None:
                connections.append(r)

    elapsed = time.perf_counter() - start
    results.samples.append(elapsed)

    successful = len(connections)
    print(f"    Established {successful}/{n} connections in {elapsed*1000:.1f}ms")

    # Close all
    close_tasks = [asyncio.create_task(_close_connection(ws)) for ws in connections]
    await asyncio.gather(*close_tasks)

    return results


async def _open_connection(uri: str):
    """Open a single WebSocket connection."""
    return await asyncio.wait_for(websockets.connect(uri), timeout=10.0)


async def _close_connection(ws):
    """Close a single WebSocket connection."""
    try:
        await ws.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Test: Message throughput (pipelined sends)
# ---------------------------------------------------------------------------

async def measure_message_throughput(uri: str, n_messages: int, n_runs: int = 3) -> PerfResults:
    """Measure messages-per-second throughput for chat messages.

    Runs multiple iterations and reports mean ± stddev.
    Uses pipelined (fire-and-forget) sends for realistic throughput testing.
    """
    results = PerfResults(test_name=f"Message Throughput ({n_messages} msgs, {n_runs} runs)")

    for run in range(n_runs):
        try:
            ws1 = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            await ws1.send(json.dumps({"type": "create_room", "payload": {"name": f"ThroughputHost{run}"}}))
            response = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5.0))
            if not validate_response(response, "room_created"):
                results.record_error(ValueError("Failed to create room"))
                await ws1.close()
                continue
            room_code = response["payload"]["room_code"]

            ws2 = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            await ws2.send(json.dumps({"type": "join_room", "payload": {"name": f"ThroughputGuest{run}", "room_code": room_code}}))
            await asyncio.wait_for(ws2.recv(), timeout=5.0)

            # Drain setup messages
            try:
                while True:
                    await asyncio.wait_for(ws1.recv(), timeout=0.2)
            except asyncio.TimeoutError:
                pass

            # Pipelined sends: fire all messages without awaiting individually
            messages = [
                json.dumps({"type": "chat", "payload": {"text": f"msg{i}"}})
                for i in range(n_messages)
            ]

            start = time.perf_counter()

            # Send all messages as fast as possible (pipelined)
            send_tasks = [ws1.send(m) for m in messages]
            await asyncio.gather(*send_tasks)

            # Wait for all broadcasts to arrive at ws2
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
# Test: Reconnection latency
# ---------------------------------------------------------------------------

async def measure_reconnection_latency(uri: str, n: int) -> PerfResults:
    """Measure reconnection latency after disconnect."""
    results = PerfResults(test_name="Reconnection RTT")

    for i in range(n):
        try:
            # Create a room and get the room code
            ws = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            await ws.send(json.dumps({"type": "create_room", "payload": {"name": f"ReconnUser{i}"}}))
            response = json.loads(await asyncio.wait_for(ws.recv(), timeout=5.0))
            if not validate_response(response, "room_created"):
                results.record_error(ValueError("Failed to create room"))
                await ws.close()
                continue
            room_code = response["payload"]["room_code"]
            await ws.close()

            # Measure reconnection time
            ws2 = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
            msg = json.dumps({"type": "reconnect", "payload": {"name": f"ReconnUser{i}", "room_code": room_code}})

            start = time.perf_counter()
            await ws2.send(msg)
            resp = await asyncio.wait_for(ws2.recv(), timeout=5.0)
            elapsed = time.perf_counter() - start

            data = json.loads(resp)
            # Reconnect may succeed or fail (room may be cleaned up)
            # We measure the RTT regardless
            results.samples.append(elapsed)
            await ws2.close()

        except Exception as e:
            results.record_error(e)

    return results


# ---------------------------------------------------------------------------
# Test: Ramp-up (stepped load)
# ---------------------------------------------------------------------------

async def measure_ramp_up(uri: str, steps: list[int]) -> PerfResults:
    """Measure latency under increasing concurrent load (stepped ramp-up)."""
    results = PerfResults(test_name=f"Ramp-Up Latency (steps={steps})")

    for n_concurrent in steps:
        print(f"    Step: {n_concurrent} concurrent connections...")
        batch_results = PerfResults(test_name=f"step-{n_concurrent}")

        # Create n_concurrent rooms simultaneously
        tasks = [
            asyncio.create_task(_create_room_measure(uri, f"Ramp{n_concurrent}_{i}", batch_results))
            for i in range(n_concurrent)
        ]
        await asyncio.gather(*tasks)

        if batch_results.samples:
            avg = statistics.mean(batch_results.samples) * 1000
            p95 = sorted(batch_results.samples)[int(len(batch_results.samples) * 0.95)] * 1000 if batch_results.samples else 0
            print(f"      {n_concurrent} clients: avg={avg:.1f}ms, p95={p95:.1f}ms, errors={batch_results.total_errors}")

        results.samples.extend(batch_results.samples)
        for k, v in batch_results.errors.items():
            results.errors[k] = results.errors.get(k, 0) + v

        await cooldown(0.5)

    return results


async def _create_room_measure(uri: str, name: str, results: PerfResults) -> None:
    """Create a room and record the RTT."""
    try:
        ws = await asyncio.wait_for(websockets.connect(uri), timeout=10.0)
        msg = json.dumps({"type": "create_room", "payload": {"name": name}})
        start = time.perf_counter()
        await ws.send(msg)
        response = await asyncio.wait_for(ws.recv(), timeout=5.0)
        elapsed = time.perf_counter() - start
        data = json.loads(response)
        if validate_response(data, "room_created"):
            results.samples.append(elapsed)
        else:
            results.record_error(ValueError(f"Unexpected: {data.get('type')}"))
        await ws.close()
    except Exception as e:
        results.record_error(e)


# ---------------------------------------------------------------------------
# Main test runner
# ---------------------------------------------------------------------------

async def run_all_tests(host: str, port: int, n_clients: int, ramp_up: bool = False,
                        p95_max: Optional[float] = None):
    """Run all performance tests and print report."""
    uri = f"ws://{host}:{port}/ws"

    print(f"\n{'='*60}")
    print(f"  PICTIONARY GAME — PERFORMANCE TEST REPORT")
    print(f"  Server: {uri}")
    print(f"  Clients: {n_clients}")
    print(f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}\n")

    # Warm-up phase
    print("Warming up (5 connections)...")
    await warmup(uri, n=5)
    await cooldown(1.0)
    print("  Done.\n")

    all_results = []

    # Test 1: Connection time (concurrent)
    print("Running: Connection Establishment (concurrent burst)...")
    r = await measure_connection_time(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms ± {r.stddev_ms:.2f}ms\n")
    await cooldown()

    # Test 2: Room creation
    print("Running: Room Creation RTT...")
    r = await measure_room_creation(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")
    await cooldown()

    # Test 3: Join room
    print("Running: Join Room RTT...")
    r = await measure_join_room(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")
    await cooldown()

    # Test 4: Stroke broadcast latency (100 samples for statistical validity)
    print(f"Running: Stroke Broadcast Latency ({n_clients} clients, 100 samples)...")
    r = await measure_stroke_broadcast_latency(uri, n_clients, n_samples=100)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")
    await cooldown()

    # Test 5: Concurrent connections
    print(f"Running: Concurrent Connections (target={n_clients * 5})...")
    r = await measure_concurrent_connections(uri, n_clients * 5)
    all_results.append(r)
    print()
    await cooldown()

    # Test 6: Message throughput (multiple runs)
    print("Running: Message Throughput (3 runs)...")
    r = await measure_message_throughput(uri, 100, n_runs=3)
    all_results.append(r)
    if r.samples:
        print(f"  Avg throughput: {r.avg_ms:.0f} msgs/sec ± {r.stddev_ms:.0f}\n")
    await cooldown()

    # Test 7: Reconnection latency
    print("Running: Reconnection RTT...")
    r = await measure_reconnection_latency(uri, min(n_clients, 10))
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")
    await cooldown()

    # Test 8: Ramp-up (optional)
    if ramp_up:
        print("Running: Ramp-Up Latency...")
        steps = [1, 5, 10, 20, 50]
        r = await measure_ramp_up(uri, steps)
        all_results.append(r)
        print(f"  Done.\n")

    # Final report
    print(f"\n{'='*60}")
    print(f"  RESULTS SUMMARY")
    print(f"{'='*60}\n")
    for r in all_results:
        print(r.report())
        print()

    # Pass/fail threshold check
    threshold_passed = True
    if p95_max is not None:
        print(f"  {'─'*50}")
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

    print(f"{'='*60}")
    if p95_max and not threshold_passed:
        print(f"  RESULT: FAILED (P95 threshold exceeded)")
    else:
        print(f"  RESULT: PASSED")
    print(f"{'='*60}\n")

    return threshold_passed


def main():
    parser = argparse.ArgumentParser(description="Pictionary Game Performance Test")
    parser.add_argument("--host", default="localhost", help="Server host (default: localhost)")
    parser.add_argument("--port", type=int, default=8000, help="Server port (default: 8000)")
    parser.add_argument("--clients", type=int, default=10, help="Number of simulated clients (default: 10)")
    parser.add_argument("--ramp-up", action="store_true", help="Enable stepped ramp-up test")
    parser.add_argument("--p95-max", type=float, default=None,
                        help="P95 latency threshold in ms (exit non-zero on breach)")
    args = parser.parse_args()

    passed = asyncio.run(run_all_tests(args.host, args.port, args.clients,
                                       ramp_up=args.ramp_up, p95_max=args.p95_max))

    if args.p95_max and not passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
