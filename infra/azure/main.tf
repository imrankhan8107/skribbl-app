terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
  }
  required_version = ">= 1.5.0"
}

provider "azurerm" {
  features {}
}

# --- Locals ---
locals {
  effective_allowed_cidrs = distinct(compact(concat(
    var.allowed_cidrs,
    var.allowed_cidr != "" ? [var.allowed_cidr] : []
  )))
  # If empty, safely fall back to loopback CIDR so NSG rule syntax remains valid
  safe_allowed_cidrs = length(local.effective_allowed_cidrs) > 0 ? local.effective_allowed_cidrs : ["127.0.0.1/32"]
  web_allowed_cidrs  = var.is_private ? local.safe_allowed_cidrs : ["*"]
}

# --- Resource Group & Networking ---

resource "azurerm_resource_group" "rg" {
  name     = "${var.app_name}-rg"
  location = var.azure_location

  tags = {
    Environment = "production"
    Application = var.app_name
  }
}

resource "azurerm_virtual_network" "vnet" {
  name                = "${var.app_name}-vnet"
  address_space       = [var.vnet_cidr]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  tags = {
    Application = var.app_name
  }
}

resource "azurerm_subnet" "subnet" {
  name                 = "${var.app_name}-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_cidr]
}

# --- Network Security Group (NSG) ---
# Strict firewall: internal communication within VirtualNetwork only;
# all external ingress (SSH, HTTP, gateway, coord, logs, monitoring) strictly restricted to allowed CIDRs.

resource "azurerm_network_security_group" "nsg" {
  name                = "${var.app_name}-nsg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  # 1. Internal inter-instance communication (VNet-only)
  security_rule {
    name                       = "allow-internal-vnet"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "VirtualNetwork"
  }

  # 2. SSH restricted strictly to allowed_cidrs
  security_rule {
    name                        = "allow-ssh"
    priority                    = 110
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "22"
    source_address_prefixes     = local.safe_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 3. HTTP port 80
  security_rule {
    name                        = "allow-http"
    priority                    = 120
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "80"
    source_address_prefixes     = local.web_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 4. HTTPS port 443
  security_rule {
    name                        = "allow-https"
    priority                    = 130
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "443"
    source_address_prefixes     = local.web_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 5. Direct Go Gateway data plane (9000-9020)
  security_rule {
    name                        = "allow-gateway-data"
    priority                    = 140
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "9000-9020"
    source_address_prefixes     = local.web_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 6. Gateway Coord control plane (9100-9120)
  security_rule {
    name                        = "allow-gateway-coord"
    priority                    = 150
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "9100-9120"
    source_address_prefixes     = local.safe_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 7. Log server (8080)
  security_rule {
    name                        = "allow-log-server"
    priority                    = 160
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "8080"
    source_address_prefixes     = local.safe_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 8. Grafana dashboard (3000)
  security_rule {
    name                        = "allow-grafana"
    priority                    = 170
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "3000"
    source_address_prefixes     = local.safe_allowed_cidrs
    destination_address_prefix  = "*"
  }

  # 9. Prometheus UI (9090)
  security_rule {
    name                        = "allow-prometheus"
    priority                    = 180
    direction                   = "Inbound"
    access                      = "Allow"
    protocol                    = "Tcp"
    source_port_range           = "*"
    destination_port_range      = "9090"
    source_address_prefixes     = local.safe_allowed_cidrs
    destination_address_prefix  = "*"
  }

  tags = {
    Application = var.app_name
  }
}

resource "azurerm_subnet_network_security_group_association" "subnet_assoc" {
  subnet_id                 = azurerm_subnet.subnet.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

# ==============================================================================
# MODE 1: SINGLE INSTANCE DEPLOYMENT
# ==============================================================================

resource "azurerm_public_ip" "single" {
  count               = var.single_instance_mode ? 1 : 0
  name                = "${var.app_name}-server-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "single" {
  count               = var.single_instance_mode ? 1 : 0
  name                = "${var.app_name}-server-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.single[0].id
  }
}

resource "azurerm_linux_virtual_machine" "single" {
  count               = var.single_instance_mode ? 1 : 0
  name                = "${var.app_name}-server"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = var.single_instance_vm_size
  admin_username      = "ubuntu"

  network_interface_ids = [azurerm_network_interface.single[0].id]

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init-single-instance.tftpl", {
    git_repo_url = var.git_repo_url
    git_branch   = var.git_branch
  }))

  tags = {
    Application = var.app_name
    Tier        = "single-instance"
  }
}

# ==============================================================================
# MODE 2: MULTI-HOST DISTRIBUTED CLUSTER DEPLOYMENT
# ==============================================================================

# --- Redis Instance ---

resource "azurerm_public_ip" "redis" {
  count               = var.single_instance_mode ? 0 : 1
  name                = "${var.app_name}-redis-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "redis" {
  count               = var.single_instance_mode ? 0 : 1
  name                = "${var.app_name}-redis-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = length(azurerm_public_ip.redis) > 0 ? azurerm_public_ip.redis[0].id : null
  }
}

resource "azurerm_linux_virtual_machine" "redis" {
  count               = var.single_instance_mode ? 0 : 1
  name                = "${var.app_name}-redis"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = var.redis_vm_size
  admin_username      = "ubuntu"

  network_interface_ids = [azurerm_network_interface.redis[0].id]

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init-redis.tftpl", {
    git_repo_url = var.git_repo_url
    git_branch   = var.git_branch
  }))

  tags = {
    Application = var.app_name
    Tier        = "redis"
  }
}

