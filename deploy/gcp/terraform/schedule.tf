# ------------------------------------------------------------------ Cloud Scheduler
resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_backup" {
  name     = google_cloud_run_v2_job.backup.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# Every minute: send queued emails and retry failed ones (the outbox). The call carries a Google-signed identity token
# for the scheduler account; the app verifies the token, its audience and the account's email.
resource "google_cloud_scheduler_job" "outbox" {
  name      = "${local.name}-outbox-drain"
  region    = var.region
  schedule  = "* * * * *"
  time_zone = "Etc/UTC"
  attempt_deadline = "60s"
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.app.uri}/api/internal/outbox/drain"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.app_url
    }
  }
  retry_config { retry_count = 0 }
}

resource "google_cloud_scheduler_job" "cleanup" {
  name      = "${local.name}-cleanup"
  region    = var.region
  schedule  = "17 * * * *"
  time_zone = "Etc/UTC"
  attempt_deadline = "120s"
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.app.uri}/api/internal/cleanup"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.app_url
    }
  }
}

resource "google_cloud_scheduler_job" "backup" {
  name      = "${local.name}-backup-nightly"
  region    = var.region
  schedule  = "0 2 * * *"
  time_zone = "Etc/UTC"
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.backup.name}:run"
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
}

# ------------------------------------------------------------------ GitHub Actions: keyless deploys (Workload Identity Federation)
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name}-github"
  depends_on                = [google_project_service.apis]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository == \"${var.github_repo}\" && assertion.ref == \"refs/heads/main\""   # only main can deploy
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_project_iam_member" "deployer_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_service_account_iam_member" "deployer_acts_as_app" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_service_account_iam_member" "deployer_acts_as_backup" {
  service_account_id = google_service_account.backup.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
