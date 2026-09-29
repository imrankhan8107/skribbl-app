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

## AWS Multi-Host Distributed Deployment (Terraform)

For production scale (handling up to 150,000+ concurrent players), the application deploys across dedicated AWS EC2 instances managed via Terraform in `infra/aws/`.

### Architecture Topology

```
                              Internet (Browser Clients & k6)
                                             │
                                             ▼
                     ┌────────────────────────────────────────────────┐
                     │          Nginx Reverse Proxy / LB              │
                     │          (Public Subnet, Port 80/443)          │
                     │   hash "$arg_gw$arg_room$arg_cid" consistent   │
                     └───────────────┬────────────────┬───────────────┘
                                     │                │
                     ┌───────────────▼┐              ┌▼───────────────┐
                     │ Go Gateway 1   │              │ Go Gateway N   │
                     │ (EC2, :9000)   │  ...         │ (EC2, :9000)   │
                     │ + Coord :9100  │              │ + Coord :9100  │
                     └───────┬────────┘              └────────┬───────┘
                             │                                │
                             │  gRPC RoomStream (:50051)      │
                             └───────────────┬────────────────┘
                                             ▼
                     ┌────────────────────────────────────────────────┐
                     │           Python Worker Tier                   │
                     │   Worker 1 (:50051) ... Worker M (:50051)      │
                     │   (FastAPI + gRPC Servicer + VirtualTransport) │
                     └───────────────────────┬────────────────────────┘
                                             │
                                             ▼
                     ┌────────────────────────────────────────────────┐
                     │          Redis Tier (:6379)                    │
                     │   Dedicated EC2 Instance with AOF persistence  │
                     │   (Room registry, worker discovery, snapshots) │
                     └────────────────────────────────────────────────┘
```

### Tier Responsibilities

1. **Nginx Reverse Proxy / Load Balancer** (`c5a.4xlarge`):
   - Terminates public HTTP/HTTPS traffic.
   - Consistent hashing via `hash "$arg_gw$arg_room$arg_cid"` ensures all clients in a game room land on the same Go Gateway instance.
   - Kernel TCP tuning (`net.core.somaxconn = 65535`, file descriptor limits > 200,000).

2. **Go Edge Gateways** (`c5a.2xlarge`):
   - High-throughput epoll-based WebSocket termination on port `9000`.
   - Handles client heartbeats (ping/pong), binary frame chunking, and backpressure queues.
   - Maintains gRPC bidirectional streaming (`RoomStream`) on port `50051` to Python workers.
   - Inter-gateway coordinator on port `9100`.

3. **Python Game Workers** (`c5a.2xlarge`):
   - Executes game logic (turns, canvas stroke validation, scoring, hints, word selection).
   - In-memory room manager backed by `VirtualTransport` abstraction.
   - Serves gRPC servicer streams (`:50051`) with zero HTTP overhead.

4. **Redis Data Tier** (`c5a.xlarge`):
   - Room registry and active worker discovery.
   - Append-Only File (AOF) persistence for reliable recovery.
   - Cross-gateway pub/sub relay for room broadcasts.

### Security & Firewall Constraints

In accordance with strict security standards, **zero ports are exposed to `0.0.0.0/0`**:

1. **Internal Inter-Tier Communication**: All traffic between Nginx, Gateways, Workers, and Redis is locked strictly to `self = true` (only instances within the cluster security group can communicate across private IPs).
2. **External Traffic (SSH, HTTP, Gateways, Coord)**: External ingress on ports 22, 80, 443, 9000, and 9100 is strictly locked down to `var.allowed_cidrs` (your local public IP/32 and CI/CD/Cloud9 IP/32).

### Prerequisites

1. **AWS CLI** installed and configured (`aws configure`).
2. **Terraform** >= 1.5.0 installed (`terraform --version`).
3. An SSH public key on your local machine (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`).
4. Your current public IP address (`curl ifconfig.me`).

### Step-by-Step Deployment

```bash
cd infra/aws

# 1. Copy example configuration
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
aws_region    = "us-east-1"
allowed_cidrs = [
  "YOUR_LOCAL_IP/32",     # Your local machine (from curl ifconfig.me)
]
ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."

# Cluster sizing
gateway_count     = 2
gateways_per_host = 1
worker_count      = 2
workers_per_host  = 2
```

Provision the infrastructure:
```bash
# 2. Initialize and deploy
terraform init
terraform plan
terraform apply
```

Deployment takes ~3–5 minutes for cloud-init to provision packages, compile container images, and start the services across all EC2 instances.

### Verification & Monitoring

1. **Get cluster connection info**:
   ```bash
   terraform output
   ```

2. **Verify Nginx health**:
   ```bash
   curl -I http://<nginx_public_ip>/health
   ```

3. **Check cloud-init deployment logs on any instance**:
   ```bash
   ssh -i ~/.ssh/id_ed25519 ubuntu@<node_ip> "tail -f /var/log/cloud-init-output.log"
   ```

### Teardown

```bash
terraform destroy
```

See [infra/aws/README.md](../infra/aws/README.md) for full operational runbooks, k6 distributed load testing procedures, and troubleshooting.

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

| Deployment | Target Concurrent Users (VUs) | Architecture Topology | Verified Telemetry & Limits |
|------------|-------------------------------|-----------------------|------------------------------|
| **Single Container (Docker)** | 100–500 | Single container (FastAPI + built React) | 500 connections, 6,781 msgs/sec |
| **Local Multi-Worker (Compose)** | 500–2,000 | Nginx LB + 3 App Workers + Redis | Sticky sessions with cookie routing |
| **AWS Distributed Cluster (Terraform)** | **10,000–150,000+** | **Nginx (`c5a.4xlarge`) + Go Gateways (`c5a.2xlarge`) + Python Workers (`c5a.2xlarge`) + Redis (`c5a.xlarge`)** | **150,000 VUs, 512M messages, 4.00 Gbps, 0 control drops** ✅ |

Each Python worker holds rooms in-memory with the game engine. The Go edge gateway offloads high-concurrency WebSocket I/O, epoll connection state, and frame buffering, while dedicated Redis synchronizes cross-gateway state and room discovery.
