# 06 - Messaging & Decoupling

## Amazon SQS (Simple Queue Service)

### Standard vs FIFO

| Feature | Standard | FIFO |
|---------|----------|------|
| Throughput | Unlimited | 300 msg/s (3,000 with batching) |
| Ordering | Best-effort | Guaranteed (within message group) |
| Delivery | At-least-once (possible duplicates) | Exactly-once (deduplication) |
| Queue name | Any | Must end in `.fifo` |
| Use Case | High throughput, order not critical | Financial transactions, ordered processing |

### Key Properties

| Property | Value |
|----------|-------|
| Message retention | 4 days (default) — 1 minute to **14 days** (max) |
| Max message size | **256 KB** (use S3 for larger via Extended Client Library) |
| Visibility timeout | **30 seconds** (default) — 0 to 12 hours |
| Long polling wait | 1 to 20 seconds |
| Delay queue | 0 to 15 minutes |
| In-flight messages (Standard) | 120,000 |
| In-flight messages (FIFO) | 20,000 |

### Visibility Timeout
- Message received → invisible for `VisibilityTimeout` duration
- If not deleted within timeout → becomes visible again (reprocessed)
- If processing takes longer → call `ChangeMessageVisibility` to extend
- Set too high: reprocessing delays if consumer crashes
- Set too low: duplicate processing

### Dead-Letter Queue (DLQ)
- Messages that fail processing repeatedly go to DLQ
- **MaxReceiveCount:** How many times message is received before DLQ (e.g., 3)
- DLQ must be same type as source (Standard→Standard, FIFO→FIFO)
- **Redrive to source:** Move messages back from DLQ to original queue after fixing
- Set DLQ retention to max (14 days) to avoid losing messages

### Long Polling vs Short Polling

| Feature | Long Polling | Short Polling |
|---------|-------------|---------------|
| Behavior | Waits up to 20s for messages | Returns immediately (empty or not) |
| Cost | ✅ Fewer API calls (cheaper) | ❌ More API calls |
| Latency | Slightly higher | Immediate response |
| Enable | Set `WaitTimeSeconds` > 0 | Default (WaitTimeSeconds = 0) |

### Delay Queues
- Delay message delivery (messages invisible for delay period)
- Default: 0 seconds; Max: 15 minutes
- Can set per-queue or per-message (message timer overrides queue delay)

### SQS + Auto Scaling
- CloudWatch metric: `ApproximateNumberOfMessagesVisible`
- Target Tracking: scale EC2 instances based on queue depth
- Common pattern: SQS → CloudWatch Alarm → ASG scaling

### Exam Tips - SQS
- "Decouple application components" → SQS
- "Buffer writes to DB" → SQS in between
- "Exactly-once, ordered" → SQS FIFO
- "Messages processed multiple times" → increase visibility timeout
- "Messages lost" → check DLQ, extend retention
- SQS + Lambda: Lambda polls SQS (event source mapping); batch size up to 10
- Cannot convert Standard queue to FIFO (must create new)

---

## Amazon SNS (Simple Notification Service)

### Key Concepts
- **Pub/Sub model:** Publisher sends to Topic, Topic delivers to all Subscribers
- One message → many subscribers (fan-out)
- Up to **12,500,000 subscriptions** per topic
- Up to **100,000 topics** per account

### Subscription Types
| Protocol | Description |
|----------|-------------|
| SQS | Queue receives message |
| Lambda | Function invoked |
| HTTP/HTTPS | Webhook endpoint |
| Email / Email-JSON | Email notification |
| SMS | Text message |
| Kinesis Data Firehose | Deliver to S3/Redshift |

### SNS + SQS Fan-out (⭐ Most Tested Pattern)
```
                    ┌→ SQS Queue A → Service A
SNS Topic →─────────┼→ SQS Queue B → Service B  
                    └→ SQS Queue C → Service C
```
- **Why:** One event triggers multiple independent consumers
- SQS queues must have **access policy** allowing SNS to send messages
- Guarantees: each subscriber gets all messages, independent processing, independent retry
- Use case: S3 event → SNS → multiple SQS queues for parallel processing

### SNS FIFO
- Ordering by Message Group ID
- Deduplication (ID or content-based)
- **Only SQS FIFO** can be subscribers (not Lambda, HTTP, etc.)
- Throughput: 300 msg/s (3,000 with batching)

### SNS Message Filtering
- JSON filter policy attached to subscription
- Subscriber only receives messages matching the filter
- Reduces unnecessary processing

