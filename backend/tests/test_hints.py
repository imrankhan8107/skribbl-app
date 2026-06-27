"""Unit tests for hint generation functions in game_engine.py."""

import pytest
from backend.game_engine import generate_initial_hint, reveal_hint_char


class TestGenerateInitialHint:
    """Tests for generate_initial_hint."""

    def test_simple_word(self):
        """Initial hint replaces all letters with underscores."""
        hint = generate_initial_hint("hello")
        assert hint == ['_', '_', '_', '_', '_']

    def test_word_with_space(self):
        """Spaces are preserved in the initial hint."""
        hint = generate_initial_hint("ice cream")
        assert hint == ['_', '_', '_', ' ', '_', '_', '_', '_', '_']

    def test_hint_length_matches_word(self):
        """Hint length equals word length."""
        word = "elephant"
        hint = generate_initial_hint(word)
        assert len(hint) == len(word)

    def test_spaces_preserved(self):
        """All space positions in the word are spaces in the hint."""
        word = "hot dog"
        hint = generate_initial_hint(word)
        for i, ch in enumerate(word):
            if ch == ' ':
                assert hint[i] == ' '

    def test_non_spaces_are_underscores(self):
        """All non-space positions in the word are underscores in the hint."""
        word = "hot dog"
        hint = generate_initial_hint(word)
        for i, ch in enumerate(word):
            if ch != ' ':
                assert hint[i] == '_'

    def test_single_character_word(self):
        """A single character word produces a single underscore."""
        hint = generate_initial_hint("a")
        assert hint == ['_']

    def test_multiple_spaces(self):
        """Multiple spaces are all preserved."""
        word = "a b c"
        hint = generate_initial_hint(word)
        assert hint == ['_', ' ', '_', ' ', '_']


class TestRevealHintChar:
    """Tests for reveal_hint_char."""

    def test_reveals_exactly_one_character(self):
        """Revealing a hint char reveals exactly one underscore."""
        word = "hello"
        hint = generate_initial_hint(word)
        original_underscores = hint.count('_')
        new_hint = reveal_hint_char(hint, word)
        new_underscores = new_hint.count('_')
        assert new_underscores == original_underscores - 1

    def test_revealed_char_matches_word(self):
        """The revealed character matches the corresponding character in the word."""
        word = "hello"
        hint = generate_initial_hint(word)
        new_hint = reveal_hint_char(hint, word)
        for i, ch in enumerate(new_hint):
            if ch != '_' and ch != ' ':
                assert ch == word[i]

    def test_never_reveals_last_hidden_char(self):
        """When only one underscore remains, reveal_hint_char does nothing."""
        word = "hello"
        # Manually set hint to have only one underscore remaining
        hint = list(word)
        hint[2] = '_'  # Only index 2 is hidden
        result = reveal_hint_char(hint, word)
        assert result.count('_') == 1
        assert result[2] == '_'

    def test_no_underscores_returns_unchanged(self):
        """When no underscores remain, hint is returned unchanged."""
        word = "hello"
        hint = list(word)  # Fully revealed
        result = reveal_hint_char(hint, word)
        assert result == list(word)

    def test_hint_length_unchanged_after_reveal(self):
        """Hint length never changes after a reveal."""
        word = "ice cream"
        hint = generate_initial_hint(word)
        original_length = len(hint)
        new_hint = reveal_hint_char(hint, word)
        assert len(new_hint) == original_length

    def test_multiple_reveals_always_leave_one_hidden(self):
        """After repeated reveals, at least one underscore always remains."""
        word = "hello"
        hint = generate_initial_hint(word)
        # Reveal as many times as possible
        for _ in range(len(word)):
            hint = reveal_hint_char(hint, word)
        # At least one underscore must remain
        assert '_' in hint

    def test_spaces_never_affected_by_reveal(self):
        """Spaces in the hint are never changed by reveal operations."""
        word = "ice cream"
        hint = generate_initial_hint(word)
        space_indices = [i for i, ch in enumerate(word) if ch == ' ']
        # Perform several reveals
        for _ in range(5):
            hint = reveal_hint_char(hint, word)
        for idx in space_indices:
            assert hint[idx] == ' '
