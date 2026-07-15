# 02 - Storage

## Amazon S3 (Simple Storage Service)

### S3 Storage Classes

| Class | Durability | Availability | Min Storage | Retrieval Fee | Use Case |
|-------|-----------|--------------|-------------|---------------|----------|
| **S3 Standard** | 99.999999999% (11 9s) | 99.99% | None | None | Frequently accessed data |
| **S3 Standard-IA** | 11 9s | 99.9% | 30 days | Per GB | Infrequent but rapid access |
| **S3 One Zone-IA** | 11 9s | 99.5% | 30 days | Per GB | Reproducible infrequent data |
| **S3 Glacier Instant** | 11 9s | 99.9% | 90 days | Per GB | Archive with instant access |
| **S3 Glacier Flexible** | 11 9s | 99.99% | 90 days | Per GB | Minutes to hours retrieval |
| **S3 Glacier Deep Archive** | 11 9s | 99.99% | 180 days | Per GB | Cheapest, 12-48 hour retrieval |
| **S3 Intelligent-Tiering** | 11 9s | 99.9% | None | Monitoring fee | Unknown/changing access patterns |

### Glacier Retrieval Options
| Tier | Glacier Flexible | Glacier Deep Archive |
|------|-----------------|---------------------|
| Expedited | 1-5 minutes | N/A |
| Standard | 3-5 hours | 12 hours |
| Bulk | 5-12 hours | 48 hours |

### S3 Intelligent-Tiering (Automatic Tiers)
1. Frequent Access (default)
2. Infrequent Access (30 days no access)
3. Archive Instant Access (90 days)
4. Archive Access (optional, 90-730 days)
5. Deep Archive Access (optional, 180-730 days)

---

### S3 Lifecycle Policies

**Transition Rules (minimum days):**
- Standard → Standard-IA or One Zone-IA: **30 days minimum**
- Standard-IA → Glacier classes: **30 days minimum** (total 60 from Standard)
- Smaller objects: min 128 KB for Standard-IA/One Zone-IA (charged minimum anyway)

**Expiration Rules:**
- Delete objects after N days
- Delete old versions
- Delete incomplete multipart uploads

### Exam Tips - Lifecycle
- Can't transition from Standard-IA to One Zone-IA
- Waterfall: Standard → Standard-IA → Glacier Instant → Glacier Flexible → Deep Archive
- 30-day minimum between each transition tier

---

### S3 Versioning
- Enabled at bucket level
- Protects against unintended deletes (adds delete marker)
- Any file not versioned prior = version "null"
- Suspending versioning does NOT delete existing versions
- **MFA Delete:** Requires MFA to permanently delete versions or change versioning state; only bucket owner (root) can enable

---

### S3 Replication

| Feature | CRR (Cross-Region) | SRR (Same-Region) |
|---------|--------------------|--------------------|
| Purpose | Compliance, lower latency, cross-account | Log aggregation, live replication between prod/test |
| Requirement | Both buckets must have versioning enabled | Both buckets must have versioning enabled |
| IAM | Proper IAM role required | Proper IAM role required |

**What IS replicated:**
- New objects after enabling replication
- Unencrypted objects and SSE-S3 encrypted objects
- SSE-KMS (with extra config)

**What is NOT replicated:**
- Existing objects (use S3 Batch Replication for those)
- Objects with SSE-C encryption
- Delete markers (optional to replicate)
- Deletes with version ID
- Objects in Glacier/Deep Archive

### Exam Tips - Replication
- No "chaining": If bucket A → B → C, objects in A don't auto-replicate to C
- Replication Time Control (RTC): guarantees 99.99% within 15 minutes

---

### S3 Pre-signed URLs
- Temporary access to private objects
- Generated using SDK/CLI with your credentials
- Expiration: default 1 hour (max 7 days with IAM user credentials)
- Inherits permissions of the IAM user/role that generated it
- Use case: allow temporary download/upload without making bucket public

---

### S3 Event Notifications
- Triggers on: `s3:ObjectCreated:*`, `s3:ObjectRemoved:*`, `s3:ObjectRestore:*`
- Destinations: **SNS, SQS, Lambda, EventBridge**
- EventBridge: more filtering, more destinations, archive/replay

---

### S3 Access Points
- Simplify managing access to shared datasets
- Each access point has its own DNS name and policy
- Can restrict to specific VPC (VPC origin)

---

### S3 Performance

| Feature | Description |
|---------|-------------|
| **Baseline** | 3,500 PUT/COPY/POST/DELETE + 5,500 GET/HEAD per prefix per second |
| **Multi-part Upload** | Recommended >100MB, required >5GB; parallelizes uploads |
| **Byte-Range Fetches** | Parallelize GETs by requesting byte ranges |
| **S3 Transfer Acceleration** | Uses CloudFront edge locations for faster upload (extra cost) |
| **S3 Select / Glacier Select** | Server-side filtering with SQL (retrieve less data) |

---

### S3 Encryption