# --- Python Worker Instances ---

resource "azurerm_public_ip" "workers" {
  count               = var.single_instance_mode ? 0 : var.worker_count
  name                = "${var.app_name}-worker-${count.index + 1}-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "workers" {
  count               = var.single_instance_mode ? 0 : var.worker_count
  name                = "${var.app_name}-worker-${count.index + 1}-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.workers[count.index].id
  }
}

resource "azurerm_linux_virtual_machine" "workers" {
  count               = var.single_instance_mode ? 0 : var.worker_count
  name                = "${var.app_name}-worker-${count.index + 1}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = var.worker_vm_size
  admin_username      = "ubuntu"

  network_interface_ids = [azurerm_network_interface.workers[count.index].id]

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 40
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init-worker.tftpl", {
    redis_ip                = length(azurerm_network_interface.redis) > 0 ? azurerm_network_interface.redis[0].private_ip_address : ""
    git_repo_url            = var.git_repo_url
    git_branch              = var.git_branch
    workers_per_host        = var.workers_per_host
    trace_enabled           = var.trace_enabled
    grpc_send_queue_maxsize = var.grpc_send_queue_maxsize
  }))

  depends_on = [azurerm_linux_virtual_machine.redis]

  tags = {
    Application = var.app_name
    Tier        = "worker"
  }
}

# --- Go Gateway Instances ---

resource "azurerm_public_ip" "gateways" {
  count               = var.single_instance_mode ? 0 : var.gateway_count
  name                = "${var.app_name}-gateway-${count.index + 1}-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "gateways" {
  count               = var.single_instance_mode ? 0 : var.gateway_count
  name                = "${var.app_name}-gateway-${count.index + 1}-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.gateways[count.index].id
  }
}

resource "azurerm_linux_virtual_machine" "gateways" {
  count               = var.single_instance_mode ? 0 : var.gateway_count
  name                = "${var.app_name}-gateway-${count.index + 1}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = var.gateway_vm_size
  admin_username      = "ubuntu"

  network_interface_ids = [azurerm_network_interface.gateways[count.index].id]

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 40
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init-gateway.tftpl", {
    gateway_id              = "gateway-${count.index + 1}"
    redis_ip                = length(azurerm_network_interface.redis) > 0 ? azurerm_network_interface.redis[0].private_ip_address : ""
    git_repo_url            = var.git_repo_url
    git_branch              = var.git_branch
    gateways_per_host       = var.gateways_per_host
    trace_enabled           = var.trace_enabled
    grpc_stream_buffer_size = var.grpc_stream_buffer_size
  }))

  depends_on = [azurerm_linux_virtual_machine.redis]

  tags = {
    Application = var.app_name
    Tier        = "gateway"
  }
}

# --- Nginx Load Balancer Instance ---

resource "azurerm_public_ip" "lb" {
  count               = var.single_instance_mode ? 0 : 1
  name                = "${var.app_name}-lb-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "lb" {
  count               = var.single_instance_mode ? 0 : 1
  name                = "${var.app_name}-lb-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = length(azurerm_public_ip.lb) > 0 ? azurerm_public_ip.lb[0].id : null
  }
}

