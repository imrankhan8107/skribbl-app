# 01 - EC2 & Compute

## EC2 Instance Types

| Family | Prefix | Use Case | Example |
|--------|--------|----------|---------|
| General Purpose | t3, m5, m6i | Balanced workloads, web servers | t3.micro (free tier) |
| Compute Optimized | c5, c6i | Batch processing, ML, gaming, HPC | c5.large |
| Memory Optimized | r5, r6i, x1 | In-memory databases, real-time processing | r5.xlarge |
| Storage Optimized | i3, d2, h1 | Data warehousing, distributed file systems | i3.large |
| Accelerated Computing | p4, g5, inf1 | GPU workloads, ML inference, video encoding | p4d.24xlarge |

### Key Facts
- **t-series** = burstable (CPU credits); T2 Unlimited / T3 Unlimited for sustained high CPU
- **Naming:** m5.2xlarge → m = family, 5 = generation, 2xlarge = size
- **Nitro System:** Newer generation instances use Nitro for better performance, networking, and security

---

## Placement Groups

| Type | Description | Use Case | Limitations |
|------|-------------|----------|-------------|
| **Cluster** | All instances in same rack, same AZ | Low latency, HPC, big data | Single AZ, high risk if rack fails |
| **Spread** | Each instance on different hardware | High availability, critical apps | Max 7 instances per AZ per group |
| **Partition** | Instances spread across partitions (different racks) | HDFS, HBase, Cassandra, Kafka | Up to 7 partitions per AZ |

### Exam Tips
- **Cluster** = best network performance (10 Gbps between instances)
- **Spread** = max 7 per AZ (commonly tested!)
- **Partition** = big data workloads that need rack-awareness

---

## Tenancy

| Type | Description | Cost |
|------|-------------|------|
| **Shared (default)** | Multiple customers share same physical hardware | Cheapest |
| **Dedicated Instance** | Hardware dedicated to your account, may share with other instances in same account | More expensive |
| **Dedicated Host** | Entire physical server dedicated to you, visibility into sockets/cores | Most expensive, needed for BYOL |

### Exam Tips
- **Dedicated Host** → Use for: software licenses tied to physical cores/sockets (BYOL), compliance requirements
- **Dedicated Instance** → You don't control placement, just guaranteed no other AWS accounts on same hardware
- You CANNOT convert shared to dedicated after launch (must stop & restart with tenancy change)

---

## AMIs, User Data & Instance Metadata

### AMI (Amazon Machine Image)
- Pre-configured template: OS + software + config
- Region-specific (can copy cross-region)
- Can be shared with other accounts or made public
- Types: AWS-provided, Marketplace, Custom

### User Data
- Script that runs **once** at instance first boot
- Used for bootstrapping: install software, download files, start services
- Runs as **root** user
- Max size: 16 KB

### Instance Metadata
- URL: `http://169.254.169.254/latest/meta-data/`
- Access instance info from within the instance (instance ID, public IP, IAM role, etc.)
- IMDSv2 (recommended): requires token-based session (PUT request first)

---

## Auto Scaling Groups (ASG)

### Launch Template vs Launch Configuration
| Feature | Launch Template | Launch Configuration |
|---------|----------------|---------------------|
| Versioning | ✅ Yes | ❌ No |
| Multiple instance types | ✅ Yes | ❌ No |
| Spot + On-Demand mix | ✅ Yes | ❌ No |
| Recommended | ✅ Yes | ❌ Legacy (deprecated) |

### Scaling Policies

| Policy | How It Works | Use Case |
|--------|-------------|----------|
| **Target Tracking** | Maintain a target value (e.g., CPU at 50%) | Most common, simplest |
| **Step Scaling** | Scale by different amounts based on alarm thresholds | Fine-grained control |
| **Simple Scaling** | Add/remove fixed number when alarm triggers | Basic, waits for cooldown |
| **Scheduled** | Scale at specific times | Predictable traffic patterns |
| **Predictive** | ML-based, forecasts traffic | Recurring patterns |

### Key Concepts
- **Cooldown Period:** Default 300 seconds; prevents ASG from launching/terminating before previous activity takes effect
- **Lifecycle Hooks:** Perform actions before instance enters InService (Pending:Wait) or before termination (Terminating:Wait)
- **Health Check Grace Period:** Time before ASG checks health (default 300s) — allows instance to boot
- **Termination Policy:** Default = oldest launch config → closest to next billing hour → random
- **Instance Refresh:** Update all instances with new launch template (minimum healthy percentage)

### Exam Tips
- ASG + ALB health checks = best practice (not just EC2 status checks)
- ASG spans multiple AZs within a region (not cross-region)
- Desired capacity sits between min and max
- Scale-in protection available for specific instances

---

## Elastic Load Balancing (ELB)

### Load Balancer Comparison

| Feature | ALB | NLB | GLB | CLB |
|---------|-----|-----|-----|-----|
| Layer | 7 (HTTP/HTTPS) | 4 (TCP/UDP/TLS) | 3 (IP packets) | 4 & 7 |
| Performance | Good | Ultra-high, millions of req/s | — | Legacy |
| Static IP | ❌ (use Global Accelerator) | ✅ Elastic IP per AZ | — | ❌ |
| WebSocket | ✅ | ✅ | — | ❌ |
| SSL termination | ✅ | ✅ | — | ✅ |
| Path/Host routing | ✅ | ❌ | — | ❌ |
| Use Case | Web apps, microservices | Gaming, IoT, extreme perf | 3rd party firewalls, IDS/IPS | Legacy only |