### Exam Tips - SNS
- "Send notification to multiple services simultaneously" → SNS fan-out
- "S3 event to multiple destinations" → S3 → SNS → multiple SQS (fan-out)
- "Email notification" → SNS
- SNS does NOT retain messages (if no subscriber processes it, it's lost)
- SNS + SQS = reliability (SQS retains even if consumer is down)

---

## Amazon EventBridge (formerly CloudWatch Events)

### Key Concepts
- **Event Bus:** Receives events from various sources
- **Rules:** Match events and route to targets
- **Schema Registry:** Auto-discover and store event schemas
- **Serverless:** No infrastructure to manage

### Event Bus Types
| Type | Description |
|------|-------------|
| Default | AWS service events (EC2, S3, etc.) |
| Custom | Your application events |
| Partner | SaaS events (Zendesk, Datadog, etc.) |

### Rules & Targets
- Rules match events using event patterns (JSON) or schedules (cron/rate)
- Targets (up to 5): Lambda, SQS, SNS, Step Functions, Kinesis, ECS task, SSM, API Gateway, etc.
- Can transform event data before sending to target

### Scheduled Events
- Cron expressions: `cron(0 12 * * ? *)` (every day at noon)
- Rate expressions: `rate(5 minutes)`
- Use case: trigger Lambda on schedule

### Event Replay & Archive
- Archive events to replay later
- Useful for debugging, testing, recovering from failures
- Set retention period for archived events

### EventBridge vs SNS

| Feature | EventBridge | SNS |
|---------|-------------|-----|
| Source | AWS services, SaaS, custom apps | Any publisher |
| Filtering | Advanced JSON pattern matching | Filter policy (limited) |
| Targets | 15+ AWS services | SQS, Lambda, HTTP, email, SMS |
| Schema | Auto-discovery | Manual |
| Archive/Replay | ✅ | ❌ |
| Use Case | Event-driven architectures, SaaS integration | Simple pub/sub notifications |

### Exam Tips - EventBridge
- "React to AWS service state changes" → EventBridge
- "Schedule Lambda execution (cron)" → EventBridge Scheduled Rules
- "SaaS integration events" → EventBridge Partner Event Bus
- "Advanced filtering" → EventBridge (better than SNS)
- Default event bus receives all AWS service events automatically
- S3 events can go to EventBridge (enable in S3 settings)

---

## Amazon Kinesis

### Kinesis Data Streams

| Property | Value |
|----------|-------|
| Latency | **Real-time (~200ms)** |
| Data retention | 1 day (default) to **365 days** |
| Throughput (per shard) | 1 MB/s IN, 2 MB/s OUT |
| Record size | Max 1 MB |
| Ordering | Per shard (partition key) |
| Replay | ✅ Yes (immutable data) |
| Scaling | Manual (add/remove shards) or on-demand |

### Key Concepts
- **Shard:** Unit of capacity (1 MB/s in, 2 MB/s out)
- **Partition Key:** Determines which shard receives the record (MD5 hash)
- **Producers:** SDK, KPL (Kinesis Producer Library), Kinesis Agent
- **Consumers:**
  - Shared (classic): 2 MB/s per shard across all consumers; pull
  - Enhanced fan-out: 2 MB/s per shard **per consumer**; push (HTTP/2)
- **On-Demand mode:** Auto-scales shards (up to 200 MB/s default)

### Kinesis Data Firehose

| Property | Value |
|----------|-------|
| Latency | **Near-real-time (60 seconds buffer minimum)** |
| Data retention | ❌ No storage/replay |
| Scaling | Automatic (fully managed) |
| Transformation | ✅ Lambda (optional) |
| Destinations | S3, Redshift, OpenSearch, Splunk, HTTP endpoint, Datadog, MongoDB |

### Kinesis Data Streams vs Firehose

| Feature | Data Streams | Firehose |
|---------|-------------|----------|
| Latency | Real-time (~200ms) | Near-real-time (~60s) |
| Scaling | Manual/On-demand shards | Auto-scaling |
| Data retention | 1-365 days | No retention |
| Replay | ✅ | ❌ |
| Consumers | Custom (Lambda, KCL, SDK) | S3, Redshift, OpenSearch, HTTP |
| Management | More operational overhead | Fully managed |
| Use Case | Custom processing, real-time analytics | Data delivery to storage/analytics |

### Kinesis Data Analytics
- SQL or Apache Flink on streaming data
- Real-time analytics: sliding windows, aggregations
- Sources: Data Streams, Firehose
- Destinations: Data Streams, Firehose, Lambda

### Kinesis vs SQS

| Feature | Kinesis | SQS |
|---------|---------|-----|
| Ordering | Per shard (partition key) | FIFO only |
| Replay | ✅ (data persists) | ❌ (deleted after processing) |
| Consumers | Multiple (fan-out) | Single consumer group |
| Throughput | Provisioned (shards) | Unlimited (Standard) |
| Latency | ~200ms | Variable |
| Use Case | Real-time analytics, log streaming | Decoupling, work queues |

### Exam Tips - Kinesis
- "Real-time data streaming" → Kinesis Data Streams
- "Deliver streaming data to S3" → Kinesis Data Firehose
- "Replay / reprocess stream data" → Kinesis Data Streams (not Firehose)
- "Real-time analytics on streams" → Kinesis Data Analytics
- "IoT device data ingestion" → Kinesis Data Streams
- Hot partition: one shard gets too many records (poor partition key choice)

---

## AWS Step Functions

### Key Concepts
- **Orchestrate** multiple AWS services into serverless workflows
- Visual workflow with **state machines** (JSON definition, ASL)
- States: Task, Choice, Parallel, Wait, Succeed, Fail, Map, Pass

### Workflow Types

| Type | Standard | Express |
|------|----------|---------|
| Duration | Up to 1 year | Up to 5 minutes |
| Execution rate | 2,000/sec start rate | 100,000/sec start rate |
| Pricing | Per state transition | Per execution + duration + memory |
| Execution model | Exactly-once | At-least-once (async) or at-most-once (sync) |
| Use Case | Long-running, audit trail | High-volume, short duration (IoT, streaming) |

### Error Handling
- **Retry:** Automatic retry with exponential backoff
- **Catch:** Fallback state on error
- Built-in error types: `States.ALL`, `States.Timeout`, `States.TaskFailed`
- Can combine Retry + Catch for robust error handling

### Integration Patterns
- **Optimized integrations:** Lambda, DynamoDB, ECS, SNS, SQS, Glue, SageMaker, etc.
- **SDK integrations:** Call any AWS service API
- Patterns: Request-Response, Wait for Callback (.waitForTaskToken), Run a Job (.sync)

### Exam Tips - Step Functions
- "Orchestrate Lambda functions" → Step Functions
- "Visual workflow with branching logic" → Step Functions
- "Long-running workflow (hours/days)" → Standard Workflow
- "High-volume short processing" → Express Workflow
- "Error handling + retry logic" → Step Functions (built-in)
- Step Functions vs SQS: Step Functions for orchestration with logic; SQS for simple decoupling

---

## Amazon MQ

- **Managed message broker** for Apache ActiveMQ and RabbitMQ
- Use when **migrating from on-premises** (existing apps using AMQP, MQTT, STOMP, OpenWire, WSS)
- Supports industry-standard APIs and protocols
- Runs on dedicated instances (NOT serverless)
- Multi-AZ with failover (active-standby)

### When to Use Amazon MQ vs SQS/SNS

| Scenario | Choose |
|----------|--------|
| New cloud-native application | SQS/SNS |
| Migrating existing on-prem broker | Amazon MQ |
| Need standard protocols (AMQP, MQTT) | Amazon MQ |
| Serverless, unlimited scaling | SQS/SNS |

### Exam Tips - Amazon MQ
- "Migrate on-premises RabbitMQ/ActiveMQ" → Amazon MQ
- "MQTT protocol for IoT" → Amazon MQ (or IoT Core)
- Amazon MQ has both queue and topic features (like SQS + SNS combined)
- Less scalable than SQS/SNS (fixed infrastructure)

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| SQS message size | 256 KB max |
| SQS retention | 4 days default, 14 days max |
| SQS visibility timeout | 30 seconds default |
| SQS FIFO throughput | 300 msg/s (3,000 batched) |
| SQS long polling | Up to 20 seconds |
| SNS subscriptions per topic | 12,500,000 |
| Kinesis Data Streams retention | 1-365 days |
| Kinesis shard throughput | 1 MB/s in, 2 MB/s out |
| Kinesis record max size | 1 MB |
| Firehose buffer | 60 seconds minimum |
| Step Functions Standard max | 1 year |
| Step Functions Express max | 5 minutes |

---

## Gotchas & Exam Traps

1. **SQS FIFO queue name must end in `.fifo`** — common setup mistake
2. **SNS does NOT retain messages** — lost if subscriber can't process
3. **SNS FIFO only supports SQS FIFO subscribers** — no Lambda, HTTP
4. **Kinesis Data Streams requires manual shard management** (unless on-demand mode)
5. **Firehose is NOT real-time** — minimum 60 second buffer
6. **Firehose cannot send to SQS or SNS** — only S3, Redshift, OpenSearch, HTTP endpoints
7. **SQS messages are deleted after processing** — no replay (unlike Kinesis)
8. **Visibility timeout** too short = duplicate processing; too long = slow retry
9. **Step Functions Express** is at-least-once (NOT exactly-once for async)
10. **Amazon MQ is NOT serverless** — runs on EC2 (cannot scale like SQS)
11. **SNS + SQS fan-out** requires SQS access policy allowing SNS to send
12. **EventBridge** is preferred over CloudWatch Events (same service, more features)
