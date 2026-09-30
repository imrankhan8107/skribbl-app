terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5.0"
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

# --- Locals ---
locals {
  effective_allowed_cidrs = distinct(compact(concat(
    var.allowed_cidrs,
    var.allowed_cidr != "" ? [var.allowed_cidr] : []
  )))
  safe_allowed_cidrs = length(local.effective_allowed_cidrs) > 0 ? local.effective_allowed_cidrs : ["127.0.0.1/32"]
  ad                 = data.oci_identity_availability_domains.ads.availability_domains[0].name
}

# --- Availability Domains & OS Images ---

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.single_instance_mode ? var.single_instance_shape : var.lb_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# --- Networking ---

resource "oci_core_vcn" "vcn" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.app_name}-vcn"
  cidr_blocks    = [var.vcn_cidr]
  dns_label      = var.app_name
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.app_name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public_rt" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.app_name}-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.igw.id
  }
}

# --- Security List ---
# Strict firewall: internal communication within VCN only;
# all external ingress (SSH, HTTP, gateway, coord, logs, monitoring) strictly restricted to allowed CIDRs.

resource "oci_core_security_list" "cluster_sl" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.app_name}-cluster-sl"

  # Allow all outbound
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # 1. Internal inter-instance communication (within VCN)
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = var.vcn_cidr
    description = "Internal inter-tier communication across VCN"
    tcp_options {
      min = 1
      max = 65535
    }
  }

  # 2. SSH (22) from allowed_cidrs
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "SSH access strictly from allowed IPs"
      tcp_options {
        min = 22
        max = 22
      }
    }
  }

  # 3. HTTP (80) from allowed_cidrs
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "HTTP access strictly from allowed IPs"
      tcp_options {
        min = 80
        max = 80
      }
    }
  }

  # 4. HTTPS (443) from allowed_cidrs
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "HTTPS access strictly from allowed IPs"
      tcp_options {
        min = 443
        max = 443
      }
    }
  }

  # 5. Direct Go Gateway data plane (9000-9020)
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "Gateway data plane access strictly from allowed IPs"
      tcp_options {
        min = 9000
        max = 9020
      }
    }
  }

  # 6. Gateway Coord control plane (9100-9120)
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "Gateway coord control plane strictly from allowed IPs"
      tcp_options {
        min = 9100
        max = 9120
      }
    }
  }

  # 7. Log server (8080)
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "Log server strictly from allowed IPs"
      tcp_options {
        min = 8080
        max = 8080
      }
    }
  }

  # 8. Grafana dashboard (3000)
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "Grafana dashboard strictly from allowed IPs"
      tcp_options {
        min = 3000
        max = 3000
      }
    }
  }

  # 9. Prometheus UI (9090)
  dynamic "ingress_security_rules" {
    for_each = local.safe_allowed_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      description = "Prometheus UI strictly from allowed IPs"
      tcp_options {
        min = 9090
        max = 9090
      }
    }
  }
}

resource "oci_core_subnet" "public_subnet" {
  compartment_id    = var.compartment_ocid
  vcn_id            = oci_core_vcn.vcn.id
  cidr_block        = var.subnet_cidr
  display_name      = "${var.app_name}-public-subnet"
  route_table_id    = oci_core_route_table.public_rt.id
  security_list_ids = [oci_core_security_list.cluster_sl.id]
  dns_label         = "public"
}

# ==============================================================================
# MODE 1: SINGLE INSTANCE DEPLOYMENT (Ideal for OCI Always Free Tier)
# ==============================================================================

resource "oci_core_instance" "single" {
  count               = var.single_instance_mode ? 1 : 0
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad
  display_name        = "${var.app_name}-server"
  shape               = var.single_instance_shape

  shape_config {
    ocpus         = var.single_instance_ocpus
    memory_in_gbs = var.single_instance_memory_in_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public_subnet.id
    display_name     = "${var.app_name}-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-single-instance.tftpl", {
      git_repo_url = var.git_repo_url
      git_branch   = var.git_branch
    }))
  }
}

# ==============================================================================
# MODE 2: MULTI-HOST DISTRIBUTED CLUSTER DEPLOYMENT
# ==============================================================================

# --- Redis Instance ---

resource "oci_core_instance" "redis" {
  count               = var.single_instance_mode ? 0 : 1
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad
  display_name        = "${var.app_name}-redis"
  shape               = var.redis_shape

  shape_config {
    ocpus         = var.redis_ocpus
    memory_in_gbs = var.redis_memory_in_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public_subnet.id
    display_name     = "${var.app_name}-redis-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-redis.tftpl", {
      git_repo_url = var.git_repo_url
      git_branch   = var.git_branch
    }))
  }
}

# --- Python Worker Instances ---

