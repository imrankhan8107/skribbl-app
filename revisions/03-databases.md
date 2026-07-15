# 03 - Databases

## Amazon RDS (Relational Database Service)

### Supported Engines
- MySQL, PostgreSQL, MariaDB, Oracle, SQL Server, **Aurora** (MySQL/PostgreSQL compatible)

### Multi-AZ Deployment
- **Synchronous** standby replica in a different AZ
- **Automatic failover** (DNS automatically points to standby)
- NOT used for read scaling (standby is not accessible for reads)
- One DNS name → automatic failover
- Zero downtime operation (enable Multi-AZ = just click modify)

### Read Replicas
- **Asynchronous** replication
- Up to **15 Read Replicas** (Aurora) / **5 Read Replicas** (other engines)
- Can be in same AZ, cross-AZ, or **cross-region**
- Can be promoted to standalone DB (breaks replication)
- Read Replicas are for **read scaling**, NOT for disaster recovery (that's Multi-AZ)
- Network cost: same region = free; cross-region = charged

### Storage Auto Scaling
- Automatically increases storage when running low
- Set Maximum Storage Threshold
- Triggers when: free storage < 10% AND low-storage lasts 5 min AND 6 hours since last modification
- Useful for unpredictable workloads

### RDS Proxy
- Fully managed connection pooling for RDS
- Reduces failover time by up to 66%
- Supports IAM authentication
- **Perfect for Lambda** (which creates many short-lived connections)
- Never publicly accessible (only from within VPC)
- Enforces IAM auth + Secrets Manager for credentials

### Exam Tips - RDS
- "Managed relational database" → RDS
- "Automatic failover" → Multi-AZ
- "Read scaling" → Read Replicas
- "Lambda + RDS" → Use RDS Proxy
- "Encryption at rest" → Enable at creation (or snapshot → restore encrypted)
- Cannot encrypt an existing unencrypted RDS instance directly

---

## Amazon Aurora

### Key Architecture
- **6 copies** of data across **3 AZs** (2 copies per AZ)
- Self-healing: continuous background verification + repair
- **Writer endpoint:** Points to single master
- **Reader endpoint:** Load-balanced connection to all read replicas
- Up to **15 read replicas** with auto-scaling
- Storage auto-scales: 10 GB → 128 TB

### Aurora Features

| Feature | Description |
|---------|-------------|
| **Aurora Serverless v2** | Auto-scales compute (0.5 to 128 ACUs); pay per second; instant scaling |
| **Aurora Global Database** | 1 primary region + up to 5 secondary regions; < 1 second replication lag |
| **Aurora Multi-Master** | All nodes can read AND write (high availability for writes) |
| **Aurora ML** | Integrates with SageMaker/Comprehend for ML predictions via SQL |
| **Backtrack** | "Rewind" database to a point in time without restoring from backup |

### Aurora Serverless v2
- Scales to zero NOT supported (minimum 0.5 ACU)
- Use for: infrequent, intermittent, unpredictable workloads
- Instant scaling (unlike v1 which had delays)

### Aurora Global Database
- Primary region: read/write
- Up to 5 secondary regions: read-only (up to 16 read replicas each)
- Replication lag: **< 1 second**
- Promote secondary to primary: RTO < 1 minute
- Use case: disaster recovery, global reads

### Exam Tips - Aurora
- **5x performance of MySQL, 3x of PostgreSQL** (on RDS)
- Aurora costs ~20% more than RDS but more efficient
- "High availability for writes" → Aurora Multi-Master
- "Global disaster recovery with < 1s lag" → Aurora Global Database
- "Serverless database that auto-scales" → Aurora Serverless v2
- Aurora does NOT have a free tier

---

## Amazon DynamoDB

### Core Concepts
- **Fully managed**, serverless NoSQL database
- Single-digit millisecond performance at any scale
- **Primary Key:** Partition Key (PK) alone OR Partition Key + Sort Key (PK + SK)
- Max item size: **400 KB**
- Supports TTL (automatic item deletion)

### Capacity Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Provisioned** | Specify RCU/WCU, auto-scaling available | Predictable workload |
| **On-Demand** | Pay per request, no capacity planning | Unpredictable, new tables |

### RCU/WCU Calculations

**RCU (Read Capacity Units):**
- 1 RCU = 1 Strongly Consistent read/s for item ≤ 4 KB
- 1 RCU = 2 Eventually Consistent reads/s for item ≤ 4 KB
- Transactional reads = 2x RCU

**WCU (Write Capacity Units):**
- 1 WCU = 1 write/s for item ≤ 1 KB
- Transactional writes = 2x WCU

**Example:** 10 strongly consistent reads/s of 6 KB items = 10 × ceil(6/4) = 10 × 2 = 20 RCU

### Indexes

| Feature | GSI (Global Secondary Index) | LSI (Local Secondary Index) |
|---------|-----------------------------|-----------------------------|
| Partition Key | Different from table | Same as table |
| Sort Key | Any attribute | Different sort key |
| When to Create | Anytime | At table creation ONLY |
| Consistency | Eventually consistent only | Strongly or eventually consistent |
| Own Throughput | ✅ Yes (separate RCU/WCU) | ❌ Uses table's throughput |
| Throttling | Can throttle main table if GSI throttled | N/A |

### DAX (DynamoDB Accelerator)
- In-memory cache for DynamoDB
- **Microsecond** latency (vs millisecond for DynamoDB)
- No application code change needed (drop-in replacement)
- 5-minute default TTL
- Multi-AZ (minimum 3 nodes recommended)
- NOT for write-heavy workloads (cache reads only)

### DynamoDB Streams
- Ordered stream of item-level modifications (insert, update, delete)
- Retention: **24 hours**
- Use cases: trigger Lambda, cross-region replication, analytics
- Can choose what to capture: KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, NEW_AND_OLD_IMAGES

### DynamoDB Global Tables
- Multi-region, **active-active** replication
- Sub-second replication between regions
- Must enable DynamoDB Streams first
- Read/write to any region (no concept of primary)
- Use case: globally distributed applications

### Exam Tips - DynamoDB
- "Serverless NoSQL" → DynamoDB
- "Microsecond cache for DynamoDB" → DAX
- "ElastiCache vs DAX" → DAX for DynamoDB specifically; ElastiCache for general caching
- "Multi-region active-active" → DynamoDB Global Tables
- "Trigger Lambda on DB changes" → DynamoDB Streams
- "Auto-expire items" → TTL
- GSI throttling can affect the main table!
- On-demand is more expensive per request but no capacity planning

---

## Amazon ElastiCache

### Redis vs Memcached

| Feature | Redis | Memcached |
|---------|-------|-----------|
| Data structures | Complex (strings, lists, sets, sorted sets, hashes) | Simple (strings) |
| Replication | ✅ Multi-AZ with auto-failover | ❌ No replication |
| Persistence | ✅ AOF + RDB snapshots | ❌ No persistence |
| Backup/Restore | ✅ | ❌ |
| Pub/Sub | ✅ | ❌ |
| Multi-threaded | ❌ Single-threaded | ✅ Multi-threaded |
| Clustering | Cluster mode (data sharding) | Simple partitioning |
| Use Case | HA, persistence, complex data | Simple caching, multi-threaded |

### Caching Strategies

| Strategy | How It Works | Pros | Cons |
|----------|-------------|------|------|
| **Lazy Loading** | Cache on read miss; return from cache on hit | Only requested data cached; resilient to node failure | Cache miss = 3 trips; stale data possible |
| **Write-Through** | Write to cache AND DB simultaneously | Data never stale | Write penalty; cache filled with unread data |
| **TTL** | Expire cached data after time | Limits staleness | May serve stale data until expiry |

### Exam Tips - ElastiCache
- "In-memory caching" → ElastiCache
- "Need persistence/replication" → Redis
- "Simple, multi-threaded, no persistence" → Memcached
- "Session store" → Redis (or DynamoDB)
- ElastiCache does NOT support IAM auth (uses Redis AUTH or security groups)
- Redis Auth token can be set; supports SSL in transit

---

## Amazon Redshift

- **Columnar** storage (column-oriented, not row)
- SQL-based **data warehouse** for OLAP (Online Analytical Processing)
- NOT for OLTP (use RDS/Aurora for that)
- Based on PostgreSQL (but not used for regular OLTP)
- Up to 10x better performance than other DW through columnar + compression
- Nodes: Leader node (query planning) + Compute nodes (parallel execution)
- **Single-AZ** only (no Multi-AZ)

### Key Features
- **Redshift Spectrum:** Query data directly in S3 without loading
- **Redshift Serverless:** Auto-scaling, pay per query
- **Enhanced VPC Routing:** All COPY/UNLOAD traffic goes through VPC
- **Snapshots:** Automated + manual; can copy to another region for DR
- **Concurrency Scaling:** Automatically adds cluster capacity for burst read queries

### Exam Tips - Redshift
- "Data warehouse / analytics / OLAP" → Redshift
- "Query S3 data without loading" → Redshift Spectrum (or Athena)
- "NOT for OLTP" — common distractor
- Redshift is provisioned (plan capacity) unless using Serverless
- Single-AZ: rely on snapshots for DR

---

## Purpose-Built Databases (Quick Reference)

| Service | Type | Use Case |
|---------|------|----------|
| **Neptune** | Graph DB | Social networks, fraud detection, knowledge graphs |
| **DocumentDB** | Document DB (MongoDB-compatible) | Content management, catalogs, user profiles |
| **Keyspaces** | Wide-column (Cassandra-compatible) | IoT, time-series, high-volume apps |
| **QLDB** | Ledger (immutable) | Financial transactions, supply chain, audit trail |
| **Timestream** | Time-series | IoT sensor data, DevOps metrics, real-time analytics |

### Exam Tips - Purpose-Built
- "Graph database" → Neptune
- "MongoDB compatible" → DocumentDB
- "Cassandra compatible" → Keyspaces
- "Immutable ledger / cryptographic verification" → QLDB
- "Time-series data" → Timestream
- These are **fully managed** — no operational overhead

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| RDS Read Replicas (non-Aurora) | Up to 5 |
| Aurora Read Replicas | Up to 15 |
| Aurora data copies | 6 across 3 AZs |
| Aurora storage max | 128 TB |
| Aurora Global DB replication lag | < 1 second |
| Aurora Global DB secondary regions | Up to 5 |
| DynamoDB max item size | 400 KB |
| DynamoDB Streams retention | 24 hours |
| DAX default TTL | 5 minutes |
| 1 RCU (strongly consistent) | 1 read/s, ≤ 4 KB |
| 1 WCU | 1 write/s, ≤ 1 KB |
| ElastiCache Redis max nodes per cluster | 6 (1 primary + 5 replicas) |
| Redshift node types | Dense Compute (dc2) / RA3 (managed storage) |

---

## Gotchas & Exam Traps

1. **Multi-AZ ≠ Read Replica** — Multi-AZ is for HA (failover), Read Replica is for scaling reads
2. **Read Replicas can be promoted** — but this breaks replication permanently
3. **Aurora Serverless v2** does NOT scale to zero (min 0.5 ACU)
4. **DynamoDB GSI** can throttle the base table if it doesn't have enough WCU
5. **LSI must be created at table creation** — cannot add later
6. **DAX is for reads** — doesn't help write-heavy workloads
7. **Redshift is OLAP** — if the question mentions OLTP transactions, it's wrong
8. **ElastiCache Redis** supports replication; Memcached does NOT
9. **RDS encryption** must be enabled at creation (can't encrypt existing instance in-place)
10. **DynamoDB On-Demand** is more expensive per request but better for unpredictable traffic