| Type | Key Management | Header |
|------|---------------|--------|
| **SSE-S3** | AWS manages keys (AES-256) | `x-amz-server-side-encryption: AES256` |
| **SSE-KMS** | AWS KMS manages keys (audit trail in CloudTrail) | `x-amz-server-side-encryption: aws:kms` |
| **SSE-C** | Customer provides key (HTTPS required) | Key in request headers |
| **Client-Side** | Customer encrypts before upload | N/A |

**Exam Tips - Encryption:**
- SSE-KMS has API call limits (GenerateDataKey / Decrypt count toward KMS quotas: 5500-30000/s depending on region)
- SSE-C: AWS never stores your key; you must send it with every request
- Default encryption: SSE-S3 (can enforce with bucket policy)
- Bucket policy can deny `PutObject` without encryption headers

---

### S3 Access Control

| Method | Scope | Use Case |
|--------|-------|----------|
| **Bucket Policy** | Bucket level (JSON) | Cross-account access, enforce encryption, public access |
| **ACLs** | Object/bucket level | Legacy, less common |
| **Block Public Access** | Account or bucket level | Safety net to prevent public exposure |
| **Object Lock** | Object level | WORM (Write Once Read Many) - compliance/governance mode |
| **Glacier Vault Lock** | Vault level | Immutable policy, cannot be changed once locked |

**Object Lock Modes:**
- **Governance Mode:** Only users with special permissions can overwrite/delete
- **Compliance Mode:** NO ONE can overwrite/delete (not even root) until retention expires

---

## EBS (Elastic Block Store)

### Volume Types

| Type | Category | Max IOPS | Max Throughput | Size | Use Case |
|------|----------|----------|----------------|------|----------|
| **gp3** | General SSD | 16,000 | 1,000 MB/s | 1 GB - 16 TB | Default, cost-effective |
| **gp2** | General SSD | 16,000 (burst) | 250 MB/s | 1 GB - 16 TB | Legacy general purpose |
| **io2 Block Express** | Provisioned SSD | 256,000 | 4,000 MB/s | 4 GB - 64 TB | Highest performance |
| **io2** | Provisioned SSD | 64,000 | 1,000 MB/s | 4 GB - 16 TB | Databases, critical apps |
| **io1** | Provisioned SSD | 64,000 | 1,000 MB/s | 4 GB - 16 TB | Legacy provisioned |
| **st1** | Throughput HDD | 500 | 500 MB/s | 125 GB - 16 TB | Big data, data warehouse |
| **sc1** | Cold HDD | 250 | 250 MB/s | 125 GB - 16 TB | Infrequent access, cheapest |

### Key Comparisons
- **gp2 vs gp3:** gp2 IOPS linked to size (3 IOPS/GB); gp3 = 3,000 IOPS baseline (independent of size), cheaper
- **io1/io2:** Can provision IOPS independently; io2 has better durability (99.999%)
- **st1/sc1:** CANNOT be boot volumes
- **Multi-Attach:** Only io1/io2 in same AZ (up to 16 instances)

### EBS Snapshots
- Incremental (only changed blocks backed up)
- Stored in S3 (managed by AWS)
- Can copy cross-region (for DR)
- EBS Snapshot Archive: 75% cheaper, 24-72 hours to restore
- Recycle Bin: protect against accidental deletion (1 day to 1 year)
- Fast Snapshot Restore (FSR): no latency on first use ($$$)

### EBS Encryption
- Encrypted EBS volumes: data at rest, in-flight, all snapshots encrypted
- Encryption uses KMS (AES-256)
- To encrypt an unencrypted volume: snapshot → copy with encryption → create volume from encrypted snapshot
- Can set default encryption for all new EBS volumes in a region

### Exam Tips - EBS
- EBS is AZ-locked (cannot attach across AZs)
- Root EBS volume deleted by default on termination (can disable)
- gp3 is generally the right answer for "cost-effective SSD"
- io2 for "highest IOPS provisioned" workloads
- Multi-Attach = io1/io2 only, same AZ

---

## EFS (Elastic File System)

### Key Features
- **Managed NFS** (Network File System) — Linux only (NFSv4.1)
- Multi-AZ (Regional) or One Zone
- Auto-scales (no capacity planning), pay per use
- Supports thousands of concurrent connections
- Works with EC2, ECS, EKS, Fargate, Lambda

### Performance Modes (set at creation)
| Mode | Use Case |
|------|----------|
| **General Purpose** | Latency-sensitive (web, CMS) — default |
| **Max I/O** | Higher latency, higher throughput, highly parallel (big data, media processing) |

### Throughput Modes
| Mode | Description |
|------|-------------|
| **Bursting** | Throughput scales with storage size |
| **Provisioned/Enhanced** | Set throughput independently of storage |
| **Elastic** | Auto-scales throughput for unpredictable workloads |

### Storage Classes
- **Standard:** Frequently accessed
- **Infrequent Access (EFS-IA):** Lower cost, retrieval fee (use lifecycle policy, e.g., move after 30 days)
- **One Zone:** Single AZ (cheaper, use with IA for 90%+ cost savings)

