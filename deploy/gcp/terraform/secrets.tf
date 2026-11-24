# Secret Manager: every secret the app, the migrate job and the backup job read as environment variables.
# JWT_SECRET, TOTP_ENCRYPTION_KEY, DATA_ENCRYPTION_KEY and METRICS_TOKEN are generated here and live only in Secret Manager
# (and in Terraform state: keep the state bucket private, as set up in the deploy guide). The rest come from variables.
# BACK UP TOTP_ENCRYPTION_KEY and DATA_ENCRYPTION_KEY outside Google Cloud too: if either is lost, authenticator-app secrets
# (TOTP) or saved Paystack keys (DATA) cannot be read again. Never change them once real data exists.

resource "random_password" "jwt" {
  length  = 64
  special = false
}
resource "random_password" "data_key" {
  length  = 64
  special = false
}
resource "random_id" "totp_key" {
  byte_length = 32   # the app wants 32 random bytes, base64
}
resource "random_id" "metrics_token" {
  byte_length = 24
}

locals {
  # Optional secrets are only created when a value is given (Secret Manager does not accept an empty value).
  secret_names = concat(
    ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "JWT_SECRET", "TOTP_ENCRYPTION_KEY", "DATA_ENCRYPTION_KEY", "METRICS_TOKEN"],
    nonsensitive(var.smtp_password != "") ? ["SMTP_PASS"] : [],
    nonsensitive(var.betterstack_source_token != "") ? ["BETTERSTACK_SOURCE_TOKEN"] : [],
    nonsensitive(var.betterstack_errors_dsn != "") ? ["BETTERSTACK_ERRORS_DSN"] : [],
  )
  secret_values = {
    DATABASE_URL             = var.database_url
    DATABASE_URL_UNPOOLED    = var.database_url_unpooled
    JWT_SECRET               = random_password.jwt.result
    TOTP_ENCRYPTION_KEY      = random_id.totp_key.b64_std
    DATA_ENCRYPTION_KEY      = random_password.data_key.result
    METRICS_TOKEN            = random_id.metrics_token.hex
    SMTP_PASS                = var.smtp_password
    BETTERSTACK_SOURCE_TOKEN = var.betterstack_source_token
    BETTERSTACK_ERRORS_DSN   = var.betterstack_errors_dsn
  }
  # Environment variable name -> secret, for the service and the migrate job; the backup job does not need the metrics token.
  secret_env        = { for k in local.secret_names : k => k }
  backup_secret_env = { for k in local.secret_names : k => k if k != "METRICS_TOKEN" }
}

resource "google_secret_manager_secret" "s" {
  for_each  = toset(local.secret_names)
  secret_id = "${local.name}-${lower(replace(each.key, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "s" {
  for_each    = toset(local.secret_names)
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = local.secret_values[each.key]
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = toset(local.secret_names)
  secret_id = google_secret_manager_secret.s[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}
resource "google_secret_manager_secret_iam_member" "backup" {
  for_each  = toset([for k in local.secret_names : k if k != "METRICS_TOKEN"])
  secret_id = google_secret_manager_secret.s[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backup.email}"
}
