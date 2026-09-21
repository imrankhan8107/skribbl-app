terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5.0"
}

provider "aws" {
  region = var.aws_region
}

# --- Networking ---

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.app_name}-vpc"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.app_name}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  map_public_ip_on_launch = true
  availability_zone       = "${var.aws_region}a"

  tags = {
    Name = "${var.app_name}-public-subnet"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "${var.app_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# --- Security Group ---
# Strict firewall: all inter-instance traffic within the same security group only;
# all external ingress (SSH, HTTP, gateway, coord) strictly restricted to var.allowed_cidr (your IP).
resource "aws_security_group" "cluster" {
  name        = "${var.app_name}-cluster-sg"
  description = "Security group for Skribbl cluster: internal traffic self-only, external strictly to allowed IP"
  vpc_id      = aws_vpc.main.id

  # 1. Internal inter-instance communication (self-only)
  ingress {
    description = "Internal communication between LB, Gateways, Workers, and Redis"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }

  # 2. SSH restricted strictly to allowed_cidr
  ingress {
    description = "SSH access strictly from allowed IP"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # 3. HTTP port 80 restricted strictly to allowed_cidr
  ingress {
    description = "HTTP access strictly from allowed IP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # 4. HTTPS port 443 restricted strictly to allowed_cidr
  ingress {
    description = "HTTPS access strictly from allowed IP"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # 5. Direct Go Gateway data plane (9000-9020) strictly from allowed_cidr
  ingress {
    description = "Direct Gateway data plane access strictly from allowed IP"
    from_port   = 9000
    to_port     = 9020
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # Gateway Coord control plane (9100-9120) strictly from allowed_cidr (for k6 load tests)
  ingress {
    description = "Gateway coord control plane strictly from allowed IP"
    from_port   = 9100
    to_port     = 9120
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # Log server (8080) strictly from allowed_cidr
  ingress {
    description = "Log server strictly from allowed IP"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # Outbound egress for package installations, docker hub, git
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.app_name}-cluster-sg"
  }
}

# --- AMI & SSH Key ---

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "deployer" {
  key_name   = "${var.app_name}-key"
  public_key = var.ssh_public_key

  tags = {
    Name = "${var.app_name}-key"
  }
}

# --- Redis Instance ---

resource "aws_instance" "redis" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.redis_instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.cluster.id]
  key_name               = aws_key_pair.deployer.key_name

  user_data = templatefile("${path.module}/templates/cloud-init-redis.tftpl", {})

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = {
    Name = "${var.app_name}-redis"
    Tier = "redis"
  }
}

# --- Python Worker Instances ---

resource "aws_instance" "workers" {
  count                  = var.worker_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.worker_instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.cluster.id]
  key_name               = aws_key_pair.deployer.key_name

  user_data = templatefile("${path.module}/templates/cloud-init-worker.tftpl", {
    redis_ip         = aws_instance.redis.private_ip
    git_repo_url     = var.git_repo_url
    git_branch       = var.git_branch
    workers_per_host = var.workers_per_host
  })

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  depends_on = [aws_instance.redis]

  tags = {
    Name = "${var.app_name}-worker-${count.index + 1}"
    Tier = "worker"
  }
}

# --- Go Gateway Instances ---

resource "aws_instance" "gateways" {
  count                  = var.gateway_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.gateway_instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.cluster.id]
  key_name               = aws_key_pair.deployer.key_name

  user_data = templatefile("${path.module}/templates/cloud-init-gateway.tftpl", {
    gateway_id        = "gateway-${count.index + 1}"
    redis_ip          = aws_instance.redis.private_ip
    git_repo_url      = var.git_repo_url
    git_branch        = var.git_branch
    gateways_per_host = var.gateways_per_host
  })

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  depends_on = [aws_instance.redis]

  tags = {
    Name = "${var.app_name}-gateway-${count.index + 1}"
    Tier = "gateway"
  }
}

# --- Nginx Load Balancer Instance ---

resource "aws_instance" "lb" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.lb_instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.cluster.id]
  key_name               = aws_key_pair.deployer.key_name

  user_data = templatefile("${path.module}/templates/cloud-init-lb.tftpl", {
    nginx_config = templatefile("${path.module}/templates/nginx.conf.tftpl", {
      gateway_ips   = aws_instance.gateways[*].private_ip
      gateway_ports = [for i in range(var.gateways_per_host) : 9000 + i * 2]
    })
  })

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  depends_on = [aws_instance.gateways]

  tags = {
    Name = "${var.app_name}-lb"
    Tier = "load-balancer"
  }
}

# --- In-VPC k6 Load Generator Instance ---

resource "aws_instance" "load_generator" {
  count                  = var.enable_load_generator ? 1 : 0
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.load_generator_instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.cluster.id]
  key_name               = aws_key_pair.deployer.key_name

  user_data = templatefile("${path.module}/templates/cloud-init-k6.tftpl", {
    git_repo_url        = var.git_repo_url
    git_branch          = var.git_branch
    lb_private_ip       = aws_instance.lb.private_ip
    coord_host          = aws_instance.gateways[0].private_ip
    gateway_health_urls = join(",", [for ip in aws_instance.gateways[*].private_ip : "http://${ip}:9000/health"])
  })

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  depends_on = [aws_instance.lb]

  tags = {
    Name = "${var.app_name}-k6-runner"
    Tier = "load-generator"
  }
}

