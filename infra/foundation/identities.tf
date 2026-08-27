locals {
  service_accounts = {
    api       = "Public REST API and playback proxy"
    lease     = "Private recording lease service"
    worker    = "Outbox publisher, projector, and retention worker"
    scheduler = "Kubernetes recorder scheduler"
    recorder  = "Ephemeral media recorder Jobs"
    migration = "Database migration Cloud Run Job"
    node      = "Dedicated GKE Autopilot node identity"
    signer    = "Dedicated V4 playback URL signer"
  }
}

resource "google_service_account" "runtime" {
  for_each = local.service_accounts
  project  = var.project_id

  account_id   = "vigil-${each.key}"
  display_name = "Vigil ${each.key}"
  description  = each.value
}

locals {
  project_roles = {
    api-cloudsql       = ["api", "roles/cloudsql.client"]
    lease-cloudsql     = ["lease", "roles/cloudsql.client"]
    worker-cloudsql    = ["worker", "roles/cloudsql.client"]
    worker-kafka       = ["worker", "roles/managedkafka.client"]
    scheduler-kafka    = ["scheduler", "roles/managedkafka.client"]
    recorder-kafka     = ["recorder", "roles/managedkafka.client"]
    migration-cloudsql = ["migration", "roles/cloudsql.client"]
    node-runtime       = ["node", "roles/container.defaultNodeServiceAccount"]
  }
}

resource "google_compute_subnetwork_iam_member" "github_cloud_run_network" {
  project    = var.project_id
  region     = var.region
  subnetwork = google_compute_subnetwork.vigil.name
  role       = "roles/compute.networkUser"
  member     = "serviceAccount:${var.github_deployer_service_account}"
}

resource "google_project_iam_member" "runtime" {
  for_each = local.project_roles
  project  = var.project_id
  role     = each.value[1]
  member   = "serviceAccount:${google_service_account.runtime[each.value[0]].email}"
}

resource "google_service_account_iam_member" "gke_workload_identity" {
  for_each = {
    worker    = "vigil-backend-worker"
    scheduler = "vigil-scheduler"
    recorder  = "vigil-recorder"
  }
  service_account_id = google_service_account.runtime[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[vigil/${each.value}]"
}

resource "google_service_account_iam_member" "github_act_as" {
  for_each           = google_service_account.runtime
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.github_deployer_service_account}"
}

resource "google_service_account_iam_member" "api_impersonates_signer" {
  service_account_id = google_service_account.runtime["signer"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime["api"].email}"
}
