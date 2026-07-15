# 05 - Security & IAM

## IAM (Identity and Access Management)

### Core Components
- **Users:** Individual people or services
- **Groups:** Collection of users (CANNOT contain other groups)
- **Roles:** Temporary credentials for AWS services, cross-account access, federation
- **Policies:** JSON documents defining permissions

### IAM Policy Structure (JSON)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowS3Read",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::my-bucket/*"],
      "Condition": {
        "IpAddress": {"aws:SourceIp": "203.0.113.0/24"}
      }
    }
  ]
}
```

### Policy Types

| Type | Attached To | Use Case |
|------|-------------|----------|
| **Identity-based** | Users, Groups, Roles | Grant permissions to principals |
| **Resource-based** | Resources (S3, SQS, KMS) | Grant cross-account access without assuming role |
| **Permissions Boundary** | Users, Roles | Maximum permissions an entity CAN have |
| **SCPs** | OUs, Accounts (Organizations) | Maximum permissions for an account |
| **Session Policies** | STS sessions | Limit assumed role permissions |

### IAM Policy Evaluation Logic
```
Explicit DENY → wins (always)
    ↓ no explicit deny
SCP allows? → if NO → implicit deny
    ↓ yes
Permissions boundary allows? → if NO → implicit deny
    ↓ yes
Identity-based policy allows? → if YES → ALLOW
Resource-based policy allows? → if YES → ALLOW
    ↓ neither allows
Implicit DENY (default)
```

**Key Rule:** Explicit Deny > Explicit Allow > Implicit Deny

### IAM Roles Use Cases
- **EC2 Instance Role:** EC2 accesses AWS services (use instance profile)
- **Lambda Execution Role:** Lambda accesses AWS resources
- **Cross-Account Access:** STS:AssumeRole in target account
- **Service-linked Roles:** Predefined by AWS services (cannot modify)

### Exam Tips - IAM
- Root account: use MFA, don't use for daily tasks
- "Least privilege principle" → Grant minimum permissions needed
- "Cross-account access" → IAM Role + STS AssumeRole (or resource-based policy)
- Groups cannot be nested; users can belong to multiple groups
- Max 5000 IAM users per account (use IAM Identity Center for more)
- Access keys for programmatic access; password for console

---

## AWS Organizations

### Key Features
- **Management account** (payer) + member accounts
- **Consolidated billing:** Single payment, volume discounts, reserved instance sharing
- **OUs (Organizational Units):** Hierarchical grouping of accounts
- **SCPs:** Control maximum available permissions for accounts/OUs

### Service Control Policies (SCPs)
- Do NOT grant permissions (only restrict)
- Applied to OU or Account (not management account)
- Management account is NOT affected by SCPs
- Default: `FullAWSAccess` SCP (must explicitly attach restrictive ones)
- SCPs affect all users and roles in the account (including root of member accounts)

### Exam Tips - Organizations
- "Restrict services across all accounts" → SCP
- "Consolidated billing + volume discounts" → Organizations
- SCPs don't affect the management account
- SCPs + IAM policies = effective permissions (intersection)

---

## AWS IAM Identity Center (formerly SSO)

- **Single sign-on** for multiple AWS accounts and business applications
- Supports: SAML 2.0, built-in identity store, Active Directory, external IdPs
- Centralized permission management across Organization accounts
- Permission Sets: define access levels, applied to users/groups per account
- Fine-grained permissions + multi-account access from one portal

---

## Amazon Cognito

### User Pools vs Identity Pools

| Feature | User Pools | Identity Pools |
|---------|-----------|----------------|
| Purpose | **Authentication** (who you are) | **Authorization** (what you can do) |
| Function | Sign-up, sign-in, user directory | Temporary AWS credentials |
| Returns | JWT tokens | STS temporary credentials |
| Federation | Social IdPs, SAML, OIDC | Exchanges tokens for AWS creds |
| Use Case | User authentication for app | Access AWS services (S3, DynamoDB) |

### Common Pattern
1. User authenticates with **Cognito User Pool** → gets JWT
2. JWT exchanged with **Cognito Identity Pool** → gets temporary AWS credentials
3. User accesses AWS services directly with those credentials

### Exam Tips - Cognito
- "Authenticate users for web/mobile app" → User Pool
- "Give users direct access to AWS resources" → Identity Pool
- "Social login (Google, Facebook)" → User Pool (federation)
- "Temporary AWS credentials for mobile app" → Identity Pool
- User Pools integrate directly with API Gateway and ALB

---

## AWS KMS (Key Management Service)

### Key Types
| Type | Description | Use Case |
|------|-------------|----------|
| **AWS Managed Key** | Created/managed by AWS (free for AWS services) | Default service encryption |
| **Customer Managed Key (CMK)** | Created/managed by customer ($1/month + API calls) | Custom encryption, rotation control |
| **AWS Owned Key** | AWS uses internally (invisible to you) | Internal AWS operations |

### Symmetric vs Asymmetric
| Type | Description | Use Case |
|------|-------------|----------|
| **Symmetric (AES-256)** | Same key encrypts + decrypts; never leaves KMS | Most AWS services, envelope encryption |
| **Asymmetric (RSA/ECC)** | Public + private key pair | Encrypt outside AWS, digital signatures |

### Envelope Encryption
- Encrypt data > 4 KB
- Process: KMS generates **Data Encryption Key (DEK)** → encrypt data with DEK → encrypt DEK with CMK
- Only encrypted DEK stored with data
- Decrypt: send encrypted DEK to KMS → get plaintext DEK → decrypt data

### Key Rotation
- **AWS Managed Keys:** Auto-rotated every year (mandatory)
- **Customer Managed Keys:** Auto-rotation optional (every year if enabled)
- **Manual rotation:** Create new key, update alias (for asymmetric or custom schedules)

### Key Policies
- Default: root account has full access (entire account can use key)
- Custom: define specific users/roles that can use the key
- Cross-account: add external account to key policy + IAM policy in target account

### KMS Multi-Region Keys
- Identical keys in multiple regions (same key material)
- Encrypt in one region, decrypt in another
- NOT global (managed independently but interoperable)
- Use case: global DynamoDB/Aurora encryption, client-side encryption

### Exam Tips - KMS
- "Encryption at rest" → KMS
- "API call logging for key usage" → CloudTrail + KMS
- "> 4 KB encryption" → Envelope Encryption (GenerateDataKey API)
- "Share encrypted snapshot cross-account" → add target account to KMS key policy
- KMS keys are region-specific (re-encrypt with new key when copying cross-region)
- KMS API limits can throttle high-throughput encryption (request quota increase or use envelope encryption)

---

## AWS CloudHSM

- **Dedicated hardware security module** (single-tenant)
- YOU manage keys (AWS manages hardware)
- **FIPS 140-2 Level 3** compliance (vs KMS = Level 2)
- Supports symmetric AND asymmetric encryption
- High availability: deploy in multiple AZs (CloudHSM cluster)
- No AWS access to your keys (customer responsibility)
- Integrates with: custom applications, SSL/TLS offloading, Oracle TDE

### KMS vs CloudHSM

| Feature | KMS | CloudHSM |
|---------|-----|----------|
| Tenancy | Multi-tenant | Single-tenant (dedicated) |
| Key Management | AWS or customer | Customer only |
| FIPS 140-2 | Level 2 | **Level 3** |
| Integration | All AWS services natively | Custom applications |
| Availability | HA built-in | Must configure cluster |
| Cost | Per key + API calls | Per HSM per hour ($$$) |

### Exam Tips - CloudHSM
- "FIPS 140-2 Level 3" → CloudHSM
- "Customer manages all keys" → CloudHSM
- "SSL offloading" → CloudHSM
- "Integrate with KMS" → CloudHSM as custom key store for KMS

---

## AWS Secrets Manager

- Store and **automatically rotate** secrets (passwords, API keys, DB credentials)
- Built-in integration with **RDS, Redshift, DocumentDB** (auto-rotation with Lambda)
- Secrets encrypted with KMS
- Cross-region replication of secrets
- Forces rotation (rotation schedules)

### Secrets Manager vs Parameter Store

| Feature | Secrets Manager | Parameter Store |
|---------|-----------------|-----------------|
| Auto-rotation | ✅ Built-in (native) | ❌ (must use Lambda manually) |
| Cost | $0.40/secret/month + API calls | Free (standard) / $0.05 (advanced) |
| Size limit | 64 KB | 4 KB (standard) / 8 KB (advanced) |
| RDS Integration | ✅ Native rotation | ❌ Manual |
| Cross-region | ✅ Replication | ❌ No replication |
| Versioning | ✅ | ✅ |

### Exam Tips
- "Automatic rotation of DB credentials" → Secrets Manager
- "Free parameter storage" → Parameter Store (standard tier)
- "RDS password rotation" → Secrets Manager (built-in)
- Both support encryption with KMS

---

## Systems Manager Parameter Store

### Tiers
| Feature | Standard | Advanced |
|---------|----------|----------|
| Parameters | Up to 10,000 | Up to 100,000 |
| Max size | 4 KB | 8 KB |
| Parameter policies | ❌ | ✅ (TTL, expiration notifications) |
| Cost | Free | $0.05/parameter/month |

### Key Features
- Hierarchical storage: `/app/dev/db-password`
- Supports: String, StringList, SecureString (KMS encrypted)
- Version tracking
- IAM access control
- Integration: CloudFormation, Lambda, EC2, ECS

---

## AWS Certificate Manager (ACM)

- **Free** public SSL/TLS certificates
- Auto-renewal
- Integrates with: **ALB, NLB, CloudFront, API Gateway**
- Does NOT work with EC2 directly (must use self-managed certs on EC2)
- Regional service (except CloudFront which requires us-east-1 certs)

### Exam Tips - ACM
- "Free HTTPS" → ACM + ALB or CloudFront
- "SSL cert for EC2" → NOT ACM (self-managed or use ALB in front)
- CloudFront cert MUST be in us-east-1

---

## AWS WAF (Web Application Firewall)

- **Layer 7** (HTTP/HTTPS) protection
- Deploys on: **ALB, API Gateway, CloudFront, AppSync, Cognito User Pool**
- Does NOT work on NLB (Layer 4)

### Rule Types
| Rule | Description |
|------|-------------|
| IP-based | Block/allow specific IPs or CIDR ranges |
| Rate-based | Block IPs exceeding X requests in 5 minutes (DDoS protection) |
| SQL Injection | Detect SQL injection patterns |
| XSS | Detect cross-site scripting |
| Geo-match | Block/allow by country |
| Size constraints | Block requests exceeding size |
| Regex | Match against regex patterns |

### AWS Managed Rule Groups
- Pre-built rules by AWS or AWS Marketplace sellers
- Examples: AmazonIPReputationList, CommonRuleSet, SQLiRuleSet

### Exam Tips - WAF
- "Block SQL injection / XSS" → WAF
- "Rate limiting" → WAF rate-based rules
- "Block specific country" → WAF geo-match (or CloudFront geo-restriction)
- "Layer 7 firewall on ALB" → WAF
- WAF does NOT work with NLB

---

## AWS Shield

| Feature | Shield Standard | Shield Advanced |
|---------|----------------|-----------------|
| Cost | Free (automatic) | $3,000/month |
| Protection | Layer 3/4 DDoS | Layer 3/4/7 DDoS |
| Scope | All AWS customers | Opted-in resources |
| Response Team | ❌ | ✅ 24/7 DRT (DDoS Response Team) |
| Cost Protection | ❌ | ✅ (reimburse scaling costs from DDoS) |
| Visibility | Basic | Advanced real-time metrics |
| Works With | All resources | EC2, ELB, CloudFront, Global Accelerator, Route 53 |

### Exam Tips - Shield
- "DDoS protection" → Shield (Standard is already on)
- "24/7 support team for DDoS" → Shield Advanced
- "Cost protection during DDoS attack" → Shield Advanced
- Shield Advanced + WAF = comprehensive L3-L7 protection

---

## AWS GuardDuty

- **Intelligent threat detection** using ML, anomaly detection, 3rd party threat intel
- Analyzes: CloudTrail logs, VPC Flow Logs, DNS logs, EKS audit logs, S3 data events
- Detects: cryptocurrency mining, compromised instances, unauthorized access
- Findings sent to EventBridge → trigger Lambda, SNS, etc.
- No need to enable VPC Flow Logs separately (GuardDuty gets them independently)
- Multi-account support via Organizations

---

## Amazon Inspector

- **Automated vulnerability scanning**
- Targets: **EC2 instances, ECR container images, Lambda functions**
- Checks: CVEs, network reachability, OS vulnerabilities, code vulnerabilities
- Continuous scanning (not just one-time)
- Findings → EventBridge, Security Hub
- Risk score assigned to each finding

---

## Amazon Macie

- ML-powered service to discover and protect **sensitive data (PII)** in S3
- Automatically discovers: credit card numbers, SSNs, names, addresses
- Findings → EventBridge → SNS/Lambda
- Use case: compliance, data privacy (GDPR, HIPAA)

---

## AWS Config

- **Record and evaluate** resource configurations over time
- Compliance auditing: "Is my S3 bucket public?", "Is encryption enabled?"
- **Config Rules:** Managed or custom (Lambda-based)
- **Remediation:** Automatic via SSM Automation documents
- **Aggregator:** Multi-account, multi-region view
- NOT preventive (detective only) — evaluates after the fact
- Stores history in S3, sends notifications via SNS

### Exam Tips - Config
- "Compliance history of resources" → AWS Config
- "Is my security group unrestricted?" → Config rule
- "Auto-remediate non-compliant resources" → Config + SSM Automation
- Config ≠ CloudTrail (Config = resource state; CloudTrail = who did what)

---

## AWS CloudTrail

- **Logs all API calls** made in your AWS account
- Enabled by default (90 days retention in Event History)
- **Management Events:** Resource operations (create, modify, delete) — logged by default
- **Data Events:** Object-level activity (S3 GetObject, Lambda Invoke) — NOT logged by default (high volume)
- **Insight Events:** Detect unusual activity (burst of API calls)
- Store in S3 for long-term retention
- Organization Trail: single trail for all accounts
- CloudTrail + EventBridge: trigger on any API call

### Exam Tips - CloudTrail
- "Who terminated my EC2 instance?" → CloudTrail
- "Audit API calls" → CloudTrail
- "S3 object-level logging" → CloudTrail Data Events (not management events)
- "Detect unusual API activity" → CloudTrail Insights

---

## 🔑 Key Numbers to Memorize

| Item | Value |
|------|-------|
| IAM users per account | 5,000 |
| IAM groups per account | 300 |
| IAM policies per user | 10 managed policies |
| KMS key max data size (direct) | 4 KB |
| Secrets Manager max secret size | 64 KB |
| Parameter Store standard max | 4 KB |
| Parameter Store advanced max | 8 KB |
| Shield Advanced cost | $3,000/month |
| CloudTrail default retention | 90 days (Event History) |
| WAF rate-based rule interval | 5 minutes |
| ACM region for CloudFront | us-east-1 only |

---

## Gotchas & Exam Traps

1. **SCPs don't grant permissions** — they only set maximum boundaries
2. **Management account** is NOT affected by SCPs
3. **KMS keys are regional** — cross-region operations need re-encryption
4. **ACM certs for CloudFront** must be in us-east-1
5. **WAF doesn't work with NLB** — only ALB, API Gateway, CloudFront
6. **GuardDuty doesn't require** you to enable VPC Flow Logs separately
7. **Config is detective** not preventive — use SCPs/IAM for prevention
8. **CloudTrail Data Events** not enabled by default (must opt-in, extra cost)
9. **Permissions boundaries** limit max permissions but don't grant anything
10. **Resource-based policies** allow cross-account access WITHOUT assuming a role
11. **Secrets Manager** costs money; Parameter Store standard tier is free
12. **CloudHSM = FIPS 140-2 Level 3**; KMS = Level 2 (frequently tested)
