# AWS Solutions Architect Associate (SAA-C03) - Revision Notes

## 📚 Study Guide Index

| # | Topic | File |
|---|-------|------|
| 01 | [EC2 & Compute](./01-ec2-compute.md) | Instance types, ASG, ELB, Lambda, Elastic Beanstalk |
| 02 | [Storage](./02-storage.md) | S3, EBS, EFS, FSx, Storage Gateway, Snow Family |
| 03 | [Databases](./03-databases.md) | RDS, Aurora, DynamoDB, ElastiCache, Redshift, Purpose-built DBs |
| 04 | [Networking & VPC](./04-networking.md) | VPC, Subnets, Security Groups, NACLs, VPN, Direct Connect, CloudFront, Route 53 |
| 05 | [Security & IAM](./05-security-iam.md) | IAM, KMS, Cognito, WAF, Shield, GuardDuty, Organizations |
| 06 | [Messaging & Decoupling](./06-messaging-decoupling.md) | SQS, SNS, EventBridge, Kinesis, Step Functions |
| 07 | [Serverless](./07-serverless.md) | Lambda, API Gateway, DynamoDB, SAM, AppSync |
| 08 | [Containers](./08-containers.md) | ECS, Fargate, EKS, ECR, App Runner |
| 09 | [Monitoring & Logging](./09-monitoring.md) | CloudWatch, CloudTrail, X-Ray, Config, Trusted Advisor |
| 10 | [Cost Optimization](./10-cost-optimization.md) | Pricing models, Savings Plans, Spot, Cost Explorer, Budgets |
| 11 | [Disaster Recovery & Migration](./11-disaster-recovery.md) | DR strategies, DMS, Snow Family, DataSync, MGN |
| 12 | [Advanced Architecture Patterns](./12-advanced-architectures.md) | Well-Architected, Event-driven, Microservices, Data Lake, Hybrid |

---

## 🎯 Exam Overview

- **Exam Code:** SAA-C03
- **Duration:** 130 minutes
- **Questions:** 65 (multiple choice & multiple response)
- **Passing Score:** 720/1000
- **Domains:**
  - Domain 1: Design Secure Architectures (30%)
  - Domain 2: Design Resilient Architectures (26%)
  - Domain 3: Design High-Performing Architectures (24%)
  - Domain 4: Design Cost-Optimized Architectures (20%)

## 💡 General Exam Tips

1. **"Most cost-effective"** → Think Spot instances, S3 lifecycle, serverless, reserved capacity
2. **"Highly available"** → Multi-AZ, multiple regions, Auto Scaling, ELB
3. **"Least operational overhead"** → Managed services, serverless, Fargate
4. **"Decouple"** → SQS, SNS, EventBridge, Step Functions
5. **"Migrate with minimal downtime"** → DMS with continuous replication, blue/green
6. **"Real-time"** → Kinesis Data Streams, not Firehose (near-real-time)
7. **"Secure access to S3 from VPC"** → VPC Gateway Endpoint (free)
8. **"Restrict S3 to CloudFront"** → OAC (Origin Access Control)
9. **"Temporary credentials"** → STS AssumeRole, Cognito Identity Pools
10. **"Compliance / audit"** → AWS Config, CloudTrail, GuardDuty
