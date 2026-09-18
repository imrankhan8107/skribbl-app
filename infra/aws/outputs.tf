output "lb_public_ip" {
  description = "Public IP of the Nginx Load Balancer"
  value       = aws_instance.lb.public_ip
}

output "app_url" {
  description = "URL to access the Skribbl game via the Load Balancer"
  value       = "http://${aws_instance.lb.public_ip}"
}

output "gateway_public_ips" {
  description = "Public IPs of the Go Gateway instances"
  value       = aws_instance.gateways[*].public_ip
}

output "gateway_private_ips" {
  description = "Private IPs of the Go Gateway instances"
  value       = aws_instance.gateways[*].private_ip
}

output "worker_private_ips" {
  description = "Private IPs of the Python Worker instances"
  value       = aws_instance.workers[*].private_ip
}

output "redis_private_ip" {
  description = "Private IP of the Redis instance"
  value       = aws_instance.redis.private_ip
}

output "ssh_lb_command" {
  description = "SSH command to connect to Load Balancer"
  value       = "ssh ubuntu@${aws_instance.lb.public_ip}"
}

output "k6_load_test_command" {
  description = "Sample k6 command to run coordinated load test against the cluster"
  value       = "k6 run --env HOST=${aws_instance.lb.public_ip} --env PORT=80 --env COORD_HOST=${aws_instance.gateways[0].public_ip} --env COORD_PORT=9100 --env VUS=1000 scripts/k6_grpc_load_test.js"
}

