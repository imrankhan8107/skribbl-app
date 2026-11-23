# Azure Region (India regions: "centralindia" [Pune - recommended], "southindia" [Chennai], "westindia" [Mumbai])
# US regions: "eastus", "eastus2"
azure_location = "centralindia"

# Base name for all resources
app_name = "skribbl"

# Virtual Network CIDR
vnet_cidr   = "10.10.0.0/16"
subnet_cidr = "10.10.1.0/24"

# ACCESS & SECURITY
# Set is_private = true if you want ONLY your IP to access the web app.
# Set is_private = false (default) so ANYONE on the internet can access and play the game at http://<LB_PUBLIC_IP>.
# Administrative SSH (port 22) is ALWAYS strictly locked down to allowed_cidrs for security!
is_private = false

# Whitelist for administrative SSH access (port 22) (and web app if is_private = true)
allowed_cidrs = [
  "103.186.47.82/32"
]

# SSH Public Key for Azure Linux VMs
ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC5NN98lc9SHFxJVJOeFhv/lnviVzs6QbTDu1JXKVysTLyefkWZlzM1gjMpFWATVvL8L18LLonezSDsXZyoTbsr2H0X4jd1sDXQiB0PaprmnmsKFamN9SOn51UDkriyFUNVLXsQNw0ycLOIkd5c37KlO2lu5Gc8joDe4d8jqgREgeBdBzLAzoHbvxwjU4vqnPMQ/C3fDmMpxt0lWDMYsZ6Ea0RIUxicmEBMQS4Aza1bE4ShDQr+sLWH6v1ARo7313LPwF+jUWqxtSsMZBGpsTMa4giC18cxqe933iTKlog+uouuHG/igKEV3/j+gktEYUGZV6XXocKeIae2NLTElbyL8crwQmPwPmfe4ehXXOzQPu78e/5t1x46IDmreDeIE9yGw4JwVQKE+nOPRwC09jBe6eq2n9eEEv/b/QhQoE5fQ8AKJw6hGmfTnK0Iv80h3DSPfqMc3tM2XLFITgWWOUt6Gv8MXFOBzvaeFFOskK4SFz4ikwqqF1u5VEm2oURtG/FDOT9OYMCm3UU+lqJq8/iX6zvBEBN/Np8hm50IXJIfwmd9XW45ilf1TOyvPq8G+ti4N1skYkFGgnw8grRrp8rWsMcgjxnD3VwnZfJkWwFt7wI6OjbP/1EuYmFBVKOgHnyBmmNnaV3yMPM0NXUWzhA7JuoweMVwzJ6CWSi4y2GJdw== arbaz khan@LAPTOP-0E0LPOOP"

# ==============================================================================
# DEPLOYMENT MODE
# ==============================================================================
# Set true for single-machine deployment (1 Azure VM running unified container)
# Set false for multi-host distributed cluster (separate VMs for LB, Gateways, Workers, Redis)
single_instance_mode    = true
single_instance_vm_size = "Standard_D2s_v4"

# --- Multi-Host Cluster Sizing (Used when single_instance_mode = false) ---
gateway_count     = 3
gateways_per_host = 3
worker_count      = 5
workers_per_host  = 6
lb_count          = 2

# Azure VM sizing (Using Intel Xeon v4 's_v4' which has universal capacity and no regional restrictions)
# For dev/low-cost: Standard_B2s (2 vCPU, 4GB)
# For production/load testing: Standard_D4s_v4 (4 vCPU, 16GB) / Standard_D8s_v4 (8 vCPU, 32GB)
lb_vm_size             = "Standard_D4s_v4"
gateway_vm_size        = "Standard_D4s_v4"
worker_vm_size         = "Standard_D4s_v4"
redis_vm_size          = "Standard_D2s_v4"
load_generator_vm_size = "Standard_D8s_v4"

# Git repository configuration
git_repo_url = "https://github.com/imrankhan8107/skribbl-app.git"
git_branch   = "master"

# In-VNet k6 Load Generator
enable_load_generator = true
load_generator_count  = 0
# Performance tuning
trace_enabled           = false
grpc_stream_buffer_size = 4096
grpc_send_queue_maxsize = 1024
write_coalesce          = true
