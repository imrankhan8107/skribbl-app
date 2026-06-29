# Skribbl App — Oracle Cloud (OCI) Terraform Deployment

Deploys the Skribbl app on an OCI Always Free tier A1.Flex compute instance with Docker.

## Architecture

- **Compute**: VM.Standard.A1.Flex (ARM, 1 OCPU / 6 GB RAM — Always Free)
- **Networking**: VCN + public subnet + internet gateway
- **App**: Docker Compose (app + Redis + nginx) deployed via cloud-init
- **Cost**: $0 on Always Free tier

## Prerequisites

1. [OCI account](https://cloud.oracle.com/) with Always Free tier
2. [Terraform](https://developer.hashicorp.com/terraform/downloads) >= 1.5
3. [OCI CLI configured](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm) with API key
4. SSH key pair

## Quick Start

```bash
cd infra/oci

# Copy and edit variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your OCI credentials

# Deploy
terraform init
terraform plan
terraform apply
```

## After Deployment

The app takes 3-5 minutes to fully start (Docker builds from source).

Check progress:
```bash
ssh ubuntu@<public_ip>
tail -f /var/log/skribbl-deploy.log
```

Access the app:
- Via nginx (load balanced): `http://<public_ip>:8080`
- Direct (single worker): `http://<public_ip>:8000`

## Updating the App

SSH in and pull the latest code:
```bash
ssh ubuntu@<public_ip>
cd /home/ubuntu/skribbl-app
git pull
docker compose up -d --build
```

## Teardown

```bash
terraform destroy
```

## Always Free Limits

| Resource | Free Allowance | This Deployment |
|----------|---------------|-----------------|
| A1.Flex OCPUs | 4 | 1 |
| A1.Flex Memory | 24 GB | 6 GB |
| Boot Volume | 200 GB total | 50 GB |
| VCN | 2 | 1 |
| Public IPs | 2 | 1 |
| Outbound Data | 10 TB/month | Minimal |
