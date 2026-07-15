# 07 - Serverless

## AWS Lambda

### Key Characteristics
- Event-driven, pay-per-invocation compute
- No servers to manage, automatic scaling
- Integrated with 200+ AWS services

### Limits

| Property | Value |
|----------|-------|
| Timeout | Max **15 minutes** |
| Memory | 128 MB – 10,240 MB (10 GB) |
| CPU | Scales proportionally with memory |
| Concurrency | **1,000 per region** (soft limit, can increase) |
| Deployment package | 50 MB (zipped), 250 MB (unzipped) |
| /tmp storage | 512 MB – 10,240 MB |
| Environment variables | 4 KB total |
| Layers | Max 5 |
| Ephemeral storage (/tmp) | Persists between invocations (same execution environment) |

### Invocation Types

| Type | Behavior | Retry | Example Triggers |
|------|----------|-------|-----------------|
| **Synchronous** | Caller waits for response | Caller retries | API Gateway, ALB, CloudFront, Cognito |
| **Asynchronous** | Event queued, Lambda retries twice | Built-in 2 retries | S3, SNS, EventBridge, CloudWatch Events |
| **Event Source Mapping** | Lambda polls the source | Depends on source | SQS, Kinesis, DynamoDB Streams, Kafka |

### Async Invocation Details
- Events go to internal queue
- 2 automatic retries on failure
- **Destinations:** Route results (success/failure) to SQS, SNS, Lambda, or EventBridge
- **DLQ:** Alternative to destinations for failures (SQS or SNS)
- Destinations are preferred over DLQ (more flexible)

### Event Source Mapping Details
- Lambda **polls** the source (you don't push)
- **SQS:** Batch size 1-10; scales up to 1000 batches/minute; delete on success
- **Kinesis/DynamoDB Streams:** Batch size up to 10,000; in-order per shard; retries entire batch on failure
- **Failure handling:** bisect batch, max retry attempts, DLQ on source, destinations

### Concurrency

| Type | Description |
|------|-------------|
| **Unreserved** | Shared pool (total 1000 minus reserved) |
| **Reserved** | Guaranteed for specific function (limits other functions) |
| **Provisioned** | Pre-initialized environments (eliminates cold starts) |

- **Throttling behavior:**
  - Synchronous: returns 429 ThrottleError
  - Asynchronous: retries automatically, then DLQ
  - Event Source Mapping: retries until data expires

### Lambda Networking
- **Default:** Runs in AWS-managed VPC (has internet access, no VPC resource access)
- **In VPC:** Runs in your VPC (needs NAT Gateway for internet access)
- Uses Hyperplane ENIs (shared across functions in same subnet/SG)
- EFS mounting supported (for shared persistent storage)

### Lambda@Edge vs CloudFront Functions

| Feature | Lambda@Edge | CloudFront Functions |
|---------|-------------|---------------------|
| Runtime | Node.js, Python | JavaScript only |
| Execution time | Up to 5-30 seconds | Up to 1 ms |
| Memory | 128 MB – 10 GB | 2 MB |
| Network access | ✅ | ❌ |
| File system | ✅ | ❌ |
| Request body access | ✅ | ❌ |
| Scale | Thousands/s | Millions/s |
| Price | Higher | 1/6 of Lambda@Edge |
| Use Case | Complex logic, external calls | Simple transforms, URL rewrites |

### CloudFront Functions Use Cases
- Cache key normalization
- Header manipulation
- URL rewrites/redirects
- Request authentication (JWT validation)

### Lambda@Edge Use Cases
- Longer execution (API calls, DB lookups)
- Body manipulation
- Complex authentication
- Generate responses at edge

### Exam Tips - Lambda
- "15 min timeout" → If longer processing needed, use Step Functions or ECS
- "Lambda in VPC + internet" → NAT Gateway required
- "Eliminate cold starts" → Provisioned Concurrency
- "Process S3 events" → Async invocation (Lambda retries automatically)
- "Process SQS messages" → Event Source Mapping (Lambda polls)
- "Large deployment package" → Use Layers or container images (up to 10 GB)
- Lambda container images supported (must implement Lambda Runtime API)

---

## Amazon API Gateway

### API Types

| Type | Protocol | Use Case | Features |
|------|----------|----------|----------|
| **REST API** | HTTP | Full-featured APIs | Caching, throttling, API keys, request validation, WAF |
| **HTTP API** | HTTP | Simple, cheaper, faster | Simpler, 70% cheaper, lower latency, OIDC/OAuth2 |
| **WebSocket API** | WebSocket | Real-time two-way communication | Chat, gaming, streaming |

### REST API Features
- **Stages:** dev, test, prod (each with own URL)
- **Deployment:** Must deploy to a stage for changes to take effect
- **Caching:** Response caching at stage level (TTL: 0-3600s, default 300s)
- **Throttling:** 10,000 req/s per region (soft limit), 5,000 burst
- **Usage Plans + API Keys:** Throttle per-client, set quotas
- **Request/Response Transformation:** Mapping templates (VTL)
- **Custom Domain Names:** With ACM certificate
- **CORS:** Must enable for cross-origin browser access

### API Gateway Authentication

| Method | Description |
|--------|-------------|
| **IAM** | SigV4 signed requests (AWS users/roles) |
| **Cognito Authorizer** | Cognito User Pool JWT validation |
| **Lambda Authorizer** | Custom Lambda function validates token |
| **API Keys** | NOT for authentication (for usage tracking/throttling only) |

### API Gateway Integration Types
| Type | Description |
|------|-------------|
| **Lambda Proxy** | Entire request passed to Lambda (most common) |
| **Lambda Custom** | Request transformed before Lambda |
| **HTTP Proxy** | Pass-through to HTTP backend |
| **HTTP Custom** | Transform request before forwarding |
| **AWS Service** | Direct integration with AWS APIs |
| **Mock** | Return response without backend |

### Exam Tips - API Gateway
- "Cheapest API option" → HTTP API (vs REST API)
- "Need caching, WAF, API keys" → REST API
- "Real-time bidirectional" → WebSocket API
- "Rate limit per client" → Usage Plans + API Keys
- API Gateway timeout: **29 seconds** max (if backend takes longer, timeout error)
- Canary deployments: route % of traffic to new stage
- Edge-optimized (default): uses CloudFront; Regional: for same-region clients

---

## DynamoDB (Serverless Context)

### Serverless Features
- Zero administration, auto-scaling
- On-demand mode: pay per request (no capacity planning)
- Auto-scales read/write capacity
- Event-driven: DynamoDB Streams → Lambda triggers
- Global Tables: multi-region, active-active (fully serverless)
- TTL: auto-delete expired items (no cost for deletes)
- Point-in-time recovery (PITR): continuous backups for 35 days

### DynamoDB + Lambda Patterns
- **DynamoDB Streams + Lambda:** React to table changes in real-time
- Event Source Mapping: Lambda polls the stream
- Batch size: up to 1,000 records
- Use case: trigger notifications, update search index, cross-region replication

---

## Cognito with API Gateway

### Authentication Flow
```
1. Client → Cognito User Pool (authenticate) → JWT token
2. Client → API Gateway + Cognito Authorizer (validate JWT)
3. API Gateway → Lambda (if authorized)
```

### Alternative: Lambda Authorizer
```
1. Client → API Gateway + Token
2. API Gateway → Lambda Authorizer (validate token, return IAM policy)
3. API Gateway → Backend (if policy allows)
```

### When to Use Which
- **Cognito Authorizer:** Standard OAuth2/OIDC, User Pool authentication
- **Lambda Authorizer:** Custom auth logic, third-party tokens, bearer tokens
- **IAM Auth:** AWS service-to-service, SigV4 (cross-account with AssumeRole)

---

## AWS SAM (Serverless Application Model)

### Key Concepts
- Open-source framework for defining serverless apps
- Extension of CloudFormation (compiles to CFN template)
- Simplified syntax for Lambda, API Gateway, DynamoDB, Step Functions

### SAM Template Structure
```yaml
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Timeout: 30

Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Runtime: python3.9
      Events:
        Api:
          Type: Api
          Properties:
            Path: /hello
            Method: get
```

### SAM CLI Commands
| Command | Purpose |
|---------|---------|
| `sam init` | Create new project |
| `sam build` | Build application |
| `sam local invoke` | Test Lambda locally |
| `sam local start-api` | Run API locally |
| `sam deploy` | Deploy to AWS |
| `sam sync` | Sync changes (faster iteration) |

### Exam Tips - SAM
- "Define serverless application as code" → SAM
- "Test Lambda locally" → SAM CLI
- SAM uses CloudFormation under the hood
- `Transform: AWS::Serverless-2016-10-31` identifies SAM templates

---

## AWS Step Functions (Serverless Orchestration)

### Common Serverless Patterns with Step Functions
- Sequential Lambda execution
- Parallel processing (fan-out)
- Conditional branching (Choice state)
- Error handling + retry with exponential backoff
- Human approval workflows (callback pattern)
- Map state: iterate over array (parallel per-item processing)

### Step Functions + Lambda vs SQS + Lambda

| Scenario | Use Step Functions | Use SQS |
|----------|-------------------|---------|
| Need workflow logic | ✅ | ❌ |
| Simple decoupling | ❌ | ✅ |
| Visual monitoring | ✅ | ❌ |
| Error handling/retry | ✅ (built-in) | Manual |
| Long-running (>15 min) | ✅ (wait states) | ❌ |

---

## AWS AppSync

- **Managed GraphQL** service
- Real-time data with **WebSocket** subscriptions
- Offline support with data sync (mobile apps)
- Data sources: DynamoDB, Lambda, RDS (Aurora Serverless), HTTP, OpenSearch
- Built-in caching, authorization (API key, IAM, Cognito, OIDC)
- Resolver mapping templates (VTL or JavaScript)

### Exam Tips - AppSync
- "GraphQL API" → AppSync
- "Real-time subscriptions (WebSocket)" → AppSync
- "Offline-first mobile app with sync" → AppSync + Amplify
- AppSync vs API Gateway: AppSync for GraphQL; API Gateway for REST/HTTP/WebSocket

---

## S3 Event Notifications

### Flow
```
S3 Event → [SNS | SQS | Lambda | EventBridge]
```

### Event Types
- `s3:ObjectCreated:*` (Put, Post, Copy, CompleteMultipartUpload)
- `s3:ObjectRemoved:*` (Delete, DeleteMarkerCreated)
- `s3:ObjectRestore:*` (Post-initiated, Completed)
- `s3:Replication:*`
- `s3:ObjectTagging:*`

### S3 → EventBridge
- Enable EventBridge on bucket for advanced routing
- Benefits: advanced filtering, multiple destinations, archive/replay
- All S3 events can go to EventBridge (more flexible than direct SNS/SQS/Lambda)

### Exam Tips - S3 Events
- "Process uploaded images" → S3 → Lambda
- "Multiple services react to upload" → S3 → SNS → SQS fan-out (or S3 → EventBridge)
- "Filter by prefix/suffix" → Supported in notification configuration
- S3 → Lambda is asynchronous invocation

---

## 🔑 Serverless Architecture Patterns

### Pattern 1: REST API
```
Client → API Gateway → Lambda → DynamoDB
```

### Pattern 2: File Processing
```
S3 Upload → S3 Event → Lambda → DynamoDB / S3
```

### Pattern 3: Real-time Stream
```
Producers → Kinesis Data Streams → Lambda → DynamoDB
```

### Pattern 4: Event-Driven Microservices
```
Service A → EventBridge → [Lambda B, SQS → Lambda C, Step Functions]
```

### Pattern 5: Static Website + API
```
S3 (static) + CloudFront → API Gateway → Lambda → DynamoDB
         Route 53 (DNS) + ACM (HTTPS)
```

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| Lambda timeout | 15 minutes max |
| Lambda memory | 128 MB – 10 GB |
| Lambda concurrency | 1,000/region (default) |
| Lambda /tmp | Up to 10 GB |
| Lambda layers | Max 5 |
| Lambda deployment (zip) | 50 MB |
| Lambda container image | Up to 10 GB |
| API Gateway timeout | 29 seconds |
| API Gateway throttle | 10,000 req/s (soft) |
| API Gateway cache TTL | 0–3600s (default 300s) |
| CloudFront Functions execution | < 1 ms |
| Lambda@Edge execution | Up to 5-30 seconds |
| Step Functions Standard | Up to 1 year |
| Step Functions Express | Up to 5 minutes |

---

## Gotchas & Exam Traps

1. **API Gateway has 29-second timeout** — cannot extend; use async for long tasks
2. **Lambda in VPC needs NAT Gateway** for internet access (common pitfall)
3. **Lambda concurrency = 1000 total** across all functions in a region
4. **Reserved concurrency** reduces pool for other functions
5. **Provisioned concurrency** prevents cold starts but costs money even when idle
6. **HTTP API vs REST API:** HTTP API cheaper but fewer features (no caching, no WAF)
7. **API Keys are NOT for authentication** — only for usage tracking
8. **Lambda@Edge** is deployed to us-east-1 (even if function runs at edge)
9. **SAM** compiles to CloudFormation — it's NOT a separate service
10. **DynamoDB Streams + Lambda** is event source mapping (Lambda polls, not pushed)
11. **AppSync ≠ API Gateway** — AppSync is specifically for GraphQL
12. **S3 → Lambda** is async invocation (Lambda retries twice on failure)
