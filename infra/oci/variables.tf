variable "tenancy_ocid" {
  description = "OCID of the OCI tenancy"
  type        = string
}

variable "user_ocid" {
  description = "OCID of the OCI user"
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the API signing key"
  type        = string
}

variable "private_key_path" {
  description = "Path to the OCI API private key file"
  type        = string
}

variable "region" {
  description = "OCI region (e.g. us-ashburn-1, ap-mumbai-1)"
  type        = string
  default     = "ap-mumbai-1"
}

variable "compartment_ocid" {
  description = "OCID of the compartment to deploy into"
  type        = string
}

variable "app_name" {
  description = "Base name for all resources"
  type        = string
  default     = "skribbl"
}

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
}

variable "instance_shape" {
  description = "Compute instance shape (VM.Standard.A1.Flex is Always Free)"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "Number of OCPUs (up to 4 free for A1.Flex)"
  type        = number
  default     = 1
}

variable "instance_memory_gb" {
  description = "Memory in GB (up to 24 free for A1.Flex)"
  type        = number
  default     = 6
}

variable "git_repo_url" {
  description = "Git repository URL to clone on the instance"
  type        = string
  default     = "https://github.com/imrankhan8107/skribbl-app.git"
}

variable "git_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "feature/redis-scaling"
}
