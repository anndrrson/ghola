#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${GHOLA_BASE_URL:-http://localhost:3000}"
REQUIRE_READY="0"

for arg in "$@"; do
  case "$arg" in
    --require-ready)
      REQUIRE_READY="1"
      ;;
    *)
      echo "usage: GHOLA_BASE_URL=https://ghola.xyz $0 [--require-ready]" >&2
      exit 2
      ;;
  esac
done

node - "$BASE_URL" "$REQUIRE_READY" <<'NODE'
const baseUrl = process.argv[2].replace(/\/$/, "");
const requireReady = process.argv[3] === "1";

function fail(message, detail) {
  console.error(`[private-agent-canary] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  }).catch((error) => fail(`request failed: ${path}`, String(error)));
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      fail(`non-JSON response from ${path}`, text.slice(0, 500));
    }
  }
  return { response, body, text };
}

const status = await request("/api/private-agent/status");
if (!status.response.ok) {
  fail(`status endpoint returned ${status.response.status}`, status.text);
}
if (status.body?.sealed_execution_required !== true) {
  fail("status endpoint does not require sealed execution", status.text);
}
if (!Array.isArray(status.body?.blocking_reasons)) {
  fail("status endpoint does not expose blocking_reasons", status.text);
}
if (requireReady && status.body?.remote_execution_ready !== true) {
  fail("private-agent runtime is not ready", status.text);
}
console.log(
  `[private-agent-canary] status remote=${status.body.remote_execution_ready} provider=${status.body.selected_provider ?? "none"} shielded=${status.body.shielded_rail_ready}`,
);

const plaintextPayload = {
  version: 1,
  strategy_id: "canary_plaintext",
  policy_hash: "policy_canary",
  owner_did: "did:key:zCanary",
  mode: "capped_session_key",
  source: "DCA 25 USDC into ETH",
  encrypted_strategy_bundle: {
    alg: "sealed-provider-v1",
    ciphertext: "ciphertext",
    recipient: "recipient",
    aad: "aad",
  },
};
const plaintext = await request("/api/private-agent/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(plaintextPayload),
});
if (plaintext.response.status !== 400) {
  fail(`plaintext canary expected HTTP 400, got ${plaintext.response.status}`, plaintext.text);
}
if (!JSON.stringify(plaintext.body).includes("plaintext")) {
  fail("plaintext rejection did not mention plaintext", plaintext.text);
}
console.log("[private-agent-canary] plaintext rejection ok");

const encryptedPayload = {
  version: 1,
  strategy_id: "canary_encrypted",
  policy_hash: "policy_canary",
  owner_did: "did:key:zCanary",
  mode: "capped_session_key",
  encrypted_strategy_bundle: {
    alg: "sealed-provider-v1",
    ciphertext: "ciphertext",
    recipient: "recipient",
    aad: "aad",
  },
};
const unauthenticated = await request("/api/private-agent/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(encryptedPayload),
});
if (![401, 403].includes(unauthenticated.response.status)) {
  fail(
    `unauthenticated encrypted canary expected HTTP 401/403, got ${unauthenticated.response.status}`,
    unauthenticated.text,
  );
}
console.log("[private-agent-canary] unauthenticated encrypted request rejected ok");
NODE
