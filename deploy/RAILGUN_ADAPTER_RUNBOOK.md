# Railgun Adapter Deploy Runbook

This runbook wires the `railgun_evm_shielded` adapter into `thumper-cloud`
without changing adapter or cloud code. The adapter is fail-closed:
`thumper-cloud` only advertises the rail when the adapter URL, auth token,
adapter signing public key, recipient, broadcaster readiness, and
proof-of-innocence policy are all configured.

## Runtime contracts

Adapter:

- `GET /health` returns `service=ghola-railgun-adapter`,
  `rail=railgun_evm_shielded`, `ready=true`, `fallback_allowed=false`,
  broadcaster readiness, proof policy readiness, network, and asset.
- `POST /verify` requires bearer auth and signs the canonical Railgun receipt
  consumed by `thumper-cloud`.

Cloud:

- `GET /health/payments` returns `rails.railgun_evm_shielded`.
- The rail is usable only when `ready=true`, `configured=true`,
  `adapter_signature_configured=true`, `broadcaster_configured=true`, and
  `fallback_allowed=false`.
- Health must expose `recipient_preview`, not the full recipient.

## Adapter env

Set these on the Railgun adapter service:

```bash
RAILGUN_ADAPTER_AUTH_TOKEN=<shared-secret-with-thumper-cloud>
RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64=<base64-pem>
RAILGUN_EVM_RPC_URL=<evm-rpc-url>
RAILGUN_EVM_NETWORK=arbitrum
RAILGUN_EVM_ASSET=USDC
RAILGUN_EVM_RECIPIENT=<railgun-0zk-recipient>
RAILGUN_EVM_BROADCASTER_READY=true
RAILGUN_EVM_PROOF_OF_INNOCENCE_REQUIRED=true
RAILGUN_EVM_PROOF_OF_INNOCENCE_CONFIGURED=true
RAILGUN_EVM_MIN_CONFIRMATIONS=1
RAILGUN_EVM_CONTRACT_ADDRESS=<railgun-contract-address>
```

Keep `RAILGUN_EVM_PROOF_OF_INNOCENCE_REQUIRED=true` in production. Do not
set `RAILGUN_EVM_BROADCASTER_READY=true` until the broadcaster path is actually
funded, monitored, and able to submit user-built private transactions.

## Emit thumper-cloud env

Run the canary helper from the repo root after the adapter is deployed:

```bash
RAILGUN_EVM_ADAPTER_URL=https://<adapter-host> \
RAILGUN_EVM_RECIPIENT=<railgun-0zk-recipient> \
RAILGUN_EVM_ADAPTER_AUTH_TOKEN=<shared-secret-with-thumper-cloud> \
RAILGUN_EVM_ADAPTER_PUBKEY=<adapter-ed25519-pubkey-hex-or-base64> \
  scripts/canary/railgun-adapter-health.sh
```

The script validates adapter health and prints the `RAILGUN_EVM_*` exports
needed by `thumper-cloud`. It redacts the auth token by default. Use
`--emit-secrets` only in a private operator shell, not in CI logs.

If the adapter private key is available locally as
`RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM` or
`RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64`, the script derives
`RAILGUN_EVM_ADAPTER_PUBKEY` automatically.

Apply the emitted values to the thumper-cloud secret store, then redeploy
thumper-cloud.

## Canary

Before any funded transaction, run the no-funds adapter mock canary:

```bash
node scripts/canary/railgun-adapter-mock-e2e.mjs
```

It starts a local mock EVM RPC plus adapter, verifies `/health`, accepts the
fixture `/verify` request, and confirms missing proof policy is rejected.

After thumper-cloud redeploys, run the end-to-end health canary:

```bash
RAILGUN_EVM_ADAPTER_URL=https://<adapter-host> \
RAILGUN_EVM_RECIPIENT=<railgun-0zk-recipient> \
THUMPER_BASE_URL=https://<thumper-cloud-host> \
  scripts/canary/railgun-adapter-health.sh --check-thumper
```

Expected result:

- Adapter `/health` returns HTTP 200 and `ready=true`.
- `thumper-cloud /health/payments` reports
  `rails.railgun_evm_shielded.ready=true`.
- The rail has `fallback_allowed=false`.
- The Railgun recipient is redacted from cloud health output.

## Funded x402 canary

Generate a real Railgun private transfer from a user/agent wallet, through the
Waku broadcaster path, then save the x402 proof JSON emitted by
`@said-pay/sdk` to a private local file:

```bash
RAILGUN_X402_PROOF_JSON=/secure/path/railgun-x402-proof.json \
GHOLA_V1_CHAT_URL=https://<thumper-cloud-host>/v1/chat/completions \
GHOLA_CANARY_MODEL=agent:research-bot \
  scripts/canary/railgun-x402-funded-canary.sh --replay-check
```

The first request must succeed. The replay check must fail because
`thumper-cloud` stores the Railgun replay key in `x402_payments`.

To exercise the blind OHTTP path as well, set the public relay URL. The same
canary command automatically switches from direct `curl` to the Node OHTTP
transport. In OHTTP mode the canary first requests the 402 challenge through
the relay, verifies the Railgun `request_hash`, then submits the funded proof
through the same relay path:

```bash
RAILGUN_X402_PROOF_JSON=/secure/path/railgun-x402-proof.json \
GHOLA_OHTTP_RELAY_URL=https://<ohttp-relay-host>/<gateway-id> \
GHOLA_RELAY_BASE_URL=https://<ghola-relay-host> \
GHOLA_V1_CHAT_URL=https://ghola.xyz/v1/chat/completions \
GHOLA_CANARY_MODEL=agent:research-bot \
  scripts/canary/railgun-x402-funded-canary.sh --replay-check
```

Before using funded proof material, verify the local OHTTP codec:

```bash
node scripts/canary/railgun-x402-ohttp-funded-canary.mjs --self-test
```

## Rollback

Unset only the cloud-side rail enablement values and redeploy thumper-cloud:

```bash
RAILGUN_EVM_ADAPTER_URL
RAILGUN_EVM_ADAPTER_AUTH_TOKEN
RAILGUN_EVM_ADAPTER_PUBKEY
RAILGUN_EVM_RECIPIENT
RAILGUN_EVM_BROADCASTER_READY
RAILGUN_EVM_PROOF_OF_INNOCENCE_CONFIGURED
```

The rail will disappear from usable private payment options while public USDC
and any other configured private rails continue to follow their existing
policies. Do not replace Railgun failures with public fallback for requests
that explicitly ask for `railgun_evm_shielded`.
