# Project Structure

```
skribbl-app/
├── backend/                    # Python FastAPI server
│   ├── main.py                 # App entrypoint, WebSocket route, sticky session middleware
│   ├── ws_handler.py           # Message dispatch + connection lifecycle
│   ├── room_manager.py         # Room CRUD, player management, kick/leave/ready
│   ├── game_engine.py          # Turn logic, scoring, hints, word selection
│   ├── models.py               # Dataclasses (Player, Room, TurnState, GameConfig)
│   ├── heartbeat.py            # Ping/pong connection health monitoring
│   ├── redis_pubsub.py         # Redis adapter (pub/sub, room registry, worker ID)
│   ├── words.py                # Word list (~200+ words)
│   └── tests/                  # pytest tests (unit + property-based + integration)
│       ├── test_property_*.py  # Hypothesis property-based tests
│       ├── test_*.py           # Unit and integration tests
│       └── __init__.py
├── frontend/                   # React 18 TypeScript SPA
│   ├── src/
│   │   ├── App.tsx             # Router setup
│   │   ├── main.tsx            # React entry point
│   │   ├── index.css           # Global styles
│   │   ├── context/            # WebSocketContext + gameReducer (state management)
│   │   ├── pages/              # Landing, Lobby, Game, GameOver
│   │   ├── components/         # Canvas, Chat, PlayerList, TimerBar, RoundTransition
│   │   ├── hooks/              # useCanvas, useWebSocket
│   │   ├── types/              # TypeScript interfaces
│   │   └── __tests__/          # Vitest component + reducer tests
│   ├── vite.config.ts          # Vite config with WS proxy and Vitest setup
│   ├── tsconfig.json           # TypeScript config
│   └── package.json            # Dependencies and scripts
├── infra/                      # Infrastructure as Code
│   ├── oci/                    # Oracle Cloud (Always Free Tier) Terraform
│   └── azure/                  # Azure Container Apps Terraform
├── scripts/                    # Utility scripts
│   ├── perf_test.py            # WebSocket performance benchmark
│   └── perf_test_sticky.py     # Sticky session performance test
├── Dockerfile                  # Multi-stage build (node → python)
├── docker-compose.yml          # Multi-worker local setup (Redis + nginx + app×N)
├── nginx.conf                  # Load balancer with WebSocket + sticky sessions
├── requirements.txt            # Python dependencies (pinned versions)
├── pytest.ini                  # pytest async config
└── .husky/pre-commit           # Smart pre-commit (only checks changed files)
```

## Key Architectural Patterns

- **State management:** All game state is in-memory on the server. Frontend holds a local mirror via `gameReducer` updated by WebSocket messages.
- **Player lookups:** O(1) via `players_by_id` dict and `_player_to_room` index on the backend.
- **Message flow:** Client sends JSON over WebSocket → `ws_handler` dispatches to `room_manager` or `game_engine` → server broadcasts responses to room.
- **Frontend pages:** `Landing` (create/join) → `Lobby` (ready check, settings) → `Game` (drawing/guessing) → `GameOver` (leaderboard/rematch).
- **Context pattern:** `WebSocketContext` provides the socket + dispatch; pages and components consume game state from context.
