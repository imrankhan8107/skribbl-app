"""Game engine module for turn/round logic, scoring, and hint progression."""

import asyncio
import json
import random
import re
import time
from collections import deque

from backend.models import Room, RoomState, TurnEndReason, TurnState
from backend.words import WORDS


def _levenshtein_distance(s1: str, s2: str) -> int:
    """Compute the Levenshtein edit distance between two strings."""
    if len(s1) < len(s2):
        return _levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (c1 != c2)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row
    return prev_row[-1]


def draw_word_choices(room: Room) -> list[str]:
    """Return 3 unique word choices for the drawer from the room's word pool.

    Maintains a per-game shuffled word pool and tracks used_words to avoid
    repeating words within a session. When the pool is exhausted (fewer than
    3 unused words remain), the pool is reshuffled:
      - If there are enough unused words (>= 3), reshuffle only from unused words.
      - If all words have been used, clear used_words and reshuffle the full list.

    Args:
        room: The Room instance containing word_pool and used_words state.

    Returns:
        A list of 3 unique words for the drawer to choose from.
    """
    # Filter pool to only words not already used in this session
    available = [w for w in room.word_pool if w not in room.used_words]

    if len(available) < 3:
        # Check how many unused words exist in the full list
        unused_from_full = [w for w in WORDS if w not in room.used_words]

        if len(unused_from_full) < 3:
            # All words exhausted — clear used_words and reshuffle full list
            room.used_words = set()
            new_pool = list(WORDS)
        else:
            # Reshuffle from unused words only
            new_pool = unused_from_full

        random.shuffle(new_pool)
        room.word_pool = deque(new_pool)
        available = [w for w in room.word_pool if w not in room.used_words]

    # Pop 3 words from the available pool (use first 3 available)
    choices = available[:3]
    # Remove chosen words from word_pool
    # Since deque doesn't have efficient arbitrary removal, rebuild without chosen words
    room.word_pool = deque(w for w in room.word_pool if w not in set(choices))

    return choices


def select_word(room: Room, word: str) -> None:
    """Record the drawer's selected word as used in this session.

    Args:
        room: The Room instance to update.
        word: The word selected by the drawer.
    """
    room.used_words.add(word)


def generate_initial_hint(word: str) -> list[str]:
    """Generate the initial hint for a word.

    Returns a list of characters where each non-space character is replaced
    with '_' and spaces are preserved.

    Example: "ice cream" → ['_', '_', '_', ' ', '_', '_', '_', '_', '_']
    """
    return [' ' if ch == ' ' else '_' for ch in word]


def reveal_hint_char(hint: list[str], word: str) -> list[str]:
    """Reveal one random unrevealed non-space character in the hint.

    Finds all indices where hint[i] == '_' (unrevealed non-space characters).
    If there are 0 or 1 unrevealed characters, returns hint unchanged
    (never reveals the last hidden char).
    Otherwise, picks one random unrevealed index and sets hint[i] = word[i].

    Returns the modified hint.
    """
    unrevealed = [i for i, ch in enumerate(hint) if ch == '_']

    # Never reveal the last hidden character
    if len(unrevealed) <= 1:
        return hint

    idx = random.choice(unrevealed)
    hint[idx] = word[idx]
    return hint


def compute_guesser_score(elapsed: float, duration: float, position: int = 1) -> int:
    """Compute the score for a guesser who guessed correctly.

    Uses exponential decay for time-based scoring plus a position multiplier.
    Earlier guessers earn significantly more than later ones.

    Formula:
        base_score = round(500 * (1 - (elapsed / duration)) ** 2)
        base_score = max(50, base_score)
        multiplier = 1.5 for 1st, 1.2 for 2nd, 1.0 for 3rd, 0.9 for 4th+
        final_score = round(base_score * multiplier)

    Args:
        elapsed: Seconds since the turn started when the player guessed.
        duration: Total turn duration in seconds.
        position: The guess order position (1 = first guesser, 2 = second, etc.)

    Returns:
        An integer score (minimum 50).
    """
    import math

    # Exponential decay — much steeper than linear
    ratio = min(1.0, max(0.0, elapsed / duration))
    base_score = round(500 * (1 - ratio) ** 2)
    base_score = max(50, base_score)

    # Position multiplier — first guesser gets 1.5x, second 1.2x, third 1.0x, 4th+ 0.9x
    multipliers = {1: 1.5, 2: 1.2, 3: 1.0}
    multiplier = multipliers.get(position, 0.9)

    return round(base_score * multiplier)


def compute_drawer_bonus(guesser_scores: list[int]) -> int:
    """Compute the drawer's bonus based on guesser scores.

    The drawer receives a bonus equal to the average of all correct guessers'
    scores for the turn, rounded to the nearest integer. If no one guessed
    correctly, the bonus is 0.

    Args:
        guesser_scores: List of scores awarded to guessers who guessed correctly.

    Returns:
        The drawer's bonus as an integer, or 0 if the list is empty.
    """
    if not guesser_scores:
        return 0
    return round(sum(guesser_scores) / len(guesser_scores))


async def start_turn(room: Room, room_manager) -> None:
    """Start a new turn: send word choices to the drawer and begin selection timer.

    1. Gets the current drawer from room.players[room.drawer_index]
    2. Draws 3 word choices
    3. Sends word_choices message ONLY to the drawer
    4. Transitions room state to WORD_SELECTION
    5. Schedules a 15-second auto-select timer

    Args:
        room: The Room instance.
        room_manager: The RoomManager for broadcasting messages.
    """
    drawer = room.players[room.drawer_index]
    choices = draw_word_choices(room)

    # Store choices temporarily on the room for validation during selection
    room._pending_word_choices = choices

    # Send word_choices only to the drawer
    message = json.dumps({
        "type": "word_choices",
        "payload": {"choices": choices},
    })
    if drawer.is_connected and drawer.websocket is not None:
        try:
            await drawer.websocket.send_text(message)
        except Exception:
            pass

    # Transition to WORD_SELECTION state
    room.state = RoomState.WORD_SELECTION

    # Broadcast to all players who the new drawer is (so non-drawers show the name)
    await room_manager.broadcast(room.code, {
        "type": "drawer_selecting",
        "payload": {"drawer_id": drawer.id, "drawer_name": drawer.name},
    })

    # Schedule 15-second auto-select timer
    async def auto_select():
        await asyncio.sleep(15)
        # If still in word selection, auto-select a random word
        if room.state == RoomState.WORD_SELECTION and hasattr(room, '_pending_word_choices'):
            word = random.choice(room._pending_word_choices)
            await handle_word_selection(room, drawer.id, word, room_manager)

    room._auto_select_task = asyncio.create_task(auto_select())


async def handle_word_selection(room: Room, player_id: str, word: str, room_manager) -> None:
    """Handle the drawer's word selection and start the turn.

    1. Validates that player_id matches the current drawer
    2. Validates that word is one of the offered choices
    3. Creates TurnState and sets up timers
    4. Broadcasts turn_started and clear_canvas

    Args:
        room: The Room instance.
        player_id: The ID of the player selecting the word.
        word: The selected word.
        room_manager: The RoomManager for broadcasting messages.
    """
    drawer = room.players[room.drawer_index]

    # Validate that the player is the current drawer
    if player_id != drawer.id:
        return

    # Validate that the word is one of the offered choices
    pending_choices = getattr(room, '_pending_word_choices', [])
    if word not in pending_choices:
        return

    # Cancel the auto-select timer if it's still running
    auto_select_task = getattr(room, '_auto_select_task', None)
    if auto_select_task is not None and not auto_select_task.done():
        auto_select_task.cancel()
        room._auto_select_task = None

    # Mark the word as used
    select_word(room, word)

    # Create TurnState
    hint = generate_initial_hint(word)
    turn_state = TurnState(
        drawer_id=drawer.id,
        word=word,
        hint=hint,
        start_time=time.time(),
        word_choices=pending_choices,
    )
    room.turn = turn_state

    # Transition to PLAYING state
    room.state = RoomState.PLAYING

    # Reset all players' has_guessed to False
    for player in room.players:
        player.has_guessed = False

    # Clean up pending choices
    if hasattr(room, '_pending_word_choices'):
        del room._pending_word_choices

    duration = room.config.turn_duration

    # Broadcast turn_started to all players
    await room_manager.broadcast(room.code, {
        "type": "turn_started",
        "payload": {
            "drawer_id": drawer.id,
            "hint": hint,
            "duration": duration,
            "round": room.current_round,
        },
    })

    # Send the selected word privately to the drawer (for auto-select case)
    if drawer.is_connected and drawer.websocket is not None:
        try:
            import json as _json
            await drawer.websocket.send_text(_json.dumps({
                "type": "word_assigned",
                "payload": {"word": word},
            }))
        except Exception:
            pass

    # Broadcast clear_canvas to all players (each turn starts fresh)
    await room_manager.broadcast(room.code, {
        "type": "clear_canvas",
        "payload": {},
    })

    # Schedule hint reveal at 40% of duration
    async def reveal_hint_40():
        await asyncio.sleep(duration * 0.4)
        # Check if the turn is still active
        if room.turn is not None and room.turn is turn_state and room.state == RoomState.PLAYING:
            reveal_hint_char(turn_state.hint, turn_state.word)
            await room_manager.broadcast(room.code, {
                "type": "hint_update",
                "payload": {"hint": turn_state.hint},
            })

    # Schedule hint reveal at 70% of duration
    async def reveal_hint_70():
        await asyncio.sleep(duration * 0.7)
        # Check if the turn is still active
        if room.turn is not None and room.turn is turn_state and room.state == RoomState.PLAYING:
            reveal_hint_char(turn_state.hint, turn_state.word)
            await room_manager.broadcast(room.code, {
                "type": "hint_update",
                "payload": {"hint": turn_state.hint},
            })

    # Schedule turn timer (end turn when duration expires)
    async def turn_timer():
        await asyncio.sleep(duration)
        # Check if the turn is still active
        if room.turn is not None and room.turn is turn_state and room.state == RoomState.PLAYING:
            await end_turn(room, TurnEndReason.TIMER_EXPIRED, room_manager)

    turn_state.hint_task_40 = asyncio.create_task(reveal_hint_40())
    turn_state.hint_task_70 = asyncio.create_task(reveal_hint_70())
    turn_state.timer_task = asyncio.create_task(turn_timer())


