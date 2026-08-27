variable "project_id" {
  type    = string
  default = "boltstream-r7m5o9ld"
}

variable "region" {
  type    = string
  default = "europe-west3"
}

variable "billing_account_id" {
  description = "Billing account used only for the project-scoped alerting budget."
  type        = string
  default     = "010A7B-134BD2-8CB391"
}

variable "monthly_budget_units" {
  description = "Alert-only monthly budget in the billing account's native currency."
  type        = number
  default     = 300
}

variable "database_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "github_deployer_service_account" {
  type    = string
  default = "vigil-github@boltstream-r7m5o9ld.iam.gserviceaccount.com"
}
