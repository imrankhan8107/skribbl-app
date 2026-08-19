# Tech Stack & Build System

## Backend
- **Language:** Python 3.12
- **Framework:** FastAPI with uvicorn (ASGI)
- **WebSocket:** native FastAPI WebSocket support (JSON protocol)
- **Async:** asyncio throughout
- **Multi-worker:** Redis pub/sub for cross-worker relay (optional — runs single-worker without REDIS_URL)
- **Dependencies:** pinned in `requirements.txt`

## Frontend
- **Framework:** React 18 with TypeScript
- **Bundler:** Vite 5
- **Routing:** React Router v6
- **Styling:** Plain CSS (index.css)
- **Package manager:** npm (lockfile committed)

## Testing
- **Backend:** pytest with `asyncio_mode = auto`, Hypothesis for property-based tests
- **Frontend:** Vitest with jsdom environment, @testing-library/react, @testing-library/user-event

## Code Quality
- **Frontend formatting:** Prettier
- **Frontend linting:** ESLint with @typescript-eslint
- **Pre-commit:** Husky hook that only checks changed files per layer

## Infrastructure
- **Containerization:** Docker (multi-stage: node build → python slim)
- **Orchestration:** docker-compose (app + Redis + nginx)
- **Load balancer:** nginx with WebSocket support + sticky sessions
- **IaC:** Terraform for OCI (Always Free Tier) and Azure Container Apps

## Common Commands

### Backend
```bash
# Install dependencies
pip install -r requirements.txt

# Run dev server
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# Run all tests (213 tests)
python -m pytest backend/tests/ -v

# Run a specific test file
python -m pytest backend/tests/test_game_engine.py -v
```

### Frontend
```bash
cd frontend

# Install dependencies
npm install

# Run dev server (proxies /ws to backend on port 8000)
npm run dev

# Run tests (single run)
npx vitest run

# Type check
npm run typecheck

# Format code
npm run format

# Build for production
npm run build
```

### Docker
```bash
# Build single image
docker build -t skribbl-app .

# Run single worker (no Redis needed)
docker run -p 80:8000 skribbl-app

# Multi-worker with Redis + nginx
docker compose up --build
docker compose up --build --scale app=3
```

### Performance Testing
```bash
python scripts/perf_test.py --clients 100
python scripts/perf_test_sticky.py --host localhost --port 8080 --clients 10
```
