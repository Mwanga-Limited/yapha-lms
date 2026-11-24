# Contributing to Yapha LMS

This is a proprietary Mwanga Limited project. Contributions are accepted from Mwanga staff and contractors under written agreement.

1. Branch from `main`: `feature/<short-name>` or `fix/<short-name>`.
2. Keep changes focused. Update `CHANGELOG.md` under "Unreleased" and API.md / README.md when behaviour changes.
3. Before opening a PR run: `cd backend && npm test`, `cd frontend && npm run typecheck && npm run lint && npm test`.
4. Never commit secrets, `.env` files or real user data. Use `.env.example` for new settings.
5. Changes to migrations, `db.js`, security code, `deploy/` or CI need a review from the code owners (`.github/CODEOWNERS`).
6. Database changes go in a new numbered file in `backend/migrations/`; never edit one that has been released.

Questions: tech@mwanga.ng
