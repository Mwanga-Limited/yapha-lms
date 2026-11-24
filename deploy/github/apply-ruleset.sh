#!/usr/bin/env bash
# Creates the branch protection ruleset on GitHub. Needs the gh CLI signed in as a repository admin. Review ruleset.json first.
#   ./deploy/github/apply-ruleset.sh owner/repo
#
# Notes on the ruleset:
# - History must be linear, so pull requests are squash- or rebase-merged (merge commits are refused). This script also turns
#   merge commits off in the repository settings so the Merge button matches.
# - Repository admins can bypass it, but only through a pull request (bypass_mode "pull_request"), for emergencies.
# - The status check names (backend, frontend, image, e2e, analyze) are the job ids in .github/workflows/. Keep them in step.
# - The CodeQL "analyze" check needs GitHub Advanced Security on a private repository; remove it from ruleset.json if you do not have that.
set -euo pipefail
repo="${1:?usage: apply-ruleset.sh owner/repo}"
gh api -X PATCH "repos/$repo" -F allow_merge_commit=false -F allow_squash_merge=true -F allow_rebase_merge=true -F delete_branch_on_merge=true >/dev/null
gh api -X POST "repos/$repo/rulesets" --input "$(dirname "$0")/ruleset.json"
echo "ruleset created. Also: Settings > Environments > production > Required reviewers."
echo "Create the @Mwanga-Limited/maintainers team (write access), or CODEOWNERS review can never be satisfied."
