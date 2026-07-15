# 11 - Disaster Recovery & Migration

## Key DR Concepts

### RPO & RTO

| Metric | Definition | Question It Answers |
|--------|-----------|---------------------|
| **RPO (Recovery Point Objective)** | Maximum acceptable data loss (time between last backup and disaster) | "How much data can we afford to lose?" |
| **RTO (Recovery Time Objective)** | Maximum acceptable downtime (time to restore service) | "How long can we be down?" |

```
         RPO                    RTO
    ←─────────────→     ←─────────────────→
    |               |     |                 |
Last Backup     DISASTER    Recovery Complete
```

- Lower RPO/RTO = more expensive
- RPO = 0 means NO data loss (synchronous replication required)
- RTO = 0 means instant failover (active-active required)

---

## DR Strategies (Cheapest → Most Expensive)

### 1. Backup & Restore

| Property | Value |
|----------|-------|
| Cost | 💰 (Cheapest) |
| RPO | Hours |
| RTO | Hours (24+) |
| How | Periodic backups to S3/Glacier, restore when disaster occurs |

**Implementation:**
- Automated snapshots: EBS, RDS, Redshift
- S3 cross-region replication for backups
- AWS Backup for centralized backup management
- Restore: launch infrastructure from backups/snapshots

**Use Case:** Non-critical systems, acceptable hours of downtime

---

### 2. Pilot Light

| Property | Value |
|----------|-------|
| Cost | 💰💰 |
| RPO | Minutes |
| RTO | 10s of minutes |
| How | Core systems always running (minimal version), scale up on disaster |

**Implementation:**
- Critical data continuously replicated (RDS read replica in DR region)
- Core infrastructure running but minimal (small instances or stopped)
- On disaster: scale up instances, switch DNS, promote read replicas
- Route 53 health checks trigger failover

**What's Running (Always):**
- Database replica (RDS cross-region read replica)
- Maybe: core app server (small size)

**What's NOT Running:**
- Web servers, app servers, full-scale infrastructure
- Scaled up on demand during DR event

**Use Case:** Important systems where minutes of downtime is acceptable

---

### 3. Warm Standby

| Property | Value |
|----------|-------|
| Cost | 💰💰💰 |
| RPO | Seconds |
| RTO | Minutes |
| How | Scaled-down full system always running in DR region |

**Implementation:**
- Full system running at minimum capacity in DR region
- Data continuously replicated (sync or near-sync)
- On disaster: scale up to production capacity + switch DNS
- Auto Scaling groups with low min capacity (scale up quickly)

**What's Running (Always):**
- Full application stack (web, app, DB) at reduced capacity
- Load balancer, Auto Scaling (minimum instances)
- Database with continuous replication

**Difference from Pilot Light:**
- Warm Standby = full system at reduced scale
- Pilot Light = only core/critical components

**Use Case:** Business-critical systems needing fast recovery

---

### 4. Multi-Site / Hot Standby (Active-Active)

| Property | Value |
|----------|-------|
| Cost | 💰💰💰💰 (Most expensive) |
| RPO | Near zero |
| RTO | Near zero (instant failover) |
| How | Full production environment running in multiple regions simultaneously |

**Implementation:**
- Active-active: both regions serve traffic
- Route 53 weighted/latency routing to both regions
- Data synchronization: Aurora Global Database, DynamoDB Global Tables
- No failover needed (both regions already active)
- Can also be active-passive with instant promotion

**Use Case:** Mission-critical, zero-tolerance for downtime

---

### DR Strategy Comparison Table

| Strategy | RPO | RTO | Cost | Complexity |
|----------|-----|-----|------|-----------|
| Backup & Restore | Hours | Hours (24h+) | $ | Low |
| Pilot Light | Minutes | 10s of min | $$ | Medium |
| Warm Standby | Seconds | Minutes | $$$ | High |
| Multi-Site Active-Active | Near zero | Near zero | $$$$ | Highest |

### Exam Tips - DR Strategies
- "Cheapest DR" → Backup & Restore
- "Lowest RTO/RPO" → Multi-Site Active-Active
- "Core systems running, scale on disaster" → Pilot Light
- "Full system at reduced capacity" → Warm Standby
- Know the order: Backup & Restore < Pilot Light < Warm Standby < Multi-Site

---

## AWS Backup

- **Centralized backup management** across AWS services
- Supports: EC2, EBS, RDS, Aurora, DynamoDB, EFS, FSx, Storage Gateway, S3
- **Backup Plans:** Schedule, retention, lifecycle (move to cold storage)
- **Cross-region backup:** Automatic copy to another region
- **Cross-account backup:** Copy to another AWS account (Organizations)
- **Vault Lock:** WORM (Write Once Read Many) — prevents deletion (compliance)
- **Point-in-time recovery** for supported services
- **Tags-based backup:** Automatically backup resources with specific tags

### Exam Tips - AWS Backup
- "Centralized backup across services" → AWS Backup
- "Compliance — cannot delete backups" → AWS Backup Vault Lock
- "Automated cross-region backup" → AWS Backup with cross-region copy rule
- Replaces manual snapshot/backup management per service

---

## AWS DMS (Database Migration Service)

### Key Concepts
- Migrate databases to AWS with **minimal downtime**
- Source remains operational during migration
- Supports continuous replication (CDC — Change Data Capture)
- Runs on EC2 instance (replication instance)

### Migration Types

| Type | Source → Target | SCT Needed? |
|------|-----------------|-------------|
| **Homogeneous** | Same engine (Oracle → Oracle, MySQL → MySQL) | ❌ No |
| **Heterogeneous** | Different engine (Oracle → PostgreSQL) | ✅ Yes (Schema Conversion Tool) |

### Sources & Targets
- **Sources:** On-prem databases, EC2 databases, RDS, Aurora, S3, MongoDB, Azure SQL
- **Targets:** RDS, Aurora, DynamoDB, S3, Redshift, Kinesis, OpenSearch, Neptune, DocumentDB

### AWS SCT (Schema Conversion Tool)
- Converts database schema from one engine to another
- Converts stored procedures, functions, views
- Highlights conversion issues (manual intervention needed)
- Not needed for homogeneous migrations

### DMS Features
| Feature | Description |
|---------|-------------|
| **Full Load** | Migrate all existing data |
| **CDC (Change Data Capture)** | Replicate ongoing changes after full load |
| **Full Load + CDC** | Initial migration + continuous sync |
| **Multi-AZ** | HA for replication instance |
| **Validation** | Verify data was migrated correctly |

### Exam Tips - DMS
- "Migrate database with minimal downtime" → DMS
- "Oracle to Aurora PostgreSQL" → DMS + SCT (heterogeneous)
- "MySQL on-prem to RDS MySQL" → DMS only (homogeneous)
- "Continuous replication during migration" → DMS with CDC
- DMS can also replicate to S3 (data lake ingestion pattern)

---

## Snow Family (Offline Data Migration)

| Device | Capacity | Transfer Size | Time |
|--------|----------|---------------|------|
| **Snowcone** | 8 TB HDD / 14 TB SSD | TBs | Ship both ways |
| **Snowball Edge (Storage)** | 80 TB | PBs | Ship both ways |
| **Snowball Edge (Compute)** | 42 TB + GPU | PBs | Ship + edge compute |
| **Snowmobile** | 100 PB | Exabytes | Truck to your DC |

### When to Use Snow vs Online Transfer

| Data Size | Network Speed | Time Online | Recommendation |
|-----------|--------------|-------------|----------------|
| 10 TB | 100 Mbps | ~12 days | Consider Snowball |
| 10 TB | 1 Gbps | ~1 day | Transfer online |
| 100 TB | 1 Gbps | ~12 days | Snowball Edge |
| 1 PB | 1 Gbps | ~120 days | Snowball Edge |
| > 10 PB | Any | Too long | Snowmobile |

### Exam Tips - Snow Family
- "Offline migration, no internet" → Snow Family
- "> 10 PB migration" → Snowmobile
- "Edge computing in remote location" → Snowball Edge Compute
- "Limited bandwidth" → Snowball Edge Storage Optimized
- OpsHub: management GUI for Snow devices
- Can run EC2 AMIs and Lambda on Snowball Edge

---

## AWS DataSync

### Key Concepts
- **Online data transfer** service (over network)
- Transfer between: on-premises ↔ AWS, or AWS ↔ AWS
- **Agent-based:** Install DataSync agent on-premises (or on Snow device)
- **Scheduled:** Set frequency (hourly, daily, weekly)
- **Bandwidth throttling:** Limit network usage
- Automatic: encryption, data validation, compression

### Supported Locations
| Source | Destination |
|--------|-------------|
| On-prem NFS/SMB | S3 (all classes), EFS, FSx |
| On-prem HDFS | S3 |
| AWS S3 | Another S3 bucket (different account/region) |
| AWS EFS | Another EFS |
| Other cloud (Google, Azure) | AWS storage |

### DataSync vs Storage Gateway vs Snow Family

| Service | Use Case | Speed |
|---------|----------|-------|
| **DataSync** | One-time or scheduled transfers (migration) | Online (network) |
| **Storage Gateway** | Ongoing hybrid access (continuous) | Online (network) |
| **Snow Family** | Offline large-scale transfers | Physical shipping |

