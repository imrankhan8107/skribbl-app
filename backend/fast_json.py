"""High-speed JSON serialization and deserialization adapter.

Uses orjson (written in Rust) for 3-5x faster serialization/deserialization
than standard library json, with transparent fallback if unavailable.
"""

from typing import Any

try:
    import orjson

    JSONDecodeError = orjson.JSONDecodeError

    def json_dumps(obj: Any) -> str:
        """Serialize obj to JSON string via orjson (3-5x faster than stdlib)."""
        return orjson.dumps(obj).decode("utf-8")

    def json_dumps_bytes(obj: Any) -> bytes:
        """Serialize obj to JSON bytes directly without UTF-8 decoding pass."""
        return orjson.dumps(obj)

    def json_loads(data: str | bytes | bytearray | memoryview) -> Any:
        """Deserialize JSON from string or bytes via orjson."""
        return orjson.loads(data)

except ImportError:
    import json

    JSONDecodeError = json.JSONDecodeError

    def json_dumps(obj: Any) -> str:
        return json.dumps(obj)

    def json_dumps_bytes(obj: Any) -> bytes:
        return json.dumps(obj).encode("utf-8")

    def json_loads(data: str | bytes | bytearray | memoryview) -> Any:
        return json.loads(data)

