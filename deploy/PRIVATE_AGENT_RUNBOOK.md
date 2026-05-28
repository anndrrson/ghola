# Private Agent Runtime Runbook

This runbook wires `/strategies` session-key agents to remote confidential
compute. The product must remain fail-closed: if attestation, sealed-recipient
publishing, subscription entitlement, or shielded settlement is missing, Ghola
allows local preparation only.

## Subscription wiring

The web route accepts encrypted session requests only after billing confirms a
paid private-agent entitlement. Configure the Thumper Cloud billing service with
the Stripe price IDs:

```bash
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_PRIVATE_AGENT=price_...
STRIPE_PRICE_UNLIMITED=price_...
```

`private_agent`, `unlimited`, and `enterprise` users can create sealed cloud
agent sessions. Free users remain limited to local encrypted strategy
preparation.

## Runtime contract

Web:

- `GET /api/private-agent/status` reports provider-neutral runtime status.
- `POST /api/private-agent/sessions` accepts only encrypted strategy bundles.
- Plaintext `source`, `prompt`, `policy`, `strategy`, or `messages` fields are
  rejected before billing or provider forwarding.

Provider:

- Accepts `POST /private-agent/sessions`.
- Receives `encrypted_strategy_bundle.ciphertext`, a `said-envelope-v1` payload
  sealed to the provider's attestation-bound X25519 key.
- Must verify the envelope signature, associated data, strategy policy hash, and
  user-approved caps before creating any background watcher or session key.
- Must not submit public AMM, public unshield, known-wallet, unique-amount, or
  unsafe calldata proposals.

## Phala first provider

### Local staging bootstrap

For a local staging-equivalent worker URL and auth token, generate an ignored
env file:

```bash
bash scripts/staging/private-agent-bootstrap-local.sh
set -a; source .dev/private-agent-staging.env; set +a
cd apps/private-agent-worker && npm start
```

Then run the sealed worker and venue canaries:

```bash
bash scripts/canary/private-agent-worker-local.sh
node scripts/canary/private-agent-venue-live.mjs
```

The bootstrap writes `.dev/private-agent-staging.env`, which is ignored by git.
It defaults to `PRIVATE_AGENT_VENUE_DRY_RUN=true`, so it proves sealed worker
ingress and TEE-side decrypt/routing without touching venues.

For a real staging CVM, keep the generated
`GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN` as the shared web-to-worker token, deploy
the worker to Phala, then replace `PRIVATE_AGENT_WORKER_URL` and
`GHOLA_PRIVATE_AGENT_EXECUTION_URL` with the CVM HTTPS endpoint after recipient
attestation passes.

Build and deploy a fresh provider worker before changing web readiness flags:

```bash
gh workflow run build-private-agent-worker-image.yml \
  -f ref_to_build=<git-ref-or-sha> \
  -f image=ghcr.io/anndrrson/ghola-private-agent-worker:private-agent-worker-<git-sha>
```

The workflow summary prints `image`, `digest`, and `pinned`. Use the pinned
value for the CVM image and set the matching digest in web/worker env. Do not
arm Hyperliquid live mode with the historical image below; it is listed only as
a prior deployment reference:

```text
ghcr.io/anndrrson/ghola-private-agent-worker:private-agent-worker-128f9e8@sha256:9e2cb99b475ab193bfa5cc9c8c2dcd4b1ed314586ee4801aa217a2eeeb6c66f7
```

Ghola supports just-in-time Phala startup. The session route only calls the
Phala provisioner after billing confirms a paid private-agent entitlement and
monthly compute allowance. The provisioner receives only infrastructure config
and a worker auth secret; it never receives user prompts, plaintext strategies,
messages, policies, or encrypted strategy bundles.

Set these on the web deployment to arm paid-on-demand provisioning:

```bash
GHOLA_PRIVATE_AGENT_PROVIDER=phala
GHOLA_PRIVATE_AGENT_JIT_PROVISIONING=true
GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME=ghola-private-agent-worker
GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola-private-agent-worker:private-agent-worker-<git-sha>
GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST=sha256:<workflow-digest>
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN=<random-worker-token-not-the-phala-api-key>
GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true
GHOLA_HYPERLIQUID_LIVE_MODE=tiny_fill
GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS=ready
PHALA_CLOUD_API_KEY=<phala-cloud-api-key>
```

Optional sizing knobs:

```bash
GHOLA_PHALA_PRIVATE_AGENT_INSTANCE_TYPE=tdx.small
GHOLA_PHALA_PRIVATE_AGENT_REGION=<phala-region>
```

On the first paid private-agent session request, Ghola creates or starts the
CVM, waits briefly for readiness, then returns a provisioning response if the
worker is still booting. User payload forwarding remains fail-closed until the
worker publishes recipient evidence bound to a dstack quote and Phala reports
CVM attestation.

You can also deploy `apps/private-agent-worker/docker-compose.phala.yml`
manually as the Phala CVM payload, then fetch the worker recipient metadata:

```bash
curl -fsS https://<phala-agent-host>/.well-known/private-agent-recipient
curl -fsS https://<phala-agent-host>/ready
```

The recipient key is the public key browsers seal strategy bundles to. Treat it
as production-ready only after the attestation verifier proves the quote,
measurement, image digest, and recipient key binding. The worker itself also
rejects plaintext strategy fields and refuses sessions until attestation env is
complete.

Set these on the web deployment after manually deploying and verifying the
Phala CVM if you do not use JIT discovery:

