# Yapha LMS: TODO

Owner: Mwanga Limited engineering (tech@mwanga.ng). Tick items off and note the PR/commit when done.

## Documentation and compliance
- [ ] **Privacy notice / data-processing notes.** Cover what learner data is stored per tenant, retention, sub-processors (Google Cloud, email provider), data-subject requests, and Nigeria Data Protection Act (NDPA) obligations. File: `PRIVACY.md` plus a user-facing page in the app.
- [ ] **Architecture overview.** Tenancy and row-level security model, request flow, deployment topology (Cloud Run, Neon, GCS), diagrams. File: `ARCHITECTURE.md`.
- [ ] **Third-party licence report / SBOM.** Generate for backend and frontend (e.g. `license-checker`, CycloneDX), attach to releases, and link from `NOTICE`.
- [ ] **Support and SLA page.** Support channels (tech@mwanga.ng), hours, severity levels, response and resolution targets, escalation. File: `SUPPORT.md`.

## Engineering
- [ ] Create the `@Mwanga-Limited/maintainers` GitHub team referenced in `.github/CODEOWNERS`.
