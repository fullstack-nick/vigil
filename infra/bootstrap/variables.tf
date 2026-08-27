variable "project_id" {
  description = "Existing billed GCP project selected for Vigil."
  type        = string
  default     = "boltstream-r7m5o9ld"
}

variable "github_owner" {
  type    = string
  default = "fullstack-nick"
}

variable "github_repository" {
  type    = string
  default = "vigil"
}