### Exam Tips - EFS
- Linux only (Windows → FSx for Windows)
- 10x cost of EBS, but shared + auto-scaling
- POSIX-compliant
- Encryption at rest with KMS

---

## FSx

| Feature | FSx for Windows | FSx for Lustre |
|---------|----------------|----------------|
| Protocol | SMB, NTFS | POSIX (Linux) |
| Use Case | Windows file shares, AD integration | HPC, ML, video processing |
| Integration | Active Directory | S3 (seamless) |
| Multi-AZ | ✅ (HA) | ❌ (single AZ) |
| Performance | Up to GB/s, millions IOPS | 100s GB/s, millions IOPS |

### FSx for Lustre Deployment Options
- **Scratch:** Temporary, high burst, no replication (short-term processing)
- **Persistent:** Long-term storage, data replicated within same AZ

---

## Instance Store
- **Ephemeral** block storage physically attached to the host
- **Highest IOPS** available (millions of IOPS for some types)
- Lost on: stop, hibernate, termination, hardware failure
- Use case: buffer, cache, scratch data, temporary content
- Cannot be resized or backed up manually

### Exam Tips - Instance Store
- "Highest I/O performance" + "temporary/cache" → Instance Store
- NOT for durable data
- Size fixed based on instance type

---

## Storage Gateway

| Type | Protocol | Use Case | Storage |
|------|----------|----------|---------|
| **S3 File Gateway** | NFS/SMB | File access to S3 with local cache | S3 (all classes except Glacier) |
| **FSx File Gateway** | SMB | Local cache for FSx for Windows | FSx for Windows |
| **Volume Gateway (Cached)** | iSCSI | Frequently accessed data cached locally, full data in S3 | S3 + EBS snapshots |
| **Volume Gateway (Stored)** | iSCSI | Full data locally, async backup to S3 | Local + S3 (EBS snapshots) |
| **Tape Gateway** | iSCSI VTL | Virtual tape backup to S3/Glacier | S3 Glacier / Deep Archive |

### Exam Tips - Storage Gateway
- "On-premises access to S3" → File Gateway
- "Backup tapes to cloud" → Tape Gateway
- "Low-latency access to frequently used data + S3 backend" → Volume Gateway (Cached)
- Runs as VM on-premises (VMware, Hyper-V, KVM) or as hardware appliance

---

## Snow Family

| Device | Storage | Compute | Use Case | Migration Size |
|--------|---------|---------|----------|----------------|
| **Snowcone** | 8 TB HDD / 14 TB SSD | 2 vCPUs, 4 GB RAM | Edge computing, small transfers | Up to TBs |
| **Snowball Edge Storage Optimized** | 80 TB | 40 vCPUs, 80 GB RAM | Large data migration, edge | Up to PBs |
| **Snowball Edge Compute Optimized** | 42 TB | 52 vCPUs, 208 GB RAM, optional GPU | Edge ML, processing | Up to PBs |
| **Snowmobile** | 100 PB (exabyte-scale) | N/A | Massive data center migrations | >10 PB |

### Key Facts
- Can run EC2 & Lambda on Snowball Edge
- DataSync agent can run on Snow devices
- Snowcone: can send data via DataSync over network as alternative
- Snowmobile: literal shipping container truck; use when >10 PB to transfer

### Exam Tips - Snow Family
- "Large offline migration" → Snowball Edge
- "Edge computing in disconnected locations" → Snowball Edge Compute Optimized
- ">10 PB" or "exabytes" → Snowmobile
- Snow devices for areas with limited/no internet connectivity
- OpsHub: GUI for managing Snow devices

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| S3 object max size | 5 TB |
| S3 single PUT max | 5 GB |
| S3 multipart threshold | 100 MB (recommended) |
| S3 requests/prefix | 3,500 PUT + 5,500 GET/s |
| S3 Standard-IA min storage | 30 days |
| S3 Glacier Flexible min | 90 days |
| S3 Glacier Deep Archive min | 180 days |
| EBS gp3 baseline IOPS | 3,000 |
| EBS io2 max IOPS | 64,000 (256,000 Block Express) |
| EBS max size | 16 TB (64 TB io2 Block Express) |
| EFS concurrent connections | Thousands |
| Snowball Edge Storage | 80 TB |
| Snowmobile | 100 PB |

---

## Gotchas & Exam Traps

1. **S3 is NOT a file system** — it's object storage. You can't mount it like EBS/EFS (but can use File Gateway)
2. **EBS is single-AZ** — to move, snapshot and recreate in new AZ
3. **EFS is regional** (multi-AZ) by default — more expensive than EBS but shared
4. **gp2 IOPS scales with size** (3 IOPS/GB) — gp3 is fixed baseline 3,000
5. **Instance Store data is LOST** on stop/terminate — NEVER for persistent data
6. **S3 replication doesn't replicate existing objects** without Batch Replication
7. **Glacier Deep Archive** is cheapest but slowest (12-48 hours)
8. **Multi-part upload** is required above 5 GB
9. **S3 Lifecycle minimum** 30 days before transitioning to IA classes
10. **SSE-KMS** can be throttled due to KMS API limits (important for high-throughput)
