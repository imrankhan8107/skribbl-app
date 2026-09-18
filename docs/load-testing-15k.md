# 🚀 Load Testing Guide: Scaling to 15,000 Concurrent VUs @ 20Hz

This guide documents the architecture, OS kernel tuning, execution profiles, and metrics analysis for driving Skribbl beyond 10,000 Virtual Users (VUs) to **12,500 – 15,000 concurrent players at 20Hz drawing frequency**.

---

## 1. Workload Sizing & Fan-out Math

| Metric | 10,000 VUs | 12,500 VUs | 15,000 VUs |
|---|---|---|---|
| **Players per Room** | 5 | 5 | 5 |
| **Total Concurrent Rooms** | 2,000 | 2,500 | 3,000 |
| **Active Drawers (1 per room)** | 2,000 | 2,500 | 3,000 |
| **Active Guessers (4 per room)** | 8,000 | 10,000 | 12,000 |
| **Stroke Emission Rate** | 20 Hz (50ms interval) | 20 Hz (50ms interval) | 20 Hz (50ms interval) |
| **Stroke Ingress to Gateways** | 40,000 msgs/sec | 50,000 msgs/sec | 60,000 msgs/sec |
| **Stroke Fan-out Egress** | **160,000 msgs/sec** | **200,000 msgs/sec** | **240,000 msgs/sec** |
| **gRPC Bidirectional Streams** | 2,000 streams | 2,500 streams | 3,000 streams |
| **Recommended Gateways** | 2–3 × `c5a.xlarge` | 3–4 × `c5a.xlarge` | 4 × `c5a.xlarge` |
| **Recommended Workers** | 2–3 × `c5a.xlarge` | 3–4 × `c5a.xlarge` | 4 × `c5a.xlarge` |

---

## 2. Infrastructure Deployment Topology (AWS)

To sustain 240k broadcast writes/sec without dropping frames or triggering WebSocket TCP backpressure:

```
                               k6 Load Generators
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │   Nginx Reverse Proxy / LB    │ (c5a.xlarge)
                       │   hash "$arg_gw$arg_room$arg_cid"
                       └───────┬───────────────┬───────┘
                               │               │
               ┌───────────────▼┐             ┌▼───────────────┐
               │ Go Gateway 1   │             │ Go Gateway 4   │ (4 × c5a.xlarge)
               │ ~3,750 WS VUs  │   . . .     │ ~3,750 WS VUs  │
               │ ~60k writes/s  │             │ ~60k writes/s  │
               └───────┬────────┘             └────────┬───────┘
                       │                               │
                       │   gRPC RoomStream (:50051)    │
                       └───────────────┬───────────────┘
                                       ▼
                       ┌───────────────────────────────┐
                       │    Python Game Workers (1..4) │ (4 × c5a.xlarge)
                       │    ~750 rooms per worker node │
                       └───────────────┬───────────────┘
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │     Dedicated Redis 7         │ (t3.medium / ElastiCache)
                       │     Room routing & snapshots  │
                       └───────────────────────────────┘
```

---

## 3. Host OS & TCP Kernel Tuning

On all EC2 instances (Load Balancer, Gateways, Workers, and k6 runners), apply the following `sysctl` limits:

```ini
# /etc/sysctl.d/99-skribbl-tuning.conf
fs.file-max = 2097152
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65536
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_max_syn_backlog = 65536
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
```

Reload with:
```bash
sudo sysctl --system
```

Set file descriptor limits in `/etc/security/limits.d/99-skribbl.conf`:
```text
* soft nofile 131072
* hard nofile 131072
* soft nproc 65536
* hard nproc 65536
```

---

## 4. Running the Tests with k6

### A. Quick Validation (500 VUs)
Verify coordination, room creation, and drawing fan-out:
```bash
k6 run -e VUS=500 -e PLAYERS_PER_ROOM=5 -e STROKE_HZ=20 -e HOST=<LB_PUBLIC_IP> scripts/k6_grpc_load_test.js
```

### B. Scaled Load (10,000 VUs @ 20Hz)
```bash
k6 run \
  -e VUS=10000 \
  -e PLAYERS_PER_ROOM=5 \
  -e STROKE_HZ=20 \
  -e RAMP_SECONDS=60 \
  -e HOST=<LB_PUBLIC_IP> \
  scripts/k6_grpc_load_test.js
```

### C. Peak Capacity Tier 1 (12,500 VUs @ 20Hz)
```bash
k6 run \
  -e VUS=12500 \
  -e PLAYERS_PER_ROOM=5 \
  -e STROKE_HZ=20 \
  -e RAMP_SECONDS=60 \
  -e HOST=<LB_PUBLIC_IP> \
  scripts/k6_grpc_load_test.js
```

### D. Peak Capacity Tier 2 (15,000 VUs @ 20Hz)
```bash
k6 run \
  -e VUS=15000 \
  -e PLAYERS_PER_ROOM=5 \
  -e STROKE_HZ=20 \
  -e RAMP_SECONDS=90 \
  -e HOST=<LB_PUBLIC_IP> \
  scripts/k6_grpc_load_test.js
```

---

## 5. Key Metrics & Pass Criteria

The test script automatically calculates and enforces acceptance thresholds in `handleSummary`:

1. **Connection Success (`ws_connection_success`)**: `≥ 99.0%`
   - Verified on initial WebSocket upgrade.
2. **Message Latency p95 (`message_latency`)**: `≤ 50ms`
   - Verified on `toggle_ready` → `player_list` round-trip.
3. **Game Completion Rate (`game_completion_rate`)**: `≥ 80.0%`
   - Measured per-room by the host across all rounds to `game_over`.
4. **Gateway Outbound Drop Rate**: `0` control frame drops.

