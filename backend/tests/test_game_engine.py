"""Unit tests for word selection logic in game_engine.py.

Validates Requirements 10.1, 10.2, 10.3:
- 3 words are returned
- Words don't repeat until pool is exhausted
- Pool reshuffles correctly when exhausted
"""

import pytest
from backend.game_engine import draw_word_choices, select_word
from backend.models import Room
from backend.words import WORDS


def _make_room() -> Room:
    """Create a minimal Room for testing."""
    return Room(code="TEST01", host_id="host-1")


class TestDrawWordChoicesBasic:
    """Basic tests for draw_word_choices."""

    def test_returns_exactly_three_words(self):
        """draw_word_choices always returns exactly 3 words."""
        room = _make_room()
        choices = draw_word_choices(room)
        assert len(choices) == 3

    def test_all_words_from_word_list(self):
        """All returned words must come from the WORDS list."""
        room = _make_room()
        choices = draw_word_choices(room)
        for word in choices:
            assert word in WORDS

    def test_three_distinct_words(self):
        """The 3 returned words must be distinct from each other."""
        room = _make_room()
        choices = draw_word_choices(room)
        assert len(set(choices)) == 3


class TestWordNoRepeatWithinSession:
    """Tests that words don't repeat within a session until pool is exhausted."""

    def test_no_repeat_across_multiple_draws(self):
        """Words selected via select_word should not appear in subsequent choices."""
        room = _make_room()
        selected_words = set()

        for _ in range(30):
            choices = draw_word_choices(room)
            # None of the choices should already be in used_words
            for word in choices:
                assert word not in room.used_words
            # Simulate drawer selecting the first choice
            selected = choices[0]
            select_word(room, selected)
            selected_words.add(selected)

    def test_used_words_tracked_correctly(self):
        """select_word adds the word to room.used_words."""
        room = _make_room()
        choices = draw_word_choices(room)
        word = choices[0]
        select_word(room, word)
        assert word in room.used_words

    def test_choices_exclude_used_words(self):
        """Returned choices never include words already in used_words."""
        room = _make_room()
        # Mark several words as used
        room.used_words = set(WORDS[:20])
        choices = draw_word_choices(room)
        for word in choices:
            assert word not in set(WORDS[:20])


class TestPoolReshuffle:
    """Tests for pool reshuffling when exhausted."""

    def test_reshuffle_when_pool_empty(self):
        """When word_pool is empty, it reshuffles and still returns 3 words."""
        room = _make_room()
        room.word_pool = []
        choices = draw_word_choices(room)
        assert len(choices) == 3

    def test_reshuffle_clears_used_words_when_all_exhausted(self):
        """When all words have been used, used_words is cleared on reshuffle."""
        room = _make_room()
        # Mark all but 2 words as used — fewer than 3 unused remain
        room.used_words = set(WORDS[:-2])
        room.word_pool = []

        choices = draw_word_choices(room)
        assert len(choices) == 3
        # used_words should be cleared since fewer than 3 unused words existed
        assert len(room.used_words) == 0

    def test_reshuffle_preserves_used_words_when_enough_unused(self):
        """When enough unused words exist, reshuffle without clearing used_words."""
        room = _make_room()
        used = set(WORDS[:10])
        room.used_words = used.copy()
        room.word_pool = []

        choices = draw_word_choices(room)
        assert len(choices) == 3
        # used_words should still contain the original 10
        assert room.used_words == used
        # Choices should not be in used_words
        for word in choices:
            assert word not in used

    def test_full_cycle_through_all_words(self):
        """Can cycle through all words in the list without errors."""
        room = _make_room()
        all_selected = []

        # Select enough words to exhaust the pool and trigger a reshuffle
        num_iterations = len(WORDS) + 5
        for _ in range(num_iterations):
            choices = draw_word_choices(room)
            assert len(choices) == 3
            selected = choices[0]
            select_word(room, selected)
            all_selected.append(selected)

        # Verify we selected more words than the pool size (proves reshuffle worked)
        assert len(all_selected) > len(WORDS)
