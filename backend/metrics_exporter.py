"""Prometheus metrics exporter for Skribbl Python Workers.

Defines gauges, counters, and histograms exposing operational metrics
for rooms, players, turn progressions, and guess evaluations.
"""

from __future__ import annotations

import logging
from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
    CONTENT_TYPE_LATEST,
)

logger = logging.getLogger(__name__)

# Dedicated registry for worker metrics
REGISTRY = CollectorRegistry(auto_describe=True)

# ─── Metrics Definitions ──────────────────────────────────────────────────────

# Active Rooms on this worker
ACTIVE_ROOMS = Gauge(
    "skribbl_worker_active_rooms",
    "Number of active rooms currently managed by this worker process",
    registry=REGISTRY,
)

# Active Players on this worker
ACTIVE_PLAYERS = Gauge(
    "skribbl_worker_active_players",
    "Number of active players currently connected to this worker",
    registry=REGISTRY,
)

# Active gRPC Streams serving
GRPC_STREAMS_SERVING = Gauge(
    "skribbl_worker_grpc_streams_serving",
    "Number of active bidirectional RoomStream connections served",
    registry=REGISTRY,
)

# Inbound & Outbound messages handled
MESSAGES_TOTAL = Counter(
    "skribbl_worker_messages_total",
    "Total messages handled by worker by type and direction",
    ["type", "direction"],
    registry=REGISTRY,
)

# Player guess outcomes
GUESSES_TOTAL = Counter(
    "skribbl_worker_guesses_total",
    "Total player guesses categorized by result (correct, close, incorrect)",
    ["result"],
    registry=REGISTRY,
)

# Turns completed
TURNS_TOTAL = Counter(
    "skribbl_worker_turns_total",
    "Total game turns started or completed",
    ["status"],
    registry=REGISTRY,
)

# Turn duration distribution
TURN_DURATION_HISTOGRAM = Histogram(
    "skribbl_worker_turn_duration_seconds",
    "Duration of game turns in seconds",
    buckets=[5, 10, 20, 30, 45, 60, 80, 120, 180],
    registry=REGISTRY,
)


def record_message(msg_type: str, direction: str = "inbound") -> None:
    """Record a processed message."""
    try:
        MESSAGES_TOTAL.labels(type=msg_type, direction=direction).inc()
    except Exception as e:
        logger.debug("Failed to record message metric: %s", e)


def record_guess(result: str) -> None:
    """Record a guess outcome ('correct', 'close', 'incorrect')."""
    try:
        GUESSES_TOTAL.labels(result=result).inc()
    except Exception as e:
        logger.debug("Failed to record guess metric: %s", e)


def set_active_rooms(count: int) -> None:
    """Set the count of active rooms."""
    ACTIVE_ROOMS.set(max(0, count))


def set_active_players(count: int) -> None:
    """Set the count of active players."""
    ACTIVE_PLAYERS.set(max(0, count))


def set_grpc_streams(count: int) -> None:
    """Set active gRPC streams count."""
    GRPC_STREAMS_SERVING.set(max(0, count))


def generate_prometheus_metrics() -> tuple[bytes, str]:
    """Generate the latest Prometheus exposition format output."""
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST

