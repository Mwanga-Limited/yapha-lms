# ------------------------------------------------------------------ alerting
resource "google_monitoring_notification_channel" "email" {
  display_name = "Yapha on-call"
  type         = "email"
  labels       = { email_address = var.alert_email }
  depends_on   = [google_project_service.apis]
}

locals {
  channels = [google_monitoring_notification_channel.email.id]
  svc      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.app.name}\""
}

resource "google_monitoring_uptime_check_config" "health" {
  display_name = "Yapha health"
  timeout      = "10s"
  period       = "60s"
  http_check {
    path         = "/api/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
    accepted_response_status_codes { status_class = "STATUS_CLASS_2XX" }
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = local.host }
  }
}

# ---- log-based metrics (the app writes JSON logs: see backend/src/lib/logger.js)
resource "google_logging_metric" "backup_ok" {
  name   = "yapha_backup_completed"
  filter = "resource.type=\"cloud_run_job\" AND jsonPayload.event=\"backup_completed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}
resource "google_logging_metric" "backup_failed" {
  name   = "yapha_backup_failed"
  filter = "resource.type=\"cloud_run_job\" AND jsonPayload.event=\"backup_failed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}
resource "google_logging_metric" "mail_failed" {
  name   = "yapha_mail_failed_permanently"
  filter = "${local.svc} AND jsonPayload.message=\"mail failed permanently\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}
resource "google_logging_metric" "outbox_lag" {
  name        = "yapha_outbox_oldest_due_seconds"
  filter      = "${local.svc} AND jsonPayload.message=\"outbox\""
  value_extractor = "EXTRACT(jsonPayload.oldestDueSec)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "s"
  }
  bucket_options {
    explicit_buckets { bounds = [0, 30, 60, 120, 300, 600, 1800, 3600] }
  }
}
resource "google_logging_metric" "outbox_ran" {
  name   = "yapha_outbox_drain_ran"
  filter = "${local.svc} AND jsonPayload.message=\"outbox\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}
resource "google_logging_metric" "app_errors" {
  name   = "yapha_app_errors"
  filter = "${local.svc} AND severity>=ERROR AND NOT jsonPayload.message=\"mail send failed, will retry\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# ---- alert policies
resource "google_monitoring_alert_policy" "down" {
  display_name = "Site is down"
  combiner     = "OR"
  conditions {
    display_name = "Health check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id=\"${google_monitoring_uptime_check_config.health.uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "180s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id"]
      }
    }
  }
  notification_channels = local.channels
  documentation { content = "The health check has failed for 3 minutes. See deploy/gcp/RUNBOOK.md, section 'Site is down'." }
}

resource "google_monitoring_alert_policy" "server_errors" {
  display_name = "Too many server errors"
  combiner     = "OR"
  conditions {
    display_name = "5xx responses"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${google_cloud_run_v2_service.app.name}\" AND metric.label.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = local.channels
  documentation { content = "More than 5 server errors a minute for 5 minutes. Search the logs for severity=ERROR; each error carries a requestId." }
}

resource "google_monitoring_alert_policy" "backup_missing" {
  display_name = "No successful backup in 23 hours"
  combiner     = "OR"
  conditions {
    display_name = "backup_completed absent"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.backup_ok.name}\" AND resource.type=\"cloud_run_job\""
      duration = "82800s"   # Cloud Monitoring allows at most 23.5 hours for an absence condition
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = local.channels
  documentation { content = "The nightly backup job has not reported success for 23 hours. Run the job by hand and read its logs (Cloud Run > Jobs > yapha-backup)." }
}

resource "google_monitoring_alert_policy" "backup_failed" {
  display_name = "Backup job failed"
  combiner     = "OR"
  conditions {
    display_name = "backup_failed"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.backup_failed.name}\" AND resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = local.channels
}

resource "google_monitoring_alert_policy" "mail_stuck" {
  display_name = "Emails are not going out"
  combiner     = "OR"
  conditions {
    display_name = "Oldest due email waiting over 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.outbox_lag.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 600
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
      }
    }
  }
  conditions {
    display_name = "Outbox worker has not run for 10 minutes"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.outbox_ran.name}\" AND resource.type=\"cloud_run_revision\""
      duration = "600s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = local.channels
  documentation { content = "Sign-in codes and invitations are queued but not being delivered. Check SMTP settings and the Cloud Scheduler job yapha-outbox-drain." }
}

resource "google_monitoring_alert_policy" "mail_failed" {
  display_name = "An email failed permanently"
  combiner     = "OR"
  conditions {
    display_name = "mail failed permanently"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.mail_failed.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = local.channels
  documentation { content = "More than 3 emails in an hour were refused for good (bad address, or the sender is blocked). Check SPF/DKIM/DMARC and the provider's dashboard." }
}

# The database is Neon: watch its CPU, storage and connections in the Neon console (Monitoring), not here.
