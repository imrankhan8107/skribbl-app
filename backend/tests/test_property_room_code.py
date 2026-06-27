"""Property-based tests for room code uniqueness.

Validates: Requirements 1.1
"""

import pytest
from unittest.mock import AsyncMock

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.room_manager import RoomManager


@given(n=st.integers(min_value=1, max_value=500))
@settings(max_examples=200, deadline=None)
@pytest.mark.asyncio
async def test_room_codes_are_unique(n: int):
    """Property 1: Room code uniqueness

    For any sequence of N room creation requests, every generated Room_Code
    SHALL be distinct from all currently active Room_Codes.

    **Validates: Requirements 1.1**
    """
    manager = RoomManager()
    codes = []

    for i in range(n):
        ws = AsyncMock()
        ws.send_text = AsyncMock()
        result = await manager.create_room(f"Player{i}", ws)
        assert result["type"] == "room_created"
        code = result["payload"]["room_code"]

        # Verify code format: 6 characters, alphanumeric, uppercase
        assert len(code) == 6
        assert code.isalnum()
        assert code == code.upper()

        codes.append(code)

    # All codes must be distinct
    assert len(set(codes)) == len(codes), f"Duplicate room codes found among {n} rooms"
