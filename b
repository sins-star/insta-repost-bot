#!/usr/bin/env bash
#
# ONE PASTE. From any shell, in any directory, with or without a clone:
#
#   bash <(curl -sL https://raw.githubusercontent.com/sins-star/insta-repost-bot/main/b)
#
# Named `b` and not `bootstrap.sh` on purpose: every character here is a
# character that has to survive a phone keyboard, and this one line is the
# whole install.
#
# Why this exists at all. `./go` assumes you are already sitting inside a
# clone of this repo — which is exactly the assumption that kept failing. A
# Cloud Shell that timed out and reconnected drops you in $HOME with no clone;
# the Google Cloud mobile app opens a shell that has never had one. `cd`-ing to
# the right place first is one more thing to type correctly, so this does it.
set -euo pipefail

DIR="$HOME/insta-repost-bot"
REPO="https://github.com/sins-star/insta-repost-bot.git"

echo ""
echo "Instagram → Telegram reposter — one-paste install"
echo "──────────────────────────────────────────────────"

if [ -d "$DIR/.git" ]; then
  echo "Found the code already here — updating it…"
  git -C "$DIR" fetch --quiet origin main
  # Hard reset rather than pull: a half-finished earlier attempt can leave the
  # clone dirty, and a merge conflict at this point is unfixable on a phone.
  git -C "$DIR" reset --hard --quiet origin/main
else
  echo "Fetching the code…"
  rm -rf "$DIR"
  git clone --quiet "$REPO" "$DIR"
fi

cd "$DIR"
# A fresh clone keeps the executable bit, but a zip download or a restored
# Cloud Shell home directory may not.
chmod +x b go deploy.sh setup-autodeploy.sh 2>/dev/null || true

echo "Code is at: $DIR"
exec ./go
