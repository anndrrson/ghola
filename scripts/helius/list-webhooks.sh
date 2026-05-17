#!/usr/bin/env bash
# list-webhooks.sh — list every webhook on the Helius account.
#
# Useful before running register-webhook.sh to check whether one
# already exists (and to grab its `webhookID`).
#
# Usage:
#   HELIUS_API_KEY=... ./scripts/helius/list-webhooks.sh

set -euo pipefail

: "${HELIUS_API_KEY:?HELIUS_API_KEY must be set}"

API="https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}"

TMP_BODY="$(mktemp)"
trap 'rm -f "${TMP_BODY}"' EXIT

HTTP_CODE="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' "${API}")"

if [[ "${HTTP_CODE}" -lt 200 || "${HTTP_CODE}" -ge 300 ]]; then
  echo "ERROR: Helius returned HTTP ${HTTP_CODE}" >&2
  cat "${TMP_BODY}" >&2
  echo >&2
  exit 1
fi

jq '.' < "${TMP_BODY}"
