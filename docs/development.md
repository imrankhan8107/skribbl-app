# Development Guide

## Prerequisites

- Python 3.12+
- Node.js 18+
- Git

## Local Setup

### Backend

```bash
# Install Python dependencies
pip install -r requirements.txt

# Run the server
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

The `--reload` flag enables hot-reload on file changes during development.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite dev server runs at `http://localhost:5173` and proxies `/ws` to the backend at `localhost:8000` (configured in `vite.config.ts`).

### Access

- Development: `http://localhost:5173` (Vite dev server with HMR)
- Local network: `http://<your-ip>:5173` (other devices on same network)
- Production build: `http://localhost:8000` (FastAPI serves static files)

---

## Testing

### Backend Tests (213 tests)

```bash
# Run all backend tests
python -m pytest backend/tests/ -v

# Run specific test file
python -m pytest backend/tests/test_scoring.py -v

# Run property-based tests with more examples
HYPOTHESIS_MAX_EXAMPLES=500 python -m pytest backend/tests/ -v

# Run only property tests
python -m pytest backend/tests/test_property_*.py -v
```

**Test categories:**
| Category | Files | Description |
|----------|-------|-------------|
| Unit | `test_scoring.py`, `test_hints.py`, `test_word_selection.py` | Pure logic functions |
| Property-based | `test_property_*.py` (15 files) | Hypothesis-powered invariant checks |
| Integration | `test_ws_integration.py` | Full WebSocket flow |
| Lifecycle | `test_turn_lifecycle.py`, `test_disconnection.py`, `test_rematch.py` | State machine transitions |

### Frontend Tests (62 tests)

```bash
cd frontend

# Run all tests (single pass)
npx vitest run

# Watch mode
npx vitest

# With verbose output
npx vitest run --reporter=verbose
```

**Test categories:**
| File | Tests | Description |
|------|-------|-------------|
| `gameReducer.test.ts` | 17 | Pure reducer state transitions |
| `Landing.test.tsx` | 6 | Form submission, error display |
| `Lobby.test.tsx` | 8 | Settings, host controls, start game |
| `Game.test.tsx` | 6 | Hint display, timer, navigation |
| `Chat.test.tsx` | 6 | Input state, message styling |
| `Canvas.test.tsx` | 8 | Toolbar visibility, drawing events |
| `GameOver.test.tsx` | 5 | Leaderboard, rematch button |

### Performance Tests

```bash
# Single-worker benchmark (requires running server)
python scripts/perf_test.py --clients 100

# Multi-worker sticky session test (requires docker compose up)
python scripts/perf_test_sticky.py --host localhost --port 8080 --clients 10

# With P95 threshold (exit non-zero on breach)
python scripts/perf_test_sticky.py --p95-max 50
```

---

## Pre-commit Hooks

The `.husky/pre-commit` hook runs checks only on changed files:

### Frontend Changes Detected

1. **Prettier** — format check on staged `.ts`, `.tsx`, `.css` files
2. **TypeScript** — full `tsc --noEmit` compile check
3. **Build** — `npm run build` (catches build errors)
4. **Tests** — Vitest with `--changed` flag (related tests only)

### Backend Changes Detected

- **Source files changed** → Full `pytest` suite
- **Only test files changed** → Only those test files run

### No Changes in a Layer

That layer is skipped entirely (fast commits for README-only changes, etc.)

---

## Project Conventions

### Backend

- **Python 3.12** features: type hints with `str | None`, match statements
- **Dataclasses** for all models (no Pydantic for simplicity)
- **asyncio** for all I/O (WebSocket, timers, Redis)
- **Logging** via `logging` module (not print statements)
- **Error handling**: All WebSocket handlers wrapped in try/except; errors sent as messages, never crash the connection

### Frontend

- **TypeScript strict mode** — no `any` types
- **Functional components** only (no class components)
- **React hooks** for all state and effects
- **React Router v6** for navigation
- **CSS modules / plain CSS** — no CSS-in-JS libraries
- **Prettier** for formatting (configured in `.prettierrc`)

### Naming

- Backend: `snake_case` for everything (Python convention)
- Frontend: `camelCase` for variables/functions, `PascalCase` for components
- WebSocket messages: `snake_case` on the wire, converted to `camelCase` in the frontend context

### Git

- Feature branches off `main`
- Smart pre-commit hooks run relevant checks
- Commit messages: imperative mood, concise

---

## Adding a New Message Type

### Backend

1. Add handler in `ws_handler.py` dispatch loop
2. Implement logic in `room_manager.py` or `game_engine.py`
3. Add broadcast call if other players need to see it
4. Write tests in `backend/tests/`

### Frontend

1. Add server type → action type mapping in `WebSocketContext.tsx` (`mapServerTypeToActionType`)
2. Add the action case in `gameReducer`
3. Add TypeScript types in `types/index.ts`
4. Update components to react to new state
5. Write reducer test in `gameReducer.test.ts`

---

## Common Tasks

### Add a New Word

Edit `backend/words.py` — just append to the `WORDS` list.

### Change Default Config

Edit the `GameConfig` dataclass defaults in `backend/models.py`.

### Add a New Page/Route

1. Create component in `frontend/src/pages/`
2. Add route in `frontend/src/App.tsx`
3. Add navigation logic (usually in response to `gameState.phase` changes)

### Debug WebSocket Messages

The frontend logs all incoming messages to the browser console:
```
[WS] Received: turn_started { drawer_id: "...", hint: [...], ... }
[WS] Dispatching: TURN_STARTED { drawerId: "...", ... }
```

### Redis Debugging

When running multi-worker locally:
```bash
# Connect to Redis CLI
docker compose exec redis redis-cli

# Subscribe to all channels
PSUBSCRIBE *

# Check connected workers
SMEMBERS room_workers:<room_code>
```
