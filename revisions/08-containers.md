# 08 - Containers

## Docker Basics

### Key Concepts
- **Container:** Lightweight, standalone executable package (code + runtime + dependencies)
- **Image:** Read-only template for creating containers (built from Dockerfile)
- **Dockerfile:** Instructions to build an image (`FROM`, `RUN`, `COPY`, `CMD`, `EXPOSE`)
- **Registry:** Store for images (Docker Hub, Amazon ECR)

### Container vs VM
| Feature | Container | VM |
|---------|-----------|-----|
| Size | MBs | GBs |
| Boot time | Seconds | Minutes |
| Isolation | Process-level | Hardware-level |
| OS | Shares host kernel | Own OS |
| Density | High (many per host) | Lower |

---

## Amazon ECS (Elastic Container Service)

### Core Components

| Component | Description |
|-----------|-------------|
| **Cluster** | Logical grouping of tasks/services |
| **Task Definition** | Blueprint (JSON): image, CPU, memory, ports, env vars, IAM role |
| **Task** | Running instance of a task definition |
| **Service** | Maintains desired count of tasks, integrates with ELB |
| **Container Instance** | EC2 instance running ECS agent (EC2 launch type only) |

### Launch Types

| Feature | EC2 Launch Type | Fargate Launch Type |
|---------|-----------------|---------------------|
| Infrastructure | You manage EC2 instances | AWS manages infrastructure |
| Scaling | Must scale EC2 + tasks | Scale tasks only |
| Pricing | Pay for EC2 instances | Pay for vCPU + memory used |
| Control | Full control over instances | No access to underlying infra |
| Placement | Placement strategies available | AWS handles placement |
| Use Case | Cost optimization, GPU, compliance | Simplicity, serverless containers |

### Task Definition Key Properties
- **Task Role:** IAM role for the containers (access AWS services)
- **Task Execution Role:** IAM role for ECS agent (pull images, send logs)
- **CPU/Memory:** Hard limits (required for Fargate)
- **Network Mode:** `awsvpc` (recommended, each task gets ENI), `bridge`, `host`, `none`
- **Volumes:** EFS, EBS, bind mounts, Docker volumes
- **Log Driver:** awslogs (CloudWatch), splunk, fluentd

### ECS with ALB

#### Dynamic Port Mapping
- With `awsvpc` mode: each task gets unique IP (ALB routes by IP:port)
- With `bridge` mode: random host port mapped (ALB discovers via target group)
- ALB is recommended for ECS (supports path-based routing to different services)
- NLB for high-throughput or TCP/UDP traffic

### ECS Service Auto Scaling

| Metric | Description |
|--------|-------------|
| CPU Utilization | Average CPU across tasks |
| Memory Utilization | Average memory across tasks |
| ALB Request Count per Target | Requests per task |
| Custom CloudWatch Metric | Any custom metric |

**Scaling Policies:**
- Target Tracking (most common)
- Step Scaling
- Scheduled Scaling

### ECS + EC2 Instance Scaling (EC2 Launch Type)
- Problem: Scaling tasks requires enough EC2 capacity
- Solutions:
  1. **Auto Scaling Group:** Scale based on CPU/memory reservation
  2. **ECS Cluster Capacity Provider (recommended):** Automatically provisions/deregisters EC2 instances based on task needs
  3. **Fargate:** Eliminates this problem entirely

### ECS Task Placement (EC2 Launch Type Only)

**Strategies:**
| Strategy | Description |
|----------|-------------|
| `binpack` | Place on least available CPU/memory (minimize instances, cost-saving) |
| `random` | Random placement |
| `spread` | Spread across attribute (AZ, instance-id) |

**Constraints:**
- `distinctInstance`: Each task on different instance
- `memberOf`: Place based on expression (e.g., instance type, AZ)

### Exam Tips - ECS
- "Managed container orchestration on AWS" → ECS
- "Serverless containers" → ECS + Fargate
- "Need GPU instances for containers" → ECS + EC2 launch type
- "Dynamic port mapping" → ALB + ECS
- "Minimize EC2 instances (cost)" → `binpack` strategy
- "Spread across AZs" → `spread` strategy
- Task Role = what containers can do; Execution Role = what ECS agent can do

