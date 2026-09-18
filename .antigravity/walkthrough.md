# Walkthrough — Step 3B: Multi-Host Cloud Architecture on AWS

Implemented a production-grade, multi-host distributed cluster on **Amazon Web Services (AWS)** using Terraform in a new [infra/aws/](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws) module. Existing Oracle Cloud and Azure configurations were kept strictly untouched.

---

## What Was Created & Changed

### 1. Dedicated Multi-Host AWS Terraform Module ([infra/aws/](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws))

* **Infrastructure Configuration ([infra/aws/main.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/main.tf))**:
  * **VPC & Networking**: Dedicated VPC (`10.10.0.0/16`), public subnet, internet gateway, and route table.
  * **Redis Tier**: Dedicated EC2 instance (`aws_instance.redis`) running Redis 7 with AOF persistence on port 6379.
  * **Go Gateway Tier**: Scalable EC2 cluster (`aws_instance.gateways`, default 2 instances) running compiled Go Gateway binaries (`:9000` data plane, `:9100` coord control plane) with `GATEWAY_ID` advertising to Redis.
  * **Python Worker Tier**: Scalable EC2 cluster (`aws_instance.workers`, default 2 instances) running FastAPI + gRPC Servicers (`:50051`), dynamically discovering and advertising their private IPs.
  * **Nginx Load Balancer Tier**: Front-door EC2 instance (`aws_instance.lb`) with dynamic upstream configuration.

* **Strict Ingress Security Group (`aws_security_group.cluster`)**:
  * **Zero ports exposed to `0.0.0.0/0`**:
    * **Internal Communication**: Ingress from `self = true` on all TCP ports allows seamless communication between Nginx, Gateways, Workers, and Redis across private IPs within the VPC.
    * **External Access**: Ingress for SSH (port 22), HTTP (port 80), HTTPS (port 443), Gateway data plane (port 9000), and Coord control plane (port 9100) is strictly restricted to `var.allowed_cidr` (the user's public IP).

* **Templates ([infra/aws/templates/](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/templates/))**:
  * `nginx.conf.tftpl`: Dynamically injects the private IPs of all provisioned Gateway instances into the `upstream gateways` block, maintaining exact room-sticky consistent hashing (`hash "$arg_gw$arg_room$arg_cid" consistent;`) with `worker_rlimit_nofile 131072` and `worker_connections 65536`.
  * `cloud-init-lb.tftpl`: Configures high-performance TCP parameters (`somaxconn=65535`, `tcp_tw_reuse=1`, `LimitNOFILE=131072`), installs Nginx, applies config, and starts the service.
  * `cloud-init-gateway.tftpl`: Sets up high connection limits, clones the repository, builds and runs the Go Gateway binary targeting the Redis instance.
  * `cloud-init-worker.tftpl`: Clones repository, obtains private IP via IMDSv2, and launches FastAPI/gRPC worker advertising its private IP for inter-host gRPC streams.
  * `cloud-init-redis.tftpl`: Tunes memory overcommit and runs Redis 7 container with append-only persistence.

* **Variables & Outputs ([infra/aws/variables.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/variables.tf) & [infra/aws/outputs.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/outputs.tf))**:
  * Configurable instance types, cluster sizing, region, and SSH keys.
  * Clear outputs: Load Balancer public IP/URL, Gateway public/private IPs, Worker private IPs, Redis private IP, and a ready-to-run k6 load-testing command.
  * Complete documentation in [infra/aws/README.md](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/README.md) and configuration template in [infra/aws/terraform.tfvars.example](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/terraform.tfvars.example).

### 2. Backend Service Discovery Enhancement ([backend/main.py](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/backend/main.py))

* Updated worker startup to check `WORKER_ADVERTISE_HOST` (falling back to `HOSTNAME` or `localhost`). When workers run on separate EC2 VMs, they advertise their EC2 private IP address so Go Gateways on other VMs dial them directly via gRPC over the internal network.

---

## Verification Results

1. **Existing Cloud Configurations Untouched**:
   * `git status` confirms zero modifications to [infra/oci/](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/oci) and [infra/azure/](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/azure).
2. **Terraform Formatting & Validation**:
   * `terraform fmt` passed cleanly across all files in [infra/aws/](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws).
3. **Backend Test Suite**:
   * All 274 backend tests passed cleanly (including state durability test suite).
4. **Go Gateway Test Suite**:
   * All 10 tests passed cleanly (`TestNewSessionRegistry`, `TestConcurrentAccess`, `TestWritePumpDelivery`, etc.).
5. **Frontend Test Suite**:
   * All 62 Vitest component and page tests passed cleanly.

---

## Step 3C: Push Load Testing Past 10,000 VUs (12,500 – 15,000 @ 20Hz)

* **Updated Load Test Harness ([scripts/k6_grpc_load_test.js](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/scripts/k6_grpc_load_test.js))**:
  * Added execution profiles and recipes for **12,500 VUs** and **15,000 VUs** at **20Hz** drawing frequency.
  * Updated `strokeProfileLabel(hz)` to distinguish high-intensity drawing (20Hz) from extreme stress testing (30Hz).
* **Comprehensive Scale Runbook ([docs/load-testing-15k.md](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/docs/load-testing-15k.md))**:
  * Detailed fan-out calculations (240,000 egress msgs/sec at 15k VUs).
  * Host kernel tuning parameters (`somaxconn=65535`, `nofile=131072`, `tcp_tw_reuse=1`).
  * Sizing matrix for AWS deployment across Gateways, Workers, and Redis.