async def handle_guess(room: Room, player_id: str, text: str, room_manager) -> None:
    """Handle a guess submission from a guesser.

    Performs case-insensitive strip comparison against the current word.
    On correct guess: marks player, awards score, broadcasts guess_correct,
    and ends turn if all connected guessers have guessed.
    On incorrect guess: broadcasts the guess as a chat_message.

    Args:
        room: The Room instance.
        player_id: The ID of the guessing player.
        text: The guess text submitted by the player.
        room_manager: The RoomManager for broadcasting messages.
    """
    # Validate the turn is active
    if room.turn is None or room.state != RoomState.PLAYING:
        return

    # Find the player
    player = room.get_player(player_id)
    if player is None:
        return

    # Drawer cannot guess
    if player.id == room.turn.drawer_id:
        return

    # Already guessed — silently ignore (Property 14)
    if player.has_guessed:
        return

    # Disconnected players cannot guess
    if not player.is_connected:
        return

    # Case-insensitive strip comparison (Property 13)
    if text.strip().lower() == room.turn.word.lower():
        # Correct guess
        player.has_guessed = True
        player._guess_time = time.time()

        # Track guess order for position-based scoring (no sort needed at end_turn)
        room.turn.guess_order.append(player.id)

        # Compute score
        elapsed = player._guess_time - room.turn.start_time
        score = compute_guesser_score(elapsed, room.config.turn_duration)
        player.score += score

        # Broadcast guess_correct — do NOT include the word (Requirement 6.3, 6.6)
        await room_manager.broadcast(room.code, {
            "type": "guess_correct",
            "payload": {"player_name": player.name},
        })

        # Check if all connected guessers have guessed (Requirement 6.7)
        all_guessed = all(
            p.has_guessed
            for p in room.players
            if p.id != room.turn.drawer_id and p.is_connected
        )
        if all_guessed:
            await end_turn(room, TurnEndReason.ALL_GUESSED, room_manager)
    else:
        # Incorrect guess — check if it's close before broadcasting
        guess_normalized = text.strip().lower()
        word_normalized = room.turn.word.lower()
        is_close = False
        if len(guess_normalized) >= 3:
            distance = _levenshtein_distance(guess_normalized, word_normalized)
            if distance <= 2:
                is_close = True

        if is_close:
            # Close guess — DON'T broadcast the actual guess (it's too revealing)
            # Only show the "is very close!" system message
            await room_manager.broadcast(room.code, {
                "type": "chat_message",
                "payload": {
                    "player_name": "System",
                    "text": f"{player.name} is very close!",
                    "is_system": True,
                },
            })
        else:
            # Not close — broadcast as normal chat_message
            await room_manager.broadcast(room.code, {
                "type": "chat_message",
                "payload": {
                    "player_name": player.name,
                    "text": text,
                    "is_system": False,
                },
            })


async def handle_chat(room: Room, player_id: str, text: str, room_manager) -> None:
    """Handle a chat message from the drawer.

    Only the drawer can send chat messages. The current word is stripped
    from the message text before broadcasting to prevent accidental reveals.

    Args:
        room: The Room instance.
        player_id: The ID of the chatting player.
        text: The chat text submitted by the player.
        room_manager: The RoomManager for broadcasting messages.
    """
    # Validate the turn is active
    if room.turn is None or room.state != RoomState.PLAYING:
        return

    # Find the player
    player = room.get_player(player_id)
    if player is None:
        return

    # Only the drawer can send chat messages (Requirement 6.8)
    if player.id != room.turn.drawer_id:
        return

    # Strip the current word from the message (case-insensitive) to prevent reveals (Requirement 6.6)
    word = room.turn.word
    sanitized_text = re.sub(re.escape(word), "***", text, flags=re.IGNORECASE)

    # Broadcast chat_message
    await room_manager.broadcast(room.code, {
        "type": "chat_message",
        "payload": {
            "player_name": player.name,
            "text": sanitized_text,
            "is_system": False,
        },
    })


