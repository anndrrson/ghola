#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/canary/railgun-adapter-health.sh [--check-thumper] [--emit-secrets]

Checks the Railgun adapter /health contract and emits the thumper-cloud
environment variables required to enable railgun_evm_shielded.

Required:
  RAILGUN_EVM_ADAPTER_URL or RAILGUN_ADAPTER_URL
  RAILGUN_EVM_RECIPIENT or RAILGUN_RECIPIENT

Optional:
  GHOLA_BASE_URL                         thumper-cloud URL for --check-thumper
  RAILGUN_EVM_ADAPTER_AUTH_TOKEN          emitted as placeholder unless --emit-secrets
  RAILGUN_EVM_ADAPTER_PUBKEY              32-byte Ed25519 pubkey, hex or base64
  RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM derive pubkey if pubkey is not set
  RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64 derive pubkey if pubkey is not set

Examples:
  RAILGUN_EVM_ADAPTER_URL=https://railgun-adapter.example \
  RAILGUN_EVM_RECIPIENT=0zk... \
    scripts/canary/railgun-adapter-health.sh

  GHOLA_BASE_URL=https://thumper-cloud.onrender.com \
    scripts/canary/railgun-adapter-health.sh --check-thumper
EOF
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  }
}

shell_quote() {
  if [ "$#" -ne 1 ]; then
    return 2
  fi
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

base64_decode() {
  if base64 --help 2>&1 | grep -q -- '--decode'; then
    base64 --decode
  else
    base64 -D
  fi
}

json_get() {
  jq -r "$1 // empty" "$2"
}

derive_pubkey_from_private_key() {
  local key_file der_file

  if command -v node >/dev/null 2>&1; then
    node --input-type=module <<'NODE'
import { createPrivateKey, createPublicKey } from 'node:crypto';

const pem =
  process.env.RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM ||
  (process.env.RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64
    ? Buffer.from(process.env.RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64, 'base64').toString('utf8')
    : '');

if (!pem.trim()) {
  process.exit(1);
}

const privateKey = createPrivateKey(pem);
const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
process.stdout.write(Buffer.from(publicDer).subarray(-32).toString('hex'));
NODE
    return $?
  fi

  key_file="$(mktemp)"
  der_file="$(mktemp)"
  trap 'rm -f "$key_file" "$der_file"' RETURN

  if [ -n "${RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM:-}" ]; then
    printf '%s\n' "$RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM" >"$key_file"
  elif [ -n "${RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64:-}" ]; then
    printf '%s' "$RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64" | base64_decode >"$key_file"
  else
    return 1
  fi

  openssl pkey -in "$key_file" -pubout -outform DER -out "$der_file" >/dev/null 2>&1
  tail -c 32 "$der_file" | xxd -p -c 256
}

CHECK_THUMPER=false
EMIT_SECRETS=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-thumper)
      CHECK_THUMPER=true
      ;;
    --emit-secrets)
      EMIT_SECRETS=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  shift
done

need curl
need jq
need sed
need tail

ADAPTER_URL="${RAILGUN_EVM_ADAPTER_URL:-${RAILGUN_ADAPTER_URL:-}}"
RECIPIENT="${RAILGUN_EVM_RECIPIENT:-${RAILGUN_RECIPIENT:-}}"
AUTH_TOKEN="${RAILGUN_EVM_ADAPTER_AUTH_TOKEN:-${RAILGUN_ADAPTER_AUTH_TOKEN:-}}"
PUBKEY="${RAILGUN_EVM_ADAPTER_PUBKEY:-${RAILGUN_ADAPTER_PUBKEY:-}}"

if [ -z "$ADAPTER_URL" ]; then
  printf 'RAILGUN_EVM_ADAPTER_URL or RAILGUN_ADAPTER_URL is required\n' >&2
  exit 2
fi
if [ -z "$RECIPIENT" ]; then
  printf 'RAILGUN_EVM_RECIPIENT or RAILGUN_RECIPIENT is required\n' >&2
  exit 2
fi

health_body="$(mktemp)"
trap 'rm -f "$health_body" "${thumper_body:-}"' EXIT

health_code="$(
  curl -sS -o "$health_body" -w '%{http_code}' \
    "${ADAPTER_URL%/}/health"
)"
if [ "$health_code" != "200" ]; then
  printf 'Railgun adapter /health returned %s\n' "$health_code" >&2
  cat "$health_body" >&2
  exit 1
fi

jq -e '
  .service == "ghola-railgun-adapter"
  and .provider == "railgun"
  and .rail == "railgun_evm_shielded"
  and .ready == true
  and .configured == true
  and .broadcaster_configured == true
  and .fallback_allowed == false
  and ((.proof_of_innocence_required != true) or (.proof_of_innocence_configured == true))
