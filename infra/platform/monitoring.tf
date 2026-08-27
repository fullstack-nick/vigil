resource "google_logging_metric" "integrity_conflicts" {
  project = var.project_id
  name    = "vigil/integrity_conflicts"
  filter  = <<-EOT
    resource.type=("k8s_container" OR "cloud_run_revision")
    jsonPayload.message="event identity conflict quarantined"
  EOT
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Vigil quarantined event identity conflicts"
  }
}

resource "google_monitoring_alert_policy" "api_server_errors" {
  project      = var.project_id
  display_name = "Vigil API server errors"
  combiner     = "OR"

  conditions {
    display_name = "More than five API 5xx responses in five minutes"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.label.service_name = \"vigil-api\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.label.response_code_class = \"5xx\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }
  notification_channels = var.notification_channels
  documentation {
    content   = "Vigil API is returning server errors. Follow docs/runbook.md and inspect the Cloud Run revision plus Cloud SQL connectivity."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "integrity_conflict" {
  project      = var.project_id
  display_name = "Vigil event integrity conflict"
  combiner     = "OR"

  conditions {
    display_name = "Any quarantined conflicting event identity"
    condition_threshold {
      filter          = "resource.type = \"global\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.integrity_conflicts.name}\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }
  notification_channels = var.notification_channels
  documentation {
    content   = "A duplicate event ID or attempt/sequence carried different bytes. The projector quarantined it. Preserve evidence and follow the integrity-conflict runbook."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_dashboard" "vigil" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "Vigil — consent-gated recording"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos   = 0
          yPos   = 0
          width  = 6
          height = 4
          widget = {
            title = "Cloud Run request rate"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.service_name=monitoring.regex.full_match(\"vigil-(api|lease)\")"
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_RATE"
                    }
                  }
                }
              }]
              yAxis = { label = "requests/s", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 6
          yPos   = 0
          width  = 6
          height = 4
          widget = {
            title = "Recorder Jobs by phase"
            xyChart = {
              dataSets = [{
                plotType   = "STACKED_AREA"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  prometheusQuery = "sum by (phase) (kube_job_status_active{namespace=\"vigil\"})"
                }
              }]
              yAxis = { label = "jobs", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 0
          yPos   = 4
          width  = 12
          height = 4
          widget = {
            title = "Vigil projected events"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  prometheusQuery = "sum by (result, type) (rate(vigil_projected_events_total[5m]))"
                }
              }]
              yAxis = { label = "events/s", scale = "LINEAR" }
            }
          }
        }
      ]
    }
  })
}

