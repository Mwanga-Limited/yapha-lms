# Yapha LMS on Google Cloud: Cloud Run + Neon (PostgreSQL, external, URLs passed in as secrets) + Cloud Storage + Secret Manager + Cloud Scheduler + Cloud Monitoring.
# NOTE: written without access to a Google Cloud project; run `terraform validate` and `terraform plan` and read the plan before applying.

locals {
  name = "yapha"
  apis = [
    "run.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com",
    "cloudscheduler.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "iamcredentials.googleapis.com",
    "iam.googleapis.com", "storage.googleapis.com", "sts.googleapis.com", "cloudresourcemanager.googleapis.com",
  ]
  host   = var.domain != "" ? var.domain : replace(google_cloud_run_v2_service.app.uri, "https://", "")
}

data "google_project" "this" { project_id = var.project_id }

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.key
  disable_on_destroy = false
}

# ------------------------------------------------------------------ images
resource "google_artifact_registry_repository" "images" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 20 }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition { older_than = "2592000s" }
  }
  depends_on = [google_project_service.apis]
}

# ------------------------------------------------------------------ identities (no key files anywhere)
resource "google_service_account" "app" {
  account_id   = "${local.name}-app"
  display_name = "Yapha LMS runtime"
}
resource "google_service_account" "backup" {
  account_id   = "${local.name}-backup"
  display_name = "Yapha LMS backup job"
}
resource "google_service_account" "scheduler" {
  account_id   = "${local.name}-scheduler"
  display_name = "Yapha LMS scheduled jobs"
}
resource "google_service_account" "deployer" {
  account_id   = "${local.name}-deployer"
  display_name = "GitHub Actions deployer"
}

# The runtime signs download/upload addresses as itself (IAM signBlob), so it needs this on its own account.
resource "google_service_account_iam_member" "app_signs_for_itself" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.app.email}"
}

# The database is Neon (outside Google Cloud): DATABASE_URL (pooled, for the app) and DATABASE_URL_UNPOOLED (direct, for migrations and backups) are given as variables below.

# ------------------------------------------------------------------ file storage
resource "google_storage_bucket" "uploads" {
  name                        = "${var.project_id}-${local.name}-uploads"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"   # files are only reachable through the app (public ones) or signed addresses (private ones)
  versioning { enabled = true }
  soft_delete_policy { retention_duration_seconds = 604800 }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action { type = "Delete" }
  }
  cors {   # browsers PUT files straight to the bucket
    origin          = [var.app_url]
    method          = ["PUT", "GET", "HEAD"]
    response_header = ["Content-Type", "x-goog-content-length-range", "Content-Length"]
    max_age_seconds = 3600
  }
  depends_on = [google_project_service.apis]
}
resource "google_storage_bucket_iam_member" "app_uploads" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}
# objectAdmin cannot read bucket metadata, and the health check calls bucket.exists() (storage.buckets.get).
# Without this the check reports storage as down and Cloud Run never marks the service ready.
resource "google_storage_bucket_iam_member" "app_uploads_bucket_reader" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.app.email}"
}

# Independent backup copy: another region, retention that even an admin cannot shorten once locked.
resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-${local.name}-backups"
  location                    = var.backup_region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  retention_policy {
    retention_period = var.backup_retention_days * 86400
    is_locked        = var.lock_backup_retention
  }
  depends_on = [google_project_service.apis]
}
resource "google_storage_bucket_iam_member" "backup_write" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectUser"   # create and read; with a retention policy nothing can be deleted early
  member = "serviceAccount:${google_service_account.backup.email}"
}
resource "google_storage_bucket_iam_member" "backup_read_uploads" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.backup.email}"
}

# ------------------------------------------------------------------ app
locals {
  env = {
    NODE_ENV           = "production"
    APP_URL            = var.app_url
    TRUST_PROXY        = "1"   # Cloud Run's front end is one proxy hop; raise to 2 behind your own load balancer
    STORAGE_DRIVER     = "gcs"
    GCS_BUCKET         = google_storage_bucket.uploads.name
    BACKUP_BUCKET      = google_storage_bucket.backups.name
    DB_POOL_MAX        = tostring(var.db_pool_max)
    RATE_LIMIT_STORE   = "postgres"
    MAIL_TRANSPORT     = "smtp"
    MAIL_FROM          = var.mail_from
    SMTP_HOST          = var.smtp_host
    SMTP_PORT          = tostring(var.smtp_port)
    SMTP_USER          = var.smtp_user
    GOOGLE_CLIENT_ID   = var.google_client_id
    INTERNAL_AUDIENCE  = var.app_url
    INTERNAL_INVOKER_EMAIL = google_service_account.scheduler.email
    LOG_LEVEL          = "info"
    SMTP_SECURE        = tostring(var.smtp_port == 465)
    BETTERSTACK_INGESTING_HOST = var.betterstack_ingesting_host
  }
}

resource "google_cloud_run_v2_service" "app" {
  name                = local.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true
  template {
    service_account = google_service_account.app.email
    timeout         = "120s"
    scaling {
      min_instance_count = 1   # no cold start for the first visitor; costs one always-on instance
      max_instance_count = var.max_instances
    }
    max_instance_request_concurrency = 40
    containers {
      image = var.image
      ports { container_port = 8080 }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = false   # CPU stays allocated, so mail delivery after a response is not throttled
      }
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = "/api/health" }
        period_seconds    = 5
        failure_threshold = 12
      }
      liveness_probe {
        http_get { path = "/api/health" }
        period_seconds = 30
      }
    }
  }
  # The deploy workflow ships new images; Terraform must not roll them back.
  # The service-level `scaling` block is filled in by Google (zeros) and shows as a permanent diff; the real limits are in template.scaling.
  lifecycle { ignore_changes = [client, client_version, scaling, template[0].containers[0].image] }
  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.app,
    google_storage_bucket_iam_member.app_uploads,
    google_storage_bucket_iam_member.app_uploads_bucket_reader,
  ]
}

# The site is public; the scheduler endpoints under /api/internal check Google's identity token themselves.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_domain_mapping" "domain" {
  count    = var.domain != "" ? 1 : 0
  name     = var.domain
  location = var.region
  metadata { namespace = var.project_id }
  spec { route_name = google_cloud_run_v2_service.app.name }
}

# ------------------------------------------------------------------ jobs: migrate (every release) and backup (nightly)
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${local.name}-migrate"
  location            = var.region
  deletion_protection = false
  template {
    template {
      service_account = google_service_account.app.email
      timeout         = "600s"
      max_retries     = 0
      containers {
        image   = var.image
        command = ["sh", "-c", "node src/scripts/migrate.js && node src/scripts/encrypt-totp-secrets.js"]
        dynamic "env" {
          for_each = local.env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.s[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  lifecycle { ignore_changes = [client, client_version, template[0].template[0].containers[0].image] }
  depends_on = [google_secret_manager_secret_version.s, google_secret_manager_secret_iam_member.app]
}

resource "google_cloud_run_v2_job" "backup" {
  name                = "${local.name}-backup"
  location            = var.region
  deletion_protection = false
  template {
    template {
      service_account = google_service_account.backup.email
      timeout         = "3000s"
      max_retries     = 1
      containers {
        image   = var.image
        command = ["node", "src/scripts/backup.js"]
        resources { limits = { cpu = "1", memory = "1Gi" } }
        dynamic "env" {
          for_each = local.env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.backup_secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.s[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  lifecycle { ignore_changes = [client, client_version, template[0].template[0].containers[0].image] }
  depends_on = [google_secret_manager_secret_version.s, google_secret_manager_secret_iam_member.backup]
}
