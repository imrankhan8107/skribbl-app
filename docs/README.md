# Skribbl App Documentation

Technical documentation for the Skribbl real-time multiplayer drawing game.

## Contents

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System architecture, deployment topology, and data flow |
| [API Reference](./api-reference.md) | WebSocket protocol — all client/server message types |
| [Game Logic](./game-logic.md) | Scoring, hints, turn/round lifecycle, word selection |
| [Deployment Guide](./deployment.md) | Multi-Host Distributed Terraform (AWS, Azure, OCI), Docker |
| [Development Guide](./development.md) | Local setup, testing, pre-commit hooks, project conventions |
| [Frontend Architecture](./frontend.md) | React SPA structure, state management, component tree |
| [Scaling to 1M Users](./scaling-to-1m.md) | Architecture for 1M concurrent users, code changes, cost estimates |

## Quick Links

- [Main README](../README.md) — project overview and quick start
- [AWS Deployment](../infra/aws/README.md) — Multi-host distributed AWS cluster deployment with Terraform
- [Azure Deployment](../infra/azure/README.md) — Multi-host distributed Azure cluster deployment with Terraform
- [OCI Deployment](../infra/oci/README.md) — Multi-host distributed Oracle Cloud cluster deployment with Terraform
