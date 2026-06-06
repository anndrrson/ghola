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
  -f image=ghcr.io/anndrrson/ghola:private-agent-worker-<git-sha>
```

The workflow summary prints `image`, `digest`, and `pinned`. Use the pinned
value for the CVM image and set the matching digest in web/worker env. The
current verified worker image built from the live Hyperliquid account-stream
branch is:

```text
ghcr.io/anndrrson/ghola:private-agent-worker-6a4f843@sha256:9b36fd7356dc8be88a685419b8af9b17bb5c46248daf942d753e928b6edc7933
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
GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola:private-agent-worker-<git-sha>
GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST=sha256:<workflow-digest>
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN=<random-worker-token-not-the-phala-api-key>
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<worker-funding-signer-spki-b64>
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

### Idle shutdown without Vercel Pro

Ghola records a short server-side runtime lease whenever a real user action
needs the private worker: pooled venue access, no-submit preview, connector
submit, or private-agent session creation. Passive page loads and status probes
do not wake Phala.

Use Cloudflare Worker Cron to stop the CVM after the lease expires while keeping
Vercel on the Hobby plan:

```bash
GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN=true
GHOLA_PRIVATE_AGENT_IDLE_AFTER_MINUTES=30
GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET=<random-idle-cron-secret>
```

Deploy the Worker in `deploy/cloudflare/ghola-idle-cron`:

```bash
cd deploy/cloudflare/ghola-idle-cron
npx wrangler secret put GHOLA_IDLE_CRON_SECRET
npx wrangler deploy
```

Set `GHOLA_IDLE_CRON_SECRET` to the same value as
`GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET`. The Worker runs every 15 minutes and
calls `GET https://ghola.xyz/api/private-agent/idle`. The web endpoint checks
the lease before calling Phala `stopCvm`, so scheduled checks are safe during
active usage. Vercel's daily cron can remain as a backstop, but Cloudflare is
the cost-control path.

### Pooled venue credentials

Pooled live trading is only green when the Phala worker can load executable
venue credentials inside the TEE. Production readiness flags such as
`GHOLA_HYPERLIQUID_POOLED_ACCOUNT_POOL_READY=true` are not enough; those flags
only describe launch posture on the web side. The worker still needs sealed
credential material.

Create a local, gitignored file:

```bash
deploy/private-agent-pooled-credentials.env
```

Required keys:

```bash
PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON='{"accounts":[{"network":"mainnet","account_address":"0x...","api_wallet_private_key":"0x..."}]}'
PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON='{"kind":"ghola_solana_perps_execution_vault","network":"mainnet","wallet_private_key":[...]}'
PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON='{"kind":"ghola_solana_swap_execution_vault","network":"mainnet","wallet_private_key":[...]}'
PRIVATE_AGENT_JUPITER_API_KEY='...'
PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON='{"kind":"ghola_coinbase_advanced_execution_vault","network":"mainnet","api_key_name":"...","api_private_key_pem":"-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----"}'
```

If quoting multiline JSON or PEM is awkward, provide any JSON value as
`*_JSON_B64`; the installer decodes it before pushing sealed envs.

Validate without touching production:

```bash
node scripts/install-phala-pooled-credentials.mjs \
  --env deploy/private-agent-pooled-credentials.env \
  --dry-run
```

Install into the Phala CVM:

```bash
node scripts/install-phala-pooled-credentials.mjs \
  --env deploy/private-agent-pooled-credentials.env
```

The script validates credential shape, pushes only the required sealed env keys
with `phala envs update`, deletes its temp env file, then checks:

```bash
curl -fsS https://ghola.xyz/v1/private-account/live-trading/status
```

Expected result after a successful install:

