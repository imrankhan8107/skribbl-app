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
* **Dedicated In-VPC k6 Load Generator Instance**:
  * Added `aws_instance.load_generator` to [infra/aws/main.tf](file:///c:/Users/imran.am.khan/OneDrive%20-%20Accenture/Documents/python/skribbl-app/infra/aws/main.tf) with automated `k6` installation and kernel tuning.
  * Generated `/home/ubuntu/run-test.sh` on the instance for running in-VPC tests against the private IP of the Load Balancer, eliminating home Wi-Fi and NAT bottlenecks.
* **Live In-VPC AWS Acceptance Benchmark Results**:
  * **Test 1: 100 Players (50 rooms × 2 players @ 20Hz)**:
    * **Connection Success (Req 9.1)**: **100.00%** [PASS] (target $\ge$ 99%)
    * **Message Latency p95 (Req 9.2)**: **3.0ms** [PASS] (target $\le$ 50ms)
    * **Game Completion (Req 9.3)**: **98.00%** [PASS] (target $\ge$ 80%)
    * **Room Create RTT p95**: **15.64ms** | **Room Join RTT p95**: **10ms** | **WS Open RTT p95**: **2ms**
    * **Overall Acceptance**: **PASS**

  * **Test 2: 1,000 Players (200 rooms × 5 players @ 20Hz, Dedicated `c5a.xlarge` Compute)**:
    * **Connection Success (Req 9.1)**: **100.00%** (1,000 / 1,000) [PASS]
    * **Message Latency p95 (Req 9.2)**: **2.0ms** [PASS] (25x faster than 50ms requirement!)
    * **Game Completion (Req 9.3)**: **99.50%** (199 / 200 rooms completed all 3 rounds to game over!) [PASS]
    * **Player Session Completion**: **98.40%** (984 / 1,000 players completed full game)
    * **Total Live Messages**: **9,061,890 messages** sustained at **~6,781 writes/sec** for 22 minutes
    * **Total Network Throughput**: **2.95 GB** (2.5 GB received, 457 MB sent)
    * **Room Create RTT p95**: **9.0ms** | **Room Join RTT p95**: **6.0ms** | **WS Open RTT p95**: **2.0ms**
    * **HTTP Failures & Dropped Frames**: **0.00% / 0 drops**
    * **Overall Acceptance**: **PASS**

  * **Test 3: 3,000 Players (600 rooms × 5 players @ 20Hz, Multi-Container Cluster)**:
    * **Cluster Topology**: 2 Gateways × 3 containers = 6 Go Gateway processes (`c5a.2xlarge`); 2 Workers × 6 containers = 12 Python Worker processes (`c5a.2xlarge`); Redis on `c5a.large`; LB on `c5a.xlarge`.
    * **Efficiency**: Slashed VM count from 7 compute instances down to just 4 instances while sustaining identical peak performance.
    * **Connection Success (Req 9.1)**: **100.00%** (3,000 / 3,000) [PASS]
    * **Message Latency p95 (Req 9.2)**: **2.0ms** [PASS] (p90 = 2ms, med = 1ms, max = 10ms)
    * **Game Completion (Req 9.3)**: **93.33%** (560 / 600 rooms completed all 3 rounds to game over!) [PASS]
    * **Player Session Completion**: **92.26%** (2,768 / 3,000 players completed full game)
    * **Total Live Messages**: **29,939,840 messages** (24,875,469 received + 5,064,371 sent) sustained at **~18,612 rx msgs/sec** and **~3,789 tx msgs/sec** for 22 minutes
    * **Total Network Throughput**: **8.1 GB** (6.8 GB received, 1.3 GB sent at 5.1 MB/s)
    * **Room Create RTT p95**: **6.0ms** | **Room Join RTT p95**: **5.0ms** | **WS Open RTT p95**: **2.0ms**
    * **HTTP Failures & Dropped Frames**: **0.00% (0 / 3,001 requests)**
    * **Overall Acceptance**: **PASS**

  * **Test 4: 10,000 Players (2,000 rooms × 5 players @ 5Hz, Multi-Container Cluster)**:
    * **Cluster Topology**: 2 Gateways × 3 containers = 6 Go Gateway processes (`c5a.2xlarge`); 2 Workers × 6 containers = 12 Python Worker processes (`c5a.2xlarge`); Redis on `c5a.large`; LB on `c5a.xlarge`.
    * **Connection Success (Req 9.1)**: **100.00%** (10,000 / 10,000) [PASS]
    * **Message Latency p95 (Req 9.2)**: **7.0ms** [PASS] (target $\le$ 50ms — 7x faster than requirement!)
    * **Game Completion (Req 9.3)**: **96.50%** (1,930 / 2,000 rooms finished all 3 rounds to game over!) [PASS]
    * **Player Session Completion**: **95.52%** (9,552 / 10,000 players completed full game)
    * **Total Live Messages**: **29,801,602 messages** (24,919,761 received + 4,881,841 sent) sustained at **~18,233 rx msgs/sec** and **~3,572 tx msgs/sec** for 22m46s
    * **Total Network Throughput**: **7.4 GB** (6.3 GB received, 1.1 GB sent at 4.6 MB/s)
    * **Room Create RTT p95**: **71.0ms** (med = 4ms) | **Room Join RTT p95**: **28.0ms** (med = 4ms) | **WS Open RTT p95**: **21.0ms** (med = 1ms)
    * **HTTP Failures & Dropped Frames**: **0.00% (0 / 10,001 requests)**
    * **Overall Acceptance**: **PASS**

  * **Test 5: 15,000 Players (3,000 rooms × 5 players @ 5Hz, In-VPC AWS Cluster)**:
    * **Cluster Topology**: Multi-Host AWS Cluster (Terraform) with Nginx LB, Go Gateways, Python Game Workers, and dedicated Redis 7.
    * **Connection Success (Req 9.1)**: **100.00%** (14,996 / 14,996 WebSocket upgrades succeeded) [PASS]
    * **Message Latency p95 (Req 9.2)**: **28.0ms** (med = 2ms, p90 = 10ms, p95 = 28ms $\le$ 50ms) [PASS]
    * **Room Lifecycle & RTT**:
      * **Rooms Created**: **3,000 / 3,000 (100%)** — `k${vu.toString(36)}` fix completely cleared the earlier 1,000 `INVALID_NAME` errors!
      * **Rooms Joined**: **11,996 / 12,000 (99.97%)** (Room create p95: 73ms, Room join p95: 61ms, WS open p95: 36ms).
    * **Gateway Health**: Clean data plane with **0 control drops**, **0 lossy drops**, and **0 send buffer drops**.
    * **Identified Bottleneck & Root Cause**:
      * **Player Session Completion**: 27.76% (4,163 completed / 10,833 aborted via `errors_timeout`).
      * **Lobby Timeout Cascade**: Median session duration was exactly 3m0s (`LOBBY_TIMEOUT_MS = 180000`). Joiners sat in lobbies because hosts only issued 496 `start_game` requests.
      * **Root Cause Found**: In `backend/grpc_server.py`, the host's `VirtualTransport` was instantiated during `create_room` with `room_code = ""`. While `player_id` was rebound to the assigned UUID, `transport.room_code` remained `""`. On single-stream rooms, `room_manager.broadcast()` used the host transport's `send_room()`, emitting broadcasts with `room_code = ""`. The gateway dropped these into the void, preventing hosts from seeing $\ge 2$ players to start games.
      * **Interrupted VUs**: 3,001 VUs (the hosts) stayed alive waiting on `HOLD_SECONDS` / `setInterval` after joiners aborted at 3m, and were force-stopped at the 27m scenario deadline.



