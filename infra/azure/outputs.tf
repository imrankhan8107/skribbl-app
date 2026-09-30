output "cluster_access" {
  description = "Cluster connection info and test instructions"
  value = {
    deployment_mode   = var.single_instance_mode ? "single_instance" : "multi_host distributed cluster"
    server_public_ip  = var.single_instance_mode ? (length(azurerm_public_ip.single) > 0 ? azurerm_public_ip.single[0].ip_address : null) : (length(azurerm_public_ip.lb) > 0 ? azurerm_public_ip.lb[0].ip_address : null)
    app_url           = "http://${var.single_instance_mode ? (length(azurerm_public_ip.single) > 0 ? azurerm_public_ip.single[0].ip_address : "") : (length(azurerm_public_ip.lb) > 0 ? azurerm_public_ip.lb[0].ip_address : "")}"
    app_url_alt_port  = "http://${var.single_instance_mode ? (length(azurerm_public_ip.single) > 0 ? azurerm_public_ip.single[0].ip_address : "") : (length(azurerm_public_ip.lb) > 0 ? azurerm_public_ip.lb[0].ip_address : "")}:9000"
    grafana_url       = var.single_instance_mode ? "N/A" : (length(azurerm_public_ip.lb) > 0 ? "http://${azurerm_public_ip.lb[0].ip_address}:3000" : "N/A")
    prometheus_url    = var.single_instance_mode ? "N/A" : (length(azurerm_public_ip.lb) > 0 ? "http://${azurerm_public_ip.lb[0].ip_address}:9090" : "N/A")
    load_generator_ip = (!var.single_instance_mode && length(azurerm_public_ip.load_generator) > 0) ? azurerm_public_ip.load_generator[0].ip_address : "N/A"
  }
}

output "node_ssh" {
  description = "SSH connection strings for all provisioned node(s)"
  value = var.single_instance_mode ? (
    length(azurerm_public_ip.single) > 0 ? {
      server = "ssh ubuntu@${azurerm_public_ip.single[0].ip_address}"
    } : {}
  ) : merge(
    length(azurerm_public_ip.lb) > 0 ? { lb = "ssh ubuntu@${azurerm_public_ip.lb[0].ip_address}" } : {},
    length(azurerm_public_ip.redis) > 0 ? { redis = "ssh ubuntu@${azurerm_public_ip.redis[0].ip_address}" } : {},
    { for idx, pip in azurerm_public_ip.gateways : "gateway-${idx + 1}" => "ssh ubuntu@${pip.ip_address}" },
    { for idx, pip in azurerm_public_ip.workers : "worker-${idx + 1}" => "ssh ubuntu@${pip.ip_address}" },
    { for idx, pip in azurerm_public_ip.load_generator : "load-gen-${idx + 1}" => "ssh ubuntu@${pip.ip_address}" }
  )
}

output "internal_topology" {
  description = "Private IP layout within Azure VNet"
  value = {
    server_private_ip          = length(azurerm_network_interface.single) > 0 ? azurerm_network_interface.single[0].private_ip_address : null
    lb_private_ip              = length(azurerm_network_interface.lb) > 0 ? azurerm_network_interface.lb[0].private_ip_address : null
    redis_private_ip           = length(azurerm_network_interface.redis) > 0 ? azurerm_network_interface.redis[0].private_ip_address : null
    gateway_private_ips        = azurerm_network_interface.gateways[*].private_ip_address
    worker_private_ips         = azurerm_network_interface.workers[*].private_ip_address
    load_generator_private_ips = azurerm_network_interface.load_generator[*].private_ip_address
  }
}
