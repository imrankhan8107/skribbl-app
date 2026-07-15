# 10 - Cost Optimization

## EC2 Pricing Models

### Overview Comparison

| Model | Discount | Commitment | Best For |
|-------|----------|-----------|----------|
| **On-Demand** | 0% (full price) | None | Unpredictable, short-term, testing |
| **Reserved (Standard)** | Up to 72% | 1 or 3 years | Steady-state, predictable workloads |
| **Reserved (Convertible)** | Up to 66% | 1 or 3 years | Steady-state + flexibility to change |
| **Savings Plans (Compute)** | Up to 66% | 1 or 3 years | Flexible compute (EC2, Fargate, Lambda) |
| **Savings Plans (EC2 Instance)** | Up to 72% | 1 or 3 years | Specific instance family in a region |
| **Spot Instances** | Up to 90% | None (can be interrupted) | Fault-tolerant, flexible, batch jobs |
| **Dedicated Host** | Full price (or reserved) | None or reserved | BYOL, compliance |
| **Capacity Reservations** | Full price | None | Guarantee capacity in AZ |

---

### Reserved Instances (RI) in Detail

**Standard vs Convertible:**
| Feature | Standard RI | Convertible RI |
|---------|-------------|----------------|
| Discount | Up to 72% | Up to 66% |
| Change instance type | ❌ (within same family only via modification) | ✅ Any instance type/family/OS/tenancy |
| Sell on Marketplace | ✅ | ❌ |
| Best for | Known, fixed workloads | Need flexibility |

**Payment Options:**
| Option | Discount Level | Cash Flow |
|--------|---------------|-----------|
| All Upfront | Highest discount | Pay everything now |
| Partial Upfront | Medium discount | Some now, rest monthly |
| No Upfront | Lowest RI discount | All monthly |

**Term Options:** 1 year or 3 years (3-year = bigger discount)

**Scope:**
- Regional: capacity reservation flexibility across AZs, auto-applies
- Zonal: specific AZ capacity reservation

---

### Savings Plans

| Type | Flexibility | Discount |
|------|-------------|----------|
| **Compute Savings Plan** | Any instance family, region, OS, tenancy; also covers Fargate + Lambda | Up to 66% |
| **EC2 Instance Savings Plan** | Specific instance family in specific region (flexible size, OS, tenancy) | Up to 72% |
| **SageMaker Savings Plan** | SageMaker instances | Up to 64% |

**Key Points:**
- Commit to $/hour for 1 or 3 years
- Excess usage billed at On-Demand rate
- More flexible than RIs (especially Compute Savings Plan)
- Automatically applies to matching usage

### Exam Tips - Savings Plans vs RIs
- "Most flexible discount" → Compute Savings Plan
- "Highest discount for specific instance" → Standard RI or EC2 Instance Savings Plan
- "Covers Lambda and Fargate too" → Compute Savings Plan
- Savings Plans are generally the recommended answer for new commitments

---

### Spot Instances

**Key Facts:**
- Up to **90% discount** vs On-Demand
- Can be **interrupted with 2-minute warning** when AWS needs capacity back
- You define a **max price** (current spot price fluctuates)
- NOT suitable for: databases, critical jobs, anything that can't handle interruption

**Spot Instance Interruption:**
- 2-minute notification (via CloudWatch Events / instance metadata)
- Behavior options: Stop, Hibernate, or Terminate

**Spot Fleet:**
- Collection of Spot + (optionally) On-Demand instances
- Strategies:
  | Strategy | Description |
  |----------|-------------|
  | `lowestPrice` | Pick cheapest pool (default, good for short batch) |
  | `diversified` | Spread across pools (availability, long workloads) |
  | `capacityOptimized` | Pick pool with most available capacity (fewer interruptions) |
  | `priceCapacityOptimized` | Balance price + capacity (recommended) |

**Spot Block (deprecated):** Reserve Spot for 1-6 hours without interruption — being phased out

### Exam Tips - Spot
- "Fault-tolerant batch processing" → Spot Instances
- "Big data / EMR / CI-CD" → Spot Instances
- "Need to minimize interruptions" → `capacityOptimized` or `priceCapacityOptimized`
- "Cannot tolerate interruption" → NOT Spot (use On-Demand or Reserved)
- Spot + On-Demand mix in ASG = cost optimization with baseline reliability

---

### When to Use Each Pricing Model

