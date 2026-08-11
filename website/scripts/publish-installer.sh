#!/usr/bin/env bash
# Publish a new installer release, end to end:
#   1. rebuild the desktop installer (targets the production site)
#   2. upload it to the Vercel Blob store (public)
#   3. point DOWNLOAD_URL at the new blob URL
#   4. redeploy the website to production
#
# Run from the website/ dir:  bash scripts/publish-installer.sh
# Requires: the Vercel CLI logged in, the project linked, and a BLOB_READ_WRITE_TOKEN
# in .env.local (created by `vercel blob create-store`).

set -euo pipefail

WEBSITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$WEBSITE_DIR/../main-appv2.4-main/main-app11/main-app"
# Fallback if the nested layout differs.
[ -d "$APP_DIR" ] || APP_DIR="$WEBSITE_DIR/../main-app11/main-app"

echo "▶ 1/4  Rebuilding installer in: $APP_DIR"
( cd "$APP_DIR" && npm run build )

EXE="$(ls -t "$APP_DIR"/dist/main-Setup-*.exe 2>/dev/null | head -1)"
[ -n "$EXE" ] || { echo "✖ No installer found in $APP_DIR/dist"; exit 1; }
echo "   built: $EXE"

echo "▶ 2/4  Uploading to Vercel Blob…"
TOKEN="$(grep -E '^BLOB_READ_WRITE_TOKEN=' "$WEBSITE_DIR/.env.local" | head -1 | sed 's/^BLOB_READ_WRITE_TOKEN=//; s/^"//; s/"$//')"
[ -n "$TOKEN" ] || { echo "✖ BLOB_READ_WRITE_TOKEN not found in .env.local"; exit 1; }
OUT="$(cd "$WEBSITE_DIR" && npx --yes vercel blob put "$EXE" --access public --force --rw-token "$TOKEN" 2>&1)"
URL="$(printf '%s' "$OUT" | grep -oE 'https://[^ ]+\.exe' | head -1)"
[ -n "$URL" ] || { echo "✖ Upload failed:"; echo "$OUT"; exit 1; }
echo "   uploaded: $URL"

echo "▶ 3/4  Setting DOWNLOAD_URL…"
( cd "$WEBSITE_DIR"
  npx --yes vercel env rm DOWNLOAD_URL production --yes >/dev/null 2>&1 || true
  printf '%s' "$URL" | npx --yes vercel env add DOWNLOAD_URL production >/dev/null 2>&1
)
echo "   DOWNLOAD_URL updated"

echo "▶ 4/4  Redeploying to production…"
( cd "$WEBSITE_DIR" && npx --yes vercel --prod --yes >/dev/null 2>&1 )
echo "✓ Done. Live installer: $URL"
