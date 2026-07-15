# 09 - Monitoring & Logging

## Amazon CloudWatch

### CloudWatch Metrics

| Type | Interval | Cost | Examples |
|------|----------|------|----------|
| **Basic Monitoring** | 5 minutes | Free | CPU, Network, Disk (EC2), StatusChecks |
| **Detailed Monitoring** | 1 minute | Paid | Same metrics, higher resolution |
| **Custom Metrics** | Up to 1 second (high-res) | Paid | Memory, disk space, custom app metrics |

### EC2 Default Metrics (NO agent needed)
- CPU Utilization
- Network In/Out
- Disk Read/Write (instance store only)
- Status Checks (System & Instance)

### EC2 Metrics NOT Available by Default
- **Memory utilization** ❌ (requires CloudWatch Agent)
- **Disk space utilization** ❌ (requires CloudWatch Agent)
- **Number of processes** ❌ (requires CloudWatch Agent)

### Custom Metrics
- `PutMetricData` API
- Dimensions: up to 30 per metric (e.g., InstanceId, Environment)
- Resolution: Standard (1 min) or High-Resolution (1 second)
- Accepts data points up to 2 weeks in the past, 2 hours in the future
- Metric Math: combine metrics with expressions

---

### CloudWatch Alarms

**States:**
| State | Meaning |
|-------|---------|
| `OK` | Metric within defined threshold |
| `ALARM` | Metric breached threshold |
| `INSUFFICIENT_DATA` | Not enough data to evaluate |

**Alarm Actions:**
| Target | Action |
|--------|--------|
| EC2 | Stop, Terminate, Reboot, Recover |
| Auto Scaling | Scale in/out |
| SNS | Send notification |

**Key Settings:**
- Period: Time to evaluate (e.g., 300 seconds)
- Evaluation Periods: How many consecutive periods to breach
- Datapoints to Alarm: How many of evaluation periods must be breaching
- **Composite Alarms:** Combine multiple alarms with AND/OR logic (reduce alarm noise)

### Exam Tips - Alarms
- "Recover EC2 instance on failure" → CloudWatch Alarm → EC2 Recovery action
- "Auto-terminate idle instances" → CloudWatch Alarm → EC2 Terminate
- "Reduce alarm noise" → Composite Alarms
- EC2 Recovery: moves instance to new host (same IP, metadata, placement group)

---

### CloudWatch Logs

**Components:**
| Component | Description |
|-----------|-------------|
| **Log Group** | Collection of log streams (set retention here: 1 day – 10 years, or never expire) |
| **Log Stream** | Sequence of log events from same source |
| **Log Event** | Single log entry (timestamp + message) |

**Sources:** EC2 (agent), Lambda, ECS, VPC Flow Logs, API Gateway, CloudTrail, Route 53, Elastic Beanstalk

### Log Features

| Feature | Description |
|---------|-------------|
| **Metric Filters** | Create CloudWatch metrics from log patterns (e.g., count ERROR occurrences) |
| **Logs Insights** | Interactive SQL-like query language for log analysis |
| **Subscription Filters** | Stream logs to Lambda, Kinesis Data Streams, Kinesis Firehose |
| **Export to S3** | Batch export (can take up to 12 hours) — use Subscription Filter for real-time |
| **Cross-account** | Share logs across accounts via subscription filters |
| **Log Anomaly Detection** | ML-based detection of unusual patterns |

### CloudWatch Logs to S3
- **Export (CreateExportTask):** Batch, takes hours, not real-time
- **Subscription Filter → Firehose → S3:** Near-real-time (recommended)
- **Subscription Filter → Lambda → S3:** Real-time, custom processing

### Exam Tips - Logs
- "Real-time log streaming to S3" → Subscription Filter + Firehose
- "Query and analyze logs" → CloudWatch Logs Insights
- "Create alarm from log pattern" → Metric Filter + Alarm
- "EC2 memory/disk metrics" → Install CloudWatch Agent
- Logs never expire by default (set retention policy!)

---

### CloudWatch Agent

**Unified CloudWatch Agent (recommended):**
- Collects both metrics AND logs
- Installs on EC2 or on-premises servers
- Config stored in SSM Parameter Store

**Metrics collected by agent:**
- Memory utilization (RAM)
- Disk space/usage
- Swap usage
- Custom application metrics
- Detailed networking (netstat)
- Process-level metrics

**Old Agent types (legacy):**
- CloudWatch Logs Agent: logs only
- CloudWatch Monitoring Scripts: metrics only (deprecated)
- **Always choose Unified Agent** in exam