async def end_turn(room: Room, reason: TurnEndReason, room_manager) -> None:
    """End the current turn, compute scores, and advance.

    1. Cancels all timer tasks
    2. Computes scores for guessers and drawer
    3. Updates cumulative player scores
    4. Broadcasts turn_ended
    5. Advances to next turn or round

    Args:
        room: The Room instance.
        reason: The reason the turn ended.
        room_manager: The RoomManager for broadcasting messages.
    """
    turn_state = room.turn
    if turn_state is None:
        return

    # Cancel all timer tasks
    for task in (turn_state.timer_task, turn_state.hint_task_40, turn_state.hint_task_70):
        if task is not None and not task.done():
            task.cancel()

    # Compute scores for guessers who guessed correctly
    duration = room.config.turn_duration
    guesser_scores = []
    scores_payload = {}

    if reason != TurnEndReason.DRAWER_DISCONNECTED:
        # Use guess_order (maintained during the turn) — no sorting needed
        for position, player_id in enumerate(turn_state.guess_order, start=1):
            player = room.get_player(player_id)
            if player is None:
                continue
            elapsed = getattr(player, '_guess_time', time.time()) - turn_state.start_time
            elapsed = max(0, min(elapsed, duration))
            score = compute_guesser_score(elapsed, duration, position)
            guesser_scores.append(score)
            player.score += score
            scores_payload[player.id] = score

        # Compute drawer bonus
        drawer_bonus = compute_drawer_bonus(guesser_scores)
        drawer = room.get_player(turn_state.drawer_id)
        if drawer is not None:
            drawer.score += drawer_bonus
            scores_payload[drawer.id] = drawer_bonus

    # Broadcast turn_ended with word, scores, and reason
    await room_manager.broadcast(room.code, {
        "type": "turn_ended",
        "payload": {
            "word": turn_state.word,
            "scores": scores_payload,
            "reason": reason.value,
        },
    })

    # Clear turn state
    room.turn = None

    # Advance to next turn or round
    await advance_turn_or_round(room, room_manager)


async def advance_turn_or_round(room: Room, room_manager) -> None:
    """Advance the drawer index, incrementing rounds when all players have drawn.

    1. Increments drawer_index
    2. If all players have drawn, resets drawer_index and increments round
    3. If all rounds complete, transitions to GAME_OVER
    4. Skips disconnected players
    5. Checks for < 2 connected players and ends game if so
    6. Otherwise, starts the next turn

    Args:
        room: The Room instance.
        room_manager: The RoomManager for broadcasting messages.
    """
    # Check if < 2 connected players remain — end game immediately
    connected_count = sum(1 for p in room.players if p.is_connected)
    if connected_count < 2:
        await room_manager._end_game_insufficient_players(room)
        return

    # Increment drawer index
    room.drawer_index += 1

    # If all players have drawn this round, advance to next round
    if room.drawer_index >= len(room.players):
        room.drawer_index = 0
        room.current_round += 1

    # Check if the game is over (all rounds complete)
    if room.current_round > room.config.num_rounds:
        room.state = RoomState.GAME_OVER

        # Build final ranked scores
        ranked_players = sorted(room.players, key=lambda p: p.score, reverse=True)
        final_scores = [
            {"id": p.id, "name": p.name, "score": p.score}
            for p in ranked_players
        ]

        await room_manager.broadcast(room.code, {
            "type": "game_over",
            "payload": {"scores": final_scores},
        })
        return

    # Skip disconnected players when advancing drawer
    attempts = 0
    while attempts < len(room.players):
        current_drawer = room.players[room.drawer_index]
        if current_drawer.is_connected:
            break
        # Skip this player, advance to next
        room.drawer_index += 1
        if room.drawer_index >= len(room.players):
            room.drawer_index = 0
            room.current_round += 1
            if room.current_round > room.config.num_rounds:
                room.state = RoomState.GAME_OVER
                ranked_players = sorted(room.players, key=lambda p: p.score, reverse=True)
                final_scores = [
                    {"id": p.id, "name": p.name, "score": p.score}
                    for p in ranked_players
                ]
                await room_manager.broadcast(room.code, {
                    "type": "game_over",
                    "payload": {"scores": final_scores},
                })
                return
        attempts += 1
    else:
        # No connected players found — end game
        room.state = RoomState.GAME_OVER
        ranked_players = sorted(room.players, key=lambda p: p.score, reverse=True)
        final_scores = [
            {"id": p.id, "name": p.name, "score": p.score}
            for p in ranked_players
        ]
        await room_manager.broadcast(room.code, {
            "type": "game_over",
            "payload": {"scores": final_scores},
        })
        return

    # Start the next turn
    await start_turn(room, room_manager)
