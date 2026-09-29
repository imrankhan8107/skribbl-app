# WebSocket API Reference

All communication between client and server uses a single WebSocket connection at `/ws`. Messages are JSON objects with a `type` field and an optional `payload` field.

```json
{ "type": "message_type", "payload": { ... } }
```

## Connection Lifecycle

1. Client connects to `ws://<host>/ws` (or `wss://` for HTTPS)
2. Server accepts the connection and starts heartbeat monitoring
3. Client sends `create_room` or `join_room` to identify themselves
4. Server assigns a `player_id` and responds with room state
5. All subsequent messages are dispatched based on `type`
6. On disconnect, server applies disconnection rules (120-second grace window)

## Client → Server Messages

### Room Management

| Type | Payload | Description |
|------|---------|-------------|
| `create_room` | `{ name: string, avatar?: string, password?: string }` | Create a new room. Sender becomes host. |
| `join_room` | `{ name: string, room_code: string, avatar?: string, password?: string, as_spectator?: boolean }` | Join room (as player or live spectator). |
| `reconnect` | `{ name: string, room_code: string, avatar?: string }` | Reconnect after page refresh (within 120s). |
| `leave_room` | — | Leave the room voluntarily. |
| `respond_join_request` | `{ request_id: string, action: "accept_player" | "accept_spectator" | "decline" }` | Host approves/declines mid-game joiner. |
| `cancel_join_request` | `{ request_id?: string }` | Joiner cancels pending mid-game join request. |
| `request_become_player` | — | Spectator requests host to become an active player (max 2 attempts). |
| `respond_spectator_role_request` | `{ request_id: string, action: "accept" | "decline" }` | Host approves or declines spectator becoming an active player. |
| `cancel_spectator_role_request` | `{ request_id?: string }` | Spectator cancels their promotion request. |

### Host Controls

| Type | Payload | Description |
|------|---------|-------------|
| `update_settings` | `{ num_rounds?, turn_duration?, max_players?, custom_words? }` | Update game configuration. Host only. |
| `start_game` | — | Start the game. Requires ≥2 active players. Host only. |
| `kick_player` | `{ target_player_id: string }` | Kick a player immediately. Host only. |
| `transfer_host` | `{ target_player_id: string }` | Transfer host status to another active player. |
| `rematch` | — | Start a new game after game over (preserves cumulative stats). |
| `end_game_now` | — | End game immediately during disconnect countdown. Host only. |

### Game Actions

| Type | Payload | Description |
|------|---------|-------------|
| `select_word` | `{ word: string }` | Drawer picks a word from choices or theme packs. |
| `stroke` | `{ points: [[x,y],...], color: string, size: number }` | Real-time drawing batch (smoothed Bézier curves). |
| `shape` | `{ shape_type: "line" | "rect" | "circle", start: [x,y], end: [x,y], color: string, size: number }` | Geometric shape drawing. |
| `highlighter` | `{ points: [[x,y],...], color: string, size: number }` | Semitransparent highlighter stroke. |
| `fill` | `{ x: number, y: number, color: string }` | Flood fill at coordinates. |
| `clear_canvas` | — | Clear the entire canvas. |
| `undo` | `{ id?: number }` | Undo the last stroke or shape action. |
| `guess` | `{ text: string }` | Submit a guess (guessers only). |
| `chat` | `{ text: string }` | Send a chat message (lobby, drawer, or spectators). |

### Social & Moderation

| Type | Payload | Description |
|------|---------|-------------|
| `reaction` | `{ emoji: string }` | Send an animated floating emoji reaction. |
| `typing` | `{ is_typing: boolean }` | Broadcast player typing indicator status. |
| `toggle_ready` | — | Toggle ready status in lobby. |
| `update_profile` | `{ name?: string, avatar?: string }` | Update player display name and avatar. |
| `vote_kick` | `{ target_player_id: string }` | Initiate a democratic vote-kick against a player. |
| `vote_kick_cast` | `{ vote: boolean }` | Cast vote in an active vote-kick poll. |

### Heartbeat

| Type | Payload | Description |
|------|---------|-------------|
| `pong` | — | Response to server heartbeat ping. |

---

## Server → Client Messages

### Room State

| Type | Payload | Description |
|------|---------|-------------|
| `room_created` | `{ room_code, player_id, config }` | Confirms room creation. |
| `room_joined` | `{ room_code, player_id, players, config, is_host, is_spectator, state, total_rounds, current_round, drawer_id, hint, duration, theme }` | Confirms join with full snapshot. |
| `reconnected` | `{ room_code, player_id, players, config, state, host_id, drawer_id, hint, current_round, is_spectator }` | Full state restore on reconnection. |
| `player_list` | `{ players: [...] }` | Updated player list broadcast. |
| `settings_updated` | `{ config: {...} }` | Config change broadcast. |
| `profile_updated` | `{ player_id, name, avatar }` | Confirms profile update. |
| `host_transferred` | `{ new_host_id, new_host_name, old_host_id, old_host_name }` | Host leadership reassigned. |

### Game Flow

| Type | Payload | Description |
|------|---------|-------------|
| `game_started` | `{ drawer_id, round, total_rounds, config }` | Game begins. |
| `drawer_selecting` | `{ drawer_id, drawer_name }` | Broadcast: drawer is choosing a word. |
| `word_choices` | `{ choices: string[], packs?: WordPackChoice[] }` | Sent only to the drawer (words + theme packs). |
| `word_assigned` | `{ word: string }` | Sent to drawer on 15s auto-select timeout. |
| `turn_started` | `{ drawer_id, hint, duration, round, theme }` | Turn begins. Hint is array of chars. |
| `hint_update` | `{ hint: [...] }` | Partial character reveal (40%, 70%). |
| `turn_ended` | `{ word, scores, reason, players }` | Turn over. Word revealed, score deltas. |
| `game_over` | `{ scores: [...], mvp_awards: [...], session_stats: [...] }` | Final ranked scores and awards. |
| `rematch_started` | `{ players, config }` | New game starting, scores reset, session preserved. |

