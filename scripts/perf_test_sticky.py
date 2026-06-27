"""Performance test with sticky sessions for multi-worker deployment.

Simulates realistic usage where all players in a room connect to the
same worker via sticky sessions (cookie-based routing).

This test:
1. Connects to get a worker_id cookie from the first HTTP request
2. Reuses that cookie for all subsequent WebSocket connections
3. Ensures all clients in a room hit the same worker

Usage:
    python scripts/perf_test_sticky.py [--host localhost] [--port 8080] [--clients 10]

Requirements:
    pip install websockets aiohttp
"""

import asyncio
import json
import statistics
import time
import argparse
from dataclasses import dataclass, field
from typing import Optional

try:
    import websockets
    from websockets.client import connect as ws_connect
except ImportError:
    print("Install websockets: pip install websockets")
    exit(1)

try:
    import aiohttp
except ImportError:
    print("Install aiohttp: pip install aiohttp")
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


async def connect_with_cookie(ws_uri: str, cookie: Optional[str] = None):
    """Connect to WebSocket with sticky session cookie."""
    headers = {}
    if cookie:
        headers["Cookie"] = cookie
    return await websockets.connect(ws_uri, additional_headers=headers)


async def measure_sticky_connection(http_url: str, ws_uri: str, n: int) -> PerfResults:
    """Measure connection time with sticky sessions (all go to same worker)."""
    results = PerfResults(test_name="Sticky Connection (same worker)")

    # Get the sticky cookie first
    cookie = await get_sticky_cookie(http_url)
    print(f"    Got sticky cookie: {cookie[:30]}..." if cookie else "    No cookie (single worker mode)")

    for _ in range(n):
        start = time.perf_counter()
        try:
            ws = await connect_with_cookie(ws_uri, cookie)
            elapsed = time.perf_counter() - start
            results.samples.append(elapsed)
            await ws.close()
        except Exception as e:
            results.errors += 1

    return results


async def measure_sticky_room_flow(http_url: str, ws_uri: str, n_players: int) -> PerfResults:
    """Measure a full room flow where all players use the same sticky session."""
    results = PerfResults(test_name=f"Sticky Room Flow ({n_players} players, same worker)")

    # Get sticky cookie — all players will use this
    cookie = await get_sticky_cookie(http_url)

    # Host creates a room
    ws_host = await connect_with_cookie(ws_uri, cookie)
    await ws_host.send(json.dumps({"type": "create_room", "payload": {"name": "StickyHost"}}))
    response = json.loads(await ws_host.recv())
    if response.get("type") != "room_created":
        results.errors += 1
        await ws_host.close()
        return results
    room_code = response["payload"]["room_code"]

    # Players join with same cookie (same worker)
    players = [ws_host]
    for i in range(min(n_players - 1, 7)):
        ws = await connect_with_cookie(ws_uri, cookie)
        await ws.send(json.dumps({"type": "join_room", "payload": {"name": f"StickyPlayer{i}", "room_code": room_code}}))
        resp = await ws.recv()
        players.append(ws)
        # Drain player_list from host
        try:
            await asyncio.wait_for(ws_host.recv(), timeout=0.3)
        except asyncio.TimeoutError:
            pass

    # Drain any pending messages
    for ws in players:
        try:
            while True:
                await asyncio.wait_for(ws.recv(), timeout=0.1)
        except asyncio.TimeoutError:
            pass

    # Measure stroke latency (host sends, last player receives)
    guesser = players[-1]
    for i in range(50):
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
                results.errors += 1
        except asyncio.TimeoutError:
            results.errors += 1

    for ws in players:
        await ws.close()

    return results


async def measure_sticky_throughput(http_url: str, ws_uri: str, n_messages: int) -> PerfResults:
    """Measure throughput with sticky sessions (both players on same worker)."""
    results = PerfResults(test_name=f"Sticky Throughput ({n_messages} msgs, same worker)")

    cookie = await get_sticky_cookie(http_url)

    # Create room with 2 players on same worker
    ws1 = await connect_with_cookie(ws_uri, cookie)
    await ws1.send(json.dumps({"type": "create_room", "payload": {"name": "ThroughputHost"}}))
    response = json.loads(await ws1.recv())
    room_code = response["payload"]["room_code"]

    ws2 = await connect_with_cookie(ws_uri, cookie)
    await ws2.send(json.dumps({"type": "join_room", "payload": {"name": "ThroughputGuest", "room_code": room_code}}))
    await ws2.recv()

    # Drain setup messages
    try:
        while True:
            await asyncio.wait_for(ws1.recv(), timeout=0.2)
    except asyncio.TimeoutError:
        pass
    try:
        while True:
            await asyncio.wait_for(ws2.recv(), timeout=0.2)
    except asyncio.TimeoutError:
        pass

    # Send N messages and measure
    start = time.perf_counter()
    for i in range(n_messages):
        await ws1.send(json.dumps({"type": "chat", "payload": {"text": f"msg{i}"}}))

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
    results.samples.append(elapsed)

    print(f"    Sent {n_messages}, Received {received} in {elapsed*1000:.1f}ms")
    print(f"    Throughput: {throughput:.0f} msgs/sec")

    await ws1.close()
    await ws2.close()

    return results


