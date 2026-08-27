data "google_project" "current" {
  project_id = var.project_id
}

locals {
  github_repository_full_name = "${var.github_owner}/${var.github_repository}"
  bootstrap_apis = toset([
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ])
}

resource "google_project_service" "bootstrap" {
  for_each = local.bootstrap_apis
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}

resource "google_storage_bucket" "terraform_state" {
  name                        = "vigil-${data.google_project.current.number}-tfstate"
  project                     = var.project_id
  location                    = "EU"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 20
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.bootstrap]
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "vigil-github"
  display_name              = "Vigil GitHub Actions"
  description               = "Keyless deployment identity restricted to the public Vigil repository."

  depends_on = [google_project_service.bootstrap]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "vigil-github"
  display_name                       = "Vigil GitHub OIDC"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
  }
  attribute_condition = "assertion.repository_owner == '${var.github_owner}' && assertion.repository == '${local.github_repository_full_name}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github" {
  project      = var.project_id
  account_id   = "vigil-github"
  display_name = "Vigil GitHub deployment"
  description  = "Keyless principal for manual Vigil deployment workflows."
}

resource "google_service_account_iam_member" "github_federation" {
  service_account_id = google_service_account.github.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${local.github_repository_full_name}"
}

resource "google_project_iam_member" "github_roles" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/browser",
    "roles/container.developer",
    "roles/logging.configWriter",
    "roles/managedkafka.viewer",
    "roles/monitoring.editor",
    "roles/run.admin",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github.email}"
}

resource "google_storage_bucket_iam_member" "github_state" {
  bucket = google_storage_bucket.terraform_state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.github.email}"
}
