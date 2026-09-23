# Multi-Host Distributed Deployment on AWS (Terraform)

This Terraform configuration provisions a production-grade, multi-host distributed cluster on **Amazon Web Services (AWS)** for the Skribbl application, separating Load Balancers, Go Gateways, Python Workers, and Redis across dedicated EC2 instances.

---

## Architecture Topology

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

---

## Security & Firewall Constraints

In accordance with strict security standards, **zero ports are exposed to `0.0.0.0/0`**:

1. **Internal Inter-Tier Communication**: All traffic between Nginx, Gateways, Workers, and Redis is locked strictly to `self = true` (only instances within the cluster security group can communicate across private IPs).
2. **External Traffic (SSH, HTTP, Gateways, Coord)**: External ingress on ports 22, 80, 443, 9000, and 9100 is strictly locked down to `var.allowed_cidr` (your public IP/32).

---

## Prerequisites

1. **AWS CLI** installed and configured (`aws configure`).
2. **Terraform** >= 1.5.0 installed (`terraform --version`).
3. An SSH public key on your local machine (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`).
4. Your current public IP address (run `curl ifconfig.me`).

---

## Quick Start

### 1. Initialize and Configure

```bash
cd infra/aws

# Copy example variables
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
aws_region   = "us-east-1"
allowed_cidr = "YOUR_PUBLIC_IP/32"    # Output of: curl ifconfig.me
ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."

# Cluster sizing & multi-container tuning
gateway_count     = 2
gateways_per_host = 1
worker_count      = 2
workers_per_host  = 2
```

### 2. Deploy the Cluster

```bash
terraform init
terraform plan
terraform apply
```

Deployment takes ~3–5 minutes for cloud-init to provision packages, compile images, and start the services across instances.

### 3. Verify Deployment

Once `terraform apply` finishes, outputs will display:

```bash
Apply complete! Resources: 11 added, 0 changed, 0 destroyed.

Outputs:

app_url = "http://54.x.x.x"
grafana_url = "http://54.x.x.x:3000"
prometheus_url = "http://54.x.x.x:9090"
gateway_public_ips = ["54.y.y.1", "54.y.y.2"]
lb_public_ip = "54.x.x.x"
ssh_lb_command = "ssh ubuntu@54.x.x.x"
k6_load_test_command = "k6 run --env HOST=54.x.x.x --env PORT=80 --env COORD_HOST=54.y.y.1 --env COORD_PORT=9100 --env VUS=1000 scripts/k6_grpc_load_test.js"
```

1. **Gameplay App**: Open `http://<lb_public_ip>` in your browser to play and test the game.
2. **Live Grafana Dashboard**: Open `http://<lb_public_ip>:3000` to view real-time metrics (Active Rooms, Players, gRPC Streams, and Msg/sec).
   - Ingress on port 3000 (Grafana) and port 9090 (Prometheus) is **strictly restricted to `allowed_cidr` (your IP)** via the AWS Security Group.
   - Prometheus runs on the Load Balancer instance and automatically discovers and scrapes all Go Gateways (`:9000`) and Python Workers (`:8000`) across the cluster private network.


---

## Running Load Tests

### Method 1: Running Inside the Dedicated In-VPC k6 Runner (Recommended)

Running k6 inside the AWS VPC eliminates home network bandwidth and Wi-Fi latency limits:

1. Connect via SSH to the load generator instance:
   ```bash
   ssh ubuntu@<load_generator_public_ip>
   ```
2. Run the pre-configured runner script (`./run-test.sh <VUS> <PLAYERS> <STROKE_HZ> <RAMP_SECONDS> [HOLD_SECONDS] [VU_OFFSET]`):
   ```bash
   # Smoke test: 100 VUs, 2 players/room, 20Hz drawing
   ./run-test.sh 100 2 20

   # High scale test: 5,000 VUs, 5 players/room, 20Hz drawing, 60s ramp, 2400s hold
   ./run-test.sh 5000 5 20 60 2400

   # 120k True Simultaneous Milestone (Run concurrently across 4 runners):
   # All runners ramp simultaneously with automated VU_OFFSET partitioning:
   # Runner 1 (Offset 0 auto-applied):
   ./run-test.sh 30000 5 20 300 2400
   # Runner 2 (Offset 30,000 auto-applied):
   ./run-test.sh 30000 5 20 300 2400
   # Runner 3 (Offset 60,000 auto-applied):
   ./run-test.sh 30000 5 20 300 2400
   # Runner 4 (Offset 90,000 auto-applied):
   ./run-test.sh 30000 5 20 300 2400
   ```

3. **Automated Cluster Metrics Report**:
   When the test completes, `/home/ubuntu/run-test.sh` automatically polls all cluster instances (Gateways, Workers, LB, Redis, Load Generator) and prints a high-resolution performance table showing:
   - **CPU Utilization (%)**: Min, Avg, Peak Max
   - **Memory Usage (MB)**: Avg, Peak Max
   - **Network Bandwidth (Mbps)**: Avg, Peak Max for Ingress (RX) and Egress (TX)
   - **Total Transferred Data**: Total GB received and sent
   - The report is also saved to `/home/ubuntu/k6-cluster-metrics.json`.

---

### Method 2: Running from your Local Machine

```bash
k6 run \
  -e HOST=<lb_public_ip> \
  -e PORT=80 \
  -e COORD_PORT=0 \
  -e VUS=500 \
  -e PLAYERS_PER_ROOM=5 \
  -e STROKE_HZ=20 \
  scripts/k6_grpc_load_test.js
```

---

## Teardown / Cleanup

To avoid ongoing AWS charges when you finish testing:

```bash
terraform destroy
```

