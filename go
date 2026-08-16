#!/usr/bin/env bash
#
# The whole thing, in four keystrokes:  ./go
#
# Exists because Cloud Shell on a phone will not paste, so every character the
# owner has to type is a character that can go wrong. This pulls the latest
# code, sets up auto-deploy the first time, and deploys.
#
# The body is wrapped in braces so bash parses the entire file before running
# any of it — otherwise `git pull` could rewrite this script mid-execution and
# bash would carry on reading from the new bytes at the old offset.
{
  set -euo pipefail
  cd "$(dirname "$0")"

  echo ""
  echo "Getting the latest code…"
  git pull --quiet || echo "  (could not pull — carrying on with what is here)"

  # Auto-deploy only needs setting up once. Detect it rather than asking.
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
  ALREADY=""
  if [ -n "$PROJECT_ID" ]; then
    ALREADY=$(gcloud iam service-accounts describe \
      "github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
      --format='value(email)' 2>/dev/null || true)
  fi

  if [ -z "$ALREADY" ]; then
    ./setup-autodeploy.sh
  else
    echo "Auto-deploy already set up — skipping that."
  fi

  ./deploy.sh
  exit $?
}
