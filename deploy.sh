#!/usr/bin/env bash
#
# One-command Cloud Run deploy. Run this in Google Cloud Shell:
#
#   ./deploy.sh
#
# It asks for your bot token, works out everything else itself, and is safe
# to run again — re-running updates the existing service in place.
set -euo pipefail

REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-repost-bot}"

echo ""
echo "Instagram → Telegram reposter — Cloud Run deploy"
echo "─────────────────────────────────────────────────"

# ── the one thing only you know ─────────────────────────────────────────────
if [ -z "${BOT_TOKEN:-}" ]; then
  read -r -p "Paste your bot token from @BotFather: " BOT_TOKEN
fi
if ! printf '%s' "$BOT_TOKEN" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{20,}$'; then
  echo "✖ That doesn't look like a bot token (expected something like 8123456789:AAH...)."
  echo "  Copy it again from @BotFather and re-run ./deploy.sh"
  exit 1
fi

# ── project ──────────────────────────────────────────────────────────────────
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  mapfile -t PROJECTS < <(gcloud projects list --format='value(projectId)' 2>/dev/null)
  if [ "${#PROJECTS[@]}" -eq 1 ]; then
    # A fresh account has exactly one project — use it without asking.
    PROJECT_ID="${PROJECTS[0]}"
    gcloud config set project "$PROJECT_ID" --quiet
  elif [ "${#PROJECTS[@]}" -eq 0 ]; then
    echo "✖ No Google Cloud project found. Finish signup at console.cloud.google.com"
    echo "  (activate the free trial), then run ./deploy.sh again."
    exit 1
  else
    echo "You have more than one project — pick the one to deploy into:"
    select PROJECT_ID in "${PROJECTS[@]}"; do [ -n "$PROJECT_ID" ] && break; done
    gcloud config set project "$PROJECT_ID" --quiet
  fi
fi
echo "Project: $PROJECT_ID"

# ── services ─────────────────────────────────────────────────────────────────
echo "Enabling services (a minute, safe to re-run)…"
if ! gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com storage.googleapis.com --quiet; then
  echo "✖ Could not enable services — usually this means billing isn't active yet."
  echo "  Activate the free trial at console.cloud.google.com/billing, then re-run."
  exit 1
fi

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# Newer Google projects (AI-Studio-created ones especially) do not grant the
# build robot the right to read the source it is asked to build, so the deploy
# dies with PERMISSION_DENIED before anything happens. Granting the standard
# builder role is Google's documented fix; harmless when already granted.
echo "Making sure the build robot may read your code…"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None --quiet >/dev/null 2>&1 \
  || echo "  note: could not pre-grant build permissions — continuing anyway"

# ── the bot's permanent memory: owner, channels, logo, delete-buttons ────────
BUCKET="${PROJECT_ID}-repost-data"
gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" \
  --uniform-bucket-level-access --quiet 2>/dev/null || true

SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-32)
URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

echo ""
echo "Deploying. The first build takes about TEN MINUTES — leave this open."
echo ""

gcloud run deploy "$SERVICE" --source . --region "$REGION" \
  --allow-unauthenticated --quiet \
  --memory 2Gi --cpu 2 --max-instances 1 --timeout 1800 \
  --execution-environment gen2 \
  --add-volume "name=data,type=cloud-storage,bucket=${BUCKET}" \
  --add-volume-mount "volume=data,mount-path=/app/data" \
  --set-env-vars "SERVERLESS=true,BOT_TOKEN=${BOT_TOKEN},WEBHOOK_URL=${URL},WEBHOOK_SECRET=${SECRET},WATERMARK_POSITION=br,WATERMARK_OPACITY=0.8,COVER_EXISTING=true,COVER_WITH_LOGO=true"

# Belt and braces: if the service's real URL differs from the predicted one,
# point the webhook at the real one.
ACTUAL=$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(status.url)')
if [ -n "$ACTUAL" ] && [ "$ACTUAL" != "$URL" ]; then
  gcloud run services update "$SERVICE" --region "$REGION" \
    --update-env-vars "WEBHOOK_URL=${ACTUAL}" --quiet
fi

EXPECT="${ACTUAL:-$URL}"
echo ""
echo "Deployed — now VERIFYING the bot actually came up…"
VERIFIED=""
for i in $(seq 1 12); do
  HOOK=$(curl -s -m 10 "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" \
    | grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$HOOK" ] && [[ "$HOOK" == "$EXPECT"* ]]; then
    VERIFIED=1
    break
  fi
  # Poke the service: a revision that crashed after passing its readiness
  # check only shows itself when something makes it boot again.
  curl -s -m 15 "$EXPECT/health" >/dev/null 2>&1 || true
  sleep 5
done

if [ -z "$VERIFIED" ]; then
  echo ""
  echo "✖ The container deployed, but the bot never announced itself to Telegram."
  echo "  Its own logs explain why — last 30 lines:"
  echo ""
  gcloud run services logs read "$SERVICE" --region "$REGION" --limit 30 2>/dev/null | tail -30
  echo ""
  echo "Screenshot everything above."
  exit 1
fi

echo ""
echo "✅ Deployed AND verified — Telegram confirms it is delivering to this bot."
echo "Now open Telegram and message your bot:"
echo ""
echo "   1. /claim              — you become its owner, permanently"
echo "   2. add it to your channel as an admin (Post messages on)"
echo "   3. send it your logo as a FILE — that becomes the watermark"
echo ""
echo "Then paste an Instagram link. First reply after a quiet spell takes"
echo "about a minute — that's it waking up, and the sleep is why it's free."
