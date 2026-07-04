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

# Variables
variable "location" {
  default     = "eastus"
  description = "Azure region for all resources"
}

variable "app_name" {
  default     = "skribbl"
  description = "Base name for resources"
}

variable "image_tag" {
  default     = "latest"
  description = "Docker image tag to deploy"
}

# Resource Group
resource "azurerm_resource_group" "rg" {
  name     = "${var.app_name}-rg"
  location = var.location
}

# Container Registry
resource "azurerm_container_registry" "acr" {
  name                = "${var.app_name}acr"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku                 = "Basic"
  admin_enabled       = true
}

# Log Analytics Workspace (required for Container Apps)
resource "azurerm_log_analytics_workspace" "logs" {
  name                = "${var.app_name}-logs"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# Container Apps Environment
resource "azurerm_container_app_environment" "env" {
  name                       = "${var.app_name}-env"
  resource_group_name        = azurerm_resource_group.rg.name
  location                   = azurerm_resource_group.rg.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id
}

# Container App
resource "azurerm_container_app" "app" {
  name                         = "${var.app_name}-app"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.acr.login_server
    username             = azurerm_container_registry.acr.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.acr.admin_password
  }

  template {
    # Single replica — game state is in-memory
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "skribbl-app"
      image  = "${azurerm_container_registry.acr.login_server}/${var.app_name}-app:${var.image_tag}"
      cpu    = 1.0
      memory = "2Gi"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8000
    transport        = "http"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}

# Outputs
output "app_url" {
  value       = "https://${azurerm_container_app.app.ingress[0].fqdn}"
  description = "Public URL of the deployed app"
}

output "acr_login_server" {
  value       = azurerm_container_registry.acr.login_server
  description = "ACR login server for pushing Docker images"
}

output "acr_admin_username" {
  value       = azurerm_container_registry.acr.admin_username
  description = "ACR admin username"
  sensitive   = true
}

output "acr_admin_password" {
  value       = azurerm_container_registry.acr.admin_password
  description = "ACR admin password"
  sensitive   = true
}
