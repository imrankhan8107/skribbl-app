"""Unit tests for backend.fast_json adapter module."""

import pytest
from backend.fast_json import JSONDecodeError, json_dumps, json_dumps_bytes, json_loads


def test_json_dumps_and_loads():
    data = {"type": "draw", "payload": {"x": 100, "y": 200, "color": "#ff0000"}}
    serialized = json_dumps(data)
    assert isinstance(serialized, str)
    deserialized = json_loads(serialized)
    assert deserialized == data


def test_json_dumps_bytes():
    data = {"room_code": "ABCDEF", "turn": 1}
    raw_bytes = json_dumps_bytes(data)
    assert isinstance(raw_bytes, bytes)
    deserialized = json_loads(raw_bytes)
    assert deserialized == data


def test_json_loads_invalid_raises_error():
    with pytest.raises(JSONDecodeError):
        json_loads("invalid json data {")

    with pytest.raises(JSONDecodeError):
        json_loads(b"invalid json bytes {")
