resource "google_managed_kafka_cluster" "vigil" {
  project    = var.project_id
  cluster_id = "vigil-events"
  location   = var.region
  labels     = local.labels

  capacity_config {
    vcpu_count   = 3
    memory_bytes = 3221225472
  }

  gcp_config {
    access_config {
      network_configs {
        subnet = "projects/${data.google_project.current.number}/regions/${var.region}/subnetworks/${google_compute_subnetwork.vigil.name}"
      }
    }
  }

  rebalance_config {
    mode = "AUTO_REBALANCE_ON_SCALE_UP"
  }

  depends_on = [google_project_service.required]
}

resource "google_managed_kafka_topic" "commands" {
  project            = var.project_id
  location           = var.region
  cluster            = google_managed_kafka_cluster.vigil.cluster_id
  topic_id           = "vigil.recording.commands.v1"
  partition_count    = 3
  replication_factor = 3
  configs = {
    "cleanup.policy" = "delete"
    "retention.ms"   = "86400000"
  }
}

resource "google_managed_kafka_topic" "events" {
  project            = var.project_id
  location           = var.region
  cluster            = google_managed_kafka_cluster.vigil.cluster_id
  topic_id           = "vigil.recording.events.v1"
  partition_count    = 3
  replication_factor = 3
  configs = {
    "cleanup.policy" = "delete"
    "retention.ms"   = "604800000"
  }
}

resource "google_managed_kafka_acl" "commands" {
  project  = var.project_id
  location = var.region
  cluster  = google_managed_kafka_cluster.vigil.cluster_id
  acl_id   = "topic/vigil.recording.commands.v1"

  acl_entries {
    principal       = "User:${google_service_account.runtime["worker"].email}"
    permission_type = "ALLOW"
    operation       = "WRITE"
    host            = "*"
  }
  acl_entries {
    principal       = "User:${google_service_account.runtime["worker"].email}"
    permission_type = "ALLOW"
    operation       = "DESCRIBE"
    host            = "*"
  }
  acl_entries {
    principal       = "User:${google_service_account.runtime["scheduler"].email}"
    permission_type = "ALLOW"
    operation       = "READ"
    host            = "*"
  }
  acl_entries {
    principal       = "User:${google_service_account.runtime["scheduler"].email}"
    permission_type = "ALLOW"
    operation       = "DESCRIBE"
    host            = "*"
  }

  depends_on = [google_managed_kafka_topic.commands]
}

resource "google_managed_kafka_acl" "events" {
  project  = var.project_id
  location = var.region
  cluster  = google_managed_kafka_cluster.vigil.cluster_id
  acl_id   = "topic/vigil.recording.events.v1"

  dynamic "acl_entries" {
    for_each = toset([
      google_service_account.runtime["recorder"].email,
      google_service_account.runtime["scheduler"].email,
    ])
    content {
      principal       = "User:${acl_entries.value}"
      permission_type = "ALLOW"
      operation       = "WRITE"
      host            = "*"
    }
  }
  dynamic "acl_entries" {
    for_each = toset([
      google_service_account.runtime["recorder"].email,
      google_service_account.runtime["scheduler"].email,
    ])
    content {
      principal       = "User:${acl_entries.value}"
      permission_type = "ALLOW"
      operation       = "DESCRIBE"
      host            = "*"
    }
  }
  acl_entries {
    principal       = "User:${google_service_account.runtime["worker"].email}"
    permission_type = "ALLOW"
    operation       = "READ"
    host            = "*"
  }
  acl_entries {
    principal       = "User:${google_service_account.runtime["worker"].email}"
    permission_type = "ALLOW"
    operation       = "DESCRIBE"
    host            = "*"
  }

  depends_on = [google_managed_kafka_topic.events]
}

resource "google_managed_kafka_acl" "scheduler_group" {
  project  = var.project_id
  location = var.region
  cluster  = google_managed_kafka_cluster.vigil.cluster_id
  acl_id   = "consumerGroup/vigil-scheduler-v1"
  acl_entries {
    principal       = "User:${google_service_account.runtime["scheduler"].email}"
    permission_type = "ALLOW"
    operation       = "READ"
    host            = "*"
  }
}

resource "google_managed_kafka_acl" "projector_group" {
  project  = var.project_id
  location = var.region
  cluster  = google_managed_kafka_cluster.vigil.cluster_id
  acl_id   = "consumerGroup/vigil-projector-v1"
  acl_entries {
    principal       = "User:${google_service_account.runtime["worker"].email}"
    permission_type = "ALLOW"
    operation       = "READ"
    host            = "*"
  }
}

resource "google_managed_kafka_acl" "idempotent_writes" {
  project  = var.project_id
  location = var.region
  cluster  = google_managed_kafka_cluster.vigil.cluster_id
  acl_id   = "cluster"

  dynamic "acl_entries" {
    for_each = toset([
      google_service_account.runtime["worker"].email,
      google_service_account.runtime["scheduler"].email,
      google_service_account.runtime["recorder"].email,
    ])
    content {
      principal       = "User:${acl_entries.value}"
      permission_type = "ALLOW"
      operation       = "IDEMPOTENT_WRITE"
      host            = "*"
    }
  }
}

