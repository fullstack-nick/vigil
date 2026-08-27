variable "project_id" {
  type    = string
  default = "boltstream-r7m5o9ld"
}

variable "region" {
  type    = string
  default = "europe-west3"
}

variable "state_bucket" {
  description = "Dedicated bucket emitted by the bootstrap stack."
  type        = string
}

variable "node_image" {
  description = "Immutable Artifact Registry Node image reference, preferably by digest."
  type        = string
  validation {
    condition     = strcontains(var.node_image, "@sha256:")
    error_message = "node_image must be pinned by sha256 digest."
  }
}

variable "kafka_brokers" {
  description = "Managed Kafka bootstrap address returned by the cluster API."
  type        = string
  validation {
    condition     = length(trimspace(var.kafka_brokers)) > 3
    error_message = "kafka_brokers cannot be empty."
  }
}

variable "notification_channels" {
  description = "Optional pre-verified Cloud Monitoring notification channel resource names."
  type        = list(string)
  default     = []
}

