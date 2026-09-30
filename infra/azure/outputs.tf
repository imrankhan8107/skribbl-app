output "cluster_access" {
  description = "Cluster connection info and test instructions"
  value = {
    lb_public_ip        = azurerm_public_ip.lb.ip_address
    app_url             = "http://${azurerm_public_ip.lb.ip_address}"
    grafana_url         = "http://${azurerm_public_ip.lb.ip_address}:3000"
    prometheus_url      = "http://${azurerm_public_ip.lb.ip_address}:9090"
    load_generator_ip   = length(azurerm_public_ip.load_generator) > 0 ? azurerm_public_ip.load_generator[0].ip_address : "N/A"
    load_test_command   = length(azurerm_public_ip.load_generator) > 0 ? "ssh ubuntu@${azurerm_public_ip.load_generator[0].ip_address} './run-test.sh 1000 5 20 30'" : "N/A"
    distributed_runners = [for idx, pip in azurerm_public_ip.load_generator : "ssh ubuntu@${pip.ip_address} './run-test.sh <VUS_PER_RUNNER> 5 20 60 2400 <VU_OFFSET>'"]
  }
}

output "node_ssh" {
  description = "SSH connection strings for all cluster nodes"
  value = merge(
    {
      lb    = "ssh ubuntu@${azurerm_public_ip.lb.ip_address}"
      redis = "ssh ubuntu@${azurerm_public_ip.redis.ip_address}"
    },
    { for idx, pip in azurerm_public_ip.gateways : "gateway-${idx + 1}" => "ssh ubuntu@${pip.ip_address}" },
    { for idx, pip in azurerm_public_ip.workers : "worker-${idx + 1}" => "ssh ubuntu@${pip.ip_address}" },
    { for idx, pip in azurerm_public_ip.load_generator : "load-gen-${idx + 1}" => "ssh ubuntu@${pip.ip_address}" }
  )
}

output "internal_topology" {
  description = "Private IP layout within Azure VNet"
  value = {
    lb_private_ip       = azurerm_network_interface.lb.private_ip_address
    redis_private_ip    = azurerm_network_interface.redis.private_ip_address
    gateway_private_ips = azurerm_network_interface.gateways[*].private_ip_address
    worker_private_ips  = azurerm_network_interface.workers[*].private_ip_address
    load_generator_private_ips = azurerm_network_interface.load_generator[*].private_ip_address
  }
}
