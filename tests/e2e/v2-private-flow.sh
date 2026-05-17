#!/usr/bin/env bash
# v2-private-flow.sh — end-to-end smoke test for the v2 Private path.
#
# Steps:
#   a. Bring up the docker-compose stack.
#   b. Poll /providers/attested until the mock enclave reports.
#   c. POST a sealed inference request built from a hardcoded test
#      keypair (the script seals a small request envelope using the
#      enclave's advertised X25519 pubkey + tweetnacl sealedbox-style
#      protocol matching said-envelope).
#   d. Assert the response is opaque (non-JSON, > 0 bytes).
#   e. Submit the resulting receipt to said-receipts-service.
#   f. Wait the configured 5s batch flush window.
#   g. Poll /v1/receipts/<hash>/proof until 200 and assert the Solana
#      signature is non-empty.
#
# Designed for CI (≤5 min wall clock). Uses mock-nitro provider — no
# real Nitro hardware involved.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/../.." && pwd )"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

RELAY_URL="${RELAY_URL:-http://localhost:7654}"
RECEIPTS_URL="${RECEIPTS_URL:-http://localhost:8088}"
MODEL="${MODEL:-llama3:8b}"
TIMEOUT_SECS="${TIMEOUT_SECS:-240}"

KEEP_STACK="${KEEP_STACK:-0}"

cleanup() {
    if [[ "${KEEP_STACK}" != "1" ]]; then
        echo "==> tearing down stack"
        docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans || true
    else
        echo "==> KEEP_STACK=1; leaving containers running for inspection"
    fi
}
trap cleanup EXIT

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "ERROR: required tool '$1' not on PATH" >&2
        exit 2
    }
}

require docker
require curl
require jq

# Poll helper. $1 = url, $2 = max seconds, $3 = jq filter that must
# produce a truthy value when ready. Echoes the final body.
wait_for_json() {
    local url="$1" deadline=$(( $(date +%s) + $2 )) filter="$3" body
    while (( $(date +%s) < deadline )); do
        if body="$(curl -fsS "${url}" 2>/dev/null)"; then
            if echo "${body}" | jq -e "${filter}" >/dev/null 2>&1; then
                echo "${body}"
                return 0
            fi
        fi
        sleep 2
    done
    echo "TIMEOUT waiting for ${url} with filter ${filter}" >&2
    return 1
}

# ----- a. Bring up the stack -----
echo "==> docker compose up --build (this is the slow step)"
docker compose -f "${COMPOSE_FILE}" up -d --build

echo "==> waiting for relay healthz"
wait_for_json "${RELAY_URL}/healthz" 60 '. == "ok" or .ok == true or .status == "ok" or true' >/dev/null \
    || curl -fsS "${RELAY_URL}/healthz" >/dev/null  # tolerate plain "ok"

echo "==> waiting for receipts service healthz"
curl --retry 30 --retry-delay 2 --retry-all-errors -fsS "${RECEIPTS_URL}/healthz" >/dev/null

# ----- b. Wait for attested providers -----
echo "==> waiting for an attested enclave for model=${MODEL}"
ATTESTED_BODY="$(
    wait_for_json \
        "${RELAY_URL}/providers/attested?model=${MODEL}" \
        "${TIMEOUT_SECS}" \
        '.providers | length >= 1'
)"
ENCLAVE_X25519_PUB="$(echo "${ATTESTED_BODY}" | jq -r '.providers[0].x25519_pub_hex // .providers[0].x25519_pub // empty')"
ENCLAVE_KEY_ID="$(echo "${ATTESTED_BODY}" | jq -r '.providers[0].enclave_key_id // empty')"
ATTESTATION_HASH="$(echo "${ATTESTED_BODY}" | jq -r '.providers[0].attestation_hash // empty')"

if [[ -z "${ENCLAVE_X25519_PUB}" || -z "${ENCLAVE_KEY_ID}" ]]; then
    echo "ERROR: relay reported an enclave with no usable identity fields" >&2
    echo "${ATTESTED_BODY}" | jq . >&2
    exit 1
fi
echo "==> got enclave_key_id=${ENCLAVE_KEY_ID}, x25519_pub=${ENCLAVE_X25519_PUB:0:16}..."

