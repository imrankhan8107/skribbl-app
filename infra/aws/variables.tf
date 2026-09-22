variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Base name for resources"
  type        = string
  default     = "skribbl"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.10.0.0/16"
}

variable "allowed_cidr" {
  description = "Your public IP/CIDR allowed to access the cluster externally (e.g. '203.0.113.50/32'). STRICT: No 0.0.0.0/0 external ingress is permitted."
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key for EC2 instance access"
  type        = string
}

variable "gateway_count" {
  description = "Number of dedicated Go Gateway EC2 instances"
  type        = number
  default     = 2
}

variable "gateways_per_host" {
  description = "Number of Go Gateway Docker containers to run per gateway EC2 instance"
  type        = number
  default     = 1
}

variable "worker_count" {
  description = "Number of dedicated Python Worker EC2 instances"
  type        = number
  default     = 2
}

variable "workers_per_host" {
  description = "Number of Python worker Docker containers to run per worker EC2 instance"
  type        = number
  default     = 2
}

variable "lb_instance_type" {
  description = "EC2 instance type for Nginx Load Balancer"
  type        = string
  default     = "t3.medium"
}

variable "gateway_instance_type" {
  description = "EC2 instance type for Go Gateways (e.g. c5a.xlarge for benchmarks, t3.medium for dev)"
  type        = string
  default     = "t3.medium"
}

variable "worker_instance_type" {
  description = "EC2 instance type for Python Workers (e.g. c5a.xlarge for benchmarks, t3.medium for dev)"
  type        = string
  default     = "t3.medium"
}

variable "redis_instance_type" {
  description = "EC2 instance type for standalone Redis"
  type        = string
  default     = "t3.medium"
}

variable "git_repo_url" {
  description = "Git repository URL for deployment"
  type        = string
  default     = "https://github.com/imrankhan8107/skribbl-app.git"
}

variable "git_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "feature/go-gateway"
}

variable "enable_load_generator" {
  description = "Whether to provision dedicated EC2 instances for running k6 load tests in-VPC"
  type        = bool
  default     = true
}

variable "load_generator_count" {
  description = "Number of dedicated in-VPC k6 load generator instances (e.g. 1 for <=50k, 2 for 75k-100k distributed tests)"
  type        = number
  default     = 1
}

variable "load_generator_instance_type" {
  description = "EC2 instance type for k6 load generator (e.g. c5a.xlarge for 10k-15k tests, c5a.8xlarge for 50k+)"
  type        = string
  default     = "t3.medium"
}

variable "trace_enabled" {
  description = "Enable verbose per-message trace logging (set false for high-scale benchmarks to avoid log lock contention)"
  type        = bool
  default     = false
}

variable "grpc_send_queue_maxsize" {
  description = "Worker outbound gRPC stream send queue buffer size (prevents memory explosion at high stroke rates)"
  type        = number
  default     = 1024
}



