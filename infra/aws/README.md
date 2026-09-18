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

# Cluster sizing
gateway_count = 2
worker_count  = 2
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
gateway_public_ips = ["54.y.y.1", "54.y.y.2"]
lb_public_ip = "54.x.x.x"
ssh_lb_command = "ssh ubuntu@54.x.x.x"
k6_load_test_command = "k6 run --env HOST=54.x.x.x --env PORT=80 --env COORD_HOST=54.y.y.1 --env COORD_PORT=9100 --env VUS=1000 scripts/k6_grpc_load_test.js"
```

Open `http://<lb_public_ip>` in your browser to verify gameplay.

---

## Running Distributed Load Tests

Run the k6 test targeting the load balancer and gateway coordination plane:

```bash
k6 run \
  --env HOST=<lb_public_ip> \
  --env PORT=80 \
  --env COORD_HOST=<gateway_public_ip_1> \
  --env COORD_PORT=9100 \
  --env VUS=2500 \
  scripts/k6_grpc_load_test.js
```

---

## Teardown / Cleanup

To avoid ongoing AWS charges when you finish testing:

```bash
terraform destroy
```

