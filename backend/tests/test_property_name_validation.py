"""Property-based test for display name validation.

**Validates: Requirements 1.8, 1.9**

Property 3: Display name validation
For any string submitted as a display name, the server SHALL accept it if and only if
its length is between 1 and 20 characters (inclusive); all other strings SHALL be
rejected with a validation error.
"""

import pytest
from unittest.mock import AsyncMock

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.room_manager import RoomManager


@given(name=st.text())
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_display_name_validation_property(name: str):
    """Property 3: Display name validation.

    **Validates: Requirements 1.8, 1.9**

    For any arbitrary text string, the server accepts the name if and only if
    1 <= len(name) <= 20. If accepted, result type is "room_created".
    If rejected, result type is "error" with code "INVALID_NAME".
    """
    manager = RoomManager()
    mock_ws = AsyncMock()
    mock_ws.send_text = AsyncMock()

    result = await manager.create_room(name, mock_ws)

    if 1 <= len(name) <= 20:
        # Name is valid — server should accept
        assert result["type"] == "room_created", (
            f"Expected 'room_created' for valid name {name!r} (len={len(name)}), "
            f"got {result['type']!r}"
        )
    else:
        # Name is invalid — server should reject with INVALID_NAME
        assert result["type"] == "error", (
            f"Expected 'error' for invalid name {name!r} (len={len(name)}), "
            f"got {result['type']!r}"
        )
        assert result["payload"]["code"] == "INVALID_NAME", (
            f"Expected error code 'INVALID_NAME' for name {name!r} (len={len(name)}), "
            f"got {result['payload']['code']!r}"
        )
