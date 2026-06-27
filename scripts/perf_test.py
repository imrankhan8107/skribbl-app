"""Performance testing script for the Pictionary Game WebSocket server.

Simulates multiple concurrent WebSocket clients and measures:
- Connection establishment time
- Message round-trip latency
- Room creation/join throughput
- Stroke broadcast latency under load
- Max concurrent connections

Usage:
    python scripts/perf_test.py [--host localhost] [--port 8000] [--clients 10]

Requirements:
    pip install websockets aiohttp
"""

import asyncio
import json
import statistics
import time
import argparse
from dataclasses import dataclass, field

try:
    import websockets
except ImportError:
    print("Install websockets: pip install websockets")
    exit(1)


@dataclass
class PerfResults:
    """Aggregated performance test results."""
    test_name: str
    samples: list = field(default_factory=list)
    errors: int = 0

    @property
    def count(self) -> int:
        return len(self.samples)

    @property
    def avg_ms(self) -> float:
        return statistics.mean(self.samples) * 1000 if self.samples else 0

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

    def report(self) -> str:
        if not self.samples:
            return f"  {self.test_name}: NO DATA (errors={self.errors})"
        return (
            f"  {self.test_name}:\n"
            f"    Samples: {self.count} | Errors: {self.errors}\n"
            f"    Avg: {self.avg_ms:.2f}ms | P50: {self.p50_ms:.2f}ms | "
            f"P95: {self.p95_ms:.2f}ms | P99: {self.p99_ms:.2f}ms | Max: {self.max_ms:.2f}ms"
        )


async def measure_connection_time(uri: str, n: int) -> PerfResults:
    """Measure WebSocket connection establishment time."""
    results = PerfResults(test_name="Connection Establishment")

    for _ in range(n):
        start = time.perf_counter()
        try:
            ws = await websockets.connect(uri)
            elapsed = time.perf_counter() - start
            results.samples.append(elapsed)
            await ws.close()
        except Exception:
            results.errors += 1

    return results


async def measure_room_creation(uri: str, n: int) -> PerfResults:
    """Measure room creation round-trip time."""
    results = PerfResults(test_name="Room Creation RTT")

    for i in range(n):
        try:
            ws = await websockets.connect(uri)
            msg = json.dumps({"type": "create_room", "payload": {"name": f"PerfUser{i}"}})

            start = time.perf_counter()
            await ws.send(msg)
            response = await asyncio.wait_for(ws.recv(), timeout=5.0)
            elapsed = time.perf_counter() - start

            data = json.loads(response)
            if data.get("type") == "room_created":
                results.samples.append(elapsed)
            else:
                results.errors += 1

            await ws.close()
        except Exception:
            results.errors += 1

    return results


async def measure_join_room(uri: str, n: int) -> PerfResults:
    """Measure join room round-trip time with multiple players joining same room."""
    results = PerfResults(test_name="Join Room RTT")

    # Create a room first
    ws_host = await websockets.connect(uri)
    await ws_host.send(json.dumps({"type": "create_room", "payload": {"name": "PerfHost"}}))
    response = json.loads(await ws_host.recv())
    room_code = response["payload"]["room_code"]

    for i in range(min(n, 10)):  # Max 10 joins per room
        try:
            ws = await websockets.connect(uri)
            msg = json.dumps({"type": "join_room", "payload": {"name": f"Joiner{i}", "room_code": room_code}})

            start = time.perf_counter()
            await ws.send(msg)
            response = await asyncio.wait_for(ws.recv(), timeout=5.0)
            elapsed = time.perf_counter() - start

            data = json.loads(response)
            if data.get("type") == "room_joined":
                results.samples.append(elapsed)
            else:
                results.errors += 1

            await ws.close()
        except Exception:
            results.errors += 1

    await ws_host.close()
    return results


async def measure_stroke_broadcast_latency(uri: str, n_clients: int) -> PerfResults:
    """Measure stroke broadcast latency: time from drawer send to guesser receive."""
    results = PerfResults(test_name=f"Stroke Broadcast Latency ({n_clients} clients)")

    # Create room and join clients
    clients = []
    ws_host = await websockets.connect(uri)
    await ws_host.send(json.dumps({"type": "create_room", "payload": {"name": "DrawerHost"}}))
    response = json.loads(await ws_host.recv())
    room_code = response["payload"]["room_code"]
    clients.append(ws_host)

    for i in range(min(n_clients - 1, 7)):
        ws = await websockets.connect(uri)
        await ws.send(json.dumps({"type": "join_room", "payload": {"name": f"Guesser{i}", "room_code": room_code}}))
        await ws.recv()  # room_joined response
        clients.append(ws)
        # Drain player_list broadcast from host
        try:
            await asyncio.wait_for(ws_host.recv(), timeout=0.5)
        except asyncio.TimeoutError:
            pass

    # Measure stroke broadcast: host sends stroke, last client measures receive time
    guesser = clients[-1] if len(clients) > 1 else None
    if guesser is None:
        results.errors = n_clients
        return results

    # Drain any pending messages on guesser
    try:
        while True:
            await asyncio.wait_for(guesser.recv(), timeout=0.1)
    except asyncio.TimeoutError:
        pass

    for i in range(50):
        stroke_msg = json.dumps({
            "type": "stroke",
            "payload": {"points": [[i, i], [i + 10, i + 10]], "color": "#000000", "size": 3}
        })

        start = time.perf_counter()
        await ws_host.send(stroke_msg)

        try:
            # May receive non-stroke messages (ping, player_list) — skip them
            for _ in range(10):
                response = await asyncio.wait_for(guesser.recv(), timeout=2.0)
                data = json.loads(response)
                if data.get("type") == "stroke":
                    elapsed = time.perf_counter() - start
                    results.samples.append(elapsed)
                    break
            else:
                results.errors += 1
        except asyncio.TimeoutError:
            results.errors += 1

    for ws in clients:
        await ws.close()

    return results


