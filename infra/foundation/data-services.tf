resource "random_password" "database" {
  length  = 32
  special = false
}

resource "random_password" "operator" {
  length  = 32
  special = false
}

resource "random_password" "session" {
  length  = 64
  special = false
}

resource "google_sql_database_instance" "vigil" {
  project             = var.project_id
  name                = "vigil-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = false

  settings {
    tier                        = var.database_tier
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 20
    disk_autoresize             = true
    deletion_protection_enabled = false
    user_labels                 = local.labels

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      record_client_address   = false
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vigil.id
      allocated_ip_range                            = google_compute_global_address.private_services.name
      enable_private_path_for_google_cloud_services = true
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "vigil" {
  project  = var.project_id
  name     = "vigil"
  instance = google_sql_database_instance.vigil.name
}

resource "google_sql_user" "vigil" {
  project  = var.project_id
  name     = "vigil"
  instance = google_sql_database_instance.vigil.name
  password = random_password.database.result
}

resource "google_storage_bucket" "recordings" {
  project                     = var.project_id
  name                        = "vigil-${data.google_project.current.number}-recordings"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels                      = local.labels

  lifecycle_rule {
    condition {
      age = 2
    }
    action {
      type = "Delete"
    }
  }
}

locals {
  secrets = {
    db-password         = random_password.database.result
    operator-credential = random_password.operator.result
    session-secret      = random_password.session.result
  }
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secrets
  project   = var.project_id
  secret_id = "vigil-${each.key}"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "runtime" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.runtime[each.key].id
  secret_data = each.value
}

locals {
  secret_readers = {
    db-api         = ["db-password", "api"]
    db-lease       = ["db-password", "lease"]
    db-worker      = ["db-password", "worker"]
    db-migration   = ["db-password", "migration"]
    operator-api   = ["operator-credential", "api"]
    operator-lease = ["operator-credential", "lease"]
    session-api    = ["session-secret", "api"]
    session-lease  = ["session-secret", "lease"]
  }
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_readers
  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value[0]].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value[1]].email}"
}

resource "google_storage_bucket_iam_member" "recorder_write" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime["recorder"].email}"
}

resource "google_storage_bucket_iam_member" "worker_cleanup" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime["worker"].email}"
}

resource "google_storage_bucket_iam_member" "api_read" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime["api"].email}"
}

resource "google_storage_bucket_iam_member" "signer_read" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime["signer"].email}"
}

