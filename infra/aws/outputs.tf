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
  description = "Private IP addresses of Python Workers"
  value       = aws_instance.workers[*].private_ip
}

output "worker_public_ips" {
  description = "Public IP addresses of Python Workers"
  value       = aws_instance.workers[*].public_ip
}

output "gateway_log_urls" {
  description = "URLs to download gateway logs"
  value       = [for ip in aws_instance.gateways[*].public_ip : "http://${ip}:8080/"]
}

output "worker_log_urls" {
  description = "URLs to download worker logs"
  value       = [for ip in aws_instance.workers[*].public_ip : "http://${ip}:8080/"]
}

output "redis_private_ip" {
  description = "Private IP of the Redis instance"
  value       = aws_instance.redis.private_ip
}

output "ssh_lb_command" {
  description = "SSH command to connect to Load Balancer"
  value       = "ssh ubuntu@${aws_instance.lb.public_ip}"
}

output "load_generator_public_ip" {
  description = "Public IP of the dedicated k6 Load Generator instance"
  value       = try(aws_instance.load_generator[0].public_ip, "disabled")
}

output "ssh_k6_runner_command" {
  description = "SSH command to connect to the dedicated in-VPC k6 Load Generator"
  value       = try("ssh ubuntu@${aws_instance.load_generator[0].public_ip}", "disabled")
}

output "in_vpc_k6_quick_run" {
  description = "Command to run once connected inside the k6 runner EC2 instance"
  value       = "./run-test.sh 1000 5 20 30"
}

output "k6_load_test_command" {
  description = "Sample k6 command to run coordinated load test from your local laptop against the cluster"
  value       = "k6 run -e HOST=${aws_instance.lb.public_ip} -e PORT=80 -e COORD_PORT=0 -e VUS=500 -e PLAYERS_PER_ROOM=5 -e STROKE_HZ=20 scripts/k6_grpc_load_test.js"
}

