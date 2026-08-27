resource "google_compute_network" "vigil" {
  project                 = var.project_id
  name                    = "vigil-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "vigil" {
  project                  = var.project_id
  name                     = "vigil-europe-west3"
  region                   = var.region
  network                  = google_compute_network.vigil.id
  ip_cidr_range            = "10.42.0.0/20"
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "vigil-pods"
    ip_cidr_range = "10.44.0.0/14"
  }
  secondary_ip_range {
    range_name    = "vigil-services"
    ip_cidr_range = "10.48.0.0/20"
  }
}

resource "google_compute_global_address" "private_services" {
  project       = var.project_id
  name          = "vigil-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vigil.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vigil.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  depends_on = [google_project_service.required]
}

resource "google_compute_router" "vigil" {
  project = var.project_id
  name    = "vigil-router"
  region  = var.region
  network = google_compute_network.vigil.id
}

resource "google_compute_router_nat" "vigil" {
  project                            = var.project_id
  name                               = "vigil-nat"
  router                             = google_compute_router.vigil.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.vigil.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

resource "google_compute_address" "synthetic_hls" {
  project      = var.project_id
  name         = "vigil-synthetic-hls"
  region       = var.region
  subnetwork   = google_compute_subnetwork.vigil.id
  address_type = "INTERNAL"
  purpose      = "SHARED_LOADBALANCER_VIP"
  address      = "10.42.0.20"
}

