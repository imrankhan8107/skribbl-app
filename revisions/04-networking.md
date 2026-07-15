# 04 - Networking & VPC

## VPC (Virtual Private Cloud)

### Core Components
- **VPC:** Logically isolated section of AWS; regional resource
- **CIDR Block:** IP range for VPC (min /28 = 16 IPs, max /16 = 65,536 IPs)
- **Subnets:** Subdivision of VPC; AZ-specific
  - Public subnet: has route to Internet Gateway
  - Private subnet: no direct route to internet
- **AWS reserves 5 IPs** per subnet (first 4 + last 1):
  - .0 = Network address
  - .1 = VPC router
  - .2 = DNS server
  - .3 = Reserved for future
  - .255 = Broadcast (not used but reserved)

### Route Tables
- Each subnet must be associated with a route table
- Main route table = default for all subnets without explicit association
- Local route (VPC CIDR) is always present and cannot be removed

### Internet Gateway (IGW)
- Horizontally scaled, redundant, highly available
- One per VPC
- Performs NAT for instances with public IPv4
- Must update route table: `0.0.0.0/0 → igw-xxx`

### NAT Gateway vs NAT Instance

| Feature | NAT Gateway | NAT Instance |
|---------|-------------|--------------|
| Managed | ✅ AWS-managed | ❌ Self-managed EC2 |
| Availability | HA within AZ (deploy per AZ) | Manual HA (scripts, ASG) |
| Bandwidth | Up to 100 Gbps | Depends on instance type |
| Security Groups | ❌ Not supported | ✅ Supported |
| Bastion Host | ❌ Cannot use as | ✅ Can use as |
| Cost | Per hour + per GB | Instance cost |
| Source/Dest Check | Automatically disabled | Must disable manually |

### Exam Tips - NAT
- NAT Gateway in **public subnet**, route from private subnet: `0.0.0.0/0 → nat-gw`
- Deploy one NAT Gateway **per AZ** for high availability
- NAT Gateway does NOT support IPv6 (use Egress-only IGW for IPv6)

---

## Security Groups vs NACLs

| Feature | Security Groups | NACLs |
|---------|----------------|-------|
| Level | Instance (ENI) level | Subnet level |
| Statefulness | **Stateful** (return traffic auto-allowed) | **Stateless** (must explicitly allow return) |
| Rules | Allow only | Allow AND Deny |
| Rule Evaluation | All rules evaluated | Rules evaluated in order (lowest number first) |
| Default | All inbound denied, all outbound allowed | Default NACL allows all in/out |
| Association | Instance can have multiple SGs | Subnet has exactly one NACL |

### NACL Rule Numbers
- Evaluated from lowest to highest (e.g., Rule 100 before Rule 200)
- First match wins (stops evaluating)
- Rule `*` (asterisk) = default deny all (evaluated last)
- Best practice: increment by 100 (100, 200, 300…) to allow insertions

### Ephemeral Ports
- Clients use random high ports (1024-65535) for responses
- NACLs must allow ephemeral port range for return traffic
- Common ranges: Linux (32768-60999), Windows (49152-65535)

