#!/bin/sh
# Runs once, when the database volume is first created. The application connects as a NON-superuser that owns its
# database (CREATEROLE lets `migrate` create the restricted `yapha_app` role). PostgreSQL's row-level security
# then applies to the app's connection, as designed.
set -e
psql -v ON_ERROR_STOP=1 -v pw="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE yapha LOGIN CREATEROLE PASSWORD :'pw';
CREATE DATABASE yapha_lms OWNER yapha;
SQL
