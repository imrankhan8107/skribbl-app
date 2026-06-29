output "instance_public_ip" {
  description = "Public IP of the compute instance"
  value       = oci_core_instance.app.public_ip
}

output "app_url" {
  description = "URL to access the app (via nginx)"
  value       = "http://${oci_core_instance.app.public_ip}:8080"
}

output "app_direct_url" {
  description = "Direct URL to the app (single worker, no nginx)"
  value       = "http://${oci_core_instance.app.public_ip}:8000"
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh ubuntu@${oci_core_instance.app.public_ip}"
}

output "instance_ocid" {
  description = "OCID of the compute instance"
  value       = oci_core_instance.app.id
}
