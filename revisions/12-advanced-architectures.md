# 12 - Advanced Architecture Patterns

## AWS Well-Architected Framework

### 6 Pillars

| Pillar | Focus | Key Principles |
|--------|-------|---------------|
| **Operational Excellence** | Run and monitor systems | Automate, small frequent changes, learn from failures, IaC |
| **Security** | Protect information and systems | Least privilege, traceability, defense in depth, automate security |
| **Reliability** | Recover from failures | Auto-recovery, test recovery, scale horizontally, stop guessing capacity |
| **Performance Efficiency** | Use compute efficiently | Right technology for workload, experiment, go global in minutes |
| **Cost Optimization** | Avoid unnecessary costs | Pay only for what you use, measure efficiency, stop spending on undifferentiated heavy lifting |
| **Sustainability** | Minimize environmental impact | Understand impact, set sustainability goals, maximize utilization |

### Well-Architected Tool
- Review workloads against best practices
- Generate improvement plan
- Free to use in AWS Console

---

## Event-Driven Architecture

### Pattern: EventBridge + Lambda + SQS

```
┌─────────────┐     ┌──────────────┐     ┌─────────┐     ┌──────────┐
│ Source Event │ ──→ │ EventBridge  │ ──→ │ Lambda  │ ──→ │ DynamoDB │
│ (S3, API,   │     │ (Rules +     │     │ (Process│     │ (Store)  │
│  custom)    │     │  Filtering)  │     │  Event) │     │          │
└─────────────┘     └──────────────┘     └─────────┘     └──────────┘
                           │
                           ├──→ SQS (buffer for async processing)
                           └──→ Step Functions (orchestration)
```

### Key Principles
- Loose coupling between producer and consumer
- Services communicate through events (async)
- Each service owns its data
- Built-in retry and error handling

### When to Use
| Scenario | Pattern |
|----------|---------|
| React to state changes | EventBridge → Lambda |
| Fan-out to multiple consumers | SNS → SQS queues |
| Ordered processing | Kinesis / SQS FIFO |
| Complex orchestration | Step Functions |
| Scheduled tasks | EventBridge cron → Lambda |

### Exam Tips - Event-Driven
- "Decouple services" → Events (EventBridge, SNS, SQS)
- "React to S3 upload" → S3 Event → Lambda (or EventBridge)
- "Multiple services react to one event" → SNS fan-out to SQS
- "Order matters" → Kinesis or SQS FIFO

---

## Microservices Architecture

### Pattern: ECS/EKS + ALB + Service Discovery

```
┌──────────┐     ┌─────────┐     ┌───────────────────────────────────┐
│  Client  │ ──→ │   ALB   │ ──→ │  ECS/EKS Cluster                 │
│          │     │ (routing)│     │  ┌──────┐ ┌──────┐ ┌──────────┐  │
└──────────┘     └─────────┘     │  │User  │ │Order │ │Payment   │  │
                                  │  │Svc   │ │Svc   │ │Svc       │  │
                                  │  └──┬───┘ └──┬───┘ └──────────┘  │
                                  │     │        │                     │
                                  │  ┌──┴────────┴──┐                 │
                                  │  │ Cloud Map     │                 │
                                  │  │ (Service      │                 │
                                  │  │  Discovery)   │                 │
                                  └──┴───────────────┴─────────────────┘
```

### Components
| Component | Role |
|-----------|------|
| **ALB** | Path-based routing to different services |
| **ECS/EKS** | Container orchestration |
| **Cloud Map** | Service discovery (DNS or API-based) |
| **X-Ray** | Distributed tracing across services |
| **AppMesh** | Service mesh (traffic management, observability) |

### Communication Patterns
| Pattern | Implementation | Use Case |
|---------|---------------|----------|
| **Synchronous** | REST/gRPC via ALB/NLB | Real-time responses |
| **Asynchronous** | SQS/SNS/EventBridge | Decoupled, eventual consistency |
| **Event Sourcing** | Kinesis/DynamoDB Streams | Audit trail, replay events |
| **Saga Pattern** | Step Functions | Distributed transactions |

