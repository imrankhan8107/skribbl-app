variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
}

variable "user_ocid" {
  description = "OCI user OCID"
  type        = string
}

variable "fingerprint" {
  description = "OCI API key fingerprint"
  type        = string
}

variable "private_key_path" {
  description = "Path to OCI API private key"
  type        = string
}

variable "region" {
  description = "OCI region"
  type        = string
  default     = "us-ashburn-1"
}

variable "compartment_ocid" {
  description = "OCI compartment OCID"
  type        = string
}

variable "app_name" {
  description = "Base name for resources"
  type        = string
  default     = "skribbl"
}

variable "vcn_cidr" {
  description = "CIDR block for VCN"
  type        = string
  default     = "10.10.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for regional subnet"
  type        = string
  default     = "10.10.1.0/24"
}

variable "allowed_cidrs" {
  description = "List of public IP/CIDR blocks allowed to access the cluster externally. STRICT: No 0.0.0.0/0 external ingress is permitted."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for c in var.allowed_cidrs : c != "0.0.0.0/0"])
    error_message = "STRICT SECURITY: 0.0.0.0/0 is not allowed. Specify explicit /32 or subnet CIDRs."
  }
}

variable "allowed_cidr" {
  description = "Single public IP/CIDR allowed to access the cluster externally (e.g. '203.0.113.50/32'). Kept for backward compatibility; prefer allowed_cidrs."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "SSH public key for OCI instance access"
  type        = string
}

# --- Deployment Mode ---
variable "single_instance_mode" {
  description = "If true, provisions a single OCI compute instance (ideal for OCI Always Free Tier) running the full stack via Docker Compose. If false, provisions the multi-host distributed cluster."
  type        = bool
  default     = true
}

variable "single_instance_shape" {
  description = "Shape for single-instance mode (VM.Standard.A1.Flex for Always Free ARM, or VM.Standard.E4.Flex)"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "single_instance_ocpus" {
  description = "OCPUs for single-instance mode (up to 4 for Always Free A1.Flex)"
  type        = number
  default     = 4
}

variable "single_instance_memory_in_gbs" {
  description = "RAM in GB for single-instance mode (up to 24 for Always Free A1.Flex)"
  type        = number
  default     = 24
}

variable "single_instance_app_scale" {
  description = "Number of Python game worker container replicas to run in single-instance mode"
  type        = number
  default     = 4
}

# --- Multi-Host Cluster Sizing ---
  description = "Number of dedicated Go Gateway OCI compute instances"
  type        = number
  default     = 2
}

variable "gateways_per_host" {
  description = "Number of Go Gateway Docker containers to run per gateway instance"
  type        = number
  default     = 1
}

variable "worker_count" {
  description = "Number of dedicated Python Worker OCI compute instances"
  type        = number
  default     = 2
}

variable "workers_per_host" {
  description = "Number of Python worker Docker containers to run per worker instance"
  type        = number
  default     = 2
}

# --- Shapes & Sizing ---
# OCI shapes support flexible OCPU and memory allocations.
# Default shape: VM.Standard.E4.Flex (AMD) or VM.Standard.A1.Flex (Ampere ARM).

variable "lb_shape" {
  description = "OCI instance shape for Nginx Load Balancer"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "lb_ocpus" {
  description = "OCPUs for Nginx Load Balancer"
  type        = number
  default     = 2
}

variable "lb_memory_in_gbs" {
  description = "RAM in GB for Nginx Load Balancer"
  type        = number
  default     = 8
}

variable "gateway_shape" {
  description = "OCI instance shape for Go Gateways"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "gateway_ocpus" {
  description = "OCPUs for Go Gateways"
  type        = number
  default     = 4
}

variable "gateway_memory_in_gbs" {
  description = "RAM in GB for Go Gateways"
  type        = number
  default     = 16
}

variable "worker_shape" {
  description = "OCI instance shape for Python Workers"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "worker_ocpus" {
  description = "OCPUs for Python Workers"
  type        = number
  default     = 4
}

variable "worker_memory_in_gbs" {
  description = "RAM in GB for Python Workers"
  type        = number
  default     = 16
}

variable "redis_shape" {
  description = "OCI instance shape for Redis"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "redis_ocpus" {
  description = "OCPUs for Redis"
  type        = number
  default     = 2
}

variable "redis_memory_in_gbs" {
  description = "RAM in GB for Redis"
  type        = number
  default     = 8
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
  description = "Whether to provision dedicated OCI instances for running k6 load tests in-VCN"
  type        = bool
  default     = true
}

variable "load_generator_count" {
  description = "Number of dedicated in-VCN k6 load generator instances"
  type        = number
  default     = 1
}

variable "load_generator_shape" {
  description = "OCI instance shape for k6 load generator"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "load_generator_ocpus" {
  description = "OCPUs for k6 load generator"
  type        = number
  default     = 4
}

variable "load_generator_memory_in_gbs" {
  description = "RAM in GB for k6 load generator"
  type        = number
  default     = 16
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
