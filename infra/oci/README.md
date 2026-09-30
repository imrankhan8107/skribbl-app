# Oracle Cloud Infrastructure (OCI) Deployment Guide (Terraform)

This Terraform configuration supports **both**:
1. **Single-Machine Deployment (Default)**: Ideal for **Oracle Cloud Always Free Tier** (1× Ampere `VM.Standard.A1.Flex` with 4 OCPUs and 24 GB RAM — $0/month forever). Builds the multi-stage Docker image and runs the unified container (FastAPI serving both the React frontend and `/ws` WebSocket API directly on port 80). No Nginx, Go Gateway, or Redis needed!
2. **Multi-Host Distributed Deployment**: Scales across dedicated OCI compute instances for Load Balancer, Gateways, Workers, Redis, and in-VCN load generators.

---

## 1. Single-Machine Deployment (Always Free: $0/Month)

If you only have quota for **one machine** on Oracle Cloud, this mode runs the pure application in a single lightweight container:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Single OCI Compute Instance (Ubuntu 22.04)            │
│                   Ampere A1.Flex (4 OCPUs, 24 GB RAM) - Free           │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 Skribbl App Container (:80)                    │   │
│   │                                                                │   │
│   │   • Frontend: React 18 SPA (served from /assets & /)           │   │
│   │   • Backend:  FastAPI + uvloop (in-memory state on /ws)        │   │
│   │                                                                │   │
│   │   (Zero Nginx, Zero Go Gateway, Zero Redis overhead)           │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### Quick Start (Single Machine)

1. **Configure credentials**:
   ```bash
   cd infra/oci
   cp terraform.tfvars.example terraform.tfvars
   ```

2. **Edit `terraform.tfvars`**:
   ```hcl
   tenancy_ocid     = "ocid1.tenancy.oc1..aaaaaaaaxxx"
   user_ocid        = "ocid1.user.oc1..aaaaaaaaxxx"
   fingerprint      = "xx:xx:xx:xx:xx:xx:xx:xx"
   private_key_path = "~/.oci/oci_api_key.pem"
   region           = "us-ashburn-1"
   compartment_ocid = "ocid1.compartment.oc1..aaaaaaaaxxx"

   # Access mode: false = anyone can access web app; true = restricted to allowed_cidrs
   is_private    = false
   allowed_cidrs = [
     "YOUR_LOCAL_IP/32"    # Your local machine for administrative SSH (from curl ifconfig.me)
   ]
   ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."

   # Single machine mode (enabled by default)
   single_instance_mode          = true
   single_instance_shape         = "VM.Standard.A1.Flex"
   single_instance_ocpus         = 4    # Up to 4 free OCPUs
   single_instance_memory_in_gbs = 24   # Up to 24 free GB RAM
   single_instance_app_scale     = 4    # 4 Python game worker replicas
   ```

3. **Deploy**:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

4. **Access Application**:
   App is live at `http://<SERVER_PUBLIC_IP>` (and `http://<SERVER_PUBLIC_IP>:9000`) in ~3–5 minutes.

---

## 2. Multi-Host Distributed Deployment

If you want to scale horizontally across multiple dedicated OCI compute instances (separate VMs for Nginx, Go Gateways, Python Workers, Redis, and k6 load generators):

In `terraform.tfvars`, simply set:
```hcl
single_instance_mode = false

gateway_count = 2
worker_count  = 2
```

Then run `terraform apply`.

---

## Security & Firewall Constraints

In accordance with strict security standards, **zero ports are exposed to `0.0.0.0/0`**:

1. **Internal Inter-Tier Communication**: All traffic between containers and instances is locked strictly to `var.vcn_cidr` (`10.10.0.0/16`).
2. **External Ingress**: Ports 22 (SSH), 80/443 (HTTP/HTTPS), 9000–9020 (Gateway WS), and 9100–9120 (Coord) are strictly locked down to `var.allowed_cidrs`.

---

## Troubleshooting & Verification

1. **Check cloud-init deployment log**:
   ```bash
   ssh ubuntu@<SERVER_PUBLIC_IP> "tail -f /var/log/skribbl-deploy.log"
   ```

2. **Inspect running Docker containers**:
   ```bash
   ssh ubuntu@<SERVER_PUBLIC_IP> "docker ps"
   ```

3. **Update code & redeploy**:
   ```bash
   ssh ubuntu@<SERVER_PUBLIC_IP>
   cd /home/ubuntu/skribbl-app
   git pull
   docker compose up -d --build --scale app=4
   ```

4. **Teardown**:
   ```bash
   terraform destroy
   ```
