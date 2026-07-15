# Deployment Guide

## Docker (Single Container)

The multi-stage Dockerfile builds both frontend and backend into a single ~150MB image.

### Build & Run

```bash
docker build -t skribbl-app .
docker run -p 80:8000 skribbl-app
```

Access at `http://localhost`.

### How It Works

1. **Stage 1** (`node:20-alpine`): Installs npm deps, runs `npm run build` → produces `frontend/dist/`
2. **Stage 2** (`python:3.12-slim`): Installs Python deps, copies backend + built frontend, runs uvicorn

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Server port (for PaaS like Render/Railway) |
| `REDIS_URL` | — | Redis connection string (enables multi-worker mode) |

---

## Multi-Worker with Docker Compose

For 500–5000+ concurrent players, run multiple workers with Redis pub/sub:

```bash
# Start 3 workers + Redis + nginx
docker compose up --build --scale app=3
```

Access at `http://localhost` (nginx on port 80).

### Architecture

```
Browser → nginx (port 80, sticky sessions) → Worker 1/2/3
                                                   ↕
                                             Redis pub/sub
```

### How Sticky Sessions Work

1. First request → nginx uses `ip_hash` to pick a worker
2. Worker sets `worker_id` cookie in the response
3. Subsequent requests → nginx routes based on cookie
4. Result: same player always hits same worker (fast local path)

### docker-compose.yml Services

| Service | Image | Purpose |
|---------|-------|---------|
| `redis` | `redis:7-alpine` | Pub/sub message relay |
| `app` | Built from Dockerfile | Game server (scalable) |
| `nginx` | `nginx:alpine` | Load balancer + WebSocket support |

---

## Oracle Cloud (Always Free Tier)

Deploy on OCI A1.Flex ARM instance — $0/month.

### Prerequisites

- OCI account with Always Free tier
- Terraform ≥ 1.5
- OCI CLI configured with API key
- SSH key pair

### Deploy

```bash
cd infra/oci
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your OCI credentials

terraform init
terraform plan
terraform apply
```

### After Deployment

App takes 3–5 minutes to start (Docker builds from source via cloud-init).

```bash
# Check progress
ssh ubuntu@<public_ip>
tail -f /var/log/skribbl-deploy.log
```

Access:
- Via nginx: `http://<public_ip>:8080`
- Direct: `http://<public_ip>:8000`

### Update

```bash
ssh ubuntu@<public_ip>
cd /home/ubuntu/skribbl-app
git pull
docker compose up -d --build
```

### Teardown

```bash
terraform destroy
```

### Resource Usage

| Resource | Free Allowance | This Deployment |
|----------|---------------|-----------------|
| A1.Flex OCPUs | 4 | 1 |
| Memory | 24 GB | 6 GB |
| Boot Volume | 200 GB | 50 GB |
| Public IPs | 2 | 1 |

---

## Azure Container Apps

### Single Replica (Simple)

```bash
cd infra/azure
terraform init
terraform apply
```

Or use the PowerShell script: `.\infra\azure\deploy.ps1`

Cost: ~$11/month (Container Apps + Registry).

### Multi-Replica with Redis

For scaling to 2–4 replicas:

1. Create Azure Cache for Redis (Basic C0)
2. Deploy with `REDIS_URL` environment variable
3. Enable session affinity (sticky sessions)

Cost: ~$33–45/month.

See [infra/azure/README.md](../infra/azure/README.md) for step-by-step instructions.

---

## Performance Benchmarks

Tested with `scripts/perf_test.py` (100 concurrent clients, single worker):

| Metric | Value |
|--------|-------|
| Connection establishment | 5.7ms avg |
| Room creation RTT | 1.0ms avg |
| Stroke broadcast latency | 1.1ms avg (P95: 1.85ms) |
| Concurrent connections | 500/500 established |
| Message throughput | 6,781 msgs/sec |

### Sticky Session Performance Test

```bash
python scripts/perf_test_sticky.py --host localhost --port 8080 --clients 10
```

Tests multi-worker deployment with cookie-based routing:
- Worker affinity detection
- Same-worker stroke latency
- Cross-worker throughput (via Redis)
- P95 threshold checks for CI integration

---

## Capacity Planning

| Deployment | Concurrent Players | Cost |
|------------|-------------------|------|
| Single worker (no Redis) | 100–500 | Free (OCI) |
| 3 workers + Redis | 500–2000 | $0 (OCI) or ~$33/mo (Azure) |
| 5+ workers + Redis | 2000–5000+ | Scale Azure replicas |

Each worker holds rooms in-memory. With sticky sessions, most rooms stay on a single worker (fast local broadcast). Redis relay handles the edge case of players landing on different workers.
