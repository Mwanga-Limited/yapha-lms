output "service_url" { value = google_cloud_run_v2_service.app.uri }
output "artifact_registry" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "uploads_bucket" { value = google_storage_bucket.uploads.name }
output "backup_bucket" { value = google_storage_bucket.backups.name }
output "github_wif_provider" {
  description = "Set as GCP_WORKLOAD_IDENTITY_PROVIDER in the GitHub repository variables."
  value       = google_iam_workload_identity_pool_provider.github.name
}
output "github_deployer_sa" {
  description = "Set as GCP_DEPLOYER_SA in the GitHub repository variables."
  value       = google_service_account.deployer.email
}
output "dns_records" {
  value = var.domain != "" ? google_cloud_run_domain_mapping.domain[0].status[0].resource_records : []
}