---

## Amazon EventBridge (formerly CloudWatch Events)

### Key Concepts
- React to events from AWS services, custom apps, SaaS partners
- Schedule-based (cron/rate) or event-pattern based rules
- Default event bus (AWS services), Custom event bus, Partner event bus

### Common Triggers

| Source | Example Events |
|--------|---------------|
| EC2 | Instance state change (running, stopped, terminated) |
| CodePipeline | Pipeline execution state change |
| S3 | Object created/deleted (via EventBridge) |
| Health | Service health events |
| Scheduled | Cron: `cron(0 9 * * ? *)` |
| Config | Compliance state change |
| GuardDuty | New finding |
| CloudTrail | Any API call (via EventBridge) |

### Targets (30+ supported)
- Lambda, Step Functions, SQS, SNS, Kinesis, ECS Task, SSM, API Gateway, CodePipeline, and more

### Exam Tips - EventBridge
- "Trigger Lambda every hour" → EventBridge Scheduled Rule
- "React to EC2 state change" → EventBridge + Rule
- "SaaS event integration" → EventBridge Partner Event Bus
- EventBridge = evolved CloudWatch Events (use EventBridge terminology in exam)

---

## AWS CloudTrail

### Event Types

| Type | Description | Default |
|------|-------------|---------|
| **Management Events** | Control plane operations (Create, Delete, Modify resources) | ✅ Logged by default |
| **Data Events** | Data plane operations (S3 GetObject, Lambda Invoke) | ❌ Must enable (high volume) |
| **Insight Events** | Unusual activity detection (burst in API calls) | ❌ Must enable |

### Key Features
- **Event History:** Last 90 days of management events (free, always on)
- **Trail:** Store events in S3 for long-term retention + analysis
- **Organization Trail:** All accounts in org, single S3 bucket
- **Integrity Validation:** Ensure log files haven't been tampered (SHA-256)
- **Lake:** Managed data lake for querying events (SQL-based, 7-year retention)

### CloudTrail + EventBridge Integration
- Any API call logged by CloudTrail can trigger EventBridge rule
- Pattern: `"source": "aws.ec2", "detail-type": "AWS API Call via CloudTrail"`
- Use case: alert when IAM policy changed, security group modified

### Exam Tips - CloudTrail
- "Who did what and when" → CloudTrail
- "Log all API calls across all accounts" → Organization Trail
- "Detect unusual API activity" → CloudTrail Insights
- "Long-term audit trail" → CloudTrail → S3 (with lifecycle policy)
- "Prove logs not tampered" → Log File Integrity Validation
- Data Events cost extra (S3 object-level, Lambda invocations)

---

## AWS X-Ray

### Key Concepts
- **Distributed tracing** for microservices architectures
- Visualize request flow through services
- Identify performance bottlenecks and errors
- Works with: Lambda, ECS, EKS, EC2, Elastic Beanstalk, API Gateway, AppSync

### Components

| Component | Description |
|-----------|-------------|
| **Segment** | Data about work done by a single service |
| **Subsegment** | More detailed breakdown within a segment |
| **Trace** | End-to-end request across all services |
| **Service Map** | Visual representation of architecture + performance |
| **Annotations** | Key-value pairs (indexed, searchable) |
| **Metadata** | Key-value pairs (NOT indexed, for additional data) |
| **Groups** | Filter traces using expressions |

### X-Ray Integration
- **X-Ray SDK:** Instrument application code
- **X-Ray Daemon:** Runs on EC2/ECS, collects and sends traces
- **Lambda:** Built-in support (just enable Active Tracing)
- **API Gateway:** Enable tracing in stage settings
- **ECS:** Run X-Ray daemon as sidecar container

### Sampling Rules
- Default: 1 request/sec + 5% of additional requests
- Custom rules: define reservoir (fixed rate) + rate (percentage)
- Reduces cost while maintaining visibility

### Exam Tips - X-Ray
- "Trace requests across microservices" → X-Ray
- "Service map of application" → X-Ray
- "Find latency bottleneck in distributed app" → X-Ray
- "Searchable metadata in traces" → Use Annotations (not Metadata)
- X-Ray on Lambda: just enable (no daemon needed)

---

## AWS Config

### Key Concepts
- **Record** resource configuration changes over time
- **Evaluate** configurations against rules (compliance)
- **Remediate** non-compliant resources automatically

### Config Rules

| Type | Description | Examples |
|------|-------------|---------|
| **AWS Managed Rules** | Pre-built by AWS (150+) | s3-bucket-public-read-prohibited, encrypted-volumes |
| **Custom Rules** | Lambda-based custom logic | Custom compliance checks |

