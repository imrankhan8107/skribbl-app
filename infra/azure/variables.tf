variable "azure_location" {
  description = "Azure region for deployment"
  type        = string
  default     = "eastus"
}

variable "location" {
  description = "Alias for azure_location (for backward compatibility)"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Docker image tag (legacy)"
  type        = string
  default     = "latest"
}

variable "app_name" {
  description = "Base name for resources"
  type        = string
  default     = "skribbl"
}

variable "vnet_cidr" {
  description = "CIDR block for Virtual Network"
  type        = string
  default     = "10.10.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for subnet"
  type        = string
  default     = "10.10.1.0/24"
}

variable "is_private" {
  description = "If true, access to web/game ports (80, 443, 9000-9020) is strictly restricted to allowed_cidrs (your IP only). If false (default), anyone on the internet can access and play. SSH (22) is always restricted to allowed_cidrs."
  type        = bool
  default     = false
}

variable "allowed_cidrs" {
  description = "List of public IP/CIDR blocks allowed to access the cluster externally (e.g. for SSH access or restricted testing)."
  type        = list(string)
  default     = []
}

variable "allowed_cidr" {
  description = "Single public IP/CIDR allowed to access the cluster externally (e.g. '203.0.113.50/32'). Kept for backward compatibility; prefer allowed_cidrs."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "SSH public key for Azure VM instance access"
  type        = string
}

# --- Deployment Mode ---

variable "single_instance_mode" {
  description = "If true, deploys a single Azure VM running the unified container (React + FastAPI on port 80/9000). Zero Nginx, Go Gateway, or Redis overhead. If false, deploys multi-host distributed cluster."
  type        = bool
  default     = false
}

variable "single_instance_vm_size" {
  description = "Azure VM size for single-instance mode (e.g. Standard_B1s, Standard_B2s, Standard_D2as_v5)"
  type        = string
  default     = "Standard_B2s"
}

variable "gateway_count" {
  description = "Number of dedicated Go Gateway Azure VM instances"
  type        = number
  default     = 2
}

variable "gateways_per_host" {
  description = "Number of Go Gateway Docker containers to run per gateway VM instance"
  type        = number
  default     = 1
}

variable "worker_count" {
  description = "Number of dedicated Python Worker Azure VM instances"
  type        = number
  default     = 2
}

variable "workers_per_host" {
  description = "Number of Python worker Docker containers to run per worker VM instance"
  type        = number
  default     = 2
}

variable "lb_vm_size" {
  description = "Azure VM size for Nginx Load Balancer (e.g. Standard_D4as_v5 for benchmarks, Standard_B2s for dev)"
  type        = string
  default     = "Standard_D4as_v5"
}

variable "gateway_vm_size" {
  description = "Azure VM size for Go Gateways (e.g. Standard_D4as_v5 for benchmarks, Standard_B2s for dev)"
  type        = string
  default     = "Standard_D4as_v5"
}

variable "worker_vm_size" {
  description = "Azure VM size for Python Workers (e.g. Standard_D4as_v5 for benchmarks, Standard_B2s for dev)"
  type        = string
  default     = "Standard_D4as_v5"
}

variable "redis_vm_size" {
  description = "Azure VM size for standalone Redis"
  type        = string
  default     = "Standard_D2as_v5"
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
  description = "Whether to provision dedicated Azure VMs for running k6 load tests in-VNet"
  type        = bool
  default     = true
}

variable "load_generator_count" {
  description = "Number of dedicated in-VNet k6 load generator instances"
  type        = number
  default     = 1
}

variable "load_generator_vm_size" {
  description = "Azure VM size for k6 load generator"
  type        = string
  default     = "Standard_D4as_v5"
}

variable "trace_enabled" {
  description = "Enable verbose per-message trace logging (set false for high-scale benchmarks)"
  type        = bool
  default     = false
}

variable "grpc_stream_buffer_size" {
  description = "Gateway gRPC send queue size"
  type        = number
  default     = 1024
}

variable "grpc_send_queue_maxsize" {
  description = "Worker gRPC send queue max size"
  type        = number
  default     = 1024
}
