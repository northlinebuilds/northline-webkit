#!/usr/bin/env bash
# Deploy Northline WebKit to Cloudflare Workers (free plan). 
# Prereq: a Cloudflare account,
# then either `npx wrangler login`, or export CLOUDFLARE_API_TOKEN (Workers edit scope).
set -euo pipefail
cd "$(dirname "$0")/.."
N22="$(cat .node22path 2>/dev/null || true)"; [ -n "$N22" ] && export PATH="$N22:$PATH"
export WRANGLER_SEND_METRICS=false
npx tsc -p . && npx vitest run
# Facilitator: payai (default, no key) or cdp (needs: npx wrangler secret put CDP_API_KEY_ID / CDP_API_KEY_SECRET; set FACILITATOR=cdp)
OUT=$(npx wrangler deploy 2>&1 | tee /dev/stderr)
URL=$(echo "$OUT" | grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -z "$URL" ] && { echo "could not find workers.dev URL in output"; exit 1; }
echo "Deployed at $URL; redeploying with PUBLIC_BASE_URL set so 402 challenges carry absolute resource URLs"
npx wrangler deploy --var "PUBLIC_BASE_URL:$URL" >/dev/null
echo "$URL" > .deployed-url
node scripts/check-live.mjs "$URL"
