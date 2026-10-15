output "cluster_access" {
  description = "Cluster connection info and test instructions"
  value = {
    deployment_mode   = var.single_instance_mode ? "single_instance" : "multi_host distributed cluster with L4 NLB"
    app_url           = var.single_instance_mode ? "http://${length(aws_instance.single) > 0 ? aws_instance.single[0].public_ip : ""}" : (length(aws_lb.nlb) > 0 ? "http://${aws_lb.nlb[0].dns_name}" : "")
    app_url_alt_port  = var.single_instance_mode ? "http://${length(aws_instance.single) > 0 ? aws_instance.single[0].public_ip : ""}:9000" : (length(aws_lb.nlb) > 0 ? "http://${aws_lb.nlb[0].dns_name}:9000" : "")
    nlb_dns_name      = length(aws_lb.nlb) > 0 ? aws_lb.nlb[0].dns_name : null
    grafana_url       = var.single_instance_mode ? "N/A" : (length(aws_instance.lb) > 0 ? "http://${aws_instance.lb[0].public_ip}:3000" : "N/A")
    prometheus_url    = var.single_instance_mode ? "N/A" : (length(aws_instance.lb) > 0 ? "http://${aws_instance.lb[0].public_ip}:9090" : "N/A")
    load_generator_ip = (!var.single_instance_mode && length(aws_instance.load_generator) > 0) ? aws_instance.load_generator[0].public_ip : "N/A"
  }
}

output "node_ssh" {
  description = "SSH connection strings for all provisioned node(s)"
  value = var.single_instance_mode ? (
    length(aws_instance.single) > 0 ? {
      server = "ssh ubuntu@${aws_instance.single[0].public_ip}"
    } : {}
    ) : merge(
    { for idx, inst in aws_instance.lb : "lb-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    length(aws_instance.redis) > 0 ? { redis = "ssh ubuntu@${aws_instance.redis[0].private_ip}" } : {},
    { for idx, inst in aws_instance.gateways : "gateway-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    { for idx, inst in aws_instance.workers : "worker-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" },
    { for idx, inst in aws_instance.load_generator : "load-gen-${idx + 1}" => "ssh ubuntu@${inst.public_ip}" }
  )
}

output "internal_topology" {
  description = "Private IP layout within AWS VPC"
  value = {
    server_private_ip          = length(aws_instance.single) > 0 ? aws_instance.single[0].private_ip : null
    lb_private_ips             = aws_instance.lb[*].private_ip
    redis_private_ip           = length(aws_instance.redis) > 0 ? aws_instance.redis[0].private_ip : null
    gateway_private_ips        = aws_instance.gateways[*].private_ip
    worker_private_ips         = aws_instance.workers[*].private_ip
    load_generator_private_ips = aws_instance.load_generator[*].private_ip
  }
}

output "app_url" {
  description = "Primary URL to access the Skribbl game"
  value       = var.single_instance_mode ? "http://${length(aws_instance.single) > 0 ? aws_instance.single[0].public_ip : ""}" : (length(aws_lb.nlb) > 0 ? "http://${aws_lb.nlb[0].dns_name}" : "")
}

output "nlb_dns_name" {
  description = "DNS name of the L4 Network Load Balancer"
  value       = length(aws_lb.nlb) > 0 ? aws_lb.nlb[0].dns_name : null
}

output "lb_public_ips" {
  description = "Public IPs of the underlying Nginx Load Balancer instances"
  value       = aws_instance.lb[*].public_ip
}
