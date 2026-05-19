#!/usr/bin/env bash
set -euo pipefail

WEB_BASE_URL="${GHOLA_WEB_URL:-https://ghola.xyz}"
THUMPER_BASE_URL="${THUMPER_BASE_URL:-https://thumper-cloud.onrender.com}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  }
}

need cargo
need curl
need jq

printf 'Running no-funds shielded settlement fixture tests...\n'
cargo test -p thumper-cloud shielded_fixture_canary -- --test-threads=1 --nocapture

printf 'Checking public web Aleo verifier health redaction...\n'
web_health="$(curl -fsS "${WEB_BASE_URL}/api/aleo-shielded/health")"
printf '%s' "$web_health" | jq -e '
  .configured == true
  and .fail_closed == true
  and .auth_required == true
  and .adapter_auth_configured == true
  and .recipient_configured == true
  and (.recipient_preview | type == "string")
  and (has("recipient") | not)
' >/dev/null

printf 'Checking unauthenticated verifier stays fail-closed...\n'
verify_body="$(mktemp)"
verify_code="$(
  curl -sS -o "$verify_body" -w '%{http_code}' \
    -X POST "${WEB_BASE_URL}/api/aleo-shielded/verify" \
    -H 'content-type: application/json' \
    --data '{
      "provider": "aleo",
      "network": "aleo:mainnet",
      "asset": "USDCx",
      "destination": "aleo1fixture0000000000000000000000000000000000000000000000000",
      "required_amount": 1,
      "proof": {
        "tx_signature": "at1fixture000000000000",
        "nullifier_hex": "fixture-nullifier"
      }
    }'
)"
if [[ "$verify_code" != "401" ]]; then
  printf 'expected unauthenticated verifier status 401, got %s\n' "$verify_code" >&2
  cat "$verify_body" >&2
  exit 1
fi
jq -e '.settled == false and (.error | test("authenticated|auth"; "i"))' "$verify_body" >/dev/null
rm -f "$verify_body"

printf 'Checking thumper payment rail health...\n'
payments="$(curl -fsS "${THUMPER_BASE_URL}/health/payments")"
printf '%s' "$payments" | jq -e '
  .rails.aleo_usdcx_shielded.ready == true
  and .rails.aleo_usdcx_shielded.configured == true
  and .rails.aleo_usdcx_shielded.adapter_auth_configured == true
  and .rails.aleo_usdcx_shielded.fallback_allowed == false
  and .rails.aleo_usdcx_shielded.recipient_configured == true
  and (.rails.aleo_usdcx_shielded.recipient_preview | type == "string")
  and (.rails.aleo_usdcx_shielded | has("recipient") | not)
' >/dev/null

printf 'Checking thumper privacy guardrails...\n'
privacy="$(curl -fsS "${THUMPER_BASE_URL}/health/privacy")"
printf '%s' "$privacy" | jq -e '
  .strict_local_default == true
  and .approval_enforcement_enabled == true
  and .raw_approval_nonce_hashing_enabled == true
  and .private_rail_fail_closed == true
  and .remote_compute_approval_enabled == true
  and .task_result_redaction_enabled == true
  and (.blocking_reasons | length == 0)
' >/dev/null

printf 'Private USDCx no-funds canary passed.\n'
