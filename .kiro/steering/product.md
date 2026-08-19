# Product: Skribbl

A real-time multiplayer Pictionary-style drawing and guessing game. Players create or join rooms via 6-character codes, take turns drawing words on a shared canvas while others race to guess correctly via chat.

## Core Gameplay
- Drawer picks from 3 word choices (auto-selects after 15s)
- Guessers type guesses in chat; correct guesses are hidden, incorrect are visible to all
- Exponential scoring with position multiplier (first guesser earns most)
- Turn rotation so every player draws each round
- Configurable turn duration (30–180s) with hint reveals at 40% and 70%

## Room Management
- Create/join rooms with 6-character codes
- Host controls: kick players, configure settings, start game
- Ready check system in lobby
- Lobby chat before game starts

## Resilience
- Auto-reconnect on page refresh (120-second grace window)
- 20-second disconnect countdown before ending game
- Host reassignment on disconnect
- Sticky sessions for multi-worker deployments

## Social Features
- Emoji reactions (👍 😂 🔥 ❤️ 👏 😮)
- Final leaderboard with rematch option

## Architecture Philosophy
- All game state is server-authoritative (lives in-memory on the backend)
- Frontend is a thin rendering layer — server enforces all rules
- Communication is entirely via WebSocket with JSON messages
- Multi-worker scaling via Redis pub/sub with sticky sessions