### Evaluation Triggers
- Configuration change (resource modified)
- Periodic (every 1/3/6/12/24 hours)

### Remediation
- **Auto-remediation:** SSM Automation documents fix non-compliant resources
- **Manual remediation:** Send notification for human action
- Retry: configure max auto-remediation attempts

### Multi-Account & Multi-Region
- **Aggregator:** Consolidate Config data across accounts/regions
- Organization-wide rules deployment

### Config vs CloudTrail vs CloudWatch

| Aspect | Config | CloudTrail | CloudWatch |
|--------|--------|-----------|------------|
| What | Resource state/compliance | API activity (who did what) | Metrics, logs, alarms |
| When | Configuration changes | API calls | Ongoing monitoring |
| Why | Compliance auditing | Security auditing | Performance monitoring |
| Action | Remediate non-compliance | Investigate incidents | Alert and auto-scale |

### Exam Tips - Config
- "Is my S3 bucket public?" → Config Rule
- "History of resource configurations" → Config
- "Auto-fix non-compliant resources" → Config + SSM Automation
- "Compliance across multiple accounts" → Config Aggregator
- Config is NOT preventive (detects after the fact)

---

## AWS Trusted Advisor

### Categories

| Category | Examples |
|----------|---------|
| **Cost Optimization** | Idle instances, underutilized EBS, unused EIPs |
| **Performance** | High-utilization instances, CloudFront optimization |
| **Security** | Open security groups, MFA on root, IAM usage |
| **Fault Tolerance** | Multi-AZ, backup checks, RDS snapshots |
| **Service Limits** | Approaching service quotas |

### Access Levels

| Plan | Available Checks |
|------|-----------------|
| **Basic & Developer** | 7 core checks (S3 bucket perms, SG ports, IAM, MFA, EBS snapshots, RDS snapshots, Service Limits) |
| **Business & Enterprise** | All checks + API access + CloudWatch integration |

### Exam Tips - Trusted Advisor
- "Right-size EC2 instances" → Trusted Advisor (or Compute Optimizer)
- "Check service limits" → Trusted Advisor
- "Security best practices overview" → Trusted Advisor
- Full Trusted Advisor requires Business or Enterprise support plan

---

## AWS Health Dashboard

### Service Health Dashboard
- Shows health of ALL AWS services across ALL regions
- Historical information
- Public: `health.aws.amazon.com`

### Account Health Dashboard (Personal Health Dashboard)
- Shows events that affect YOUR account/resources
- Proactive notifications for scheduled maintenance
- **EventBridge integration:** Trigger automation on health events
- Shows: open issues, scheduled changes, event log

### Exam Tips
- "My specific resources affected by AWS issue" → Account Health Dashboard
- "General AWS service status" → Service Health Dashboard
- Can automate responses to health events via EventBridge

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| CloudWatch basic monitoring interval | 5 minutes |
| CloudWatch detailed monitoring interval | 1 minute |
| CloudWatch custom metric high-resolution | 1 second |
| CloudWatch Logs retention options | 1 day – 10 years (or never) |
| CloudTrail Event History | 90 days (free) |
| CloudTrail Data Events | Not free, not default |
| X-Ray default sampling | 1/sec + 5% additional |
| Config max auto-remediation retries | 5 |
| Trusted Advisor full checks | Business/Enterprise support |
| CloudWatch Alarm evaluation period | Configurable (multiples of 60s) |

---

## Gotchas & Exam Traps

1. **Memory is NOT a default EC2 metric** — must install CloudWatch Agent
2. **CloudWatch Logs never expire** by default — set retention policy explicitly
3. **Export to S3 is NOT real-time** — use Subscription Filter + Firehose for near-real-time
4. **Config is detective, NOT preventive** — it evaluates after changes happen
5. **CloudTrail Data Events cost extra** and are NOT enabled by default
6. **X-Ray Annotations are searchable**, Metadata is NOT — common exam question
7. **Trusted Advisor full checks** require Business or Enterprise support plan
8. **CloudWatch Agent** collects metrics AND logs (Unified Agent)
9. **EventBridge = CloudWatch Events** (same service, new name — use EventBridge in answers)
10. **EC2 Recovery** via CloudWatch Alarm only works for instances with EBS root volume
11. **Config Aggregator** doesn't provide remediation — just consolidates view
12. **CloudTrail Insights** detects unusual PATTERNS (not individual suspicious calls — that's GuardDuty)
