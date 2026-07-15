# Game Logic

## Game Flow

```
LOBBY → WORD_SELECTION → PLAYING → (repeat per turn) → GAME_OVER
  │                                                         │
  └────────────────── REMATCH ◄─────────────────────────────┘
```

### States

| State | Description |
|-------|-------------|
| `LOBBY` | Players join, host configures settings, ready check |
| `WORD_SELECTION` | Drawer picks from 3 words (15s timeout) |
| `PLAYING` | Active turn — drawer draws, guessers guess |
| `GAME_OVER` | Final scores displayed, rematch available |

## Turn Lifecycle

1. **Word Selection** (15 seconds max)
   - Server sends `word_choices` with 3 words to the drawer
   - Server broadcasts `drawer_selecting` to all players
   - Drawer sends `select_word` to pick one
   - If no selection in 15s → server auto-assigns randomly and sends `word_assigned`

2. **Turn Start**
   - Server broadcasts `turn_started` with hint (underscores) and duration
   - Server broadcasts `clear_canvas` to reset all canvases
   - Turn timer starts counting down

3. **During Turn**
   - Drawer draws → strokes broadcast to all
   - Guessers submit guesses → correct matches award points
   - Hints revealed at 40% and 70% elapsed time

4. **Turn End** (one of three reasons)
   - Timer expires (`timer_expired`)
   - All guessers guessed correctly (`all_guessed`)
   - Drawer disconnected (`drawer_disconnected`)

5. **Advance**
   - Next player becomes drawer → go to step 1
   - If all players have drawn this round → increment round
   - If final round complete → transition to `GAME_OVER`

## Scoring

### Guesser Score

Uses exponential decay with a position multiplier:

```
base_score = max(50, round(500 × (1 - elapsed/duration)²))
final_score = round(base_score × multiplier)
```

**Position multipliers:**
| Position | Multiplier |
|----------|-----------|
| 1st guesser | 1.5× |
| 2nd guesser | 1.2× |
| 3rd guesser | 1.0× |
| 4th+ guesser | 0.9× |

**Score range:** 45–750 points per correct guess (50×0.9 to 500×1.5).

**Key property:** Earlier guesses always score more than later guesses. The first guesser earns significantly more than subsequent guessers.

### Drawer Bonus

```
drawer_bonus = round(average(all_guesser_scores_this_turn))
```

If no one guesses correctly → drawer gets 0 points.

### Cumulative Scores

Scores only increase. Points are never deducted. Player scores accumulate across all rounds.

## Hint Progression

### Initial Hint

All non-space characters are replaced with underscores. Spaces are preserved.

Example: "ice cream" → `['_', '_', '_', ' ', '_', '_', '_', '_', '_']`

### Reveal Schedule

| Time Elapsed | Action |
|-------------|--------|
| 0% | Initial hint (all underscores) |
| 40% | Reveal 1 random character |
| 70% | Reveal 1 additional random character |

### Constraints

- Hints are never sent to the drawer (they know the word)
- At least one character always remains hidden (never fully reveals)
- Only unrevealed non-space characters are candidates for reveal

## Word Selection

### Word Pool

- Default word list: 200+ common nouns/objects
- Per-game shuffled copy maintained in `Room.word_pool`
- Used words tracked in `Room.used_words`

### Selection Process

1. Draw 3 unique words from the pool (not previously used in this session)
2. Present choices to drawer
3. On pool exhaustion → reshuffle full list and reuse

### Auto-Select

If the drawer doesn't pick a word within 15 seconds, the server randomly assigns one of the 3 choices.

## Disconnection Handling

### Grace Window (120 seconds)

When a player disconnects:
1. Player record retained with `is_connected = False`
2. `cleanup_task` scheduled (fires after 120s)
3. If player reconnects → task cancelled, state restored
4. If 120s expires → player permanently removed

### During Disconnection

- Player receives 0 points for any turns that occur
- Player is skipped if it would be their turn to draw
- Player remains in the player list (shown as disconnected)

### Drawer Disconnect

If the current drawer disconnects:
- Turn ends immediately
- All players receive 0 points for that turn
- Game advances to the next turn

### Fewer Than 2 Players

When fewer than 2 connected players remain:
1. Server starts a 20-second countdown
2. Broadcasts `waiting_for_reconnect` to remaining players
3. If someone reconnects → countdown cancelled, `reconnect_resumed` broadcast
4. If countdown expires → game ends with `game_ended_insufficient_players`
5. Host can send `end_game_now` to skip the countdown

## Drawer Rotation

Players take turns as drawer in a consistent order:
1. First drawer = first player in the room's player list
2. After each turn, advance to the next connected player
3. Skip any disconnected players
4. When all players have drawn → round complete, start next round
5. Same rotation order across all rounds

## Rematch

When host initiates a rematch:
1. All player scores reset to 0
2. Round counter reset
3. Used words and word pool reset (fresh shuffled pool)
4. Room transitions back to LOBBY state
5. `rematch_started` broadcast with reset state