### Exam Tips - Microservices
- "Service discovery in ECS" → AWS Cloud Map
- "Traffic management between microservices" → App Mesh
- "Trace requests across services" → X-Ray
- "Path-based routing to different services" → ALB with target groups
- "Distributed transaction" → Saga pattern with Step Functions

---

## Serverless Architecture

### Pattern: API Gateway + Lambda + DynamoDB + S3 + CloudFront

```
┌────────────────────────────────────────────────────┐
│                    CloudFront                        │
│  ┌──────────────────┐  ┌───────────────────────┐   │
│  │ S3 (Static Site) │  │ API Gateway (REST API) │   │
│  │ HTML/CSS/JS      │  │       │                │   │
│  └──────────────────┘  │    Lambda              │   │
│                         │       │                │   │
│                         │    DynamoDB            │   │
│                         └───────────────────────┘   │
└────────────────────────────────────────────────────┘
          ↑                        ↑
    Route 53 (DNS) + ACM (HTTPS)
```

### Full Serverless Stack

| Layer | Service |
|-------|---------|
| DNS + SSL | Route 53 + ACM |
| CDN | CloudFront |
| Static hosting | S3 |
| API layer | API Gateway |
| Compute | Lambda |
| Database | DynamoDB |
| Auth | Cognito |
| File storage | S3 |
| Search | OpenSearch Serverless |
| Messaging | SQS, SNS, EventBridge |
| Orchestration | Step Functions |

### Exam Tips - Serverless
- "Least operational overhead" → Serverless stack
- "Static website + API backend" → S3 + CloudFront + API Gateway + Lambda + DynamoDB
- "Authentication for serverless app" → Cognito User Pool
- "HTTPS for S3 website" → CloudFront + ACM (S3 website endpoint is HTTP only)

---

## Data Lake Architecture

### Pattern: S3 + Glue + Athena + QuickSight

