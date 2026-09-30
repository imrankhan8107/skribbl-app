output "cluster_access" {
  description = "Cluster connection info and test instructions"
  value = {
    lb_public_ip        = oci_core_instance.lb.public_ip
    app_url             = "http://${oci_core_instance.lb.public_ip}"
    grafana_url         = "http://${oci_core_instance.lb.public_ip}:3000"
    prometheus_url      = "http://${oci_core_instance.lb.public_ip}:9090"
    load_generator_ip   = length(oci_core_instance.load_generator) > 0 ? oci_core_instance.load_generator[0].public_ip : "N/A"
    load_test_command   = length(oci_core_instance.load_generator) > 0 ? "ssh ubuntu@${oci_core_instance.load_generator[0].public_ip} './run-test.sh 1000 5 20 30'" : "N/A"
    distributed_runners = [for idx, inst in oci_core_instance.load_generator : "ssh ubuntu@${inst.public_ip} './run-test.sh <VUS_PER_RUNNER> 5 20 60 2400 <VU_OFFSET>'"]
  }
}

output "node_ssh" {
  description = "SSH connection strings for all cluster nodes"
  value = merge(
    {
      lb    = "ssh ubuntu@${oci_core_instance.lb.public_ip}"
      redis = "ssh ubuntu@${oci_core_instance.redis.public_ip}"
    },
    { for idx, inst in oci_core_instance.gateways : "gateway-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    { for idx, inst in oci_core_instance.workers : "worker-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    { for idx, inst in oci_core_instance.load_generator : "load-gen-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" }
  )
}

output "internal_topology" {
  description = "Private IP layout within OCI VCN"
  value = {
    lb_private_ip              = oci_core_instance.lb.private_ip
    redis_private_ip           = oci_core_instance.redis.private_ip
    gateway_private_ips        = oci_core_instance.gateways[*].private_ip
    worker_private_ips         = oci_core_instance.workers[*].private_ip
    load_generator_private_ips = oci_core_instance.load_generator[*].private_ip
  }
}
