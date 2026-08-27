data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "foundation/demo"
  }
}

locals {
  foundation       = data.terraform_remote_state.foundation.outputs
  service_accounts = local.foundation.service_accounts
  secrets          = local.foundation.secret_ids
  source_url       = "http://${local.foundation.synthetic_hls_ip}:8080/live/index.m3u8"
  common_db_env = {
    INSTANCE_CONNECTION_NAME = local.foundation.sql_instance_connection_name
    DB_USER                  = "vigil"
    DB_NAME                  = "vigil"
    DB_POOL_SIZE             = "10"
  }
}

resource "google_cloud_run_v2_job" "migration" {
  project  = var.project_id
  name     = "vigil-migration"
  location = var.region

  template {
    template {
      service_account = local.service_accounts.migration
      max_retries     = 1
      timeout         = "600s"

      vpc_access {
        network_interfaces {
          network    = local.foundation.network_name
          subnetwork = local.foundation.subnetwork_name
          tags       = ["vigil-cloud-run"]
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = var.node_image
        command = ["node"]
        args    = ["packages/database/dist/migrate.js"]

        dynamic "env" {
          for_each = merge(local.common_db_env, {
            SERVICE_NAME   = "vigil-migration"
            MIGRATIONS_DIR = "/app/database/migrations"
          })
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = local.secrets["db-password"]
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }
}

resource "terraform_data" "migration" {
  triggers_replace = [var.node_image, google_cloud_run_v2_job.migration.id]

  provisioner "local-exec" {
    command = "gcloud run jobs execute ${google_cloud_run_v2_job.migration.name} --project=${var.project_id} --region=${var.region} --wait --quiet"
  }
}

resource "google_cloud_run_v2_service" "api" {
  project             = var.project_id
  name                = "vigil-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  scaling {
    min_instance_count = 0
    max_instance_count = 3
  }

  template {
    service_account                  = local.service_accounts.api
    timeout                          = "300s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = local.foundation.network_name
        subnetwork = local.foundation.subnetwork_name
        tags       = ["vigil-cloud-run"]
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.node_image
      ports {
        name           = "http1"
        container_port = 8080
      }

      dynamic "env" {
        for_each = merge(local.common_db_env, {
          NODE_ENV                   = "production"
          SERVICE_MODE               = "api"
          SERVICE_NAME               = "vigil-api"
          DEMO_SOURCE_ID             = "synthetic-hls"
          DEMO_SOURCE_URL            = local.source_url
          STORAGE_BUCKET             = local.foundation.recordings_bucket
          RETENTION_HOURS            = "24"
          SESSION_TTL_SECONDS        = "1800"
          URL_SIGNER_SERVICE_ACCOUNT = local.service_accounts.signer
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = local.secrets["db-password"]
            version = "latest"
          }
        }
      }
      env {
        name = "OPERATOR_CREDENTIAL"
        value_source {
          secret_key_ref {
            secret  = local.secrets["operator-credential"]
            version = "latest"
          }
        }
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = local.secrets["session-secret"]
            version = "latest"
          }
        }
      }

      resources {
        cpu_idle          = true
        startup_cpu_boost = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        initial_delay_seconds = 2
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 12
        http_get {
          path = "/readyz"
          port = 8080
        }
      }
    }
  }

  depends_on = [terraform_data.migration]
}

resource "google_cloud_run_v2_service_iam_member" "public_api" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "lease" {
  project             = var.project_id
  name                = "vigil-lease"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  scaling {
    min_instance_count = 1
    max_instance_count = 3
  }

  template {
    service_account                  = local.service_accounts.lease
    timeout                          = "300s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = local.foundation.network_name
        subnetwork = local.foundation.subnetwork_name
        tags       = ["vigil-cloud-run"]
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.node_image
      ports {
        name           = "h2c"
        container_port = 8080
      }

      dynamic "env" {
        for_each = merge(local.common_db_env, {
          NODE_ENV        = "production"
          SERVICE_MODE    = "lease"
          SERVICE_NAME    = "vigil-lease"
          DEMO_SOURCE_ID  = "synthetic-hls"
          DEMO_SOURCE_URL = local.source_url
          RETENTION_HOURS = "24"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = local.secrets["db-password"]
            version = "latest"
          }
        }
      }
      env {
        name = "OPERATOR_CREDENTIAL"
        value_source {
          secret_key_ref {
            secret  = local.secrets["operator-credential"]
            version = "latest"
          }
        }
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = local.secrets["session-secret"]
            version = "latest"
          }
        }
      }

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 12
        tcp_socket {
          port = 8080
        }
      }
    }
  }

  depends_on = [terraform_data.migration]
}

resource "google_cloud_run_v2_service_iam_member" "recorder_invokes_lease" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.lease.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.service_accounts.recorder}"
}