```
┌──────────────────────────────────────────────────────────────┐
│                        Data Lake on S3                         │
│                                                               │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌───────────┐ │
│  │ Ingest  │ →  │  Store  │ →  │ Process │ →  │ Analyze/  │ │
│  │         │    │         │    │ & Catalog│    │ Visualize │ │
│  └─────────┘    └─────────┘    └─────────┘    └───────────┘ │
│                                                               │
│  Kinesis         S3 (raw,        Glue ETL      Athena (SQL)  │
│  Firehose        cleaned,        Glue Catalog  Redshift      │
│  DMS             curated)        Lake Formation QuickSight   │
│  DataSync                        EMR           SageMaker     │
│  Snow Family                                                  │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | Role |
|-----------|------|
| **S3** | Central storage (raw, processed, curated zones) |
| **Kinesis / Firehose** | Real-time data ingestion |
| **AWS Glue** | ETL (Extract, Transform, Load) + Data Catalog |
| **Glue Data Catalog** | Metadata repository (schemas, tables) |
| **Lake Formation** | Security, access control, governance for data lake |
| **Athena** | Serverless SQL queries on S3 (pay per query) |
| **Redshift Spectrum** | Query S3 from Redshift (joins with DW data) |
| **QuickSight** | BI visualization and dashboards |
| **EMR** | Big data processing (Hadoop, Spark) |

### Athena Key Facts
- **Serverless** SQL query engine for S3
- Pay per TB scanned ($5/TB)
- Supports: CSV, JSON, Parquet, ORC, Avro
- Use columnar formats (Parquet/ORC) for cost savings (less data scanned)
- Partitioning reduces cost (query specific partitions)
- Federated queries: query data in RDS, DynamoDB, Redshift, etc.

### Exam Tips - Data Lake
- "Query S3 data serverless" → Athena
- "ETL jobs in AWS" → Glue
- "Data catalog / schema discovery" → Glue Data Catalog
- "Data lake security and governance" → Lake Formation
- "BI dashboards" → QuickSight
- "Cost-effective S3 queries" → Use Parquet format + partitioning

---

## Hybrid Cloud Architecture

### Pattern: Direct Connect + VPN + Storage Gateway

```
┌─────────────────────┐          ┌────────────────────────────┐
│    On-Premises       │          │          AWS Cloud          │
│                      │          │                             │
│  ┌────────────────┐  │   DX    │  ┌──────────────────────┐  │
│  │ Applications   │──┼─────────┼──│ VPC                  │  │
│  └────────────────┘  │         │  │  ├─ EC2              │  │
│                      │   VPN   │  │  ├─ RDS              │  │
│  ┌────────────────┐  │(backup) │  │  └─ ELB             │  │
│  │ Storage Gateway│──┼─────────┼──│                      │  │
│  │ (File/Volume)  │  │         │  └──────────────────────┘  │
│  └────────────────┘  │         │                             │
│                      │         │  ┌──────────────────────┐  │
│  ┌────────────────┐  │         │  │ S3 (backup, archive) │  │
│  │ AD / DNS       │──┼─────────┼──│                      │  │
│  └────────────────┘  │         │  └──────────────────────┘  │
└─────────────────────┘          └────────────────────────────┘
```

### Connectivity Options

| Solution | Speed | Encryption | Setup Time | Use Case |
|----------|-------|-----------|------------|----------|
| **Site-to-Site VPN** | Variable (internet) | ✅ IPsec | Minutes | Quick, backup, low cost |
| **Direct Connect** | 1/10 Gbps dedicated | ❌ (add VPN) | Weeks/months | High bandwidth, consistent |
| **DX + VPN** | 1/10 Gbps | ✅ | Weeks/months | Secure + fast |
| **Transit Gateway** | Aggregates all | Depends | Days | Multi-VPC hub |

### Hybrid Storage
| Service | Use Case |
|---------|----------|
| **Storage Gateway (File)** | NFS/SMB access to S3 with local cache |
| **Storage Gateway (Volume)** | iSCSI block storage with S3 backend |
| **Storage Gateway (Tape)** | Virtual tape library → Glacier |
| **FSx File Gateway** | Local cache for FSx for Windows |
| **DataSync** | Scheduled data synchronization |

### Exam Tips - Hybrid
- "Private, high-bandwidth on-prem to AWS" → Direct Connect
- "Quick encrypted connection" → Site-to-Site VPN
- "Both speed and encryption" → Direct Connect + VPN
- "On-prem apps access S3 as NFS" → File Gateway
- "Backup on-prem to cloud" → Storage Gateway or AWS Backup

---

## Multi-Account Strategy

### AWS Organizations + Control Tower

```
┌──────────────────────────────────────────────────────┐
│                  Management Account                    │
│  ┌──────────────────────────────────────────────┐    │
│  │                Control Tower                   │    │
│  │  ┌────────────────────────────────────────┐   │    │
│  │  │            SCPs (Guardrails)            │   │    │
│  │  └────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │
│  │  Security   │ │  Production │ │  Dev/Test   │    │
│  │  OU         │ │  OU         │ │  OU         │    │
│  │  ├─Audit    │ │  ├─App1     │ │  ├─Dev      │    │
│  │  ├─Log      │ │  ├─App2     │ │  ├─Staging  │    │
│  │  └─Security │ │  └─Shared   │ │  └─Sandbox  │    │
│  └─────────────┘ └─────────────┘ └─────────────┘    │
└──────────────────────────────────────────────────────┘
```

### Account Types (Best Practice)

| Account | Purpose |
|---------|---------|
| **Management** | Billing, Organizations management |
| **Log Archive** | Centralized CloudTrail, Config logs |
| **Audit/Security** | Security tools (GuardDuty, Security Hub) |
| **Shared Services** | Active Directory, DNS, shared infrastructure |
| **Sandbox** | Experimentation (restricted budgets) |
| **Production/Dev/Stage** | Workload isolation |

### Cross-Account Access
- IAM roles with trust policies (STS AssumeRole)
- Resource-based policies (S3 bucket policies, KMS key policies)
- AWS RAM (Resource Access Manager): share resources (subnets, Transit Gateway, etc.)

### AWS Control Tower
- Automated multi-account setup following best practices
- **Landing Zone:** Pre-configured multi-account environment
- **Guardrails:** Preventive (SCPs) + Detective (Config rules)
- **Account Factory:** Automated account provisioning
- Built on: Organizations, Config, CloudFormation, SSO

### Exam Tips - Multi-Account
- "Set up multi-account environment" → Control Tower
- "Share VPC subnets across accounts" → AWS RAM
- "Cross-account access" → IAM role + STS AssumeRole
- "Centralized logging" → Log Archive account + Organization Trail
- "Restrict services in child accounts" → SCPs

---

## Decoupling Patterns

### Pattern 1: SQS Between Tiers
```
Web Tier → SQS Queue → Processing Tier → Database
```
- Absorbs traffic spikes (queue buffers requests)
- Processing tier scales independently
- If processing fails, message stays in queue (retry)

### Pattern 2: SNS Fan-Out
```
               ┌→ SQS → Email Service
