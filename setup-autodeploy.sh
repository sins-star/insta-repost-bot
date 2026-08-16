#!/usr/bin/env bash
#
# Run ONCE. After this, every push to main deploys itself — no Cloud Shell,
# no gcloud, nothing to open.
#
#   ./setup-autodeploy.sh
#
# It teaches Google to trust GitHub Actions runs from this one repository, via
# Workload Identity Federation. Deliberately NOT a service-account key: a key
# would be a long-lived secret to copy into GitHub and to leak later. WIF hands
# out short-lived credentials and only ever to this repo, so there is no secret
# to paste anywhere — which is also why this needs no copying on a phone.
set -euo pipefail

REPO="${REPO:-sins-star/insta-repost-bot}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-github}"
SA_NAME="${SA_NAME:-github-deployer}"

echo ""
echo "Auto-deploy setup — run once, then never again"
echo "───────────────────────────────────────────────"

ACTIVE=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)
if [ -z "$ACTIVE" ]; then
  # Cloud Shell issues credentials on demand: the first gcloud command that
  # actually calls an API pops an "Authorize Cloud Shell" dialog. `gcloud auth
  # list` reads a local file and calls nothing, so it never triggers that — it
  # just reports "no account" and looks like a dead end. Ask for something real.
  echo "This shell has no credentials yet — asking Cloud Shell for them."
  echo "👉 If a dialog appears, tap AUTHORIZE."
  echo ""
  gcloud projects list --limit=1 >/dev/null 2>&1 || true
  ACTIVE=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)
fi
if [ -z "$ACTIVE" ]; then
  echo "✖ Still no active Google account in this shell."
  echo "  Close this tab, open https://shell.cloud.google.com fresh (not in"
  echo "  EPHEMERAL mode), and run the install line again."
  exit 1
fi
echo "Account: $ACTIVE"

# An ephemeral Cloud Shell — or any freshly reset one — starts with no project
# selected, and `gcloud projects describe ""` then fails with a message that
# says nothing about the real cause. Resolve it the way deploy.sh already does.
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  mapfile -t PROJECTS < <(gcloud projects list --format='value(projectId)' 2>/dev/null)
  if [ "${#PROJECTS[@]}" -eq 1 ]; then
    PROJECT_ID="${PROJECTS[0]}"
    gcloud config set project "$PROJECT_ID" --quiet >/dev/null
  elif [ "${#PROJECTS[@]}" -eq 0 ]; then
    echo "✖ No Google Cloud project is visible to this account."
    exit 1
  else
    echo "More than one project — pick the one to deploy into:"
    select PROJECT_ID in "${PROJECTS[@]}"; do [ -n "$PROJECT_ID" ] && break; done
    gcloud config set project "$PROJECT_ID" --quiet >/dev/null
  fi
fi
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project: $PROJECT_ID ($PROJECT_NUMBER)"
echo "Repo:    $REPO"
echo ""

echo "1/4 Enabling the services this needs…"
gcloud services enable \
  iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com --quiet

echo "2/4 Creating the deployer identity…"
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="GitHub Actions deployer" --quiet 2>/dev/null || true

for role in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.admin \
  roles/storage.admin \
  roles/iam.serviceAccountUser \
  roles/serviceusage.serviceUsageConsumer
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" \
    --condition=None --quiet >/dev/null
done

echo "3/4 Teaching Google to trust GitHub Actions from $REPO…"
gcloud iam workload-identity-pools create "$POOL" \
  --location=global --display-name="GitHub" --quiet 2>/dev/null || true

# The attribute condition is the security boundary: without it, ANY GitHub
# repository in the world could mint credentials for this project.
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --quiet 2>/dev/null || true

echo "4/4 Allowing that repo — and only that repo — to act as the deployer…"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  --quiet >/dev/null

echo ""
echo "✅ Auto-deploy is set up."
echo ""
echo "The values baked into .github/workflows/deploy.yml must match:"
echo "  provider: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "  identity: ${SA_EMAIL}"
echo ""
echo "From now on, every push to main deploys itself. Nothing to open."