```bash
GHOLA_PRIVATE_AGENT_PROVIDER=phala
GHOLA_PRIVATE_AGENT_EXECUTION_URL=https://<phala-agent-host>
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN=<random-worker-token-not-the-phala-api-key>
PHALA_ATTESTATION_VERIFIER_URL=https://<verifier-host>
PHALA_CVM_IMAGE_DIGEST=<verified-image-digest>
PHALA_ENCLAVE_KEY_ID=<attestation-bound-key-id>
PHALA_ENCLAVE_X25519_PUB_HEX=<32-byte-x25519-public-key-hex>
PHALA_CVM_MEASUREMENT_HEX=<measurement-hex>
PHALA_ATTESTATION_HASH=<attestation-doc-hash>
GHOLA_PRIVATE_AGENT_ATTESTED_READY=true
```

Set the matching worker env inside the CVM:

```bash
PRIVATE_AGENT_PROVIDER_ID=phala
PRIVATE_AGENT_TEE_KIND=phala
PRIVATE_AGENT_EXECUTION_TOKEN=<same-secret-as-GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN>
PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true
PHALA_CVM_IMAGE_DIGEST=<verified-image-digest>
PRIVATE_AGENT_VENUE_DRY_RUN=false
PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true
PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=tiny_fill
PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD=5
PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD=25
PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=50
```

Do not set `GHOLA_PRIVATE_AGENT_ATTESTED_READY=true` until the verifier has
checked the CVM quote, image digest, measurement, and X25519 key binding. The
status API treats a missing recipient key as not ready even when the endpoint
and API key are configured.

Never reuse `PHALA_CLOUD_API_KEY` as `GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN`.
The Phala API key is only for provisioning. The worker token only authorizes
Ghola to submit already-sealed private-agent session envelopes to the worker.

## Gensyn future provider

Gensyn remains optional until it can publish the same confidentiality contract:

```bash
GHOLA_PRIVATE_AGENT_PROVIDER=gensyn
GENSYN_PRIVATE_AGENT_EXECUTION_URL=https://<gensyn-agent-host>
GENSYN_API_KEY=<secret>
GENSYN_ATTESTATION_VERIFIER_URL=https://<verifier-host>
GENSYN_ENCLAVE_KEY_ID=<attestation-bound-key-id>
GENSYN_ENCLAVE_X25519_PUB_HEX=<32-byte-x25519-public-key-hex>
GENSYN_MEASUREMENT_HEX=<measurement-hex>
GENSYN_ATTESTATION_HASH=<attestation-doc-hash>
GENSYN_CONFIDENTIAL_EXECUTION_READY=true
```

If the provider cannot prove sealed execution and publish a recipient key, leave
it configured but not ready.

## Checks

```bash
GHOLA_BASE_URL=https://ghola.xyz bash scripts/canary/private-agent-runtime.sh
```

Expected ready state:

- `remote_execution_ready: true`
- `selected_provider: "phala"` or another intended provider
- selected provider has `sealed_recipient`
- `shielded_rail_ready: true`
- `blocking_reasons: []`

Plaintext rejection canary:

```bash
GHOLA_BASE_URL=https://ghola.xyz bash scripts/canary/private-agent-runtime.sh --require-ready
```

The first command is safe before provider launch and verifies fail-closed
behavior. The `--require-ready` form is for production after Phala or another
attested provider and the shielded settlement rail are live.

Venue credential canary:

```bash
set -a; source .dev/private-agent-staging.env; set +a
GHOLA_CANARY_VENUE=hyperliquid \
GHOLA_RUN_LIVE_VENUE_CANARY=1 \
GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE=5 \
GHOLA_CANARY_HYPERLIQUID_MAX_SLIPPAGE_BPS=50 \
node scripts/canary/private-agent-venue-live.mjs
```

Hyperliquid live/testnet canaries require an already-approved API/agent wallet:
set `GHOLA_CANARY_HYPERLIQUID_ACCOUNT_ADDRESS` and
`GHOLA_CANARY_HYPERLIQUID_API_WALLET_PRIVATE_KEY`. Coinbase BYO canaries require
an Advanced Trade key with view+trade permissions and transfer disabled: set
`GHOLA_CANARY_VENUE=coinbase_byo`,
`GHOLA_CANARY_COINBASE_API_KEY_NAME`, and either
`GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64` or
`GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_PATH`.

By default the venue canary uses Hyperliquid reconcile or Coinbase order preview
instead of submitting an order. To run the real Hyperliquid proof, set both
`GHOLA_CANARY_SUBMIT_ORDER=1` and `GHOLA_CANARY_ACK_TINY_ORDER_RISK=1`. The
Hyperliquid submit canary sends a sealed `$5` quote-sized IOC tiny fill and then
reconciles fills; it does not try to cancel the IOC order. Keep the venue on
testnet/sandbox first, then run one mainnet canary only after the worker and web
envs are pinned to the fresh image digest.

```bash
GHOLA_CANARY_VENUE=hyperliquid \
GHOLA_RUN_LIVE_VENUE_CANARY=1 \
GHOLA_CANARY_HYPERLIQUID_NETWORK=mainnet \
GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE=5 \
GHOLA_CANARY_HYPERLIQUID_MAX_SLIPPAGE_BPS=50 \
GHOLA_CANARY_SUBMIT_ORDER=1 \
GHOLA_CANARY_ACK_TINY_ORDER_RISK=1 \
node scripts/canary/private-agent-venue-live.mjs
```

## Rollback

Unset the provider readiness flag first:

```bash
GHOLA_PRIVATE_AGENT_ATTESTED_READY
GENSYN_CONFIDENTIAL_EXECUTION_READY
```

Then redeploy. `/strategies` should return to local-only strategy preparation
while saved encrypted strategies remain available on the user's device.