async def measure_concurrent_connections(uri: str, n: int) -> PerfResults:
    """Measure how many concurrent connections can be established."""
    results = PerfResults(test_name=f"Concurrent Connections (target={n})")
    connections = []

    start = time.perf_counter()
    for i in range(n):
        try:
            ws = await websockets.connect(uri)
            connections.append(ws)
        except Exception:
            results.errors += 1
            break

    elapsed = time.perf_counter() - start
    results.samples.append(elapsed)

    successful = len(connections)
    print(f"    Established {successful}/{n} connections in {elapsed*1000:.1f}ms")

    # Close all
    for ws in connections:
        try:
            await ws.close()
        except Exception:
            pass

    return results


async def measure_message_throughput(uri: str, n_messages: int) -> PerfResults:
    """Measure messages-per-second throughput for chat messages."""
    results = PerfResults(test_name=f"Message Throughput ({n_messages} msgs)")

    # Create room with 2 players
    ws1 = await websockets.connect(uri)
    await ws1.send(json.dumps({"type": "create_room", "payload": {"name": "ThroughputHost"}}))
    response = json.loads(await ws1.recv())
    room_code = response["payload"]["room_code"]

    ws2 = await websockets.connect(uri)
    await ws2.send(json.dumps({"type": "join_room", "payload": {"name": "ThroughputGuest", "room_code": room_code}}))
    await ws2.recv()

    # Drain setup messages
    try:
        while True:
            await asyncio.wait_for(ws1.recv(), timeout=0.2)
    except asyncio.TimeoutError:
        pass

    # Send N chat messages as fast as possible and measure total time
    start = time.perf_counter()
    for i in range(n_messages):
        await ws1.send(json.dumps({"type": "chat", "payload": {"text": f"msg{i}"}}))

    # Wait for all broadcasts to arrive at ws2
    received = 0
    try:
        while received < n_messages:
            await asyncio.wait_for(ws2.recv(), timeout=3.0)
            received += 1
    except asyncio.TimeoutError:
        pass

    elapsed = time.perf_counter() - start
    throughput = received / elapsed if elapsed > 0 else 0
    results.samples.append(elapsed)

    print(f"    Sent {n_messages}, Received {received} in {elapsed*1000:.1f}ms")
    print(f"    Throughput: {throughput:.0f} msgs/sec")

    await ws1.close()
    await ws2.close()

    return results


async def run_all_tests(host: str, port: int, n_clients: int):
    """Run all performance tests and print report."""
    uri = f"ws://{host}:{port}/ws"

    print(f"\n{'='*60}")
    print(f"  PICTIONARY GAME — PERFORMANCE TEST REPORT")
    print(f"  Server: {uri}")
    print(f"  Clients: {n_clients}")
    print(f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}\n")

    all_results = []

    # Test 1: Connection time
    print("Running: Connection Establishment...")
    r = await measure_connection_time(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")

    # Test 2: Room creation
    print("Running: Room Creation RTT...")
    r = await measure_room_creation(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")

    # Test 3: Join room
    print("Running: Join Room RTT...")
    r = await measure_join_room(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")

    # Test 4: Stroke broadcast latency
    print(f"Running: Stroke Broadcast Latency ({n_clients} clients)...")
    r = await measure_stroke_broadcast_latency(uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")

    # Test 5: Concurrent connections
    print(f"Running: Concurrent Connections (target={n_clients * 5})...")
    r = await measure_concurrent_connections(uri, n_clients * 5)
    all_results.append(r)
    print()

    # Test 6: Message throughput
    print("Running: Message Throughput...")
    r = await measure_message_throughput(uri, 100)
    all_results.append(r)
    print()

    # Final report
    print(f"\n{'='*60}")
    print(f"  RESULTS SUMMARY")
    print(f"{'='*60}\n")
    for r in all_results:
        print(r.report())
        print()

    print(f"{'='*60}")
    print(f"  Test complete.")
    print(f"{'='*60}\n")


def main():
    parser = argparse.ArgumentParser(description="Pictionary Game Performance Test")
    parser.add_argument("--host", default="localhost", help="Server host (default: localhost)")
    parser.add_argument("--port", type=int, default=8000, help="Server port (default: 8000)")
    parser.add_argument("--clients", type=int, default=10, help="Number of simulated clients (default: 10)")
    args = parser.parse_args()

    asyncio.run(run_all_tests(args.host, args.port, args.clients))


if __name__ == "__main__":
    main()
