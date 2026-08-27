output "project_number" {
  value = data.google_project.current.number
}

output "artifact_registry_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.vigil.repository_id}"
}

output "recordings_bucket" {
  value = google_storage_bucket.recordings.name
}

output "sql_instance_connection_name" {
  value = google_sql_database_instance.vigil.connection_name
}

output "gke_cluster_name" {
  value = google_container_cluster.vigil.name
}

output "kafka_cluster_id" {
  value = google_managed_kafka_cluster.vigil.cluster_id
}

output "synthetic_hls_ip" {
  value = google_compute_address.synthetic_hls.address
}

output "network_name" {
  value = google_compute_network.vigil.name
}

output "subnetwork_name" {
  value = google_compute_subnetwork.vigil.name
}

output "service_accounts" {
  value = { for key, account in google_service_account.runtime : key => account.email }
}

output "secret_ids" {
  value = { for key, secret in google_secret_manager_secret.runtime : key => secret.secret_id }
}
