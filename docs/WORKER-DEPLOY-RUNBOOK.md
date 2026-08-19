# Attested Worker Deploy Runbook

Public live trading requires a Phala-attested worker. Unattested development workers are never launch
eligible.

## Build identity

Build one immutable image from the same full 40-character commit as the web release. The image workflow
accepts only `private-agent-worker-<full SHA>`, bakes that SHA into `/app/build-identity.json`, adds the OCI
revision label, and emits BuildKit provenance. Record:

- `PRIVATE_AGENT_BUILD_GIT_SHA`
- `PRIVATE_AGENT_IMAGE_DIGEST` and `PHALA_CVM_IMAGE_DIGEST`
- `GHOLA_WEB_GIT_SHA` and `GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA` on the web
- `GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST` on the web

Verify the provenance subject maps the baked SHA to the registry digest. Deploy only `tag@sha256:digest`.
The worker rejects a runtime SHA that differs from its baked SHA. A runtime digest string alone is not
image proof; it must match the registry manifest, pinned compose image, and Phala recipient/attestation.
Before approval, require `git status --porcelain` to be empty, record `RELEASE_SHA=$(git rev-parse
HEAD)`, and require the pushed protected release ref to resolve to that exact SHA. After approval,
dispatch exactly once **at that ref** with `ref_to_build=<full SHA>` and
`image=ghcr.io/anndrrson/ghola:private-agent-worker-<full SHA>`. The protected
`investor-worker-release` environment must require a human reviewer. The workflow refuses an existing
tag. A failed or interrupted run is a stop, not a retry, and the tag must never be deleted or reused.
The build must also publish a GitHub-signed artifact attestation. Verify the exact digest before any
provisioning with `gh attestation verify oci://ghcr.io/anndrrson/ghola@sha256:<digest> --repo
anndrrson/ghola --signer-workflow
github.com/anndrrson/ghola/.github/workflows/build-private-agent-worker-image.yml --source-digest
<full SHA> --format json` and require the SLSA v1 subject name, digest, source repository, workflow,
and commit to equal the approved release.

Build Thumper once from the same exact SHA with the protected `build-thumper-image.yml` workflow and
the immutable tag `ghcr.io/anndrrson/ghola:thumper-cloud-<full SHA>`. It has the same single-attempt,
tag-absence, pinned-action/base-image, baked-identity, provenance, SBOM, and GitHub-attestation gates.
Verify its signed digest independently before updating Render. The live `thumper-cloud` service must
remain image-backed with automatic deploys and Blueprint Auto Sync off; update it once to the verified
`tag@sha256:digest`. Never switch it to a source build or ask Render to rebuild the repository.

## Worker contract

Generate the env file with `scripts/build-phala-worker-env.mjs`. Live mode fails generation unless
these values are exact:

```text
PRIVATE_AGENT_STATE_STORE=postgres
PRIVATE_AGENT_STATE_POSTGRES_URL=<durable database>
PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true
PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY=true
PRIVATE_AGENT_VENUE_DRY_RUN=false
PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false
PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true
PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket
PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED=true
PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=100
PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD=500
PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=100
PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD=100
PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD=500
PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true
GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED=true
PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only,stop_loss,take_profit
PRIVATE_AGENT_BUILD_GIT_SHA=<release SHA>
GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola:private-agent-worker-<full release SHA>
GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST=sha256:<image digest>
PRIVATE_AGENT_IMAGE_DIGEST=sha256:<image digest>
PHALA_CVM_IMAGE_DIGEST=sha256:<same image digest>
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<funding signer SPKI public key>
```

The env builder verifies that the pinned public key matches `PRIVATE_AGENT_FUNDING_SIGNING_KEY`.
All three digest pins must be the identical lowercase `sha256:` value. Also configure distinct,
strong execution/capability secrets (at least 32 characters, not placeholders) and rate limits. Never set legacy
`GHOLA_HYPERLIQUID_LIVE_MODE`.

## Web contract

```text
GHOLA_LIVE_TRADING_PUBLIC_ENABLED=true
PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true
GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED=true
GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES=limit_order,cancel,reduce_only,stop_loss,take_profit
GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD=100
GHOLA_LIVE_TRADING_DAILY_CAP_USD=500
GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS=100
GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true
GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET=<strong secret>
GHOLA_LIVE_TRADING_CONTROL_TOKEN=<strong operator secret>
GHOLA_LIVE_TRADING_RESET_TOKEN=<distinct strong reset-only secret>
GHOLA_INVESTOR_CANARY_SECRET=<strong web-to-Thumper canary secret>
CRON_SECRET=<strong scheduled-route secret>
GHOLA_PRIVATE_AGENT_EXECUTION_URL=https://<worker>
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN=<strong worker execution secret>
GHOLA_WEB_GIT_SHA=<exact release SHA>
VERCEL_GIT_COMMIT_SHA=<same exact release SHA>
GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA=<same exact release SHA>
GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST=sha256:<image digest>
PRIVATE_AGENT_IMAGE_DIGEST=sha256:<same image digest>
PHALA_CVM_IMAGE_DIGEST=sha256:<same image digest>
GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED=false
GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN=false
GHOLA_PHALA_SPEND_BRAKE_DISABLED=true
GHOLA_PRIVATE_AGENT_SPEND_ARMED=true
GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED=false
GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN=false
GHOLA_HYPERLIQUID_ACCOUNT_PROOF_ENABLED=true
NEXT_PUBLIC_GHOLA_HYPERLIQUID_ACCOUNT_PROOF_ENABLED=true
PRIVATE_AGENT_STATE_STORE=postgres
GHOLA_PRIVATE_ACCOUNT_STORE=postgres
GHOLA_PRIVATE_ACCOUNT_DATABASE_URL=<durable app database>
PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true
PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY=true
PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false
PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED=true
PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD=100
PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD=500
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<same pinned public key>
```

