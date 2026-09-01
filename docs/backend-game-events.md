# Backend Game Events

All **application-level** events sent from the Python backend to clients over
the WebSocket (JSON protocol). Gateway/gRPC transport-level messages are NOT
covered here — these are the game events produced by `game_engine.py`,
`room_manager.py`, `ws_handler.py`, and `heartbeat.py`.

Every message has the shape `{ "type": <event>, "payload": <object> }`.

Legend for payload types: `string`, `int`, `bool`, `array`, `object`, `null`.

---

## Lifecycle / Room Events

Game Event : room_created
Payload : {
  "room_code": string,
  "player_id": string,
  "config": {
    "num_rounds": int,
    "turn_duration": int,
    "max_players": int
  }
}

***

Game Event : room_joined
Payload : {
  "room_code": string,
  "player_id": string,
  "config": {
    "num_rounds": int,
    "turn_duration": int,
    "max_players": int
  }
}

***

Game Event : reconnected
Payload : {
  "room_code": string,
  "player_id": string,
  "score": int,
  "players": [
    {
      "id": string,
      "name": string,
      "score": int,
      "has_guessed": bool,
      "is_connected": bool,
      "is_ready": bool
    }
  ],
  "config": {
    "num_rounds": int,
    "turn_duration": int,
    "max_players": int
  },
  "state": string,
  "current_round": int,
  "host_id": string,
  "drawer_id": string | null,
  "hint": [string]        // list of single chars; "_" for hidden letters
}

***

Game Event : left_room
Payload : {}

***

Game Event : player_list
Payload : {
  "players": [
    {
      "id": string,
      "name": string,
      "score": int,
      "has_guessed": bool,
      "is_connected": bool,
      "is_ready": bool
    }
  ]
}

***

Game Event : player_reconnected
Payload : {
  "player_id": string,
  "name": string
}

***

Game Event : player_kicked
Payload : {
  "target_player_id": string
}

***

Game Event : kicked
Payload : {
  "message": string
}

***

Game Event : ready_toggled
Payload : {
  "is_ready": bool
}

***

Game Event : settings_updated
Payload : {
  "config": {
    "num_rounds": int,
    "turn_duration": int,
    "max_players": int
  }
}

***

## Gameplay Events

Game Event : game_started
Payload : {
  "drawer_id": string,
  "round": int,
  "total_rounds": int
}

***

Game Event : drawer_selecting
Payload : {
  "drawer_id": string,
  "drawer_name": string
}

***

Game Event : word_choices
Payload : {
  "choices": [string, string, string]
}
(Sent only to the drawer.)

***

Game Event : word_assigned
Payload : {
  "word": string
}
(Sent only to the drawer.)

***

Game Event : turn_started
Payload : {
  "drawer_id": string,
  "hint": [string],       // list of single chars; "_" for hidden letters
  "duration": int,
  "round": int
}

***

Game Event : hint_update
Payload : {
  "hint": [string]        // list of single chars; "_" for hidden letters
}

***

Game Event : turn_ended
Payload : {
  "word": string,
  "scores": {
    "<player_id>": int
  },
  "reason": string
}

***

Game Event : game_over
Payload : {
  "scores": [
    {
      "id": string,
      "name": string,
      "score": int
    }
  ]
}

***

Game Event : rematch_started
Payload : {
  "players": [
    {
      "id": string,
      "name": string,
      "score": int,
      "has_guessed": bool,
      "is_connected": bool,
      "is_ready": bool
    }
  ],
  "config": {
    "num_rounds": int,
    "turn_duration": int,
    "max_players": int
  }
}

***

## Drawing / Chat / Social Events

Game Event : stroke
Payload : <original client stroke payload, forwarded as-is>
(Typically: { "points": array, "color": string, "lineWidth": int })

***

Game Event : fill
Payload : <original client fill payload, forwarded as-is>
(Typically: { "x": int, "y": int, "color": string })

***

Game Event : clear_canvas
Payload : {}

***

Game Event : chat_message
Payload : {
  "player_name": string,
  "text": string,
  "is_system": bool
}

***

Game Event : guess_correct
Payload : {
  "player_name": string
}
(The word is intentionally NOT included.)

***

Game Event : reaction
Payload : {
  "player_name": string,
  "emoji": string
}

***

## Connection / Resilience Events

Game Event : ping
Payload : (none — heartbeat sent as { "type": "ping" })

***

Game Event : waiting_for_reconnect
Payload : {
  "seconds": int
}

***

Game Event : reconnect_resumed
Payload : {}

***

Game Event : game_ended_insufficient_players
Payload : {}

***

## Error Event

Game Event : error
Payload : {
  "code": string,
  "message": string
}

Known error codes (app level):
- INVALID_NAME
- ROOM_NOT_FOUND
- ROOM_IN_PROGRESS
- ROOM_FULL
- RECONNECT_FAILED
- GAME_NOT_ACTIVE
- PERMISSION_DENIED
- INVALID_SETTINGS
- INSUFFICIENT_PLAYERS
- PLAYER_NOT_FOUND
- UNKNOWN_MESSAGE

Error codes (gateway/gRPC transport level — not produced by the app):
- NO_BACKEND
- NOT_IDENTIFIED
- BACKEND_UNAVAILABLE
- STREAM_ERROR
- TIMEOUT
- INVALID_JSON
- INVALID_PAYLOAD
