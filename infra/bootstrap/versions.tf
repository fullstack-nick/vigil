terraform {
  required_version = ">= 1.15.0, < 2.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.41.0"
    }
  }
}

provider "google" {
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
  default_labels = {
    app         = "vigil"
    environment = "demo"
    managed_by  = "terraform"
    owner       = "fullstack-nick"
  }
}