---

## AWS Fargate

### Key Features
- **Serverless** container compute engine
- Works with both **ECS and EKS**
- No EC2 instances to manage, patch, or scale
- Pay for vCPU + memory resources consumed
- Each task runs in its own isolated environment (kernel-level isolation)

### Fargate Resource Limits
| Resource | Range |
|----------|-------|
| CPU | 0.25 – 4 vCPU |
| Memory | 0.5 – 30 GB |
| Ephemeral storage | 20 – 200 GB |

### Fargate vs EC2 Launch Type

| Consideration | Use Fargate | Use EC2 |
|---------------|-------------|---------|
| Operational overhead | ✅ Minimal | ❌ Manage instances |
| Cost predictability | Per-task pricing | Instance pricing |
| GPU support | ❌ Not supported | ✅ Supported |
| Windows containers | ✅ Supported (limited) | ✅ Full support |
| Compliance (host access) | ❌ No host access | ✅ Full access |
| Spot pricing | ✅ Fargate Spot (70% discount) | ✅ Spot Instances |
| Startup time | Slightly slower | Faster (instances running) |

### Exam Tips - Fargate
- "Least operational overhead for containers" → Fargate
- "No need to manage infrastructure" → Fargate
- "Need GPU for containers" → EC2 (not Fargate)
- Fargate Spot: interrupted tasks (use for fault-tolerant workloads)
- Fargate supports EFS for persistent shared storage

---

## Amazon ECR (Elastic Container Registry)

### Key Features
- Fully managed Docker container registry
- Store, manage, and deploy container images
- Integrated with ECS, EKS, Lambda (container images)
- Supports **private** and **public** repositories (ECR Public Gallery)

### Security
- Images encrypted at rest (KMS)
- IAM-based access control (repository policies)
- **Image scanning:** Automatic vulnerability scanning on push
  - Basic scanning: CVE database (free)
  - Enhanced scanning: Amazon Inspector integration (deeper, continuous)

### Lifecycle Policies
- Automatically clean up old/untagged images
- Rules: expire by count, age, or tag status
- Reduces storage costs

### Cross-Region / Cross-Account
- **Replication:** Automatically replicate images to other regions/accounts
- Pull-through cache: cache public registry images (Docker Hub, GitHub, etc.)

### Exam Tips - ECR
- "Store Docker images in AWS" → ECR
- "Vulnerability scanning for containers" → ECR image scanning (or Inspector)
- "Container image lifecycle management" → ECR lifecycle policies
- ECR integrates natively with ECS/EKS (no Docker Hub login needed)
- IAM required to push/pull (use `aws ecr get-login-password`)

---

## Amazon EKS (Elastic Kubernetes Service)

### Key Concepts
- **Managed Kubernetes** (K8s) service
- AWS manages the control plane (API server, etcd)
- You manage worker nodes (or use Fargate)
- Supports the same Kubernetes APIs and tools

### Node Types

| Type | Description | Management |
|------|-------------|------------|
| **Managed Node Group** | AWS manages EC2 instances + ASG | Semi-managed |
| **Self-Managed Nodes** | You manage EC2 instances | Full control |
| **Fargate** | Serverless pods | AWS-managed |

### EKS vs ECS

| Feature | EKS | ECS |
|---------|-----|-----|
| Orchestrator | Kubernetes | AWS-proprietary |
| Portability | Multi-cloud, on-prem (EKS Anywhere) | AWS only |
| Complexity | Higher (K8s knowledge needed) | Lower (simpler API) |
| Community | Large open-source ecosystem | AWS ecosystem |
| Cost | $0.10/hr per cluster + compute | Free control plane + compute |
| Use Case | K8s workloads, multi-cloud, complex microservices | AWS-native, simpler setups |

