"""Tests for guess close detection and profanity filtering."""

import pytest
from backend.game_engine import filter_profanity, _levenshtein_distance


def test_levenshtein_distance():
    """Verify Levenshtein distance calculations."""
    assert _levenshtein_distance("cat", "cat") == 0
    assert _levenshtein_distance("cat", "bat") == 1
    assert _levenshtein_distance("cat", "cats") == 1
    assert _levenshtein_distance("apple", "aple") == 1
    assert _levenshtein_distance("banana", "babana") == 1


def test_filter_profanity():
    """Verify profanity words are masked while preserving clean words."""
    assert filter_profanity("hello world") == "hello world"
    assert filter_profanity("this is shit") == "this is ****"
    assert filter_profanity("fuck that asshole") == "**** that *******"
    assert filter_profanity("what a nice day") == "what a nice day"