| Workload Type | Recommended Model |
|---------------|-------------------|
| Development/testing | On-Demand |
| Steady-state, 24/7 | Reserved Instance or Savings Plan |
| Flexible, long-running | Compute Savings Plan |
| Batch processing | Spot Instances |
| Short urgent jobs (can't interrupt) | On-Demand |
| Big data (EMR) | Spot Instances |
| Baseline + burst | Reserved/Savings Plan + Spot + On-Demand (mixed) |
| License compliance (BYOL) | Dedicated Host |
| Critical databases | Reserved Instance (Multi-AZ RDS RI) |

---

## S3 Cost Optimization

### Storage Class Selection
| If data is... | Use |
|---------------|-----|
| Frequently accessed | S3 Standard |
| Infrequently accessed (need fast retrieval) | S3 Standard-IA |
| Infrequent + reproducible | S3 One Zone-IA |
| Unknown access pattern | S3 Intelligent-Tiering |
| Archive (instant access needed) | Glacier Instant Retrieval |
| Archive (hours acceptable) | Glacier Flexible Retrieval |
| Long-term archive (12-48h acceptable) | Glacier Deep Archive |

### Lifecycle Policies
- Automate transitions between storage classes
- Example: Standard → IA (30 days) → Glacier (90 days) → Delete (365 days)
- Most cost-effective approach for data with known access patterns

### Other S3 Cost Features
| Feature | Savings |
|---------|---------|
| **Requester Pays** | Requester pays data transfer + request costs |
| **S3 Analytics** | Recommendations for lifecycle policies |
| **Incomplete Multipart Uploads** | Lifecycle rule to abort/delete after N days |
| **S3 Inventory** | Identify objects for lifecycle optimization |

---

## Data Transfer Costs

### Key Rules (Exam Favorites!)

| Transfer Type | Cost |
|---------------|------|
| Internet → AWS | Free |
| Same AZ (private IP) | Free |
| S3 → CloudFront | Free |
| Cross-AZ (same region) | ~$0.01/GB each way |
| Cross-Region | ~$0.02/GB |
| AWS → Internet | $0.09/GB (first 10 TB) |
| NAT Gateway processing | $0.045/GB |
| VPC Endpoint (Gateway) | Free |
| VPC Endpoint (Interface) | $0.01/GB |

### Cost-Saving Strategies
1. **Use VPC Gateway Endpoints** for S3/DynamoDB (free vs NAT Gateway charges)
2. **Keep resources in same AZ** when possible (free private IP transfer)
3. **Use CloudFront** for outbound traffic to internet (cheaper rates at scale)
4. **Use Direct Connect** for high-volume sustained transfers (lower per-GB cost)
5. **Minimize cross-region replication** unless needed for DR
6. **Use S3 Transfer Acceleration** only when upload speed justifies cost
7. **PrivateLink** for high-volume service access (vs NAT Gateway)

### Exam Tips - Data Transfer
- "Reduce NAT Gateway costs" → VPC Gateway Endpoint for S3/DynamoDB
- "Cheapest data transfer" → Same AZ using private IPs
- "Reduce internet egress costs" → CloudFront (cheaper at scale)
- Cross-AZ communication = cost; design for AZ-local where possible

---

## AWS Compute Optimizer

- **ML-based right-sizing recommendations**
- Analyzes: CloudWatch metrics over 14 days (or 93 days with enhanced)
- Resources: EC2, EBS, Lambda, ECS on Fargate, Auto Scaling Groups
- Recommendations: downsize, upsize, or change instance family
- Classification: Under-provisioned, Over-provisioned, Optimized, None
- **Free** (enhanced monitoring paid feature)

### Exam Tips - Compute Optimizer
- "Right-size EC2 instances" → Compute Optimizer
- "Identify over-provisioned resources" → Compute Optimizer
- Requires opt-in and 14 days of CloudWatch data minimum

---

## AWS Cost Explorer

- **Visualize and analyze** AWS spending over time
- Default: up to 12 months of historical data
- Forecast: up to 12 months into the future
- Granularity: monthly, daily, hourly (hourly = extra cost)
- Filter by: service, region, account, tag, instance type

### Key Features
| Feature | Description |
|---------|-------------|
| **Cost breakdown** | By service, account, tag, region |
| **RI recommendations** | Suggest Reserved Instances to purchase |
| **Savings Plans recommendations** | Suggest commitment level |
| **Forecasting** | Predict future spending |
| **Cost anomaly detection** | Alert on unusual spending |

### Exam Tips - Cost Explorer
- "Analyze past spending" → Cost Explorer
- "Get RI purchase recommendations" → Cost Explorer
- "Predict future costs" → Cost Explorer Forecast
- "Unusual cost spike alert" → Cost Anomaly Detection

---

## AWS Budgets

### Budget Types
| Type | Monitors |
|------|----------|
| **Cost** | Actual or forecasted spend |
| **Usage** | Resource utilization (hours, requests) |
| **Reservation** | RI utilization and coverage |
| **Savings Plans** | Savings Plans utilization and coverage |

### Alerts
- **Alert when:** Actual exceeds threshold OR forecast exceeds threshold
- **Actions:** SNS notification, email, AWS Budgets Actions (stop EC2, apply SCP, etc.)
- Up to 5 SNS notifications per budget
- Configure at: 75%, 90%, 100% thresholds (common pattern)

### Budgets Actions (automated responses)
- Apply IAM policy (restrict launches)
- Apply SCP
- Stop EC2/RDS instances
- Preventive cost controls

### Exam Tips - Budgets
- "Alert when costs exceed threshold" → AWS Budgets
- "Automatically stop instances when budget exceeded" → Budgets Actions
- "Track RI utilization" → AWS Budgets (Reservation type)
- First 2 budgets are free; each additional = $0.02/day

---

## Serverless for Cost Optimization

### Pay-Per-Use Model
```
API Gateway ($3.50/million requests)
    → Lambda ($0.20/million requests + duration)
        → DynamoDB (on-demand: $1.25/million writes, $0.25/million reads)
```

### Cost Advantages
- No cost when idle (vs EC2 running 24/7)
- Auto-scales to zero
- No capacity planning waste
- Eliminates over-provisioning

### When Serverless Saves Money
| Scenario | Savings |
|----------|---------|
| Unpredictable/sporadic traffic | Massive (vs always-on EC2) |
| Low/medium traffic APIs | Significant |
| Event-driven processing | High (only runs on events) |
| High, constant traffic | May be MORE expensive than reserved EC2 |

### Exam Tips - Serverless Cost
- "Pay only when code runs" → Lambda
- "Minimize costs for variable traffic" → Serverless architecture
- "Cost-effective for low-traffic API" → API Gateway + Lambda + DynamoDB
- At very high sustained load, EC2 Reserved may be cheaper than Lambda

---

## Auto Scaling Cost Benefits

### Scale to Zero / Near Zero
- Fargate: scale tasks to zero (with App Runner)
- Lambda: inherently scales to zero
- DynamoDB On-Demand: pay per request only
- Aurora Serverless v2: minimum 0.5 ACU (not zero)

### Mixed Instance ASG
- Combine On-Demand (baseline) + Spot (burst) in same ASG
- Example: 2 On-Demand base + Spot for scaling above base
- Can specify: % On-Demand vs Spot, allocation strategies

### Exam Tips - Auto Scaling
- "Minimize cost during off-hours" → Scheduled Scaling (scale down at night)
- "Cost-effective burst capacity" → Spot Instances in ASG
- "Right amount of compute always" → Target Tracking scaling
- Over-provisioning is waste → Auto Scaling prevents it

---

## Spot for Big Data / Batch

### Use Cases for Spot
| Workload | Why Spot Works |
|----------|----------------|
| **EMR** | Cluster can handle node loss; checkpoint data |
| **Batch processing** | Jobs can restart from checkpoint |
| **CI/CD builds** | Build agents are ephemeral |
| **Data analytics** | Process in parallel, aggregate results |
| **Rendering** | Distribute frames, re-render interrupted ones |
| **Training ML models** | Checkpoint + resume on interruption |

### EMR + Spot Strategy
- Master node: On-Demand (critical)
- Core nodes: On-Demand or Reserved (hold HDFS)
- Task nodes: Spot (compute only, no data loss on interruption)

---

## Cost Optimization Checklist (Exam-Focused)

1. ✅ Right-size instances (Compute Optimizer)
2. ✅ Use Savings Plans / Reserved for steady workloads
3. ✅ Use Spot for fault-tolerant workloads
4. ✅ S3 lifecycle policies → move to cheaper tiers
5. ✅ VPC Gateway Endpoints for S3/DynamoDB (save NAT costs)
6. ✅ Delete unused EBS volumes, snapshots, Elastic IPs
7. ✅ Use serverless for variable/low traffic
8. ✅ Auto Scaling to match demand
9. ✅ CloudFront for internet egress
10. ✅ Consolidate accounts for volume discounts

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| On-Demand discount | 0% |
| Standard RI max discount | 72% |
| Convertible RI max discount | 66% |
| Spot max discount | 90% |
| Spot interruption notice | 2 minutes |
| Savings Plan terms | 1 year or 3 years |
| NAT Gateway data processing | $0.045/GB |
| VPC Gateway Endpoint cost | Free |
| First free budgets | 2 |
| Cross-AZ data transfer | ~$0.01/GB |
| Internet → AWS | Free |
| Compute Optimizer data requirement | 14 days |

---

## Gotchas & Exam Traps

1. **Spot can be interrupted anytime** — never for databases or stateful critical services
2. **Convertible RIs cannot be sold** on Marketplace (Standard RIs can)
3. **Savings Plans** are more flexible than RIs — generally preferred answer
4. **Compute Savings Plans** cover Lambda and Fargate too (not just EC2)
5. **VPC Gateway Endpoint is free** but Interface Endpoint costs money
6. **NAT Gateway charges per GB** — can be surprisingly expensive for high-volume
7. **Same-AZ transfer is free** only with private IPs (public IPs are charged)
8. **CloudFront is cheaper** than direct internet egress for high volume
9. **Serverless is NOT always cheapest** — high constant load may be cheaper on Reserved EC2
10. **Cost Explorer** shows past costs; **Budgets** alerts on future thresholds
11. **Dedicated Host** is most expensive but required for certain license compliance
12. **3-year term** always gives bigger discount than 1-year (but more commitment risk)