' "$health_body" >/dev/null

NETWORK="$(json_get '.network' "$health_body")"
ASSET="$(json_get '.asset' "$health_body")"
BROADCASTER_READY="$(json_get '.broadcaster_configured' "$health_body")"
POI_REQUIRED="$(json_get '.proof_of_innocence_required' "$health_body")"
POI_CONFIGURED="$(json_get '.proof_of_innocence_configured' "$health_body")"

NETWORK="${RAILGUN_EVM_NETWORK:-${NETWORK:-arbitrum}}"
ASSET="${RAILGUN_EVM_ASSET:-${ASSET:-USDC}}"
BROADCASTER_READY="${RAILGUN_EVM_BROADCASTER_READY:-${BROADCASTER_READY:-true}}"
POI_REQUIRED="${RAILGUN_EVM_PROOF_OF_INNOCENCE_REQUIRED:-${POI_REQUIRED:-true}}"
POI_CONFIGURED="${RAILGUN_EVM_PROOF_OF_INNOCENCE_CONFIGURED:-${POI_CONFIGURED:-true}}"

if [ -z "$PUBKEY" ]; then
  PUBKEY="$(derive_pubkey_from_private_key || true)"
fi

if [ "$CHECK_THUMPER" = true ]; then
  GHOLA_BASE_URL="${GHOLA_BASE_URL:-}"
  if [ -z "$GHOLA_BASE_URL" ]; then
    printf 'GHOLA_BASE_URL is required with --check-thumper\n' >&2
    exit 2
  fi
  thumper_body="$(mktemp)"
  curl -fsS "${GHOLA_BASE_URL%/}/health/payments" -o "$thumper_body"
  jq -e '
    .rails.railgun_evm_shielded.ready == true
    and .rails.railgun_evm_shielded.configured == true
    and .rails.railgun_evm_shielded.adapter_configured == true
    and .rails.railgun_evm_shielded.adapter_auth_configured == true
    and .rails.railgun_evm_shielded.adapter_signature_required == true
    and .rails.railgun_evm_shielded.adapter_signature_configured == true
    and .rails.railgun_evm_shielded.broadcaster_configured == true
    and .rails.railgun_evm_shielded.fallback_allowed == false
    and .rails.railgun_evm_shielded.recipient_configured == true
    and (.rails.railgun_evm_shielded.recipient_preview | type == "string")
    and (.rails.railgun_evm_shielded | has("recipient") | not)
    and ((.rails.railgun_evm_shielded.proof_of_innocence_required != true)
      or (.rails.railgun_evm_shielded.proof_of_innocence_configured == true))
  ' "$thumper_body" >/dev/null
fi

printf 'Railgun adapter health passed for %s (%s/%s).\n' "$ADAPTER_URL" "$NETWORK" "$ASSET" >&2
if [ "$CHECK_THUMPER" = true ]; then
  printf 'thumper-cloud railgun_evm_shielded health passed for %s.\n' "$GHOLA_BASE_URL" >&2
fi

cat <<EOF
# thumper-cloud Railgun/EVM environment
export RAILGUN_EVM_ADAPTER_URL=$(shell_quote "$ADAPTER_URL")
export RAILGUN_EVM_NETWORK=$(shell_quote "$NETWORK")
export RAILGUN_EVM_ASSET=$(shell_quote "$ASSET")
export RAILGUN_EVM_RECIPIENT=$(shell_quote "$RECIPIENT")
export RAILGUN_EVM_REQUIRE_SIGNED_RECEIPT='true'
export RAILGUN_EVM_BROADCASTER_READY=$(shell_quote "$BROADCASTER_READY")
export RAILGUN_EVM_PROOF_OF_INNOCENCE_REQUIRED=$(shell_quote "$POI_REQUIRED")
export RAILGUN_EVM_PROOF_OF_INNOCENCE_CONFIGURED=$(shell_quote "$POI_CONFIGURED")
EOF

if [ -n "$PUBKEY" ]; then
  printf 'export RAILGUN_EVM_ADAPTER_PUBKEY=%s\n' "$(shell_quote "$PUBKEY")"
else
  printf 'export RAILGUN_EVM_ADAPTER_PUBKEY=%s\n' "'<adapter-ed25519-pubkey-hex-or-base64>'"
fi

if [ -n "$AUTH_TOKEN" ] && [ "$EMIT_SECRETS" = true ]; then
  printf 'export RAILGUN_EVM_ADAPTER_AUTH_TOKEN=%s\n' "$(shell_quote "$AUTH_TOKEN")"
else
  printf 'export RAILGUN_EVM_ADAPTER_AUTH_TOKEN=%s\n' "'<set-from-secret-store>'"
fi
