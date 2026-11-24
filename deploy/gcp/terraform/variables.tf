variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-east4"
}
variable "backup_region" {
  description = "A DIFFERENT region from `region`, so one regional outage cannot take both the data and its backup."
  type        = string
  default     = "us-east1"
}
variable "image" {
  description = "Full image path, e.g. europe-west1-docker.pkg.dev/PROJECT/yapha/app:GIT_SHA (set by the deploy workflow)."
  type        = string
}
variable "app_url" {
  description = "Public address of the app, no trailing slash (used in emails). Example: https://learn.example.com"
  type        = string
}
variable "domain" {
  description = "Custom domain mapped to the service (leave empty to use the run.app address)."
  type        = string
  default     = ""
}
variable "alert_email" {
  description = "Who is told when an alert fires."
  type        = string
}
variable "mail_from" {
  description = "Sender of every email, e.g. \"Yapha <no-reply@yapha.com>\". No default on purpose: SPF, DKIM and DMARC must be set up for exactly this domain."
  type        = string
}
variable "smtp_host" {
  description = "Resend: smtp.resend.com"
  type        = string
  default     = "smtp.resend.com"
}
variable "smtp_port" {
  description = "465 (implicit TLS) or 587 (STARTTLS)."
  type        = number
  default     = 465
}
variable "smtp_user" {
  description = "Resend always uses the user name \"resend\"; the password is the API key."
  type        = string
  default     = "resend"
}
variable "google_client_id" {
  type    = string
  default = ""
}
variable "max_instances" {
  description = "Cloud Run instance cap. (max_instances x db_pool_max) must stay well under the Neon pooler/compute connection limit."
  type        = number
  default     = 3
}
variable "db_pool_max" {
  description = "Connections per instance. Through Neon's pooler these are cheap client connections."
  type        = number
  default     = 8
}
variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to deploy (Workload Identity Federation)."
  type        = string
}
variable "backup_retention_days" {
  description = "Locked retention of the independent backup bucket. Backups cannot be deleted before this, by anyone."
  type        = number
  default     = 30
}
variable "lock_backup_retention" {
  description = "PERMANENTLY locks the retention policy (cannot be shortened or removed). Turn on once you are sure."
  type        = bool
  default     = false
}
variable "smtp_password" {
  description = "The Resend API key (re_...). Pass with TF_VAR_smtp_password."
  type      = string
  sensitive = true
  default   = ""
}
variable "database_url" {
  description = "Neon POOLED connection string (host contains -pooler). Used by the app. Pass with TF_VAR_database_url."
  type        = string
  sensitive   = true
}
variable "database_url_unpooled" {
  description = "Neon DIRECT connection string (same without -pooler). Used by migrations and backups. Pass with TF_VAR_database_url_unpooled."
  type        = string
  sensitive   = true
}
variable "betterstack_source_token" {
  type      = string
  sensitive = true
  default   = ""
}
variable "betterstack_errors_dsn" {
  description = "Backend error-tracking DSN."
  type        = string
  sensitive   = true
  default     = ""
}
variable "betterstack_ingesting_host" {
  type    = string
  default = ""
}