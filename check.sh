#!/usr/bin/env bash
#
# Health check for the Cloud Run deployment. Run in Cloud Shell:
#
#   ./check.sh
#
# Read-only: prints where the service is, whether it answers, whether Telegram
# knows where to reach it, and the recent logs — then a one-line verdict.
# Safe to screenshot: the bot token itself is never printed.
set -uo pipefail

REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-repost-bot}"

line() { echo ""; echo "── $1 ─────────────────────────"; }

line "service"
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(status.url)' 2>/dev/null || true)
if [ -z "$URL" ]; then
  echo "VERDICT: no Cloud Run service called '$SERVICE' in $REGION."
  echo "Fix: run ./deploy.sh"
  exit 1
fi
echo "$URL"

line "is the bot alive?"
HEALTH=$(curl -sS -m 20 "$URL/health" 2>&1 || true)
echo "${HEALTH:-(no answer)}"

line "does Telegram know where it lives?"
TOKEN=$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json \
  | jq -r '.spec.template.spec.containers[0].env[] | select(.name=="BOT_TOKEN") | .value' 2>/dev/null || true)
WEBHOOK="{}"
if [ -n "$TOKEN" ]; then
  WEBHOOK=$(curl -sS -m 20 "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" || echo '{}')
  # The webhook URL contains only a hash derived from the token — printable.
  echo "$WEBHOOK" | jq '{ok, url: .result.url, pending: .result.pending_update_count, last_error: .result.last_error_message, last_error_at: .result.last_error_date}' 2>/dev/null || echo "$WEBHOOK"
else
  echo "(could not read the deployed token)"
fi

line "recent logs"
gcloud run services logs read "$SERVICE" --region "$REGION" --limit 25 2>/dev/null | tail -25

line "verdict"
HOOK_URL=$(echo "$WEBHOOK" | jq -r '.result.url // ""' 2>/dev/null || echo "")
TG_OK=$(echo "$WEBHOOK" | jq -r '.ok // false' 2>/dev/null || echo "false")
LAST_ERR=$(echo "$WEBHOOK" | jq -r '.result.last_error_message // ""' 2>/dev/null || echo "")

if [ "$TG_OK" != "true" ]; then
  echo "Telegram rejected the deployed token — it is wrong or was revoked."
  echo "Fix: run ./deploy.sh again and paste the CURRENT token from @BotFather."
elif [ -z "$HOOK_URL" ]; then
  echo "The bot never told Telegram its address (no webhook registered)."
  echo "Fix: run ./deploy.sh again — it re-registers on boot."
elif [[ "$HOOK_URL" != "$URL"* ]]; then
  echo "Telegram is sending updates to the WRONG address:"
  echo "  webhook: $HOOK_URL"
  echo "  service: $URL"
  echo "Fix: run ./deploy.sh again — it repoints the webhook."
elif [ -n "$LAST_ERR" ]; then
  echo "Telegram reaches the right address but got an error: $LAST_ERR"
  echo "The logs above should say why. Screenshot this whole output."
elif [[ "$HEALTH" == *'"ok":true'* ]]; then
  echo "Everything checks out: bot alive, webhook right, no delivery errors."
  echo "Message the bot /claim now — the reply can take up to a minute."
else
  echo "Webhook is right but the service did not answer /health."
  echo "Screenshot this whole output, especially the logs."
fi
echo ""
