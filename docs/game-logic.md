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

### Guess Streaks & First Guesser Bonus

- Each consecutive turn a player guesses correctly increases their `streak`.
- The first correct guesser in a turn is flagged with `is_first_guesser = true` and receives a 1.5× multiplier.
- Failing to guess the word before the timer expires resets `streak` to 0 (drawers preserve their streak).

### Close Guess Detection

- When an incorrect guess is submitted, the server calculates the Levenshtein distance against the target word:
  - If $\text{length} \ge 3$ and $\text{distance} \le 2$:
    - The guess is classified as **close**.
    - The raw guess text is withheld from the room to prevent spoiling the answer.
    - A system message `"{Player} is very close!"` is broadcast to the room.

### Cumulative Session Scores & MVP Awards

Session metrics persist across rematches within the same room:
- `session_score`: Total points accumulated across all games.
- `session_wins`: Total match victories.
- `session_games`: Total games completed.

At game over, automated MVP awards are calculated and displayed:
- ⚡ **Speed Demon**: Lowest elapsed time for a correct guess.
- 🎯 **Sniper**: Most first-guesser awards.
- 🔥 **Streak Master**: Longest unbroken correct guess streak.
- 🎨 **Master Artist**: Most total points earned while drawing.

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

## Word Selection & Themes

### Curated Word Packs

The drawer is presented with 3 thematic packs (e.g., Animals, Food & Drink, Fantasy, Pop Culture, Everyday Objects) or custom words injected by the host.
- Choosing a word applies its corresponding theme emoji and title to the round.
- Guessers and spectators see the active `current_theme` badge throughout the turn.
- If the drawer makes no selection within 15 seconds, the server auto-selects a word from the first pack.

## Spectator Mode & Mid-Game Join

### Joining Mid-Game
- Players joining an in-progress match can enter directly as **Spectators** (`as_spectator = true`), bypassing game-blocking prompts.
- Players requesting active participation trigger an interactive **Host Approval Banner**:
  - `🎮 Accept as Player`: joins active rotation with initial score = 0.
  - `👁️ Accept as Spectator`: joins as spectator.
  - `✕ Decline`: rejects request.

### Spectator Role Promotion (Mid-Game)
- Live spectators can click **"Join as Player"** to request the host promote them to active player status.
- **Anti-Spam Constraint**: Spectators are strictly capped at **2 requests per game** (`become_player_requests_count`).
- Host approval converts the spectator into an active player immediately with `score = 0`, announces the join in room chat, and broadcasts an updated player list.
- Pending requests automatically migrate to the new host if the original host leaves or transfers leadership.

## Moderation & Democratic Vote-to-Kick

### Host Direct Kick
- The room host can immediately kick any player from the lobby or active game.

### Democratic Vote-Kick
- Any active player can initiate a vote-to-kick against a disruptive player (the host cannot be vote-kicked).
- Requires a calculated majority threshold ($\ge \lceil N / 2 \rceil$ of eligible voters).
- An interactive banner is displayed to all players with a 30-second voting window.
- Upon passing, the target is kicked and redirected with a clear notification; failed votes initiate a cooldown.

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

### Fewer Than 2 Active Players

When fewer than 2 connected active players remain:
1. Server starts a 20-second countdown
2. Broadcasts `waiting_for_reconnect` to remaining players
3. If someone reconnects or a spectator becomes a player → countdown cancelled, `reconnect_resumed` broadcast
4. If countdown expires → game ends with `game_ended_insufficient_players`
5. Host can send `end_game_now` to skip the countdown

## Drawer Rotation

Players take turns as drawer in a consistent order:
1. First drawer = first active player in the room's player list
2. After each turn, advance to the next connected active player
3. Spectators and disconnected players are skipped
4. When all eligible players have drawn → round complete, start next round
5. Same rotation order across all rounds

## Rematch

When host initiates a rematch:
1. In-game scores reset to 0; cumulative session stats remain intact
2. Spectator request counts reset to 0
3. Round counter reset to 0
4. Used words and word pool reset
5. Room transitions back to LOBBY state
6. `rematch_started` broadcast with fresh state
