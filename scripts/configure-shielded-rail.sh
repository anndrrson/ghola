#!/usr/bin/env bash
set -euo pipefail

SERVICE_ID="${RENDER_SERVICE_ID:-srv-d6qpkd6a2pns73a5m6dg}"
HEALTH_URL="${SHIELDED_RAIL_HEALTH_URL:-https://api.ghola.xyz/health/payments}"
PROVIDER="${SHIELDED_STABLECOIN_PROVIDER:-aleo}"
NETWORK="${SHIELDED_STABLECOIN_NETWORK:-aleo:mainnet}"
ASSET="${SHIELDED_STABLECOIN_ASSET:-USDC}"
REQUIRE_SIGNED_RECEIPT="${SHIELDED_STABLECOIN_REQUIRE_SIGNED_RECEIPT:-true}"
VERIFIER_READY="${SHIELDED_STABLECOIN_VERIFIER_READY:-false}"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required env: %s\n' "$name" >&2
    exit 2
  fi
}

require_env SHIELDED_STABLECOIN_ADAPTER_URL
require_env SHIELDED_STABLECOIN_RECIPIENT
require_env SHIELDED_STABLECOIN_ADAPTER_PUBKEY

case "$SHIELDED_STABLECOIN_ADAPTER_URL" in
  https://*) ;;
  *)
    printf 'SHIELDED_STABLECOIN_ADAPTER_URL must be an https:// URL for production\n' >&2
    exit 2
    ;;
esac

case "$SHIELDED_STABLECOIN_RECIPIENT" in
  "" | "<shielded-recipient-address>" | "0zk-recipient")
    printf 'SHIELDED_STABLECOIN_RECIPIENT is a placeholder, not a real recipient\n' >&2
    exit 2
    ;;
esac

case "$SHIELDED_STABLECOIN_ADAPTER_PUBKEY" in
  "" | "<adapter-ed25519-pubkey>" | "adapter-pubkey")
    printf 'SHIELDED_STABLECOIN_ADAPTER_PUBKEY is a placeholder, not a real Ed25519 public key\n' >&2
    exit 2
    ;;
esac

case "$ASSET" in
  USDC | USDT) ;;
  *)
    printf 'SHIELDED_STABLECOIN_ASSET must be USDC or USDT, got %s\n' "$ASSET" >&2
    exit 2
    ;;
esac

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  if [[ -f "$HOME/.render/cli.yaml" ]]; then
    RENDER_API_KEY="$(awk '/key:/{print $2; exit}' "$HOME/.render/cli.yaml")"
  fi
fi

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  printf 'missing required env: RENDER_API_KEY, or run `render login` first\n' >&2
  exit 2
fi

set_render_env() {
  local key="$1"
  local value="$2"
  curl -fsS \
    -X PUT \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "https://api.render.com/v1/services/$SERVICE_ID/env-vars/$key" \
    --data "$(jq -n --arg value "$value" '{value: $value}')" >/dev/null
}

printf 'Configuring shielded rail env vars on Render service %s...\n' "$SERVICE_ID"
set_render_env SHIELDED_STABLECOIN_ADAPTER_URL "$SHIELDED_STABLECOIN_ADAPTER_URL"
set_render_env SHIELDED_STABLECOIN_RECIPIENT "$SHIELDED_STABLECOIN_RECIPIENT"
set_render_env SHIELDED_STABLECOIN_ADAPTER_PUBKEY "$SHIELDED_STABLECOIN_ADAPTER_PUBKEY"
set_render_env SHIELDED_STABLECOIN_REQUIRE_SIGNED_RECEIPT "$REQUIRE_SIGNED_RECEIPT"
set_render_env SHIELDED_STABLECOIN_VERIFIER_READY "$VERIFIER_READY"
set_render_env SHIELDED_STABLECOIN_PROVIDER "$PROVIDER"
set_render_env SHIELDED_STABLECOIN_NETWORK "$NETWORK"
set_render_env SHIELDED_STABLECOIN_ASSET "$ASSET"

printf 'Waiting for %s to report shielded_stablecoin.configured=true...\n' "$HEALTH_URL"
for _ in {1..30}; do
  body="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
  if [[ -n "$body" ]] && command -v jq >/dev/null 2>&1; then
    if printf '%s' "$body" | jq -e '.rails.shielded_stablecoin.configured == true' >/dev/null; then
      printf 'Shielded rail configured.\n'
      exit 0
    fi
  elif [[ "$body" == *'"configured":true'* ]]; then
    printf 'Shielded rail configured.\n'
    exit 0
  fi
  sleep 10
done

printf 'Timed out waiting for configured=true. Last response:\n%s\n' "${body:-<empty>}" >&2
exit 1
