# Implementation Plan — Step 3B: Multi-Host Cloud Architecture on AWS

Create a production-grade, multi-host distributed deployment topology on AWS using Terraform in a dedicated `infra/aws/` directory. This architecture distributes the system across specialized compute tiers (Load Balancer, Gateways, Workers, Redis) to unlock scalability beyond the single-VM physical core limits.

---

## User Review Required

> [!IMPORTANT]
> **Strict Ingress Firewall (User IP / Self Only)**:
> In accordance with the user's security constraint, **no ports will be exposed to 0.0.0.0/0**.
> - All external ingress (SSH port 22, HTTP port 80/443, Gateway port 9000, Coord port 9100) will be strictly restricted to `var.my_ip` / `var.allowed_cidr` (the user's public IP).
> - All internal inter-tier traffic (Nginx to Gateways on :9000, Gateways to Workers on :50051/:8000, Gateways/Workers to Redis on :6379) will be strictly permitted only from within the cluster security group (`self = true`).

---

## Architecture Topology on AWS

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
                     │   Dedicated EC2 Instance or AWS ElastiCache    │
                     │   (Room registry, worker discovery, snapshots) │
                     └────────────────────────────────────────────────┘
```

---

## Proposed Changes

### 1. Backend Service Discovery Enhancement

#### [MODIFY] [backend/main.py](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/backend/main.py)
- Allow worker address registration to use `WORKER_ADVERTISE_HOST` (falling back to `HOSTNAME` or `localhost`). On multi-host AWS deployments, workers can advertise their EC2 private IP address so Go Gateways on other VMs connect directly via gRPC.

---

### 2. AWS Infrastructure as Code (`infra/aws/`)

#### [NEW] [infra/aws/variables.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/variables.tf)
- Configuration variables:
  - `aws_region`: AWS region (default: `us-east-1` or `eu-west-1`).
  - `vpc_cidr`: CIDR block for VPC (default: `10.10.0.0/16`).
  - `ssh_public_key`: SSH key for EC2 access.
  - `gateway_count`: Number of dedicated Go Gateway EC2 instances (default: 2).
  - `gateway_instance_type`: Instance shape for gateways (default: `c5a.xlarge` or `t3.medium`).
  - `worker_count`: Number of dedicated Python Worker EC2 instances (default: 2).
  - `worker_instance_type`: Instance shape for workers (default: `c5a.xlarge` or `t3.medium`).
  - `lb_instance_type`: Instance shape for Nginx LB (default: `c5a.large` or `t3.medium`).
  - `redis_instance_type`: Shape for standalone Redis instance (default: `t3.medium`).
  - `use_elasticache`: Boolean toggle for AWS ElastiCache vs dedicated Redis EC2.
  - `git_repo_url` & `git_branch`: Source repository configuration.

#### [NEW] [infra/aws/main.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/main.tf)
- Provider definition (`hashicorp/aws >= 5.0`).
- **Networking**:
  - `aws_vpc` (`skribbl-vpc`), `aws_internet_gateway`.
  - Public subnets for LB, Gateways, Workers, and Redis.
  - Route tables and internet gateway associations.
- **Security Groups**:
  - `lb_sg`: Ingress 80, 443, 22 from anywhere.
  - `gateway_sg`: Ingress 9000 (WS data plane) and 9100 (coord plane) from LB/clients; Ingress 22.
  - `worker_sg`: Ingress 50051 (gRPC) and 8000 (HTTP health) from Gateways and LB; Ingress 22.
  - `redis_sg`: Ingress 6379 from Gateways and Workers; Ingress 22.
- **Compute Resources**:
  - `aws_instance.redis`: Standalone Redis 7 instance with persistence.
  - `aws_instance.gateways` (count = `var.gateway_count`): Dedicated Go Gateway nodes.
  - `aws_instance.workers` (count = `var.worker_count`): Dedicated Python Worker nodes.
  - `aws_instance.lb`: Nginx Load Balancer instance configured with dynamic upstream gateway list.

#### [NEW] [infra/aws/templates/nginx.conf.tftpl](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/templates/nginx.conf.tftpl)
- Nginx configuration template dynamically populated with the private IPs of all `aws_instance.gateways.*.private_ip`.
- Configures consistent hash on `"$arg_gw$arg_room$arg_cid"` with tuned `worker_rlimit_nofile 131072` and `worker_connections 65536`.

#### [NEW] [infra/aws/templates/cloud-init-*.tftpl](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/templates/)
- Cloud-init provisioning templates for each tier:
  - `cloud-init-redis.tftpl`: Installs Docker, starts Redis 7 container with AOF/RDB persistence on port 6379.
  - `cloud-init-worker.tftpl`: Clones repo, installs dependencies or runs worker container with `WORKER_ADVERTISE_HOST=$(curl http://169.254.169.254/latest/meta-data/local-ipv4)`, pointing to Redis instance.
  - `cloud-init-gateway.tftpl`: Clones repo, builds and runs Go Gateway with `GATEWAY_ID`, pointing to Redis instance.
  - `cloud-init-lb.tftpl`: Installs Nginx, applies rendered `nginx.conf`, enables systemd service.

#### [NEW] [infra/aws/outputs.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/outputs.tf)
- Outputs:
  - `lb_public_ip` & `app_url`
  - `gateway_public_ips` & `gateway_private_ips`
  - `worker_private_ips`
  - `redis_private_ip`
  - `k6_command_example` (ready-to-run command targeting the multi-host deployment)

#### [NEW] [infra/aws/terraform.tfvars.example](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/terraform.tfvars.example) & [infra/aws/README.md](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/README.md)
- Step-by-step deployment and operational guide.

---

## Verification Plan

### Automated Validation
1. **Terraform Validation**:
   - Check syntax and formatting with `terraform fmt -check` and `terraform validate` in `infra/aws/`.
2. **Untouched Verifications**:
   - Verify `git status` confirms zero changes to `infra/oci/` and `infra/azure/`.
3. **Backend & Gateway Regression**:
   - Run `python -m pytest backend/tests/ -q` to confirm backend remains healthy.
   - Run `cd gateway && go test -v .` to confirm gateway tests pass.