### Exam Tips - DataSync
- "Migrate NFS to S3 on schedule" → DataSync
- "One-time large data transfer over network" → DataSync
- "Ongoing file access hybrid" → Storage Gateway (not DataSync)
- DataSync preserves metadata (permissions, timestamps)
- Up to 10 Gbps per task

---

## AWS Transfer Family

- Managed SFTP, FTPS, FTP, and AS2 protocol file transfers
- Destination: **S3 or EFS**
- Integrates with: AD, LDAP, custom auth (Lambda)
- Use case: partners/vendors who need file transfer using standard protocols
- DNS alias: can use existing DNS name (no client changes)
- Scales automatically, multi-AZ

### Exam Tips - Transfer Family
- "SFTP to S3" → Transfer Family
- "Partners upload files via FTP" → Transfer Family
- "Migrate FTP server to cloud" → Transfer Family

---

## AWS Application Discovery Service

### Discovery Types
| Type | How | Best For |
|------|-----|----------|
| **Agentless Discovery** | VMware vCenter connector | Quick overview, minimal setup |
| **Agent-Based Discovery** | Install agent on each server | Detailed data (network, processes, performance) |

### What It Discovers
- Server configurations, performance data, network connections
- Running processes, dependencies between servers
- Data stored in **AWS Migration Hub**

---

## AWS Migration Hub

- **Central tracking** for all migration activity
- Integrates with: DMS, SMS, Application Discovery Service, MGN
- Track progress of migrations across multiple tools
- Group servers into applications for migration planning

---

## AWS Server Migration Service (SMS) — Legacy

- **Incremental replication** of on-premises VMs to AWS
- Supports: VMware, Hyper-V, Azure VMs
- Creates AMIs from VM images
- Being replaced by **MGN (Application Migration Service)**

---

## AWS MGN (Application Migration Service)

### Key Concepts
- **Rehost (lift-and-shift)** migration from any source to AWS
- Replaces SMS (Server Migration Service)
- **Continuous block-level replication** (minimal impact on source)
- Supports: physical, virtual, and cloud servers
- Automated cutover: launch ready-to-use instances on AWS
- Non-disruptive testing before cutover

### How It Works
1. Install **replication agent** on source server
2. Continuous block-level replication to AWS (staging area)
3. Test: launch test instances (non-disruptive)
4. Cutover: launch production instances, switch traffic

### Exam Tips - MGN
- "Lift-and-shift migration" → MGN
- "Rehost with minimal downtime" → MGN (continuous replication)
- "Migrate physical servers to AWS" → MGN
- MGN is the **current recommended** tool for rehost migrations (replaces SMS)

---

## Migration Strategies (6 Rs)

| Strategy | Description | Example |
|----------|-------------|---------|
| **Rehost** (Lift & Shift) | Move as-is to cloud | MGN, VM Import |
| **Replatform** (Lift & Reshape) | Minor optimizations during migration | Move to RDS, Beanstalk |
| **Repurchase** | Move to SaaS | Move to Salesforce, Workday |
| **Refactor** (Re-architect) | Rebuild cloud-native | Microservices, serverless |
| **Retire** | Decommission | Turn off unused apps |
| **Retain** | Keep on-premises | Too complex to migrate now |

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| Backup & Restore RTO | Hours (24h+) |
| Pilot Light RTO | 10s of minutes |
| Warm Standby RTO | Minutes |
| Multi-Site RTO | Near zero |
| Aurora Global DB replication | < 1 second |
| DynamoDB Global Tables replication | Sub-second |
| DataSync max throughput | 10 Gbps/task |
| Snowball Edge capacity | 80 TB |
| Snowmobile capacity | 100 PB |
| DMS replication instance | EC2-based |

---

## Gotchas & Exam Traps

1. **Pilot Light ≠ Warm Standby** — Pilot Light is minimal core; Warm Standby is full but reduced
2. **DMS needs SCT for heterogeneous** migrations — not for homogeneous
3. **Snow Family is offline** — no internet needed (but DataSync is online)
4. **DataSync is for migration** (scheduled transfers); Storage Gateway is for ongoing hybrid access
5. **MGN replaces SMS** — SMS is legacy (but may still appear in exam)
6. **Multi-Site is most expensive** — both regions at full capacity
7. **DMS replication instance** is an EC2 — needs to be right-sized for performance
8. **AWS Backup Vault Lock** = WORM (cannot delete, even root can't)
9. **Transfer Family** is for file transfer protocols (SFTP/FTP) — not general migration
10. **DataSync preserves metadata** — important for compliance migrations
11. **Snowmobile** is for > 10 PB — don't use Snowball for exabyte-scale
12. **RPO = data loss, RTO = downtime** — don't confuse them (most common exam confusion)
