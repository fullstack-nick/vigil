output "state_bucket" {
  value = google_storage_bucket.terraform_state.name
}

output "github_service_account" {
  value = google_service_account.github.email
}

output "github_workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "project_number" {
  value = data.google_project.current.number
}

