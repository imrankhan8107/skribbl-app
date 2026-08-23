"""gRPC metrics module for the Python worker.

Exposes a simple gauge for `grpc_streams_serving` — the number of active
Room_Streams currently being served by this worker. Thread-safe via
threading.Lock for correctness, though Python's GIL would protect simple
int operations in practice.

Usage:
    from backend.grpc_metrics import increment_streams, decrement_streams, get_grpc_metrics

    increment_streams()   # on stream open
    decrement_streams()   # on stream close
    get_grpc_metrics()    # returns {"grpc_streams_serving": <int>}
"""

from __future__ import annotations

import threading


_lock = threading.Lock()
_grpc_streams_serving: int = 0


def increment_streams() -> None:
    """Increment the grpc_streams_serving gauge by 1 (call on stream open)."""
    global _grpc_streams_serving
    with _lock:
        _grpc_streams_serving += 1


def decrement_streams() -> None:
    """Decrement the grpc_streams_serving gauge by 1 (call on stream close).

    Clamps to zero to avoid negative values from unexpected double-close.
    """
    global _grpc_streams_serving
    with _lock:
        _grpc_streams_serving = max(0, _grpc_streams_serving - 1)


def get_grpc_metrics() -> dict:
    """Return current gRPC metrics as a dictionary.

    Returns:
        Dict with key 'grpc_streams_serving' mapping to the current gauge value.
    """
    with _lock:
        return {"grpc_streams_serving": _grpc_streams_serving}


def reset_metrics() -> None:
    """Reset all metrics to zero. Useful for testing."""
    global _grpc_streams_serving
    with _lock:
        _grpc_streams_serving = 0