```json
{
  "live_submit_mode": "pooled_and_byo",
  "pooled_live_trading_enabled": true,
  "pooled_reason_codes": []
}
```

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
PRIVATE_AGENT_FUNDING_SIGNING_KEY=<base64-pkcs8-ed25519-private-key>
PRIVATE_AGENT_VENUE_DRY_RUN=false
PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true
PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=tiny_fill
PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD=5
PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD=25
PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=50
# Optional Jupiter private swap pilot.
PRIVATE_AGENT_JUPITER_LIVE_MODE=full
PRIVATE_AGENT_JUPITER_API_KEY=<jupiter-api-key>
PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS=<comma-separated-mainnet-mints>
PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS=<comma-separated-mainnet-mints>
PRIVATE_AGENT_JUPITER_POOLED_VAULT_PATH=/secrets/jupiter-pooled-vault.json
```

Set the matching web env on `ghola.xyz`:

```bash
GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true
GHOLA_HYPERLIQUID_LIVE_MODE=tiny_fill
GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL=https://<phala-agent-host>
GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN=<same-secret-as-PRIVATE_AGENT_EXECUTION_TOKEN>
GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS=ready
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<worker-funding-signer-spki-b64>
GHOLA_PRIVATE_ACCOUNT_COORDINATOR_MAX_STALE_MS=90000000
# Optional Jupiter private swap pilot.
GHOLA_VENUE_JUPITER_PILOT_ENABLED=true
GHOLA_JUPITER_LIVE_MODE=full
GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_URL=https://<phala-agent-host>
GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_TOKEN=<same-secret-as-PRIVATE_AGENT_EXECUTION_TOKEN>
GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_READINESS=ready
```

## Agent Passport and guarded arbitrage

Agent Passport links must use sealed user-provided venue credentials. The web
server records only vault/capability commitments; the private worker opens the
sealed vault and verifies that the credential can read and trade while
withdraw/transfer authority is blocked. Do not mark a venue ready from a client
permission attestation alone.

Required web env:

```bash
GHOLA_PRIVATE_AGENT_EXECUTION_URL=https://<phala-agent-host>
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN=<same-secret-as-PRIVATE_AGENT_EXECUTION_TOKEN>
```

Required worker env for live guarded arbitrage:

```bash
PRIVATE_AGENT_ARB_LIVE_SUBMIT=true
PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD=5
PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD=25
PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS=50
PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS=2000
PRIVATE_AGENT_ARB_MARKET_FETCH_TIMEOUT_MS=1200
PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS=2000
```

Optional fee assumptions:

```bash
PRIVATE_AGENT_ARB_COINBASE_ADVANCED_FEE_BPS=60
PRIVATE_AGENT_ARB_HYPERLIQUID_FEE_BPS=5
PRIVATE_AGENT_ARB_JUPITER_FEE_BPS=10
```

The worker fails closed if any required arbitrage cap is missing. Each pair
execution runs a no-submit preflight for both legs first; only if both preflights
pass does the worker submit the bounded buy/sell legs. If one submitted leg
fails before reconciliation, the session pauses and emits
`unhedged_leg_requires_human`.

Run the production guarded-arbitrage canary before enabling user access. The
default mode verifies sealed Coinbase and Hyperliquid credentials, live market
data freshness, paired no-submit order construction, and no-broadcast receipts:

```bash
cd apps/private-agent-worker
PRIVATE_AGENT_WORKER_URL=https://<phala-agent-host> \
PRIVATE_AGENT_EXECUTION_TOKEN=<worker-token-or-use-capability-secret> \
PRIVATE_AGENT_WORKER_CAPABILITY_SECRET=<optional-prod-capability-secret> \
GHOLA_ARB_CANARY_MARKET=SOL-USD \
GHOLA_ARB_CANARY_LEG_NOTIONAL_USD=5 \
GHOLA_ARB_CANARY_COINBASE_API_KEY_NAME=<coinbase-api-key-name> \
GHOLA_ARB_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64=<base64-pem> \
GHOLA_ARB_CANARY_HYPERLIQUID_ACCOUNT_ADDRESS=0x... \
GHOLA_ARB_CANARY_HYPERLIQUID_API_WALLET_PRIVATE_KEY=0x... \
npm run canary:arb:prod
```

Only after no-submit passes, run the tiny-live pair canary:

```bash
GHOLA_ARB_CANARY_LIVE_SUBMIT=true \
GHOLA_ARB_CANARY_ACK_TINY_LIVE=I_UNDERSTAND_THIS_BROADCASTS \
GHOLA_ARB_CANARY_REQUIRE_EDGE=true \
npm run canary:arb:prod
```

The canary writes a redacted report to
`.dev/ghola-arb-production-canary.json` by default.

Supported v1 pairs:

- Coinbase Advanced spot to Hyperliquid perp for `BTC-USD`, `ETH-USD`, `SOL-USD`.
- Jupiter SOL swap to Hyperliquid SOL perp for `SOL-USD`.

Production Hyperliquid must be verified in two steps. The no-submit verifier
stores a sealed BYO API wallet vault and proves that production routes, auth,
worker readiness, account snapshot, account SSE, sealed instruction opening,
policy gates, Hyperliquid SDK availability, market/account reads, and capped IOC
order-request construction work without broadcasting an order:

```bash
cd apps/web
GHOLA_VERIFY_EMAIL=<test-user-email> \
GHOLA_VERIFY_PASSWORD=<test-user-password> \
GHOLA_VERIFY_HYPERLIQUID_ACCOUNT_ADDRESS=0x... \
GHOLA_VERIFY_HYPERLIQUID_API_WALLET_PRIVATE_KEY=0x... \
GHOLA_VERIFY_STORE_HYPERLIQUID_VAULT_CONFIRM=I_UNDERSTAND_THIS_STORES_A_SEALED_VAULT \
npm run verify:prod:hyperliquid
```

This certificate proves readiness to attempt broadcast, not final venue
acceptance, API-wallet approval, or a fill. Only after no-submit passes, run a
capped live tiny-fill canary:

```bash
cd apps/web
GHOLA_VERIFY_EMAIL=<test-user-email> \
GHOLA_VERIFY_PASSWORD=<test-user-password> \
GHOLA_VERIFY_HYPERLIQUID_ACCOUNT_ADDRESS=0x... \
GHOLA_VERIFY_HYPERLIQUID_API_WALLET_PRIVATE_KEY=0x... \
GHOLA_VERIFY_STORE_HYPERLIQUID_VAULT_CONFIRM=I_UNDERSTAND_THIS_STORES_A_SEALED_VAULT \
GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS \
npm run verify:prod:hyperliquid:live
```

If the verifier reports `routes_ready_credentials_required`, routes are live
but the production trading claim is still unproven because no real Hyperliquid
API wallet was supplied.

Do not set `GHOLA_PRIVATE_AGENT_ATTESTED_READY=true` until the verifier has
checked the CVM quote, image digest, measurement, and X25519 key binding. The
status API treats a missing recipient key as not ready even when the endpoint
and API key are configured.

Never reuse `PHALA_CLOUD_API_KEY` as `GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN`.
Never leave `GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64` empty in production. The web
app rejects signed funding attestations from unpinned worker keys outside
local/test mode, and the worker reports not-ready for live venue mode unless
`PRIVATE_AGENT_FUNDING_SIGNING_KEY` is configured.
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

Verified Private Mode canaries:

```bash
GHOLA_BASE_URL=https://ghola.xyz \
GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN=<internal-token> \
node scripts/canary/private-mode-verified-canaries.mjs .dev/private-mode-canaries.json
```

The payload must contain `unfunded`, `funded_program`, and `funded_relayer`
entries with `receipt_id`, `destination_commitment`, `amount_bucket`,
`asset_bucket`, and `expected_result`. The web app replays each receipt through
the configured shielded verifier and stores only verifier-derived canary
commitments; raw `evidence_commitment` strings no longer make production
canaries green.

Venue credential canary:

```bash
set -a; source .dev/private-agent-staging.env; set +a
GHOLA_CANARY_VENUE=hyperliquid \
GHOLA_RUN_LIVE_VENUE_CANARY=1 \
GHOLA_CANARY_LIVE_MODE=full_ticket \
GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE=5 \
GHOLA_CANARY_HYPERLIQUID_MAX_SLIPPAGE_BPS=50 \
GHOLA_CANARY_REPORT_URL=https://ghola.xyz/v1/private-account/live-trading/canary-report \
GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN=<internal-token> \
node scripts/canary/private-agent-venue-live.mjs
```

Hyperliquid live/testnet canaries require an already-approved API/agent wallet:
set `GHOLA_CANARY_HYPERLIQUID_ACCOUNT_ADDRESS` and
`GHOLA_CANARY_HYPERLIQUID_API_WALLET_PRIVATE_KEY`. Coinbase BYO canaries require
an Advanced Trade key with view+trade permissions and transfer disabled: set
`GHOLA_CANARY_VENUE=coinbase_byo`,
`GHOLA_CANARY_COINBASE_API_KEY_NAME`, and either
`GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64` or
`GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_PATH`. Jupiter canaries use
`GHOLA_CANARY_VENUE=jupiter`; live mode requires
`GHOLA_CANARY_JUPITER_AUTHORITY_PRIVATE_KEY`, strict input/output mint
allowlists, and the worker-side `PRIVATE_AGENT_JUPITER_API_KEY`.

By default the venue canary uses no-submit/preview flows and does not write live
launch evidence. To create a green launch canary, set
`GHOLA_CANARY_SUBMIT_ORDER=1`, `GHOLA_CANARY_ACK_TINY_ORDER_RISK=1`,
`GHOLA_CANARY_LIVE_MODE=full_ticket`, `GHOLA_CANARY_REPORT_URL`, and the web
`GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN`. The script submits the sealed order,
reconciles the venue, then stores only redacted receipt/result commitments in
`/v1/private-account/live-trading/canary-report`. Keep the venue on
testnet/sandbox first, then run one mainnet canary only after the worker and web
envs are pinned to the fresh image digest.

```bash
GHOLA_CANARY_VENUE=hyperliquid \
GHOLA_RUN_LIVE_VENUE_CANARY=1 \
GHOLA_CANARY_HYPERLIQUID_NETWORK=mainnet \
GHOLA_CANARY_LIVE_MODE=full_ticket \
GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE=5 \
GHOLA_CANARY_HYPERLIQUID_MAX_SLIPPAGE_BPS=50 \
GHOLA_CANARY_SUBMIT_ORDER=1 \
GHOLA_CANARY_ACK_TINY_ORDER_RISK=1 \
GHOLA_CANARY_REPORT_URL=https://ghola.xyz/v1/private-account/live-trading/canary-report \
GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN=<internal-token> \
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