### Exam Tips - Security
- "Block a specific IP" → NACL (Security Groups can't deny)
- "Stateful" → Security Group
- "Subnet-level firewall" → NACL
- Security Groups reference other SGs (great for tiered architectures)

---

## VPC Peering

- Connect two VPCs privately (same or different accounts/regions)
- **Non-transitive:** A↔B and B↔C does NOT mean A↔C
- **No overlapping CIDR** blocks allowed
- Must update route tables in BOTH VPCs
- DNS resolution can be enabled across peered VPCs
- Cross-region peering: data encrypted, no single point of failure

---

## Transit Gateway

- **Hub-and-spoke** connectivity for VPCs, VPNs, Direct Connect
- **Transitive routing:** Connects thousands of VPCs and on-prem networks
- Regional resource (can peer cross-region)
- Supports **IP multicast** (only AWS service that does)
- Works with: VPCs, VPN, Direct Connect Gateway, other Transit Gateways
- Route tables at Transit Gateway level for fine-grained control

### Use Cases
- Simplify network topology (replace complex peering mesh)
- Share VPN/Direct Connect across multiple VPCs
- Centralized egress (single NAT Gateway for all VPCs)

### Exam Tips - Transit Gateway
- "Connect hundreds of VPCs" → Transit Gateway
- "Transitive routing" → Transit Gateway (not VPC Peering)
- "IP multicast" → Transit Gateway (only option)

---

## VPC Endpoints

| Type | Services | How It Works | Cost |
|------|----------|-------------|------|
| **Gateway Endpoint** | S3, DynamoDB ONLY | Entry in route table | Free |
| **Interface Endpoint** | All other services | ENI with private IP (uses PrivateLink) | Per hour + per GB |

### Gateway Endpoints
- Specified in route table (target: `vpce-xxx`)
- Free to use
- Does NOT use PrivateLink
- Cannot be extended outside VPC (no peering/VPN/DX access)

### Interface Endpoints (PrivateLink)
- Creates ENI in subnet with private IP
- Supports access from on-prem (via VPN/DX), peered VPCs, Transit Gateway
- DNS: endpoint-specific DNS or private DNS (overrides public service DNS)
- Charges: hourly + data processing

### Exam Tips - VPC Endpoints
- "Private access to S3 from VPC" → Gateway Endpoint (free, simple)
- "Access AWS service without internet" → VPC Endpoint
- "On-premises access to S3 privately" → Interface Endpoint (not Gateway)
- Both types use VPC endpoint policies to control access

---

## AWS PrivateLink

- Expose your service to other VPCs **without** VPC peering, internet, NAT, route tables
- Service provider: creates NLB → Endpoint Service
- Service consumer: creates Interface Endpoint → connects to service
- Secure, scalable (used by AWS services internally)

### Exam Tips - PrivateLink
- "Expose service to 1000s of VPCs" → PrivateLink
- Requires NLB on provider side, ENI on consumer side
- No need for VPC peering (works cross-account)

---

## Site-to-Site VPN

- Encrypted connection over **public internet**
- Components:
  - **Virtual Private Gateway (VGW):** AWS side
  - **Customer Gateway (CGW):** On-premises side (device or software)
- Supports **static routing** or **dynamic routing (BGP)**
- Can go over Direct Connect for encrypted private traffic
- Setup in minutes (vs weeks for Direct Connect)
- Two tunnels per connection for HA

### VPN CloudHub
- Connect multiple on-premises sites via VPN hub-and-spoke
- Low-cost, over public internet
- All traffic encrypted

---

## AWS Direct Connect (DX)

- **Dedicated private connection** from on-prem to AWS
- Speeds: **1 Gbps, 10 Gbps** (dedicated) or 50/100/200/300/400/500 Mbps (hosted)
- **Takes weeks/months** to establish (NOT instant)
- Data does NOT go over internet (more consistent, lower latency)
- NOT encrypted by default (add VPN on top for encryption)

### Direct Connect Gateway
- Connect Direct Connect to **multiple VPCs in different regions**
- Works with Transit Gateway for even more connectivity

### Resiliency Levels
- **Maximum Resiliency:** Separate connections at separate DX locations
- **High Resiliency:** 2+ connections at same DX location
- Use VPN as backup while waiting for DX provisioning

### Exam Tips - Direct Connect
- "Dedicated private connection" → Direct Connect
- "Weeks to set up" → Direct Connect (common distractor vs VPN)
- "Encrypt Direct Connect" → Add IPsec VPN on top
- "Backup for DX" → Site-to-Site VPN (over internet)

---

## Amazon CloudFront

### Key Concepts
- **CDN (Content Delivery Network):** 400+ edge locations globally
- **Origins:** S3 bucket, ALB, EC2, custom HTTP server, MediaStore
- **Behaviors:** Path patterns → origin mapping + cache settings
- **Distribution types:** Web (HTTP/HTTPS) — RTMP deprecated

### CloudFront + S3
- **OAC (Origin Access Control):** Recommended; restricts S3 access to CloudFront only
- **OAI (Origin Access Identity):** Legacy method (same purpose)
- S3 bucket policy grants access to CloudFront OAC/OAI

### Cache Invalidation
- Invalidate specific paths: `/images/*`, `/index.html`
- Costs money per invalidation path
- Alternative: use versioned file names (`/image_v2.png`)

### CloudFront Signed URLs vs Signed Cookies

| Feature | Signed URLs | Signed Cookies |
|---------|-------------|----------------|
| Scope | Single file | Multiple files |
| Use Case | Download specific file | Access entire restricted area |
| URL Change | ✅ Modified URL | ❌ Same URL (cookie in header) |

### CloudFront vs S3 Pre-signed URLs

| Feature | CloudFront Signed URL | S3 Pre-signed URL |
|---------|----------------------|-------------------|
| Access via | Edge locations (CDN cached) | Direct to S3 |
| Caching | ✅ Edge cached | ❌ No caching |
| IP restriction | ✅ Can restrict | ❌ Cannot |
| IAM | Uses CloudFront key pair | Uses IAM user credentials |
| Best for | Large-scale distribution | Direct individual access |

### Exam Tips - CloudFront
- "Global content delivery with caching" → CloudFront
- "Restrict S3 access to CloudFront" → OAC (new) or OAI (legacy)
- "HTTPS for S3 static website" → CloudFront in front (S3 website endpoint is HTTP only)
- CloudFront can be origin for ALB (not just S3)
- Geographic restrictions: whitelist or blacklist countries

---

## AWS Global Accelerator

- Provides **2 static Anycast IPs** globally
- Routes traffic to optimal endpoint via AWS global network
- Works at **Layer 4** (TCP/UDP) — NOT a CDN, no caching
- Endpoints: ALB, NLB, EC2, Elastic IP (in any region)
- Health checks + automatic failover (< 30 seconds)

### CloudFront vs Global Accelerator

| Feature | CloudFront | Global Accelerator |
|---------|------------|-------------------|
| Purpose | Content caching at edge | Network performance optimization |
| Layer | Layer 7 (HTTP/HTTPS) | Layer 4 (TCP/UDP) |
| Static IPs | ❌ No (DNS-based) | ✅ 2 Anycast IPs |
| Caching | ✅ | ❌ |
| Use Case | Static/dynamic web content | Gaming, IoT, Voice/Video, static IP needs |

### Exam Tips - Global Accelerator
- "Static IP for ALB" → Global Accelerator
- "Non-HTTP/TCP/UDP optimization" → Global Accelerator
- "Gaming / real-time applications" → Global Accelerator
- "Caching / CDN" → CloudFront (not Global Accelerator)

---

## Amazon Route 53

### Record Types

| Type | Description |
|------|-------------|
| **A** | Maps domain → IPv4 address |
| **AAAA** | Maps domain → IPv6 address |
| **CNAME** | Maps domain → another domain (NOT for zone apex/root) |
| **Alias** | Maps domain → AWS resource (works for zone apex!) |
| **MX** | Mail exchange |
| **NS** | Name servers for the hosted zone |

### Alias Records (AWS-specific)
- Free of charge (no charge for Alias queries to AWS resources)
- Automatically recognizes IP changes of AWS resources
- Targets: ELB, CloudFront, API Gateway, S3 website, VPC Interface Endpoint, Global Accelerator, another Route 53 record
- **CANNOT** alias to EC2 DNS name

### Routing Policies

| Policy | Description | Use Case |
|--------|-------------|----------|
| **Simple** | Single resource (can return multiple IPs, client chooses random) | Basic routing |
| **Weighted** | Percentage of traffic to each resource | A/B testing, gradual migration |
| **Latency** | Route to lowest-latency region | Global apps |
| **Failover** | Primary/secondary with health check | DR/HA |
| **Geolocation** | Route based on user's location (continent/country) | Content localization |
| **Geoproximity** | Route based on geographic distance + bias | Shift traffic between regions |
| **Multi-Value** | Return multiple healthy records (up to 8) | Client-side load balancing |

### Health Checks
- Monitor endpoint health (HTTP, HTTPS, TCP)
- Can monitor: endpoint, other health checks (calculated), CloudWatch alarm
- Interval: 30 seconds (standard) or 10 seconds (fast, extra cost)
- Healthy threshold: configurable consecutive checks
- Can monitor private resources via CloudWatch alarm (Route 53 checkers are public)

### Exam Tips - Route 53
- "Root domain / zone apex (example.com)" → Alias record (NOT CNAME)
- "Free DNS queries to AWS resources" → Alias
- "A/B testing with percentages" → Weighted routing
- "Route to closest region" → Latency-based routing
- "Content by country" → Geolocation
- "DR with automatic failover" → Failover routing policy
- Route 53 is a global service (not regional)

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| VPC CIDR range | /16 to /28 |
| Reserved IPs per subnet | 5 |
| NACLs default rule number | * (last, deny all) |
| VPC Peering | Non-transitive |
| Spread placement group limit | 7 per AZ |
| Direct Connect speeds | 1 Gbps / 10 Gbps (dedicated) |
| Direct Connect setup time | Weeks to months |
| CloudFront edge locations | 400+ |
| Global Accelerator IPs | 2 static Anycast |
| Route 53 multi-value answers | Up to 8 |
| Route 53 health check interval | 30s (standard), 10s (fast) |
| NAT Gateway bandwidth | Up to 100 Gbps |
| Transit Gateway max VPCs | Thousands |

---

## Gotchas & Exam Traps

1. **VPC Peering is NOT transitive** — need Transit Gateway for hub-and-spoke
2. **Security Groups can't deny** — use NACLs to block specific IPs
3. **NAT Gateway is per-AZ** — deploy in each AZ for HA
4. **Gateway Endpoints are free** — Interface Endpoints cost money
5. **Gateway Endpoints only work for S3 and DynamoDB** — everything else = Interface
6. **Direct Connect is NOT encrypted** — add VPN on top
7. **Direct Connect takes weeks** — use VPN as interim/backup
8. **CNAME cannot be used at zone apex** — use Alias record
9. **Global Accelerator ≠ CloudFront** — GA doesn't cache, CF does
10. **CloudFront OAC** is the new recommended way (OAI is legacy but still valid in exam)
11. **Route 53 Alias to EC2** is NOT possible (common trap)
12. **NACLs need ephemeral ports** for return traffic (stateless!)
