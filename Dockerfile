# Yapha LMS: one image that serves the API and the built frontend.
#   docker build -t yapha-lms .
# Run `node src/scripts/migrate.js` as a separate release step (see docker-compose.yml and deploy/RUNBOOK.md).

FROM node:26-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Public values baked into the browser bundle (see frontend/.env.example)
ARG VITE_BETTERSTACK_ERRORS_DSN
ARG VITE_RELEASE
RUN npm run build
# Source maps are for error tracking only: upload them to Better Stack first (see README), never serve them
RUN find dist -name "*.map" -delete

FROM node:26-alpine AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine
# postgresql-client: pg_dump / psql for the backup and restore jobs (the same image runs the app, migrations and backups).
# The client must be the same major version as the server (Neon runs 18): pg_dump refuses to dump a newer server.
RUN apk add --no-cache postgresql18-client
ENV NODE_ENV=production \
    PORT=8080 \
    UPLOAD_DIR=/data/uploads \
    FRONTEND_DIST=/app/frontend/dist
WORKDIR /app/backend
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/assets ./assets
COPY deploy/backup.sh deploy/restore.sh /app/deploy/
COPY --from=frontend /app/frontend/dist /app/frontend/dist
# Local-disk uploads (STORAGE_DRIVER=disk) live on a volume at /data/uploads; on Google Cloud the driver is gcs and no disk is used.
# The app never runs as root.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME /data/uploads
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server.js"]
