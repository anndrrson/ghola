#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PRIVATE_AGENT_WORKER_URL:-http://127.0.0.1:8787}"
TOKEN="${PRIVATE_AGENT_EXECUTION_TOKEN:-dev}"

health="$(curl -sS "$BASE_URL/health")"
echo "health $health"

recipient="$(curl -fsS "$BASE_URL/.well-known/private-agent-recipient")"
echo "recipient $recipient"

plaintext_status="$(
  curl -sS -o /tmp/ghola-private-agent-worker-plaintext.json -w "%{http_code}" \
    -X POST "$BASE_URL/private-agent/sessions" \
    -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    -H "x-ghola-sealed-execution-required: true" \
    --data '{"version":1,"strategy_id":"strategy_canary","policy_hash":"policy_hash","owner_did":"did:key:zcanary","mode":"capped_session_key","encrypted_strategy_bundle":{"alg":"sealed-provider-v1","ciphertext":"ciphertext","recipient":"phala:cvm:canary","aad":"ghola/private-agent-session-v1"},"prompt":"buy eth"}'
)"
if [[ "$plaintext_status" != "400" ]]; then
  echo "expected plaintext rejection 400, got $plaintext_status"
  cat /tmp/ghola-private-agent-worker-plaintext.json
  exit 1
fi
echo "plaintext rejection ok"

accepted_status="$(
  curl -sS -o /tmp/ghola-private-agent-worker-accepted.json -w "%{http_code}" \
    -X POST "$BASE_URL/private-agent/sessions" \
    -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    -H "x-ghola-sealed-execution-required: true" \
    --data '{"version":1,"strategy_id":"strategy_canary","policy_hash":"policy_hash","owner_did":"did:key:zcanary","mode":"capped_session_key","encrypted_strategy_bundle":{"alg":"sealed-provider-v1","ciphertext":"ciphertext","recipient":"phala:cvm:canary","aad":"ghola/private-agent-session-v1"}}'
)"
if [[ "$accepted_status" != "201" ]]; then
  echo "expected encrypted acceptance 201 in dev/ready mode, got $accepted_status"
  cat /tmp/ghola-private-agent-worker-accepted.json
  exit 1
fi
echo "encrypted session acceptance ok"