Event → SNS → ├→ SQS → Analytics Service
               └→ SQS → Audit Service
```
- One event triggers multiple independent processes
- Each consumer has its own queue (independent retry/scaling)

### Pattern 3: Async Processing with Callback
```
Client → API Gateway → Lambda (start job) → SQS → Worker
                    ↓
                Return job ID immediately
                    
Client → API Gateway → Lambda (check status) → DynamoDB
```
- Don't make client wait for long operations
- Return immediately, process in background

### Pattern 4: Event Sourcing
```
Commands → DynamoDB (event store) → DynamoDB Streams → Lambda → Read DB
```
- Store events (facts) not current state
- Rebuild state by replaying events
- Full audit trail

---

## Caching Layers

### Multi-Level Caching Architecture

```
┌──────────────────────────────────────────────────────────┐
│                                                           │
│  Client → CloudFront (Edge Cache, TTL)                   │
│              │                                            │
│              ↓                                            │
│         API Gateway (Response Cache, 300s TTL)           │
│              │                                            │
│              ↓                                            │
│         ElastiCache (Application Cache, Redis)           │
│              │ (cache miss)                               │
│              ↓                                            │
│         RDS Read Replica (DB-level read scaling)         │
│              │ (replica miss)                             │
│              ↓                                            │
│         RDS Primary (source of truth)                    │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Cache at Each Level

| Level | Technology | What to Cache | TTL |
|-------|-----------|---------------|-----|
| Edge | CloudFront | Static assets, API responses | Minutes to days |
| API | API Gateway cache | API responses | Seconds to minutes |
| Application | ElastiCache (Redis/Memcached) | DB queries, session, computed data | Seconds to hours |
| Database | DAX (DynamoDB) or Read Replicas | Query results | Varies |

### Exam Tips - Caching
- "Reduce latency for global users" → CloudFront
- "Cache database queries" → ElastiCache
- "Cache DynamoDB reads" → DAX
- "Read-heavy database" → Read Replicas + ElastiCache
- "Session storage" → ElastiCache Redis or DynamoDB
- "Static content caching" → CloudFront + S3

---

## Static Website Hosting

### Pattern: S3 + CloudFront + Route 53 + ACM

```
┌──────────┐    ┌──────────┐    ┌────────────┐    ┌──────┐
│ Route 53 │ →  │CloudFront│ →  │ S3 Bucket  │    │ ACM  │
│ (Alias)  │    │ (CDN)    │    │ (Static    │    │(SSL) │
│          │    │ + OAC    │    │  files)    │    │      │
└──────────┘    └──────────┘    └────────────┘    └──────┘
```

### Setup Steps
1. Create S3 bucket (does NOT need to be public)
2. Create CloudFront distribution with S3 origin
3. Create OAC — only CloudFront can access S3
4. Request ACM certificate in **us-east-1** (for CloudFront)
5. Create Route 53 Alias record pointing to CloudFront

