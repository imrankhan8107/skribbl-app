# Multi-Host Distributed Deployment on Microsoft Azure (Terraform)

This Terraform configuration provisions a production-grade, multi-host distributed cluster on **Microsoft Azure** for the Skribbl application, separating Load Balancers, Go Gateways, Python Workers, Redis, and k6 Load Generators across dedicated Azure Linux Virtual Machines.

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
                     │ (Azure VM :9000)  ...         │ (Azure VM :9000│
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
                     │   Dedicated Azure VM with AOF persistence      │
                     │   (Room registry, worker discovery, snapshots) │
                     └────────────────────────────────────────────────┘
```

---

## Security & Firewall Constraints

In accordance with strict security standards, **zero ports are exposed to `0.0.0.0/0`**:

1. **Internal Inter-Tier Communication**: All traffic between Nginx, Gateways, Workers, and Redis is locked strictly to `VirtualNetwork` (only instances within the cluster subnet can communicate across private IPs).
2. **External Traffic (SSH, HTTP, Gateways, Coord)**: External ingress on ports 22, 80, 443, 9000-9020, and 9100-9120 is strictly locked down to `var.allowed_cidrs` (your local public IP/32 and CI/CD environment IP/32).

---

## Prerequisites

1. **Azure CLI** installed and authenticated (`az login`).
2. **Terraform** >= 1.5.0 installed (`terraform --version`).
3. An SSH public key on your local machine (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`).
4. Your current public IP address (run `curl ifconfig.me`).

---

## Quick Start

### 1. Initialize and Configure

```bash
cd infra/azure

# Copy example variables
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
azure_location = "eastus"
is_private     = false               # false = public game access; true = only allowed_cidrs
allowed_cidrs = [
  "YOUR_LOCAL_IP/32"    # Your local machine for administrative SSH (from curl ifconfig.me)
]
ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."

# Cluster sizing
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

Deployment takes ~3–5 minutes for cloud-init to provision packages, compile images, and start the services across VMs.

### 3. Verify Deployment

```bash
# View cluster access details
terraform output

# Check Nginx health
curl -I http://<LB_PUBLIC_IP>/health
```

### 4. Run In-VNet Load Tests

```bash
# SSH into the dedicated k6 load generator VM
ssh ubuntu@<LOAD_GENERATOR_PUBLIC_IP>

# Run a 1,000 VU load test: 5 players/room, 20Hz drawing, 30s ramp
./run-test.sh 1000 5 20 30
```

### 5. Teardown

```bash
terraform destroy
```
