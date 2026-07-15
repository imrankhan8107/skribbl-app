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
| `create_room` | `{ name: string }` | Create a new room. Sender becomes host. |
| `join_room` | `{ name: string, room_code: string }` | Join an existing room by code. |
| `reconnect` | `{ name: string, room_code: string }` | Reconnect after page refresh (within 120s). |
| `leave_room` | — | Leave the room voluntarily. |

### Host Controls

| Type | Payload | Description |
|------|---------|-------------|
| `update_settings` | `{ num_rounds?, turn_duration?, max_players? }` | Update game configuration. Host only. |
| `start_game` | — | Start the game. Requires ≥2 players. Host only. |
| `kick_player` | `{ target_player_id: string }` | Kick a player from the room. Host only. |
| `rematch` | — | Start a new game after game over. Host only. |
| `end_game_now` | — | End game immediately during disconnect countdown. Host only. |

### Game Actions

| Type | Payload | Description |
|------|---------|-------------|
| `select_word` | `{ word: string }` | Drawer picks a word from the 3 choices. |
| `stroke` | `{ points: [[x,y],...], color: string, size: number }` | Drawing stroke data (real-time, per segment). |
| `fill` | `{ x: number, y: number, color: string }` | Flood fill at coordinates. |
| `clear_canvas` | — | Clear the entire canvas. |
| `guess` | `{ text: string }` | Submit a guess (guessers only). |
| `chat` | `{ text: string }` | Send a chat message (lobby or drawer in-game). |

### Social

| Type | Payload | Description |
|------|---------|-------------|
| `reaction` | `{ emoji: string }` | Send an emoji reaction. |
| `toggle_ready` | — | Toggle ready status in lobby. |

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
| `room_joined` | `{ room_code, player_id, players, config, is_host }` | Confirms join with full state. |
| `reconnected` | `{ room_code, player_id, players, config, state, host_id, drawer_id, hint, current_round }` | Full state restore on reconnection. |
| `player_list` | `{ players: [...] }` | Updated player list broadcast. |
| `settings_updated` | `{ config: {...} }` | Config change broadcast. |

### Game Flow

| Type | Payload | Description |
|------|---------|-------------|
| `game_started` | `{ drawer_id, round, total_rounds, config }` | Game begins. |
| `drawer_selecting` | `{ drawer_id, drawer_name }` | Broadcast: drawer is choosing a word. |
| `word_choices` | `{ choices: [w1, w2, w3] }` | Sent only to the drawer (3 words). |
| `word_assigned` | `{ word: string }` | Sent to drawer on 15s auto-select timeout. |
| `turn_started` | `{ drawer_id, hint, duration, round }` | Turn begins. Hint is array of chars. |
| `hint_update` | `{ hint: [...] }` | Partial character reveal (40%, 70%). |
| `turn_ended` | `{ word, scores, reason }` | Turn over. Word revealed, score deltas. |
| `game_over` | `{ scores: [{ id, name, score }, ...] }` | Final ranked scores. |
| `rematch_started` | `{ players, config }` | New game starting, scores reset. |

### Drawing

| Type | Payload | Description |
|------|---------|-------------|
| `stroke` | `{ points, color, size }` | Stroke broadcast to all non-drawer clients. |
| `fill` | `{ x, y, color }` | Fill broadcast. |
| `clear_canvas` | — | Clear canvas broadcast. |

### Chat & Social

| Type | Payload | Description |
|------|---------|-------------|
| `guess_correct` | `{ player_name, player_id, score }` | A guesser guessed correctly (word not revealed). |
| `chat_message` | `{ player_name, text, is_system }` | Chat message broadcast. |
| `reaction` | `{ player_name, emoji }` | Emoji reaction broadcast. |

### Disconnection

| Type | Payload | Description |
|------|---------|-------------|
| `player_reconnected` | `{ player_id, name }` | Reconnected player restored. |
| `waiting_for_reconnect` | `{ seconds: number }` | Countdown before ending game (< 2 players). |
| `reconnect_resumed` | — | Countdown cancelled, player reconnected. |
| `game_ended_insufficient_players` | `{ players }` | Game ended due to too few players. |

### Player Actions

| Type | Payload | Description |
|------|---------|-------------|
| `kicked` | `{ message: string }` | Sent to kicked player. |
| `left_room` | — | Confirmation that player left. |

### Errors

| Type | Payload | Description |
|------|---------|-------------|
| `error` | `{ code: string, message: string }` | Error response. |

---

## Error Codes

| Code | Trigger |
|------|---------|
| `ROOM_NOT_FOUND` | Join with unknown room code |
| `ROOM_IN_PROGRESS` | Join a room not in Lobby state |
| `ROOM_FULL` | Join a room at max capacity |
| `INVALID_NAME` | Display name outside 1–20 characters |
| `PERMISSION_DENIED` | Non-host attempts host-only action |
| `INSUFFICIENT_PLAYERS` | Host starts game with < 2 players |
| `INVALID_SETTINGS` | Settings value out of allowed range |
| `NOT_YOUR_TURN` | Drawing action from a non-drawer |
| `ALREADY_GUESSED` | Guess from a player who already guessed correctly |
| `GAME_NOT_ACTIVE` | Action requires an active game but room is in wrong state |
| `INTERNAL_ERROR` | Unexpected server exception |
| `INVALID_MESSAGE` | Malformed JSON received |
| `UNKNOWN_MESSAGE` | Unrecognized message type |

---

## Player Object Shape

The `players` array in various messages contains objects with:

```json
{
  "id": "uuid-string",
  "name": "PlayerName",
  "score": 150,
  "has_guessed": false,
  "is_connected": true,
  "is_ready": false,
  "is_host": true
}
```

## Config Object Shape

```json
{
  "num_rounds": 3,
  "turn_duration": 80,
  "max_players": 8
}
```

Valid ranges:
- `num_rounds`: 2–10
- `turn_duration`: 30–180 (seconds)
- `max_players`: 2–12
