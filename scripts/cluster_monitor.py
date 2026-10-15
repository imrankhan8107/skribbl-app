#!/usr/bin/env python3
"""Cluster Performance & Network Traffic Monitor.

Zero-dependency system monitor for distributed load tests.
Runs in two modes:
  1. Agent mode (`agent`): Runs on each EC2 instance (Gateway, Worker, LB, Redis).
     Samples CPU, Memory, Network I/O (RX/TX Mbps), and TCP sockets every 1s from /proc.
     Maintains rolling window statistics (Min, Max, Avg, Totals) and serves /stats,
     /summary, and /reset over HTTP (default port 9101).
  2. Report mode (`report`): Queries all nodes concurrently and prints an ASCII table.
  3. Reset mode (`reset`): Resets the measurement window across all nodes before a run.

Usage:
  python3 cluster_monitor.py agent --role gateway --port 9101
  python3 cluster_monitor.py reset --nodes "lb:10.0.1.10,gw1:10.0.1.20"
  python3 cluster_monitor.py report --nodes "lb:10.0.1.10,gw1:10.0.1.20"
"""

from __future__ import annotations

import argparse
import collections
import http.server
import json
import logging
import os
import platform
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Deque, Dict, List, Optional, Tuple


def _bounded_deque(maxlen: int) -> "collections.deque[float]":
    """A bounded FIFO for per-sample series; oldest samples drop at the cap."""
    return collections.deque(maxlen=maxlen)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [cluster-monitor] %(message)s",
)
logger = logging.getLogger("cluster-monitor")


# ═══════════════════════════════════════════════════════════════════════════════
# Hardware Metrics Sampler (Linux /proc parsers with cross-platform fallback)
# ═══════════════════════════════════════════════════════════════════════════════

class SystemSampler:
    """Reads hardware performance counters from Linux /proc files."""

    def __init__(self) -> None:
        self.is_linux = platform.system() == "Linux"
        self._last_cpu_time: Optional[Tuple[float, float]] = None  # (work_time, total_time)
        self._last_net_bytes: Optional[Tuple[float, int, int]] = None  # (timestamp, rx_bytes, tx_bytes)

    def sample_cpu_percent(self) -> float:
        """Calculate CPU utilization percentage since last call from /proc/stat."""
        if not self.is_linux:
            return 0.0

        try:
            with open("/proc/stat", "r") as f:
                first_line = f.readline()
            parts = first_line.split()
            if parts[0] != "cpu":
                return 0.0

            fields = [float(x) for x in parts[1:8]]
            user, nice, system, idle, iowait, irq, softirq = fields
            work_time = user + nice + system + irq + softirq
            total_time = work_time + idle + iowait

            if self._last_cpu_time is None:
                self._last_cpu_time = (work_time, total_time)
                return 0.0

            prev_work, prev_total = self._last_cpu_time
            self._last_cpu_time = (work_time, total_time)

            delta_total = total_time - prev_total
            delta_work = work_time - prev_work
            if delta_total <= 0:
                return 0.0

            return max(0.0, min(100.0, (delta_work / delta_total) * 100.0))
        except Exception as exc:
            logger.debug("Failed to read /proc/stat: %s", exc)
            return 0.0

    def sample_memory_mb(self) -> Tuple[float, float, float]:
        """Return (used_mb, total_mb, percent_used) from /proc/meminfo."""
        if not self.is_linux:
            return 0.0, 0.0, 0.0

        try:
            mem_total_kb = 0.0
            mem_avail_kb = 0.0
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        mem_total_kb = float(line.split()[1])
                    elif line.startswith("MemAvailable:"):
                        mem_avail_kb = float(line.split()[1])
                    if mem_total_kb and mem_avail_kb:
                        break

            if mem_total_kb <= 0:
                return 0.0, 0.0, 0.0

            used_kb = max(0.0, mem_total_kb - mem_avail_kb)
            used_mb = used_kb / 1024.0
            total_mb = mem_total_kb / 1024.0
            percent = (used_kb / mem_total_kb) * 100.0
            return used_mb, total_mb, percent
        except Exception as exc:
            logger.debug("Failed to read /proc/meminfo: %s", exc)
            return 0.0, 0.0, 0.0

    def sample_network_rates(self) -> Tuple[float, float, int, int]:
        """Calculate network rates (rx_mbps, tx_mbps, total_rx_bytes, total_tx_bytes)."""
        if not self.is_linux:
            return 0.0, 0.0, 0, 0

        try:
            total_rx = 0
            total_tx = 0
            with open("/proc/net/dev", "r") as f:
                lines = f.readlines()[2:]  # Skip header lines
                for line in lines:
                    line = line.strip()
                    if not line or ":" not in line:
                        continue
                    iface, stats = line.split(":", 1)
                    iface = iface.strip()
                    # Skip loopback interface
                    if iface == "lo":
                        continue
                    parts = stats.split()
                    rx_bytes = int(parts[0])
                    tx_bytes = int(parts[8])
                    total_rx += rx_bytes
                    total_tx += tx_bytes

            now = time.time()
            if self._last_net_bytes is None:
                self._last_net_bytes = (now, total_rx, total_tx)
                return 0.0, 0.0, total_rx, total_tx

            prev_time, prev_rx, prev_tx = self._last_net_bytes
            self._last_net_bytes = (now, total_rx, total_tx)

            elapsed = max(0.001, now - prev_time)
            rx_delta_bytes = max(0, total_rx - prev_rx)
            tx_delta_bytes = max(0, total_tx - prev_tx)

            # Convert bytes/sec to Megabits/sec (Mbps): (bytes * 8) / (1e6 * elapsed)
            rx_mbps = (rx_delta_bytes * 8.0) / (1_000_000.0 * elapsed)
            tx_mbps = (tx_delta_bytes * 8.0) / (1_000_000.0 * elapsed)

            return rx_mbps, tx_mbps, total_rx, total_tx
        except Exception as exc:
            logger.debug("Failed to read /proc/net/dev: %s", exc)
            return 0.0, 0.0, 0, 0

    def sample_tcp_connections(self) -> int:
        """Count active established TCP connections from /proc/net/tcp and tcp6."""
        if not self.is_linux:
            return 0

        # State 01 = TCP_ESTABLISHED in Linux kernel
        count = 0
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            if not os.path.exists(path):
                continue
            try:
                with open(path, "r") as f:
                    lines = f.readlines()[1:]  # Skip header
                    for line in lines:
                        parts = line.strip().split()
                        if len(parts) >= 4 and parts[3] == "01":
                            count += 1
            except Exception:
                pass
        return count