resource "oci_core_instance" "workers" {
  count               = var.single_instance_mode ? 0 : var.worker_count
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad
  display_name        = "${var.app_name}-worker-${count.index + 1}"
  shape               = var.worker_shape

  shape_config {
    ocpus         = var.worker_ocpus
    memory_in_gbs = var.worker_memory_in_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public_subnet.id
    display_name     = "${var.app_name}-worker-${count.index + 1}-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-worker.tftpl", {
      redis_ip                = oci_core_instance.redis[0].private_ip
      git_repo_url            = var.git_repo_url
      git_branch              = var.git_branch
      workers_per_host        = var.workers_per_host
      trace_enabled           = var.trace_enabled
      grpc_send_queue_maxsize = var.grpc_send_queue_maxsize
    }))
  }

  depends_on = [oci_core_instance.redis]
}

# --- Go Gateway Instances ---

resource "oci_core_instance" "gateways" {
  count               = var.single_instance_mode ? 0 : var.gateway_count
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad
  display_name        = "${var.app_name}-gateway-${count.index + 1}"
  shape               = var.gateway_shape

  shape_config {
    ocpus         = var.gateway_ocpus
    memory_in_gbs = var.gateway_memory_in_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public_subnet.id
    display_name     = "${var.app_name}-gateway-${count.index + 1}-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-gateway.tftpl", {
      gateway_id              = "gateway-${count.index + 1}"
      redis_ip                = oci_core_instance.redis[0].private_ip
      git_repo_url            = var.git_repo_url
      git_branch              = var.git_branch
      gateways_per_host       = var.gateways_per_host
      trace_enabled           = var.trace_enabled
      grpc_stream_buffer_size = var.grpc_stream_buffer_size
    }))
  }

  depends_on = [oci_core_instance.redis]
}

# --- Nginx Load Balancer Instance ---

resource "oci_core_instance" "lb" {
  count               = var.single_instance_mode ? 0 : 1
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad
  display_name        = "${var.app_name}-lb"
  shape               = var.lb_shape

  shape_config {
    ocpus         = var.lb_ocpus
    memory_in_gbs = var.lb_memory_in_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public_subnet.id
    display_name     = "${var.app_name}-lb-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-lb.tftpl", {
      git_repo_url  = var.git_repo_url
      git_branch    = var.git_branch
      gateway_ips   = oci_core_instance.gateways[*].private_ip
      gateway_ports = [for i in range(var.gateways_per_host) : 9000 + i * 2]
      worker_ips    = oci_core_instance.workers[*].private_ip
      worker_ports  = [for i in range(var.workers_per_host) : 8000 + i]
      nginx_config = templatefile("${path.module}/templates/nginx.conf.tftpl", {
        gateway_ips   = oci_core_instance.gateways[*].private_ip
        gateway_ports = [for i in range(var.gateways_per_host) : 9000 + i * 2]
        coord_ports   = [for i in range(var.gateways_per_host) : 9100 + i * 2]
      })
    }))
  }

  depends_on = [oci_core_instance.gateways, oci_core_instance.workers]
}

# --- In-VCN k6 Load Generator Instance ---

resource "oci_core_instance" "load_generator" {
  count               = (!var.single_instance_mode && var.enable_load_generator) ? var.load_generator_count : 0
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad
  display_name        = var.load_generator_count > 1 ? "${var.app_name}-k6-${count.index + 1}" : "${var.app_name}-k6"
  shape               = var.load_generator_shape

  shape_config {
    ocpus         = var.load_generator_ocpus
    memory_in_gbs = var.load_generator_memory_in_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public_subnet.id
    display_name     = "${var.app_name}-k6-${count.index + 1}-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-k6.tftpl", {
      git_repo_url  = var.git_repo_url
      git_branch    = var.git_branch
      runner_id     = count.index + 1
      runner_count  = var.load_generator_count
      lb_private_ip = oci_core_instance.lb[0].private_ip
      coord_host    = oci_core_instance.gateways[0].private_ip
      coord_hosts   = join(",", oci_core_instance.gateways[*].private_ip)
      coord_urls = join(",", flatten([
        for ip in oci_core_instance.gateways[*].private_ip : [
          for i in range(var.gateways_per_host) : "${ip}:${9100 + i * 2}"
        ]
      ]))
      gateway_health_urls = join(",", flatten([
        for ip in oci_core_instance.gateways[*].private_ip : [
          for i in range(var.gateways_per_host) : "http://${ip}:${9000 + i * 2}/health"
        ]
      ]))
      cluster_nodes = join(",", flatten([
        ["lb:${oci_core_instance.lb[0].private_ip}:9101"],
        ["redis:${oci_core_instance.redis[0].private_ip}:9101"],
        [for idx, ip in oci_core_instance.gateways[*].private_ip : "gateway-${idx + 1}:${ip}:9101"],
        [for idx, ip in oci_core_instance.workers[*].private_ip : "worker-${idx + 1}:${ip}:9101"],
      ]))
    }))
  }

  depends_on = [
    oci_core_instance.lb,
    oci_core_instance.workers,
    oci_core_instance.gateways,
    oci_core_instance.redis
  ]
}