### Key Points
- S3 bucket does NOT need website hosting enabled (CloudFront accesses via REST API)
- S3 bucket does NOT need to be public (OAC restricts access)
- HTTPS handled by CloudFront + ACM (S3 website endpoint is HTTP only)
- Custom error pages in CloudFront (e.g., 404 → /index.html for SPA)

### Exam Tips - Static Hosting
- "HTTPS for static site" → CloudFront + ACM (NOT S3 website endpoint)
- "Restrict S3 access" → OAC (Origin Access Control)
- "Custom domain + HTTPS" → Route 53 + CloudFront + ACM
- "SPA routing" → CloudFront custom error pages (redirect 403/404 to index.html)
- ACM cert MUST be in us-east-1 for CloudFront

---

## Architecture Decision Guide (Exam Scenarios)

### "Most Cost-Effective" → Think:
1. Serverless (Lambda, DynamoDB, S3)
2. Spot Instances for batch
3. Reserved/Savings Plans for steady-state
4. S3 Intelligent-Tiering / lifecycle
5. VPC Gateway Endpoints (free)

### "Highest Availability" → Think:
1. Multi-AZ (RDS, ELB, NAT Gateway)
2. Multi-Region (Aurora Global, DynamoDB Global Tables)
3. Auto Scaling Groups
4. Route 53 failover routing
5. S3 (11 9s durability, cross-region replication)

### "Least Operational Overhead" → Think:
1. Managed services (RDS, ElastiCache, OpenSearch)
2. Serverless (Lambda, Fargate, DynamoDB)
3. App Runner for simple containers
4. Aurora Serverless for variable DB load
5. AWS Backup for centralized backups

### "Most Secure" → Think:
1. Encryption everywhere (KMS, ACM)
2. VPC Endpoints (no internet exposure)
3. Security Groups + NACLs
4. IAM least privilege
5. WAF + Shield for public-facing
6. Private subnets + NAT Gateway

### "Real-Time Processing" → Think:
1. Kinesis Data Streams (< 200ms)
2. Lambda (event-driven)
3. DynamoDB Streams
4. NOT Firehose (60s minimum buffer)
5. NOT SQS (decoupling, not real-time streaming)

---

## 🔑 Architecture Anti-Patterns (Common Wrong Answers)

| If You See... | It's Probably Wrong Because... |
|---------------|-------------------------------|
| Single AZ for production | No fault tolerance |
| Polling S3 for changes | Use S3 events/EventBridge instead |
| Public RDS instance | Should be in private subnet |
| NAT Gateway for S3 access | Use VPC Gateway Endpoint (free) |
| CloudFront for TCP/UDP | CloudFront is HTTP only (use Global Accelerator) |
| SQS for real-time streaming | SQS is for decoupling (use Kinesis) |
| Glacier for frequent access | Glacier has retrieval delays/costs |
| Read Replica for HA | Read Replicas are for scaling (Multi-AZ for HA) |
| Dedicated Host for "isolation" | Dedicated Instance is enough (Host is for BYOL) |
| Lambda for 30-min jobs | Lambda max is 15 min (use ECS/Step Functions) |

---

## Exam Tips - Architecture Patterns

1. **Always think "managed over self-managed"** — AWS prefers managed services
2. **Stateless > Stateful** — Store sessions in ElastiCache/DynamoDB, not EC2
3. **Loose coupling** — Use SQS/SNS/EventBridge between components
4. **Defense in depth** — Multiple security layers (SG + NACL + WAF + Shield)
5. **Design for failure** — Multi-AZ, health checks, auto-recovery
6. **Scale horizontally** — Add more instances, not bigger instances
7. **Cache aggressively** — CloudFront → ElastiCache → Read Replica
8. **Automate everything** — CloudFormation, CDK, SAM, Config remediation
9. **Use the right database** — Relational (RDS), NoSQL (DynamoDB), Graph (Neptune)
10. **Encrypt by default** — KMS for data at rest, TLS for data in transit
