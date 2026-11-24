terraform {
  required_version = ">= 1.7"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Keep state in a bucket you create by hand first (see deploy/gcp/DEPLOY-GUIDE.md):
  #   terraform init -backend-config="bucket=<your-state-bucket>"
  backend "gcs" { prefix = "yapha-lms" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