### EKS Features
- **EKS Anywhere:** Run EKS on-premises (your own infrastructure)
- **EKS Distro:** Open-source K8s distribution (self-managed)
- **EKS Add-ons:** Managed operational software (CoreDNS, kube-proxy, VPC CNI)
- **ALB Ingress Controller:** Automatically provisions ALB for K8s services
- **IAM Roles for Service Accounts (IRSA):** Fine-grained IAM per pod

### Exam Tips - EKS
- "Already using Kubernetes" → EKS
- "Multi-cloud / hybrid Kubernetes" → EKS or EKS Anywhere
- "Simplest container management on AWS" → ECS (not EKS)
- "Kubernetes on Fargate" → EKS + Fargate
- EKS cluster costs $0.10/hour (~$73/month) just for control plane

---

## AWS App Runner

### Key Features
- **Fully managed** service to deploy containerized web apps and APIs
- Source: Container image (ECR) or source code (GitHub)
- Auto-scaling, load balancing, encryption, health checks — all built-in
- No infrastructure knowledge needed
- Supports: Node.js, Python, Java, Go, .NET, Ruby, PHP, container images

### App Runner vs Other Services

| Feature | App Runner | ECS + Fargate | Elastic Beanstalk |
|---------|-----------|---------------|-------------------|
| Complexity | Simplest | Medium | Medium |
| Control | Least | More | More |
| Customization | Limited | Full | Moderate |
| Use Case | Simple web apps/APIs | Complex microservices | Legacy web apps |
| Source code deploy | ✅ | ❌ (need image) | ✅ |
| Auto-scaling | Built-in | Configure yourself | Built-in |
| Pricing | Per vCPU+memory when running | Same | EC2 instances |

### Exam Tips - App Runner
- "Simplest way to deploy container web app" → App Runner
- "No Docker/K8s knowledge" → App Runner
- "Full control over container orchestration" → ECS/EKS (not App Runner)
- App Runner scales to zero (pay nothing when no traffic — with provisioned instances feature)
- App Runner is ideal for startups, prototypes, simple microservices

---

## Container Architecture Patterns

### Pattern 1: Microservices on ECS
```
CloudFront → ALB → ECS Service A (path: /api/users)
                  → ECS Service B (path: /api/orders)
                  → ECS Service C (path: /api/products)
```

### Pattern 2: Event-Driven Containers
```
SQS Queue → ECS Task (poll & process) → DynamoDB
         ↑
         SNS → SQS (fan-out pattern)
```

### Pattern 3: CI/CD Pipeline
```
GitHub → CodePipeline → CodeBuild → ECR → ECS (rolling update)
```

### Pattern 4: Hybrid Kubernetes
```
On-Premises (EKS Anywhere) ↔ AWS (EKS) 
                              ↕
                    Fargate (serverless pods)
```

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| Fargate vCPU range | 0.25 – 4 vCPU |
| Fargate memory range | 0.5 – 30 GB |
| Fargate ephemeral storage | 20 – 200 GB |
| EKS control plane cost | $0.10/hour |
| ECS EC2 max tasks per instance | Depends on ENIs/memory |
| ECR image scan types | Basic (free) + Enhanced (Inspector) |
| App Runner auto-scale | Built-in, configurable min/max |

---

## Gotchas & Exam Traps

1. **Fargate does NOT support GPU** — use EC2 launch type for GPU workloads
2. **ECS Task Role ≠ Execution Role** — Task Role = container permissions; Execution Role = agent permissions
3. **EKS control plane costs money** ($0.10/hr) even with no worker nodes
4. **App Runner** is for simple use cases — complex orchestration needs ECS/EKS
5. **`binpack`** minimizes instances (cost); **`spread`** maximizes availability
6. **Dynamic port mapping** requires ALB (not NLB for this feature)
7. **ECR lifecycle policies** help manage costs (delete old images automatically)
8. **ECS Capacity Providers** solve the chicken-and-egg problem of EC2 scaling
9. **Fargate Spot** can be interrupted — only for fault-tolerant workloads
10. **EKS Anywhere** = on-premises Kubernetes (NOT the same as running EKS in AWS)
11. **Container images for Lambda** must implement the Lambda Runtime API
12. **awsvpc network mode** gives each task its own ENI (recommended, required for Fargate)
