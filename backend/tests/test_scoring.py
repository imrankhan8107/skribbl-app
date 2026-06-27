"""Unit tests for scoring functions in game_engine.py.

Scoring uses exponential decay + position multiplier:
- base_score = max(50, round(500 * (1 - elapsed/duration)^2))
- multiplier: 1st=1.5, 2nd=1.2, 3rd=1.0, 4th+=0.9
- final = round(base_score * multiplier)
"""

from backend.game_engine import compute_drawer_bonus, compute_guesser_score


class TestComputeGuesserScore:
    """Tests for compute_guesser_score."""

    def test_score_at_elapsed_zero_first_guesser(self):
        """1st guesser at elapsed=0 gets max: 500 * 1.5 = 750."""
        assert compute_guesser_score(0, 80, position=1) == 750

    def test_score_at_elapsed_zero_second_guesser(self):
        """2nd guesser at elapsed=0 gets: 500 * 1.2 = 600."""
        assert compute_guesser_score(0, 80, position=2) == 600

    def test_score_at_elapsed_zero_third_guesser(self):
        """3rd guesser at elapsed=0 gets: 500 * 1.0 = 500."""
        assert compute_guesser_score(0, 80, position=3) == 500

    def test_score_at_elapsed_equals_duration(self):
        """At elapsed=duration, base is 50. 1st guesser: 50 * 1.5 = 75."""
        assert compute_guesser_score(80, 80, position=1) == 75

    def test_score_at_half_duration_first_guesser(self):
        """At elapsed=duration/2, base = 500*(0.5^2) = 125. 1st: 125*1.5 = 188."""
        assert compute_guesser_score(40, 80, position=1) == 188

    def test_score_at_half_duration_third_guesser(self):
        """At elapsed=duration/2, base = 125. 3rd: 125*1.0 = 125."""
        assert compute_guesser_score(40, 80, position=3) == 125

    def test_score_always_at_least_50(self):
        """Score should never drop below 50 (base min) * 0.9 (min multiplier) = 45."""
        score = compute_guesser_score(100, 80, position=4)
        assert score >= 45

    def test_score_exponential_decay(self):
        """Exponential decay should give significantly different scores at different times."""
        score_early = compute_guesser_score(10, 80, position=1)  # 10s elapsed
        score_late = compute_guesser_score(60, 80, position=1)   # 60s elapsed
        # With exponential decay, early guess should score MUCH more than late
        assert score_early > score_late * 2

    def test_position_matters(self):
        """Same time, different positions should give different scores."""
        score_1st = compute_guesser_score(20, 80, position=1)
        score_2nd = compute_guesser_score(20, 80, position=2)
        score_3rd = compute_guesser_score(20, 80, position=3)
        assert score_1st > score_2nd > score_3rd

    def test_default_position_is_1(self):
        """Default position parameter should be 1."""
        assert compute_guesser_score(0, 80) == compute_guesser_score(0, 80, position=1)


class TestComputeDrawerBonus:
    """Tests for compute_drawer_bonus."""

    def test_bonus_with_multiple_scores(self):
        """Bonus should be the average of guesser scores, rounded."""
        scores = [750, 400, 300]
        assert compute_drawer_bonus(scores) == round((750 + 400 + 300) / 3)

    def test_bonus_with_empty_list(self):
        """Bonus should be 0 when no one guessed correctly."""
        assert compute_drawer_bonus([]) == 0

    def test_bonus_with_single_score(self):
        """Bonus should equal the single guesser's score."""
        assert compute_drawer_bonus([350]) == 350

    def test_bonus_rounds_correctly(self):
        """Bonus should round to nearest integer."""
        scores = [100, 101]
        result = compute_drawer_bonus(scores)
        assert result == round((100 + 101) / 2)

    def test_bonus_with_all_max_scores(self):
        """Bonus should be 750 when all guessers scored 750 (1st place max)."""
        assert compute_drawer_bonus([750, 750, 750]) == 750

    def test_bonus_with_all_min_scores(self):
        """Bonus should be 45 when all guessers scored 45."""
        assert compute_drawer_bonus([45, 45, 45]) == 45