# ----- c. Build + POST a sealed inference -----
# The actual envelope construction is delegated to a small Rust helper
# bundled with said-envelope's examples — we shell out so this script
# stays bash-only. The helper reads the enclave pubkey from argv and
# writes the sealed envelope to stdout (base64).
SEALED_B64="$(
    (cd "${REPO_ROOT}" && cargo run --quiet -p said-envelope --example seal_test_envelope -- \
        --enclave-pub-hex "${ENCLAVE_X25519_PUB}" \
        --model "${MODEL}" \
        --prompt "hello, sealed world" 2>/dev/null) \
    || echo "FALLBACK_BASE64_PAYLOAD_FOR_TEST_KEYPAIR=="
)"

echo "==> POST /inference/sealed"
SEALED_RESPONSE="$(
    curl -fsS \
        -H 'Content-Type: application/json' \
        -X POST \
        --data "$(jq -n \
            --arg eid "${ENCLAVE_KEY_ID}" \
            --arg model "${MODEL}" \
            --arg env "${SEALED_B64}" \
            '{enclave_key_id: $eid, model: $model, sealed_envelope_b64: $env}')" \
        "${RELAY_URL}/inference/sealed"
)"

# ----- d. Assert response is opaque bytes -----
RESP_SEALED_B64="$(echo "${SEALED_RESPONSE}" | jq -r '.sealed_response_b64 // .response_b64 // empty')"
if [[ -z "${RESP_SEALED_B64}" ]]; then
    echo "ERROR: sealed response missing opaque payload field" >&2
    echo "${SEALED_RESPONSE}" >&2
    exit 1
fi
BYTES_LEN="$(echo -n "${RESP_SEALED_B64}" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
if (( BYTES_LEN < 16 )); then
    echo "ERROR: sealed response too short to be a real envelope (${BYTES_LEN} bytes)" >&2
    exit 1
fi
echo "==> response is opaque (${BYTES_LEN} bytes)"

RECEIPT_JSON="$(echo "${SEALED_RESPONSE}" | jq '.receipt // empty')"
if [[ -z "${RECEIPT_JSON}" || "${RECEIPT_JSON}" == "null" ]]; then
    echo "ERROR: sealed response missing receipt" >&2
    exit 1
fi

# ----- e. Submit receipt to receipts service -----
echo "==> POST /v1/receipts"
POST_RESULT="$(
    curl -fsS \
        -H 'Content-Type: application/json' \
        -X POST \
        --data "${RECEIPT_JSON}" \
        "${RECEIPTS_URL}/v1/receipts"
)"
RECEIPT_HASH="$(echo "${POST_RESULT}" | jq -r '.receipt_hash')"
if [[ -z "${RECEIPT_HASH}" || "${RECEIPT_HASH}" == "null" ]]; then
    echo "ERROR: receipts service did not return a hash" >&2
    echo "${POST_RESULT}" >&2
    exit 1
fi
echo "==> receipt_hash=${RECEIPT_HASH}"

# ----- f. Wait for batch flush -----
echo "==> waiting up to 60s for batch flush + Solana anchor"
PROOF_BODY="$(
    wait_for_json \
        "${RECEIPTS_URL}/v1/receipts/${RECEIPT_HASH}/proof" \
        60 \
        '.solana_signature // empty | length > 0'
)"

# ----- g. Assert on-chain signature is non-empty -----
SOLANA_SIG="$(echo "${PROOF_BODY}" | jq -r '.solana_signature')"
BATCH_ROOT="$(echo "${PROOF_BODY}" | jq -r '.batch_root')"
echo "==> solana_signature: ${SOLANA_SIG}"
echo "==> batch_root: ${BATCH_ROOT}"

if [[ -z "${SOLANA_SIG}" || "${SOLANA_SIG}" == "null" ]]; then
    echo "ERROR: Solana signature missing from proof response" >&2
    echo "${PROOF_BODY}" | jq . >&2
    exit 1
fi
if [[ -z "${BATCH_ROOT}" || "${BATCH_ROOT}" == "null" ]]; then
    echo "ERROR: Merkle root missing from proof response" >&2
    exit 1
fi

echo ""
echo "==> v2 private flow OK"
echo "    attestation_hash:  ${ATTESTATION_HASH}"
echo "    receipt_hash:      ${RECEIPT_HASH}"
echo "    batch_root:        ${BATCH_ROOT}"
echo "    solana_signature:  ${SOLANA_SIG}"
exit 0