### ALB (Application Load Balancer)
- **Layer 7:** HTTP, HTTPS, WebSocket
- **Routing rules:** path-based (`/api/*`), host-based (`api.example.com`), query string, headers
- **Target Groups:** EC2, ECS tasks, Lambda, IP addresses
- **Sticky Sessions:** Cookie-based (application or duration-based)
- Fixed hostname: `xxx.region.elb.amazonaws.com`
- True client IP in `X-Forwarded-For` header

### NLB (Network Load Balancer)
- **Layer 4:** TCP, UDP, TLS
- **Static IP:** One Elastic IP per AZ (whitelisting)
- **Ultra-low latency:** ~100ms (vs ~400ms for ALB)
- **Millions of requests per second**
- Preserves source IP (no X-Forwarded-For needed)
- Target Groups: EC2, IP addresses, ALB (NLB in front of ALB pattern)

### GLB (Gateway Load Balancer)
- **Layer 3:** IP packets (GENEVE protocol, port 6081)
- Route traffic to 3rd-party virtual appliances (firewalls, IDS/IPS)
- Transparent network gateway + load balancer
- Single entry/exit for all traffic inspection

### Key ELB Concepts

| Concept | Description |
|---------|-------------|
| **Cross-Zone LB** | Distributes evenly across all AZs (enabled by default for ALB, disabled for NLB) |
| **Connection Draining / Deregistration Delay** | Time to complete in-flight requests before deregistering (default 300s, set 0 to disable) |
| **Health Checks** | Ping protocol + path + port; unhealthy threshold = consecutive failures |
| **SSL/TLS** | ACM certificates, SNI for multiple certs on one LB (ALB & NLB only) |

### Exam Tips
- Need static IP? → **NLB** (or Global Accelerator for ALB)
- Need path routing? → **ALB**
- Need 3rd party appliances? → **GLB**
- Need extreme performance? → **NLB**
- ALB cannot do TCP pass-through (use NLB)
- CLB is legacy — almost always wrong answer in exam

---

## Lambda

### Key Limits & Facts

| Property | Value |
|----------|-------|
| Timeout | Max 15 minutes |
| Memory | 128 MB – 10,240 MB (10 GB) |
| Concurrency | 1000 per region (soft limit) |
| Deployment package | 50 MB zipped, 250 MB unzipped |
| /tmp storage | 512 MB – 10,240 MB |
| Environment variables | 4 KB |
| Layers | Up to 5 layers |

### Invocation Types

| Type | Behavior | Example |
|------|----------|---------|
| **Synchronous** | Caller waits for response | API Gateway, ALB, CloudFront |
| **Asynchronous** | Event queued, Lambda retries (2 retries) | S3, SNS, EventBridge |
| **Event Source Mapping** | Lambda polls source | SQS, Kinesis, DynamoDB Streams |

### Concurrency
- **Reserved Concurrency:** Guarantees a set number of concurrent executions for a function
- **Provisioned Concurrency:** Pre-initializes execution environments (no cold starts)
- **Throttling:** Returns 429 (sync) or retries (async) when limit hit

### Lambda Destinations
- For async invocations: route results to SQS, SNS, Lambda, or EventBridge
- Separate destinations for success and failure

### Versions & Aliases
- **Version:** Immutable snapshot (code + config)
- **Alias:** Pointer to a version (can split traffic between two versions for canary/blue-green)

### Exam Tips
- Lambda + SQS: batch size matters; if function fails, entire batch retries
- Lambda in VPC: needs NAT Gateway for internet access
- Lambda@Edge: run at CloudFront edge locations (viewer/origin request/response)
- /tmp for temporary files (up to 10 GB)
- EFS can be mounted for shared persistent storage

---

## Elastic Beanstalk

### Deployment Modes

| Mode | Downtime | Speed | Rollback | Cost |
|------|----------|-------|----------|------|
| **All at Once** | ✅ Yes | Fastest | Redeploy | No extra |
| **Rolling** | Partial (batch) | Slow | Redeploy | No extra |
| **Rolling with Additional Batch** | ❌ No | Slow | Redeploy | Small extra |
| **Immutable** | ❌ No | Slowest | Terminate new ASG | Double capacity |
| **Blue/Green** | ❌ No | Medium | Swap URL | Full duplicate |

### Key Facts
- Supports: Java, .NET, PHP, Node.js, Python, Ruby, Go, Docker
- **Web Server** vs **Worker** environments (worker uses SQS)
- Free to use (you pay for underlying resources)
- Uses CloudFormation under the hood
- `.ebextensions` folder for custom config (YAML/JSON, `.config` files)
- Single instance (dev) vs High Availability (prod) with ALB

### Exam Tips
- Blue/Green = two separate environments + Route 53 weighted/swap
- Immutable = safest for production (quick rollback = terminate new instances)
- "Least downtime" for production → Immutable or Blue/Green
- Worker tier processes long-running tasks from SQS queue

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| Spread placement group max per AZ | 7 instances |
| ASG default cooldown | 300 seconds |
| Lambda max timeout | 15 minutes |
| Lambda max memory | 10 GB |
| Lambda default concurrency | 1000/region |
| Lambda deployment package (zipped) | 50 MB |
| Lambda /tmp storage | Up to 10 GB |
| Lambda layers | Max 5 |
| ELB deregistration delay default | 300 seconds |
| User data max size | 16 KB |
| NLB latency | ~100ms |
| ALB latency | ~400ms |