resource "azurerm_linux_virtual_machine" "lb" {
  count               = var.single_instance_mode ? 0 : 1
  name                = "${var.app_name}-lb"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = var.lb_vm_size
  admin_username      = "ubuntu"

  network_interface_ids = [azurerm_network_interface.lb[0].id]

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init-lb.tftpl", {
    git_repo_url  = var.git_repo_url
    git_branch    = var.git_branch
    gateway_ips   = azurerm_network_interface.gateways[*].private_ip_address
    gateway_ports = [for i in range(var.gateways_per_host) : 9000 + i * 2]
    worker_ips    = azurerm_network_interface.workers[*].private_ip_address
    worker_ports  = [for i in range(var.workers_per_host) : 8000 + i]
    nginx_config = templatefile("${path.module}/templates/nginx.conf.tftpl", {
      gateway_ips   = azurerm_network_interface.gateways[*].private_ip_address
      gateway_ports = [for i in range(var.gateways_per_host) : 9000 + i * 2]
      coord_ports   = [for i in range(var.gateways_per_host) : 9100 + i * 2]
    })
  }))

  depends_on = [azurerm_linux_virtual_machine.gateways, azurerm_linux_virtual_machine.workers]

  tags = {
    Application = var.app_name
    Tier        = "load-balancer"
  }
}

# --- In-VNet k6 Load Generator Instance ---

resource "azurerm_public_ip" "load_generator" {
  count               = (!var.single_instance_mode && var.enable_load_generator) ? var.load_generator_count : 0
  name                = "${var.app_name}-k6-${count.index + 1}-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "load_generator" {
  count               = (!var.single_instance_mode && var.enable_load_generator) ? var.load_generator_count : 0
  name                = "${var.app_name}-k6-${count.index + 1}-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.load_generator[count.index].id
  }
}

resource "azurerm_linux_virtual_machine" "load_generator" {
  count               = (!var.single_instance_mode && var.enable_load_generator) ? var.load_generator_count : 0
  name                = var.load_generator_count > 1 ? "${var.app_name}-k6-${count.index + 1}" : "${var.app_name}-k6"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = var.load_generator_vm_size
  admin_username      = "ubuntu"

  network_interface_ids = [azurerm_network_interface.load_generator[count.index].id]

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 60
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init-k6.tftpl", {
    git_repo_url  = var.git_repo_url
    git_branch    = var.git_branch
    runner_id     = count.index + 1
    runner_count  = var.load_generator_count
    lb_private_ip = length(azurerm_network_interface.lb) > 0 ? azurerm_network_interface.lb[0].private_ip_address : ""
    coord_host    = length(azurerm_network_interface.gateways) > 0 ? azurerm_network_interface.gateways[0].private_ip_address : ""
    coord_hosts   = join(",", azurerm_network_interface.gateways[*].private_ip_address)
    coord_urls = join(",", flatten([
      for ip in azurerm_network_interface.gateways[*].private_ip_address : [
        for i in range(var.gateways_per_host) : "${ip}:${9100 + i * 2}"
      ]
    ]))
    gateway_health_urls = join(",", flatten([
      for ip in azurerm_network_interface.gateways[*].private_ip_address : [
        for i in range(var.gateways_per_host) : "http://${ip}:${9000 + i * 2}/health"
      ]
    ]))
    cluster_nodes = join(",", flatten([
      length(azurerm_network_interface.lb) > 0 ? ["lb:${azurerm_network_interface.lb[0].private_ip_address}:9101"] : [],
      length(azurerm_network_interface.redis) > 0 ? ["redis:${azurerm_network_interface.redis[0].private_ip_address}:9101"] : [],
      [for idx, ip in azurerm_network_interface.gateways[*].private_ip_address : "gateway-${idx + 1}:${ip}:9101"],
      [for idx, ip in azurerm_network_interface.workers[*].private_ip_address : "worker-${idx + 1}:${ip}:9101"],
    ]))
  }))

  depends_on = [
    azurerm_linux_virtual_machine.lb,
    azurerm_linux_virtual_machine.workers,
    azurerm_linux_virtual_machine.gateways,
    azurerm_linux_virtual_machine.redis
  ]

  tags = {
    Application = var.app_name
    Tier        = "load-generator"
  }
}