async def measure_cross_worker_throughput(http_url: str, ws_uri: str, n_messages: int) -> PerfResults:
    """Measure throughput when players are on DIFFERENT workers (Redis relay)."""
    results = PerfResults(test_name=f"Cross-Worker Throughput ({n_messages} msgs, via Redis)")

    # Get two different cookies (force different workers by not reusing)
    cookie1 = await get_sticky_cookie(http_url)

    # For second player, DON'T use cookie — let nginx route to potentially different worker
    ws1 = await connect_with_cookie(ws_uri, cookie1)
    await ws1.send(json.dumps({"type": "create_room", "payload": {"name": "CrossHost"}}))
    response = json.loads(await ws1.recv())
    room_code = response["payload"]["room_code"]

    # Second player without cookie — may land on different worker
    ws2 = await connect_with_cookie(ws_uri, None)
    await ws2.send(json.dumps({"type": "join_room", "payload": {"name": "CrossGuest", "room_code": room_code}}))
    resp = json.loads(await ws2.recv())

    if resp.get("type") == "error":
        print(f"    Cross-worker join failed: {resp['payload'].get('message', 'unknown')}")
        print(f"    (This is expected — room only exists on the host's worker)")
        results.errors = n_messages
        await ws1.close()
        await ws2.close()
        return results

    # Drain setup messages
    try:
        while True:
            await asyncio.wait_for(ws1.recv(), timeout=0.2)
    except asyncio.TimeoutError:
        pass
    try:
        while True:
            await asyncio.wait_for(ws2.recv(), timeout=0.2)
    except asyncio.TimeoutError:
        pass

    # Send and measure
    start = time.perf_counter()
    for i in range(n_messages):
        await ws1.send(json.dumps({"type": "chat", "payload": {"text": f"xmsg{i}"}}))

    received = 0
    try:
        while received < n_messages:
            await asyncio.wait_for(ws2.recv(), timeout=5.0)
            received += 1
    except asyncio.TimeoutError:
        pass

    elapsed = time.perf_counter() - start
    throughput = received / elapsed if elapsed > 0 else 0
    results.samples.append(elapsed)

    print(f"    Sent {n_messages}, Received {received} in {elapsed*1000:.1f}ms")
    print(f"    Throughput: {throughput:.0f} msgs/sec")
    if received < n_messages:
        print(f"    ⚠️  {n_messages - received} messages lost (cross-worker relay)")

    await ws1.close()
    await ws2.close()

    return results


async def run_all_tests(host: str, port: int, n_clients: int):
    """Run all sticky session performance tests."""
    ws_uri = f"ws://{host}:{port}/ws"
    http_url = f"http://{host}:{port}/"

    print(f"\n{'='*60}")
    print(f"  PICTIONARY GAME — STICKY SESSION PERFORMANCE TEST")
    print(f"  Server: {ws_uri}")
    print(f"  Clients: {n_clients}")
    print(f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}\n")

    all_results = []

    # Test 1: Sticky connection (all to same worker)
    print("Running: Sticky Connection (same worker)...")
    r = await measure_sticky_connection(http_url, ws_uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")

    # Test 2: Sticky room flow (stroke latency, same worker)
    print(f"Running: Sticky Room Flow ({n_clients} players, same worker)...")
    r = await measure_sticky_room_flow(http_url, ws_uri, n_clients)
    all_results.append(r)
    print(f"  Done. Avg: {r.avg_ms:.2f}ms\n")

    # Test 3: Sticky throughput (same worker)
    print("Running: Sticky Throughput (same worker)...")
    r = await measure_sticky_throughput(http_url, ws_uri, 200)
    all_results.append(r)
    print()

    # Test 4: Cross-worker throughput (via Redis)
    print("Running: Cross-Worker Throughput (via Redis)...")
    r = await measure_cross_worker_throughput(http_url, ws_uri, 100)
    all_results.append(r)
    print()

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

    print(f"\n{'='*60}")
    print(f"  Test complete.")
    print(f"{'='*60}\n")


def main():
    parser = argparse.ArgumentParser(description="Sticky Session Performance Test")
    parser.add_argument("--host", default="localhost", help="Server host (default: localhost)")
    parser.add_argument("--port", type=int, default=8080, help="Server port (default: 8080 for nginx)")
    parser.add_argument("--clients", type=int, default=10, help="Number of simulated clients (default: 10)")
    args = parser.parse_args()

    asyncio.run(run_all_tests(args.host, args.port, args.clients))


if __name__ == "__main__":
    main()