### Drawing

| Type | Payload | Description |
|------|---------|-------------|
| `stroke` | `{ points, color, size }` | Stroke broadcast to non-drawer clients. |
| `shape` | `{ shape_type, start, end, color, size }` | Geometric shape broadcast. |
| `highlighter` | `{ points, color, size }` | Highlighter broadcast. |
| `fill` | `{ x, y, color }` | Fill broadcast. |
| `clear_canvas` | — | Clear canvas broadcast. |
| `undo` | `{ id?: number }` | Undo canvas broadcast. |

### Chat, Reactions & Moderation

| Type | Payload | Description |
|------|---------|-------------|
| `guess_correct` | `{ player_name, player_id, score }` | A guesser guessed correctly. |
| `chat_message` | `{ player_name, text, is_system }` | Chat broadcast (includes "is very close!" alerts). |
| `reaction` | `{ player_name, emoji, player_id }` | Emoji reaction broadcast. |
| `typing` | `{ player_id, player_name, is_typing }` | Typing status broadcast. |
| `vote_kick_started` | `{ target_id, target_name, initiator_id, initiator_name, current_votes, required_votes, timeout_seconds }` | Vote-kick poll opened. |
| `vote_kick_updated` | `{ current_votes, required_votes, result }` | Live vote tally updated. |
| `vote_kick_ended` | `{ target_id, target_name, result, message }` | Vote-kick concluded. |

### Mid-Game Join & Spectator Promotion

| Type | Payload | Description |
|------|---------|-------------|
| `join_request_pending` | `{ request_id, room_code }` | Waiting for host approval to enter. |
| `join_request_received` | `{ request_id, player_name, avatar, room_code }` | Host approval prompt. |
| `join_request_resolved` | `{ request_id, status }` | Join request approved or resolved. |
| `join_request_declined` | `{ request_id, reason, message }` | Join request rejected by host. |
| `become_player_request_pending`| `{ request_id, requests_remaining }` | Spectator promotion request submitted. |
| `spectator_role_request_received`| `{ request_id, player_id, player_name, avatar, room_code }` | Host prompt to promote spectator. |
| `spectator_role_request_resolved`| `{ request_id, status, player_id }` | Spectator promoted or cancelled. |
| `spectator_role_request_declined`| `{ request_id, reason, message, requests_remaining }` | Host declined promotion. |

### Disconnection & Recovery

| Type | Payload | Description |
|------|---------|-------------|
| `player_reconnected` | `{ player_id, name }` | Reconnected player restored. |
| `waiting_for_reconnect` | `{ seconds: number }` | Countdown before ending game (< 2 active players). |
| `reconnect_resumed` | — | Countdown cancelled, player reconnected. |
| `game_ended_insufficient_players` | `{ players }` | Game ended due to too few players. |
| `kicked` | `{ message: string }` | Sent to kicked player. |
| `left_room` | — | Confirmation that player left. |
| `error` | `{ code: string, message: string }` | Error response. |

---

## Error Codes

| Code | Trigger |
|------|---------|
| `ROOM_NOT_FOUND` | Join with unknown room code |
| `ROOM_IN_PROGRESS` | Join mid-game without host approval or spectator flag |
| `ROOM_FULL` | Room at maximum allowed active player capacity |
| `INVALID_NAME` | Display name outside 1–20 characters |
| `DUPLICATE_NAME` | Display name already taken in room |
| `INVALID_PASSWORD` | Incorrect room password provided |
| `PERMISSION_DENIED` | Non-host attempts host-only action |
| `INSUFFICIENT_PLAYERS` | Host starts game with < 2 active players |
| `INVALID_SETTINGS` | Settings value out of allowed range |
| `NOT_YOUR_TURN` | Drawing action from a non-drawer |
| `ALREADY_GUESSED` | Guess from a player who already guessed correctly |
| `GAME_NOT_ACTIVE` | Action requires an active game but room is in wrong state |
| `MAX_REQUESTS_EXCEEDED`| Spectator exceeded 2 join requests per game |
| `VOTE_KICK_IN_PROGRESS`| Vote-kick already active in room |
| `VOTE_KICK_COOLDOWN` | Attempt to vote-kick same player before cooldown expires |
| `CANNOT_VOTE_HOST` | Attempt to vote-kick the room host |
| `INTERNAL_ERROR` | Unexpected server exception |
| `INVALID_MESSAGE` | Malformed JSON received |
| `UNKNOWN_MESSAGE` | Unrecognized message type |

---

## Player Object Shape

```json
{
  "id": "uuid-string",
  "name": "PlayerName",
  "score": 150,
  "has_guessed": false,
  "is_connected": true,
  "is_ready": false,
  "is_host": true,
  "avatar": "cat",
  "is_spectator": false,
  "streak": 3,
  "session_score": 450,
  "session_wins": 2
}
```

## Config Object Shape

```json
{
  "num_rounds": 3,
  "turn_duration": 80,
  "max_players": 8,
  "custom_words": ["Dragon", "Wizard", "Castle"],
  "password": null
}
```

Valid ranges:
- `num_rounds`: 2–10
- `turn_duration`: 30–180 (seconds)
- `max_players`: 2–12
