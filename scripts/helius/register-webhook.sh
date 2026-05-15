#!/usr/bin/env bash
# register-webhook.sh — register a Helius enhanced webhook for said-cloud.
#
# Creates a new webhook on the Helius account that forwards every
# transaction touching any of our watched addresses to said-cloud's
# /v1/webhooks/helius endpoint. Helius requires ≥1 address at creation,
# so we seed with the System Program (11111…). said-cloud's startup
# reconcile replaces the list with real agent_wallets addresses on next
# boot, so the placeholder only exists for the gap between webhook
# creation and the next said-cloud deploy.
#
# Usage:
#   HELIUS_API_KEY=... \
#   WEBHOOK_URL=https://ghola-api.onrender.com/v1/webhooks/helius \
#   [AUTH_HEADER=<shared-secret>] \
#     ./scripts/helius/register-webhook.sh
#
# If AUTH_HEADER is unset, a fresh 32-byte hex secret is generated and
# echoed back in the Render-env-var block at the end.
#
# Output: webhookID + the three env vars to paste into Render.
# Exit:   non-zero on any HTTP non-2xx from Helius.

set -euo pipefail

: "${HELIUS_API_KEY:?HELIUS_API_KEY must be set (get one at dashboard.helius.dev)}"
: "${WEBHOOK_URL:?WEBHOOK_URL must be set (e.g. https://ghola-api.onrender.com/v1/webhooks/helius)}"

if [[ -z "${AUTH_HEADER:-}" ]]; then
  AUTH_HEADER="$(openssl rand -hex 32)"
  GENERATED_AUTH=true
else
  GENERATED_AUTH=false
fi

API="https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}"

# Build payload via jq so any special chars in URL/auth are escaped.
PAYLOAD="$(jq -n \
  --arg url "${WEBHOOK_URL}" \
  --arg auth "${AUTH_HEADER}" \
  '{
    webhookURL: $url,
    transactionTypes: ["ANY"],
    accountAddresses: ["11111111111111111111111111111111"],
    webhookType: "enhanced",
    authHeader: $auth
  }')"

# Capture body + HTTP status separately so we can fail loudly on non-2xx.
TMP_BODY="$(mktemp)"
trap 'rm -f "${TMP_BODY}"' EXIT

HTTP_CODE="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' \
  -X POST "${API}" \
  -H 'Content-Type: application/json' \
  -d "${PAYLOAD}")"

if [[ "${HTTP_CODE}" -lt 200 || "${HTTP_CODE}" -ge 300 ]]; then
  echo "ERROR: Helius returned HTTP ${HTTP_CODE}" >&2
  cat "${TMP_BODY}" >&2
  echo >&2
  exit 1
fi

WEBHOOK_ID="$(jq -r '.webhookID // empty' < "${TMP_BODY}")"
if [[ -z "${WEBHOOK_ID}" ]]; then
  echo "ERROR: response did not include webhookID:" >&2
  cat "${TMP_BODY}" >&2
  exit 1
fi

echo "Created webhook ${WEBHOOK_ID}"
if [[ "${GENERATED_AUTH}" == "true" ]]; then
  echo "(generated a fresh AUTH_HEADER — copy it now, it is not stored)"
fi
echo
echo "── Paste these into Render (or your env source) ──"
echo "HELIUS_API_KEY=${HELIUS_API_KEY}"
echo "HELIUS_WEBHOOK_ID=${WEBHOOK_ID}"
echo "HELIUS_WEBHOOK_AUTH=${AUTH_HEADER}"
