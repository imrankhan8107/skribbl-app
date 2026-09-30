output "cluster_access" {
  description = "Cluster connection info and test instructions"
  value = {
    deployment_mode   = var.single_instance_mode ? "single_instance (Always Free)" : "multi_host distributed cluster"
    server_public_ip  = var.single_instance_mode ? (length(oci_core_instance.single) > 0 ? oci_core_instance.single[0].public_ip : null) : (length(oci_core_instance.lb) > 0 ? oci_core_instance.lb[0].public_ip : null)
    app_url           = "http://${var.single_instance_mode ? (length(oci_core_instance.single) > 0 ? oci_core_instance.single[0].public_ip : "") : (length(oci_core_instance.lb) > 0 ? oci_core_instance.lb[0].public_ip : "")}"
    app_url_alt_port  = "http://${var.single_instance_mode ? (length(oci_core_instance.single) > 0 ? oci_core_instance.single[0].public_ip : "") : (length(oci_core_instance.lb) > 0 ? oci_core_instance.lb[0].public_ip : "")}:9000"
    grafana_url       = var.single_instance_mode ? "N/A" : (length(oci_core_instance.lb) > 0 ? "http://${oci_core_instance.lb[0].public_ip}:3000" : "N/A")
    prometheus_url    = var.single_instance_mode ? "N/A" : (length(oci_core_instance.lb) > 0 ? "http://${oci_core_instance.lb[0].public_ip}:9090" : "N/A")
    load_generator_ip = (!var.single_instance_mode && length(oci_core_instance.load_generator) > 0) ? oci_core_instance.load_generator[0].public_ip : "N/A"
  }
}

output "node_ssh" {
  description = "SSH connection strings for all provisioned node(s)"
  value = var.single_instance_mode ? (
    length(oci_core_instance.single) > 0 ? {
      server = "ssh ubuntu@${oci_core_instance.single[0].public_ip}"
    } : {}
  ) : merge(
    length(oci_core_instance.lb) > 0 ? { lb = "ssh ubuntu@${oci_core_instance.lb[0].public_ip}" } : {},
    length(oci_core_instance.redis) > 0 ? { redis = "ssh ubuntu@${oci_core_instance.redis[0].public_ip}" } : {},
    { for idx, inst in oci_core_instance.gateways : "gateway-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    { for idx, inst in oci_core_instance.workers : "worker-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    { for idx, inst in oci_core_instance.load_generator : "load-gen-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" }
  )
}

output "internal_topology" {
  description = "Private IP layout within OCI VCN"
  value = {
    server_private_ip          = length(oci_core_instance.single) > 0 ? oci_core_instance.single[0].private_ip : null
    lb_private_ip              = length(oci_core_instance.lb) > 0 ? oci_core_instance.lb[0].private_ip : null
    redis_private_ip           = length(oci_core_instance.redis) > 0 ? oci_core_instance.redis[0].private_ip : null
    gateway_private_ips        = oci_core_instance.gateways[*].private_ip
    worker_private_ips         = oci_core_instance.workers[*].private_ip
    load_generator_private_ips = oci_core_instance.load_generator[*].private_ip
  }
}