The investor live-release validator rejects the release unless provisioning mutations are explicitly
`false`; do not include this app-only guard in the shared web/worker execution fingerprint.

Set `GHOLA_PHALA_SPEND_BRAKE_DISABLED` as a GitHub repository variable as well as recording it in
release evidence. Mirror every worker contract value and release identity field on the web. Ordinary user/session/cron
wakes must use `GHOLA_PRIVATE_AGENT_EXECUTION_URL` and `GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN`; leave legacy
worker/connector aliases unset or set them to the identical origin/token. The compiled
`GHOLA_BAKED_WEB_GIT_SHA`, configured web SHA, Vercel SHA, and worker SHA must all match. Ordinary user/session/cron
wakes may inspect or start the existing CVM but must never provision it or update compose. Keep idle
shutdown and the Phala spend-brake schedule disabled for the investor cohort because no durable global
venue-exposure model can yet prove every BYO account flat before stopping the worker. Keep public launch state
disabled until the operator starts the canary; the proof UI remains required for each new account's
$11.00 graduation.

## Checks

1. `GET <worker>/ready`: overall and `live_trading.ready` are true; baked SHA, digest, fingerprint, caps,
   and all five capabilities match the web.
2. `GET <worker>/.well-known/private-agent-recipient`: `attested_ready=true`; image digest and
   report-data binding match.
3. `GET /api/health/ready`: `checks.byo_hyperliquid=ready` only after public activation and proofs.
4. `GET /api/internal/live-trading/launch`: inspect exact durable state and proof counts.
5. Restart the worker and web; confirm state, idempotency receipts, and kill state persist.

## Canary and rollback

Set durable state to `canary`. Each proof spends real user funds and needs separate authorization.
Three distinct eligible accounts must pass before public activation; repeated proofs from one account
do not count toward the launch threshold. The durable gate deduplicates the validated Hyperliquid
account commitment from independent venue evidence, not Ghola account, vault, or API-wallet identifiers.

For any mismatch or incident, first set durable web state to `killed`. Keep the worker global kill switch
off while canceling orders, closing reduce-only, reconciling every claim, and independently proving the
venue flat. Only then set the worker global kill switch or stop the CVM. Roll back web and worker as one
matching SHA/digest/fingerprint pair; never strand emergency exits behind a mismatched artifact.

Use the exact emergency requests (replace `<revision>` with the killed revision returned by the first call):

```sh
curl -sS https://ghola.xyz/api/internal/live-trading/launch -X POST \
  -H "Authorization: Bearer $GHOLA_LIVE_TRADING_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"state":"killed","updated_by":"operator","confirmation":"KILL HYPERLIQUID MAINNET LIVE TRADING"}'

curl -sS https://ghola.xyz/api/internal/live-trading/launch -X POST \
  -H "Authorization: Bearer $GHOLA_LIVE_TRADING_RESET_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"state":"disabled","updated_by":"operator","expected_revision":<revision>,"confirmation":"RESET KILLED LIVE TRADING TO DISABLED"}'
```

The kill is absorbing; reset is a separately authenticated exact-version transition to `disabled`,
never directly to canary or public.

## Guarded release

The legacy `launch-private-stack.yml` is permanently disabled. Before the first mutation, record the
prior Vercel, Render, worker-image, Phala compose, launch-control, and database-backup identifiers. Require
an existing stable HTTPS `GHOLA_PRIVATE_AGENT_EXECUTION_URL`; a newly discovered URL cannot be injected
into an already-built one-artifact web release.

Disable Vercel Git deploys, every Render service auto-deploy, Render Blueprint Auto Sync, the scheduled
Phala spend brake, and every other workflow capable of changing Vercel, Render, or Phala before pushing.
Verify those controls read-only and record them in the protected operations evidence. After every local
test, typecheck, lint, production build, PostgreSQL integration test, and security gate passes on the clean
commit, obtain explicit human approval for one release attempt.

The single approved attempt is: build the worker image once; build the Thumper image once; verify both
signed SHA-to-digest provenance records; update the image-backed Thumper service once; set durable launch
`disabled`; update the existing CVM
once; validate its attestation and no-submit checks; build one non-aliased Vercel production candidate from
the exact SHA; revoke any temporary deployment-protection bypass; then promote only that already-tested
artifact and rebind `canary`. Stop and report the first failure. Never auto-retry a paid build, deploy, or
provision. Restore the frozen automation only after the cohort is venue-wide flat, all claims are terminal,
and rollback evidence is complete.

If the authenticated web provision route is used for that one CVM update, its bearer must be a temporary
32+ character secret and the mutation flag must be true only for the isolated operator mutation artifact.
The promoted investor artifact must have the mutation flag false and no provision token.
