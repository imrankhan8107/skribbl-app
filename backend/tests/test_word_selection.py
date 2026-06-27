"""Unit tests for word selection logic in game_engine.py."""

import pytest
from backend.game_engine import draw_word_choices, select_word
from backend.models import Room
from backend.words import WORDS


def _make_room() -> Room:
    """Create a minimal Room for testing."""
    return Room(code="ABCDEF", host_id="host-1")


class TestDrawWordChoices:
    """Tests for draw_word_choices function."""

    def test_returns_three_words(self):
        """draw_word_choices always returns exactly 3 words."""
        room = _make_room()
        choices = draw_word_choices(room)
        assert len(choices) == 3

    def test_returned_words_are_from_word_list(self):
        """All returned words must come from the WORDS list."""
        room = _make_room()
        choices = draw_word_choices(room)
        for word in choices:
            assert word in WORDS

    def test_returned_words_are_unique(self):
        """The 3 returned words must be distinct."""
        room = _make_room()
        choices = draw_word_choices(room)
        assert len(set(choices)) == 3

    def test_no_word_repeats_within_session(self):
        """Words should not repeat within a session until pool is exhausted."""
        room = _make_room()
        all_selected = set()

        # Draw and select words multiple times (well within pool size)
        for _ in range(20):
            choices = draw_word_choices(room)
            # None of the choices should be in used_words
            for word in choices:
                assert word not in room.used_words
            # Simulate drawer selecting the first choice
            selected = choices[0]
            select_word(room, selected)
            assert selected not in all_selected or len(all_selected) >= len(WORDS)
            all_selected.add(selected)

    def test_pool_reshuffles_when_exhausted(self):
        """When all words are used, used_words is cleared and pool reshuffled."""
        room = _make_room()

        # Use all words except 2 (so next draw_word_choices will need to reshuffle)
        room.used_words = set(WORDS[:-2])
        room.word_pool = list(WORDS)

        # This should trigger a reshuffle since only 2 available words remain
        choices = draw_word_choices(room)
        assert len(choices) == 3

        # After reshuffle with exhaustion, used_words should be cleared
        # (since fewer than 3 words remained unused)
        assert len(room.used_words) == 0

    def test_pool_reshuffles_partial_when_possible(self):
        """When pool runs low but unused words exist, reshuffle without clearing used_words."""
        room = _make_room()

        # Use 10 words and empty the pool
        used = set(WORDS[:10])
        room.used_words = used
        room.word_pool = []  # Empty pool forces reshuffle

        choices = draw_word_choices(room)
        assert len(choices) == 3

        # used_words should still contain the original 10 (pool was reshuffled from remaining)
        assert room.used_words == used

        # Choices should not be in used_words
        for word in choices:
            assert word not in used

    def test_choices_not_in_used_words(self):
        """Returned choices must never be in room.used_words."""
        room = _make_room()
        # Mark some words as used
        room.used_words = set(WORDS[:5])
        room.word_pool = list(WORDS)

        choices = draw_word_choices(room)
        for word in choices:
            assert word not in room.used_words


class TestSelectWord:
    """Tests for select_word function."""

    def test_adds_word_to_used_words(self):
        """select_word should add the word to room.used_words."""
        room = _make_room()
        assert "apple" not in room.used_words
        select_word(room, "apple")
        assert "apple" in room.used_words

    def test_multiple_selections_accumulate(self):
        """Multiple select_word calls accumulate in used_words."""
        room = _make_room()
        select_word(room, "apple")
        select_word(room, "banana")
        select_word(room, "car")
        assert room.used_words == {"apple", "banana", "car"}
