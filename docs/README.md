# Skribbl App Documentation

Technical documentation for the Skribbl real-time multiplayer drawing game.

## Contents

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System architecture, deployment topology, and data flow |
| [API Reference](./api-reference.md) | WebSocket protocol — all client/server message types |
| [Game Logic](./game-logic.md) | Scoring, hints, turn/round lifecycle, word selection |
| [Deployment Guide](./deployment.md) | Docker, multi-worker Redis, OCI, Azure |
| [Development Guide](./development.md) | Local setup, testing, pre-commit hooks, project conventions |
| [Frontend Architecture](./frontend.md) | React SPA structure, state management, component tree |
| [Scaling to 1M Users](./scaling-to-1m.md) | Architecture for 1M concurrent users, code changes, cost estimates |

## Quick Links

- [Main README](../README.md) — project overview and quick start
- [OCI Deployment](../infra/oci/README.md) — Oracle Cloud Always Free deployment
- [Azure Deployment](../infra/azure/README.md) — Azure Container Apps deployment
