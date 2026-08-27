resource "google_container_cluster" "vigil" {
  project  = var.project_id
  name     = "vigil-autopilot"
  location = var.region

  enable_autopilot    = true
  deletion_protection = false
  network             = google_compute_network.vigil.id
  subnetwork          = google_compute_subnetwork.vigil.id
  networking_mode     = "VPC_NATIVE"
  datapath_provider   = "ADVANCED_DATAPATH"
  resource_labels     = local.labels

  ip_allocation_policy {
    cluster_secondary_range_name  = "vigil-pods"
    services_secondary_range_name = "vigil-services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.42.0/28"
  }

  release_channel {
    channel = "REGULAR"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS", "APISERVER", "SCHEDULER", "CONTROLLER_MANAGER", "STORAGE"]
    managed_prometheus {
      enabled = true
    }
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS", "APISERVER", "SCHEDULER", "CONTROLLER_MANAGER"]
  }

  secret_manager_config {
    enabled = true
  }

  cost_management_config {
    enabled = true
  }

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.runtime["node"].email
    }
  }

  depends_on = [google_project_service.required, google_compute_router_nat.vigil]
}