# ═══════════════════════════════════════════════════════════════════════════════
# Statistics helpers (zero-dependency: percentiles + threshold dwell analysis)
# ═══════════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS: min/avg/max throws away the SHAPE of the signal. A node that
# averages 22% but peaks at 90% looks like it has headroom — but if it spends 40%
# of the run above 85%, it's actually near saturation and the low average is just
# the turn-based duty cycle (idle between turns, spiking on each turn broadcast).
# These helpers recover the distribution (percentiles) and the dwell time above
# capacity thresholds, which is what you actually size a fleet against.

# CPU thresholds (percent) we report dwell time / crossings against.
CPU_THRESHOLDS = (70.0, 85.0, 95.0)
# Microburst threshold for the fast (200ms) CPU series — "pegged a core" territory.
BURST_THRESHOLD = 90.0


def percentile(sorted_vals: List[float], pct: float) -> float:
    """Linear-interpolation percentile over an already-SORTED list.

    pct in [0,100]. Returns 0.0 for an empty list. Matches the common
    "nearest-rank with interpolation" method (same family as numpy's default),
    implemented without numpy to keep this script dependency-free.
    """
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_vals[0]
    rank = (pct / 100.0) * (n - 1)
    lo = int(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def threshold_stats(
    series: List[float],
    interval_sec: float,
    thresholds: Tuple[float, ...],
) -> Dict[str, Dict[str, float]]:
    """For each threshold, compute dwell time and crossing/burst behaviour.

    Returns {"70": {...}, "85": {...}, ...} where each entry has:
      - pct_time: fraction of samples >= threshold, as a percentage (0-100)
      - seconds_above: approx wall-seconds >= threshold (samples * interval)
      - crossings: number of times the signal rose from below to >= threshold
                   (counts distinct spike EVENTS, not samples)
      - longest_streak_sec: longest CONSECUTIVE run >= threshold, in seconds
                            (a 1s blip at 95% is harmless; a 90s plateau is not —
                             this is what separates them)
    """
    out: Dict[str, Dict[str, float]] = {}
    n = len(series)
    for th in thresholds:
        above = 0
        crossings = 0
        longest = 0
        cur = 0
        prev_above = False
        for v in series:
            is_above = v >= th
            if is_above:
                above += 1
                cur += 1
                if cur > longest:
                    longest = cur
                if not prev_above:
                    crossings += 1
            else:
                cur = 0
            prev_above = is_above
        out[str(int(th))] = {
            "pct_time": round((above / n) * 100.0, 2) if n else 0.0,
            "seconds_above": round(above * interval_sec, 1),
            "crossings": crossings,
            "longest_streak_sec": round(longest * interval_sec, 1),
        }
    return out


def cpu_distribution(series: List[float], interval_sec: float) -> Dict[str, Any]:
    """Full CPU distribution + dwell stats for one resolution's series."""
    if not series:
        return {
            "samples": 0,
            "interval_ms": round(interval_sec * 1000),
            "p50": 0.0, "p90": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0,
            "thresholds": {},
            "bursts_ge_90": {"count": 0, "pct_time": 0.0},
        }
    s = sorted(series)
    th = threshold_stats(series, interval_sec, CPU_THRESHOLDS)
    burst = threshold_stats(series, interval_sec, (BURST_THRESHOLD,))[str(int(BURST_THRESHOLD))]
    return {
        "samples": len(series),
        "interval_ms": round(interval_sec * 1000),
        "p50": round(percentile(s, 50), 2),
        "p90": round(percentile(s, 90), 2),
        "p95": round(percentile(s, 95), 2),
        "p99": round(percentile(s, 99), 2),
        "max": round(s[-1], 2),
        "thresholds": th,
        "bursts_ge_90": {"count": burst["crossings"], "pct_time": burst["pct_time"]},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Metric Accumulator (Thread-safe running window statistics)
# ═══════════════════════════════════════════════════════════════════════════════

class MetricAccumulator:
    """Computes Min/Max/Avg plus full-distribution statistics over a test window.

    Beyond the legacy running min/avg/max, this retains the per-sample CPU series
    at TWO resolutions so we can see both sustained load and microbursts:
      - cpu_series_1s:   one CPU sample/sec (sustained-load / capacity signal)
      - cpu_series_fast: one CPU sample every ~200ms (microburst signal that 1s
                         averaging smears away — a 200ms 100% spike reads ~20% at
                         1s resolution, but ~100% at 200ms)
    Series are bounded ring buffers so a very long run can't grow memory without
    bound (a 60-min run at 200ms is ~18k floats ≈ 150 KB; the cap is well above).
    """

    def __init__(self, role: str = "node") -> None:
        self.role = role
        self.lock = threading.Lock()
        # Ring-buffer caps (samples). ~24h at 1s, ~2h at 200ms — generous; real
        # runs are <1h. Prevents unbounded growth if an agent is left running.
        self._cap_1s = 90000
        self._cap_fast = 90000
        self.fast_interval_sec = 0.2
        self.reset()

    def reset(self) -> None:
        """Reset the measurement window."""
        with self.lock:
            self.start_time = time.time()
            self.samples_count = 0

            # Per-sample CPU series at two resolutions (bounded ring buffers).
            # collections.deque(maxlen=...) drops oldest automatically at the cap.
            self.cpu_series_1s = _bounded_deque(self._cap_1s)
            self.cpu_series_fast = _bounded_deque(self._cap_fast)

            # CPU
            self.cpu_min = 100.0
            self.cpu_max = 0.0
            self.cpu_sum = 0.0
            self.cpu_current = 0.0

            # Memory MB
            self.mem_min = float("inf")
            self.mem_max = 0.0
            self.mem_sum = 0.0
            self.mem_current = 0.0
            self.mem_total = 0.0

            # Network Rates (Mbps)
            self.rx_min = float("inf")
            self.rx_max = 0.0
            self.rx_sum = 0.0
            self.rx_current = 0.0

            self.tx_min = float("inf")
            self.tx_max = 0.0
            self.tx_sum = 0.0
            self.tx_current = 0.0

            # Network Totals (Accumulated transferred bytes in window)
            self.window_start_rx_bytes: Optional[int] = None
            self.window_start_tx_bytes: Optional[int] = None
            self.last_rx_bytes = 0
            self.last_tx_bytes = 0

            # TCP Connections
            self.tcp_min = 9999999
            self.tcp_max = 0
            self.tcp_sum = 0
            self.tcp_current = 0

    def record_sample(
        self,
        cpu_pct: float,
        mem_mb: float,
        mem_total_mb: float,
        rx_mbps: float,
        tx_mbps: float,
        raw_rx_bytes: int,
        raw_tx_bytes: int,
        tcp_conns: int,
    ) -> None:
        """Incorporate a 1-second sample into running stats."""
        with self.lock:
            self.samples_count += 1

            # First sample initializes raw byte baseline
            if self.window_start_rx_bytes is None:
                self.window_start_rx_bytes = raw_rx_bytes
            if self.window_start_tx_bytes is None:
                self.window_start_tx_bytes = raw_tx_bytes

            self.last_rx_bytes = raw_rx_bytes
            self.last_tx_bytes = raw_tx_bytes

            # CPU — retain the per-second value for distribution/dwell analysis.
            self.cpu_series_1s.append(cpu_pct)
            self.cpu_current = cpu_pct
            self.cpu_min = min(self.cpu_min, cpu_pct)
            self.cpu_max = max(self.cpu_max, cpu_pct)
            self.cpu_sum += cpu_pct

            # Memory
            self.mem_current = mem_mb
            self.mem_total = mem_total_mb
            self.mem_min = min(self.mem_min, mem_mb)
            self.mem_max = max(self.mem_max, mem_mb)
            self.mem_sum += mem_mb

            # Network
            self.rx_current = rx_mbps
            self.rx_min = min(self.rx_min, rx_mbps)
            self.rx_max = max(self.rx_max, rx_mbps)
            self.rx_sum += rx_mbps

            self.tx_current = tx_mbps
            self.tx_min = min(self.tx_min, tx_mbps)
            self.tx_max = max(self.tx_max, tx_mbps)
            self.tx_sum += tx_mbps

            # TCP
            self.tcp_current = tcp_conns
            self.tcp_min = min(self.tcp_min, tcp_conns)
            self.tcp_max = max(self.tcp_max, tcp_conns)
            self.tcp_sum += tcp_conns

    def record_fast_cpu(self, cpu_pct: float) -> None:
        """Record a high-resolution (~200ms) CPU sample only.

        Kept separate and cheap: the fast loop samples CPU alone (network/TCP are
        smooth and don't need sub-second resolution), feeding the microburst
        series that 1s averaging would hide.
        """
        with self.lock:
            self.cpu_series_fast.append(cpu_pct)

    def get_summary(self) -> Dict[str, Any]:
        """Return the window summary dict."""
        with self.lock:
            n = max(1, self.samples_count)
            duration_s = max(1.0, time.time() - self.start_time)

            tot_rx = max(0, self.last_rx_bytes - (self.window_start_rx_bytes or self.last_rx_bytes))
            tot_tx = max(0, self.last_tx_bytes - (self.window_start_tx_bytes or self.last_tx_bytes))

            # Snapshot the series under the lock, then compute distributions.
            # 1s = sustained-load signal; fast(200ms) = microburst signal.
            cpu_1s = list(self.cpu_series_1s)
            cpu_fast = list(self.cpu_series_fast)
            # Derive the fast interval from samples vs duration if we have data;
            # fall back to the configured value.
            fast_iv = self.fast_interval_sec

            return {
                "role": self.role,
                "hostname": socket.gethostname(),
                "duration_seconds": round(duration_s, 1),
                "samples_count": self.samples_count,
                "cpu_percent": {
                    "current": round(self.cpu_current, 2),
                    "min": round(self.cpu_min if self.samples_count > 0 else 0.0, 2),
                    "avg": round(self.cpu_sum / n, 2),
                    "max": round(self.cpu_max, 2),
                },
                # Rich CPU distribution + dwell-above-threshold at BOTH resolutions.
                # Read these, not min/avg/max, for capacity decisions:
                #   cpu_dist_1s.p95        -> sustained busy level
                #   cpu_dist_1s.thresholds -> how long/often above 70/85/95%
                #   cpu_dist_fast.p99      -> microburst peaks 1s averaging hides
                "cpu_dist_1s": cpu_distribution(cpu_1s, 1.0),
                "cpu_dist_fast": cpu_distribution(cpu_fast, fast_iv),
                "memory_mb": {
                    "current": round(self.mem_current, 1),
                    "min": round(self.mem_min if self.samples_count > 0 else 0.0, 1),
                    "avg": round(self.mem_sum / n, 1),
                    "max": round(self.mem_max, 1),
                    "total_mb": round(self.mem_total, 1),
                },
                "network_rx_mbps": {
                    "current": round(self.rx_current, 2),
                    "min": round(self.rx_min if self.samples_count > 0 else 0.0, 2),
                    "avg": round(self.rx_sum / n, 2),
                    "max": round(self.rx_max, 2),
                    "total_mb": round(tot_rx / (1024.0 * 1024.0), 2),
                    "total_gb": round(tot_rx / (1024.0 * 1024.0 * 1024.0), 3),
                },
                "network_tx_mbps": {
                    "current": round(self.tx_current, 2),
                    "min": round(self.tx_min if self.samples_count > 0 else 0.0, 2),
                    "avg": round(self.tx_sum / n, 2),
                    "max": round(self.tx_max, 2),
                    "total_mb": round(tot_tx / (1024.0 * 1024.0), 2),
                    "total_gb": round(tot_tx / (1024.0 * 1024.0 * 1024.0), 3),
                },
                "tcp_connections": {
                    "current": self.tcp_current,
                    "min": self.tcp_min if self.samples_count > 0 else 0,
                    "avg": round(self.tcp_sum / n, 1),
                    "max": self.tcp_max,
                },
            }


# ═══════════════════════════════════════════════════════════════════════════════
# Background Polling Thread & HTTP Agent
# ═══════════════════════════════════════════════════════════════════════════════

def run_fast_cpu_loop(
    accumulator: MetricAccumulator,
    stop_event: threading.Event,
    interval_sec: float = 0.2,
) -> None:
    """High-resolution CPU-only loop (~200ms) for microburst detection.

    Uses its OWN SystemSampler: sample_cpu_percent() is a stateful delta since
    the last call, so sharing one sampler with the 1s loop would corrupt both
    series' deltas. A dedicated sampler keeps the fast CPU deltas self-consistent.

    Only CPU is sampled here — network rates and TCP counts are smooth and don't
    benefit from sub-second resolution, so sampling them at 200ms would add
    overhead for no signal.
    """
    fast_sampler = SystemSampler()
    fast_sampler.sample_cpu_percent()  # prime the delta
    time.sleep(interval_sec)
    while not stop_event.is_set():
        try:
            accumulator.record_fast_cpu(fast_sampler.sample_cpu_percent())
        except Exception as exc:
            logger.debug("Fast CPU loop error: %s", exc)
        stop_event.wait(interval_sec)


def run_sampler_loop(
    sampler: SystemSampler,
    accumulator: MetricAccumulator,
    stop_event: threading.Event,
    interval_sec: float = 1.0,
    metrics_file: Optional[str] = "/var/log/skribbl/metrics.json",
) -> None:
    """Background sampling loop running every second (full multi-metric sample)."""
    # Warm up first differential counters
    sampler.sample_cpu_percent()
    sampler.sample_network_rates()
    time.sleep(0.5)

    while not stop_event.is_set():
        try:
            cpu = sampler.sample_cpu_percent()
            used_mb, tot_mb, _ = sampler.sample_memory_mb()
            rx_mbps, tx_mbps, tot_rx, tot_tx = sampler.sample_network_rates()
            conns = sampler.sample_tcp_connections()

            accumulator.record_sample(
                cpu_pct=cpu,
                mem_mb=used_mb,
                mem_total_mb=tot_mb,
                rx_mbps=rx_mbps,
                tx_mbps=tx_mbps,
                raw_rx_bytes=tot_rx,
                raw_tx_bytes=tot_tx,
                tcp_conns=conns,
            )

            # Periodically write metrics snapshot to disk if log directory exists
            if metrics_file:
                try:
                    dir_name = os.path.dirname(metrics_file)
                    if os.path.isdir(dir_name):
                        summary = accumulator.get_summary()
                        with open(metrics_file + ".tmp", "w") as f:
                            json.dump(summary, f, indent=2)
                        os.replace(metrics_file + ".tmp", metrics_file)
                except Exception:
                    pass

        except Exception as exc:
            logger.debug("Sampling loop error: %s", exc)

        stop_event.wait(interval_sec)


def create_http_handler(accumulator: MetricAccumulator):
    """Factory creating an HTTP request handler referencing the accumulator."""

    class AgentHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass  # Suppress default noisy access logs

        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            if path in ("/summary", "/stats", "/"):
                data = accumulator.get_summary()
                body = json.dumps(data, indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path in ("/reset", "/metrics/reset"):
                accumulator.reset()
                resp = json.dumps({"status": "reset_successful", "timestamp": time.time()}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            elif path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"OK")
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self) -> None:
            path = self.path.split("?")[0]
            if path in ("/reset", "/metrics/reset"):
                accumulator.reset()
                resp = json.dumps({"status": "reset_successful", "timestamp": time.time()}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            else:
                self.send_response(404)
                self.end_headers()

    return AgentHandler


def run_agent(role: str, port: int, fast_interval_sec: float = 0.2) -> None:
    """Start agent daemon on the host.

    Runs TWO sampling threads:
      - slow (1s): full multi-metric sample (CPU, mem, net, TCP)
      - fast (~200ms): CPU-only, for microburst detection
    """
    sampler = SystemSampler()
    accumulator = MetricAccumulator(role=role)
    accumulator.fast_interval_sec = fast_interval_sec
    stop_event = threading.Event()

    sampler_thread = threading.Thread(
        target=run_sampler_loop,
        args=(sampler, accumulator, stop_event),
        daemon=True,
    )
    sampler_thread.start()

    if fast_interval_sec and fast_interval_sec > 0:
        fast_thread = threading.Thread(
            target=run_fast_cpu_loop,
            args=(accumulator, stop_event, fast_interval_sec),
            daemon=True,
        )
        fast_thread.start()
    else:
        logger.info("Fast CPU loop disabled (fast-interval-ms=0)")

    handler_cls = create_http_handler(accumulator)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler_cls)
    logger.info("Starting cluster monitor agent on port %d (role=%s)...", port, role)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down monitor agent...")
    finally:
        stop_event.set()
        server.server_close()


# ═══════════════════════════════════════════════════════════════════════════════
# CLI Commands: Report & Reset across Cluster
# ═══════════════════════════════════════════════════════════════════════════════

def parse_nodes_arg(nodes_arg: str, default_port: int = 9101) -> List[Tuple[str, str, int]]:
    """Parse comma-separated nodes list: 'role:host[:port],role:host[:port]'."""
    result = []
    for item in nodes_arg.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" in item:
            parts = item.split(":")
            if len(parts) == 2:
                role, host = parts[0], parts[1]
                port = default_port
            elif len(parts) >= 3:
                role, host, port_str = parts[0], parts[1], parts[2]
                port = int(port_str)
            else:
                role, host, port = "node", item, default_port
        else:
            role, host, port = "node", item, default_port
        result.append((role, host, port))
    return result


def fetch_node_summary(host: str, port: int, timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    """Fetch /summary from a node agent."""
    url = f"http://{host}:{port}/summary"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.debug("Failed to query %s: %s", url, exc)
    return None


def reset_node_metrics(host: str, port: int, timeout: float = 3.0) -> bool:
    """Send /reset to a node agent."""
    url = f"http://{host}:{port}/reset"
    try:
        req = urllib.request.Request(url, data=b"{}")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        # Fallback to GET /reset
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                return resp.status == 200
        except Exception:
            return False


def cmd_reset(nodes: List[Tuple[str, str, int]]) -> None:
    """Concurrently reset metrics across all cluster nodes."""
    logger.info("Resetting measurement window across %d cluster nodes...", len(nodes))
    success_count = 0
    for role, host, port in nodes:
        ok = reset_node_metrics(host, port)
        status = "OK" if ok else "FAILED (unreachable)"
        if ok:
            success_count += 1
        print(f"  [{role}] {host}:{port} -> {status}")
    logger.info("Reset completed: %d/%d nodes acknowledged.", success_count, len(nodes))


def format_table(results: List[Tuple[str, str, Optional[Dict[str, Any]]]]) -> str:
    """Format instance performance and network traffic report as an ASCII table."""
    lines = []
    border = "=" * 126
    sep = "-" * 126

    lines.append(border)
    lines.append(
        "CLUSTER INSTANCE LOAD & NETWORK TRAFFIC REPORT".center(126)
    )
    lines.append(border)
    header = (
        f"{'Instance / Host':<22} {'Role':<12} "
        f"{'CPU Util (%) [Min/Avg/Max]':<26} "
        f"{'Memory (MB) [Avg/Max]':<22} "
        f"{'Net RX Mbps [Avg/Peak]':<22} "
        f"{'Net TX Mbps [Avg/Peak]':<22} "
        f"{'Total (GB) [RX/TX]'}"
    )
    lines.append(header)
    lines.append(sep)

    tot_rx_gb = 0.0
    tot_tx_gb = 0.0
    valid_nodes = 0
    sum_cpu_avg = 0.0
    peak_rx_mbps = 0.0
    peak_tx_mbps = 0.0

    for name, host, data in results:
        label = f"{name} ({host})" if host != name else name
        if not data:
            lines.append(f"{label:<22} {'?':<12} {'[AGENT UNREACHABLE]':<26} {'-':<22} {'-':<22} {'-':<22} {'-'}")
            continue

        valid_nodes += 1
        role = data.get("role", "node")
        cpu = data.get("cpu_percent", {})
        mem = data.get("memory_mb", {})
        rx = data.get("network_rx_mbps", {})
        tx = data.get("network_tx_mbps", {})

        cpu_str = f"{cpu.get('min', 0):.1f}% / {cpu.get('avg', 0):.1f}% / {cpu.get('max', 0):.1f}%"
        mem_str = f"{mem.get('avg', 0):.0f} / {mem.get('max', 0):.0f} MB"
        rx_str = f"{rx.get('avg', 0):.1f} / {rx.get('max', 0):.1f} Mbps"
        tx_str = f"{tx.get('avg', 0):.1f} / {tx.get('max', 0):.1f} Mbps"
        tot_str = f"{rx.get('total_gb', 0):.2f}G / {tx.get('total_gb', 0):.2f}G"

        tot_rx_gb += rx.get("total_gb", 0.0)
        tot_tx_gb += tx.get("total_gb", 0.0)
        sum_cpu_avg += cpu.get("avg", 0.0)
        peak_rx_mbps = max(peak_rx_mbps, rx.get("max", 0.0))
        peak_tx_mbps = max(peak_tx_mbps, tx.get("max", 0.0))

        lines.append(
            f"{label:<22} {role:<12} {cpu_str:<26} {mem_str:<22} {rx_str:<22} {tx_str:<22} {tot_str}"
        )

    lines.append(sep)
    if valid_nodes > 0:
        fleet_cpu_avg = sum_cpu_avg / valid_nodes
        fleet_summary = (
            f"{'FLEET TOTAL / PEAK':<22} {f'{valid_nodes} nodes':<12} "
            f"{f'Avg: {fleet_cpu_avg:.1f}%':<26} "
            f"{'-':<22} "
            f"{f'Peak: {peak_rx_mbps:.1f} Mbps':<22} "
            f"{f'Peak: {peak_tx_mbps:.1f} Mbps':<22} "
            f"{f'{tot_rx_gb:.2f}G / {tot_tx_gb:.2f}G'}"
        )
        lines.append(fleet_summary)
    lines.append(border)
    return "\n".join(lines)


def format_cpu_saturation_table(results: List[Tuple[str, str, Optional[Dict[str, Any]]]]) -> str:
    """CPU distribution + saturation-dwell table — the capacity-decision view.

    This is the table to read instead of min/avg/max. Columns:
      - p50/p95 (1s): median and sustained-busy level over the run
      - p99 (200ms):  microburst peak the 1s series averages away
      - %>=70 / %>=85 / %>=95 (1s): fraction of the run spent above each capacity
        band — the real "do we have headroom?" signal
      - MaxRun>=85s: longest CONSECUTIVE stretch above 85% in seconds (a plateau,
        not a blip) — the strongest saturation red flag
      - Bursts>=90: count of distinct 200ms spikes to >=90% (frame-drop risk)

    Interpretation guide printed below the table so the numbers are actionable.
    """
    lines = []
    border = "=" * 126
    sep = "-" * 126
    lines.append(border)
    lines.append("CPU SATURATION ANALYSIS  (read this, not min/avg/max, for capacity decisions)".center(126))
    lines.append(border)
    header = (
        f"{'Instance / Host':<22} {'Role':<10} "
        f"{'p50/p95 1s':<14} {'p99 200ms':<10} "
        f"{'%>=70':<7} {'%>=85':<7} {'%>=95':<7} "
        f"{'MaxRun>=85s':<12} {'Bursts>=90':<11} {'Verdict'}"
    )
    lines.append(header)
    lines.append(sep)

    for name, host, data in results:
        label = f"{name} ({host})" if host != name else name
        if not data:
            lines.append(f"{label:<22} {'?':<10} {'[UNREACHABLE]'}")
            continue
        role = data.get("role", "node")
        d1 = data.get("cpu_dist_1s", {}) or {}
        df = data.get("cpu_dist_fast", {}) or {}
        th = d1.get("thresholds", {}) or {}
        t70 = th.get("70", {}) or {}
        t85 = th.get("85", {}) or {}
        t95 = th.get("95", {}) or {}

        p50 = d1.get("p50", 0.0)
        p95 = d1.get("p95", 0.0)
        p99f = df.get("p99", 0.0)
        pct70 = t70.get("pct_time", 0.0)
        pct85 = t85.get("pct_time", 0.0)
        pct95 = t95.get("pct_time", 0.0)
        maxrun85 = t85.get("longest_streak_sec", 0.0)
        bursts = df.get("bursts_ge_90", {}).get("count", 0)

        # Verdict heuristic: translate the dwell numbers into a plain call.
        if pct95 >= 10.0 or maxrun85 >= 30.0:
            verdict = "SATURATED"
        elif pct85 >= 20.0 or p95 >= 85.0:
            verdict = "HOT (scale soon)"
        elif pct70 >= 25.0 or p95 >= 70.0:
            verdict = "busy"
        else:
            verdict = "healthy"

        lines.append(
            f"{label:<22} {role:<10} "
            f"{f'{p50:.0f}/{p95:.0f}%':<14} {f'{p99f:.0f}%':<10} "
            f"{f'{pct70:.0f}%':<7} {f'{pct85:.0f}%':<7} {f'{pct95:.0f}%':<7} "
            f"{f'{maxrun85:.0f}s':<12} {str(bursts):<11} {verdict}"
        )

    lines.append(sep)
    lines.append(
        "Read: p95(1s)=sustained busy level | p99(200ms)=microburst peak hidden by 1s avg | "
        "%>=85=time near cap"
    )
    lines.append(
        "Size the fleet so p95(1s) sits <~70% and MaxRun>=85s stays small; "
        "SATURATED/HOT => add capacity for that tier."
    )
    lines.append(border)
    return "\n".join(lines)


def cmd_report(nodes: List[Tuple[str, str, int]], output_json: Optional[str] = None) -> None:
    """Poll all nodes and print formatted report."""
    results = []
    raw_payloads = {}

    for role, host, port in nodes:
        data = fetch_node_summary(host, port)
        results.append((role, host, data))
        if data:
            raw_payloads[f"{role}:{host}"] = data

    table = format_table(results)
    print("\n" + table + "\n")

    # Second table: the CPU distribution / saturation view that min/avg/max hides.
    cpu_table = format_cpu_saturation_table(results)
    print(cpu_table + "\n")

    if output_json:
        try:
            with open(output_json, "w") as f:
                json.dump(raw_payloads, f, indent=2)
            print(f"Saved cluster metrics JSON to {output_json}")
        except Exception as exc:
            logger.error("Failed to save metrics JSON: %s", exc)


# ═══════════════════════════════════════════════════════════════════════════════
# Main Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Cluster Performance & Network Monitor")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Agent subcommand
    agent_p = subparsers.add_parser("agent", help="Run monitor agent daemon on host")
    agent_p.add_argument("--role", default="node", help="Instance role (gateway, worker, lb, redis, etc.)")
    agent_p.add_argument("--port", type=int, default=9101, help="Port to listen on (default 9101)")
    agent_p.add_argument(
        "--fast-interval-ms", type=int, default=200,
        help="High-resolution CPU sampling interval in ms (default 200). "
             "Floor ~100ms: /proc/stat accounts CPU in ~10ms ticks, so below "
             "~100ms the deltas get noisy. Set 0 to disable the fast loop.",
    )

    # Report subcommand
    report_p = subparsers.add_parser("report", help="Fetch and display summary table from cluster nodes")
    report_p.add_argument("--nodes", required=True, help="Comma-separated role:host[:port] list")
    report_p.add_argument("--output", default=None, help="Optional output JSON file path")

    # Reset subcommand
    reset_p = subparsers.add_parser("reset", help="Reset measurement window across cluster nodes")
    reset_p.add_argument("--nodes", required=True, help="Comma-separated role:host[:port] list")

    args = parser.parse_args()

    if args.command == "agent":
        run_agent(args.role, args.port, fast_interval_sec=max(0.0, args.fast_interval_ms / 1000.0))
    elif args.command == "reset":
        nodes = parse_nodes_arg(args.nodes)
        cmd_reset(nodes)
    elif args.command == "report":
        nodes = parse_nodes_arg(args.nodes)
        cmd_report(nodes, output_json=args.output)


if __name__ == "__main__":
    main()

