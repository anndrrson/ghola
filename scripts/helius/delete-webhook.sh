#!/usr/bin/env bash
# delete-webhook.sh — delete a single Helius webhook by id.
#
# Usage:
#   HELIUS_API_KEY=... ./scripts/helius/delete-webhook.sh <webhook-id>

set -euo pipefail

: "${HELIUS_API_KEY:?HELIUS_API_KEY must be set}"

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: HELIUS_API_KEY=... $0 <webhook-id>" >&2
  exit 2
fi

WEBHOOK_ID="$1"
API="https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}"

TMP_BODY="$(mktemp)"
trap 'rm -f "${TMP_BODY}"' EXIT

HTTP_CODE="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -X DELETE "${API}")"

if [[ "${HTTP_CODE}" -lt 200 || "${HTTP_CODE}" -ge 300 ]]; then
  echo "ERROR: Helius returned HTTP ${HTTP_CODE}" >&2
  cat "${TMP_BODY}" >&2
  echo >&2
  exit 1
fi

echo "Deleted webhook ${WEBHOOK_ID}"
