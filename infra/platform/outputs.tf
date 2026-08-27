output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "lease_url" {
  value = google_cloud_run_v2_service.lease.uri
}

output "lease_endpoint" {
  value = "${trimprefix(google_cloud_run_v2_service.lease.uri, "https://")}:443"
}

output "dashboard_id" {
  value = google_monitoring_dashboard.vigil.id
}

