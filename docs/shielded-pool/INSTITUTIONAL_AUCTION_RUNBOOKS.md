# Institutional Shielded Auction Runbooks

This runbook covers the `shielded_batch_auction` rail for institutional use.
The web routes expose non-blocking institutional readiness diagnostics at
`/v1/private-account/operations/status`. Full enterprise production is blocked
until the enterprise external gate is ready; production safety is also enforced
by on-chain verification, finalized transaction confirmation, self-custody
signing, and connector/runtime failures.

## Local Working Auction Smoke

Use this before any external gate review. It starts from localnet, signs every
prepared auction transaction with a local keypair, confirms lifecycle
transactions through the web routes, and exits only after the auction is
settled in local operational state.

Prerequisites:

1. Start a local validator and deploy `said_shielded_pool` with the default
   no-real-verifier local build.
2. Make sure the local signer has SOL on localnet.
3. From `apps/web`, run:

```sh
NEXT_PUBLIC_SOLANA_RPC_URL=http://127.0.0.1:8899 \
GHOLA_SHIELDED_POOL_PROGRAM_ID=5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A \
GHOLA_AUCTION_SIGNER_KEYPAIR=~/.config/solana/id.json \
npm run smoke:auction-local
```

The script creates a local SPL mint when `GHOLA_SHIELDED_POOL_MINT` is not set,
initializes the pool PDA if missing, starts a temporary Next dev server on
`GHOLA_AUCTION_LOCAL_PORT` when `GHOLA_WEB_URL` is not supplied, and prints a
JSON result with `cluster`, `commitment`, transaction signatures, per-operation
slots, and `status: "settled"`. Failures are emitted as JSON with `stage`,
`operation`, `code`, `recovery_hint`, and route or Solana log details.

If using an already-running web server, set `GHOLA_WEB_URL` and start that
server with:

- `GHOLA_AUCTION_ON_CHAIN_PREPARE=true`
- `GHOLA_AUCTION_CONFIRMATION_MODE=local_test`
- `GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS=true`
- `GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN=<local token>`
- `GHOLA_SHIELDED_POOL_PROGRAM_ID=<deployed program>`
- `GHOLA_SHIELDED_POOL_MINT=<local mint>`

## Devnet Auction Smoke

Use this after local smoke passes and before external gate removal. Devnet mode
does not airdrop, create a mint, or initialize the pool. It verifies the
program is executable, the mint exists, the pool PDA exists, the signer is the
pool admin, and lifecycle transactions reach finalized confirmation.

Prerequisites:

1. Deploy `said_shielded_pool` to devnet and set
   `GHOLA_SHIELDED_POOL_PROGRAM_ID`.
2. Initialize the pool PDA and choose the devnet admin signer.
3. Create or choose the SPL mint and set `GHOLA_SHIELDED_POOL_MINT`.
4. Fund the admin signer on devnet.
5. From `apps/web`, run:

```sh
GHOLA_AUCTION_SMOKE_CLUSTER=devnet \
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com \
GHOLA_SHIELDED_POOL_PROGRAM_ID=<devnet program id> \
GHOLA_SHIELDED_POOL_MINT=<devnet mint> \
GHOLA_AUCTION_SIGNER_KEYPAIR=~/.config/solana/devnet-admin.json \
npm run smoke:auction-devnet
```

When `GHOLA_WEB_URL` is not supplied the script starts a temporary local Next
server with on-chain auction preparation enabled and finalized confirmation.
When using an existing web server, configure that server with the same RPC,
program id, mint, and `GHOLA_AUCTION_ON_CHAIN_PREPARE=true`.

## Production Gate Checklist

Before enabling institutional production, operations should confirm:

1. Auction Groth16 ceremony completed for `auctionClearing.circom`.
   Readiness reports concrete prover paths through
   `auction_clearing_prover_artifacts`; set
   `GHOLA_AUCTION_PROVER_ARTIFACTS_DIR` or the individual
   `GHOLA_AUCTION_CLEARING_*_PATH` overrides for the zkey, WASM, and
   verification key.
2. Generated `auction_verifying_key.rs` reviewed and compiled with
   `real-verifier,auction-verifier-ready`.
3. Anchor program deployed to the target cluster and pinned by
   `GHOLA_SHIELDED_POOL_PROGRAM_ID`.
4. Web/API auction routes wired to Anchor `init/open/commit/close/settle`
   instructions, not the local store simulation.
5. Self-custody operating policy signed off:
   `GHOLA_INSTITUTIONAL_CUSTODY_MODE=self_custody`.
6. Compliance, permissioning, audit export, and evidence-retention controls
   signed off. Enterprise readiness remains blocked until the signoff artifact
   hash and date are published through `/api/security/enterprise-gate`.
7. External security review and adversarial tests passed, including
   High/Critical retest evidence. Enterprise readiness remains blocked until
   the final report and retest hashes are published.
8. RFQ/venue connector is live-ready outside `local_test`.
9. Kill switch, rate limit, incident ownership, and paging are active.
10. Failed-clearing, rollover, settlement, and dispute runbooks accepted, with
    tabletop and live non-destructive drill evidence recorded.

The enterprise gate also requires a frozen review baseline and an issued SOC 2
Type II report. The public-safe evidence variables are:

```sh
GHOLA_ENTERPRISE_BASELINE_TAG=<review-tag>
GHOLA_ENTERPRISE_BASELINE_COMMIT=<git-sha>
GHOLA_ENTERPRISE_BASELINE_DEPLOYMENT_URL=https://ghola.xyz
GHOLA_ENTERPRISE_BASELINE_WORKER_IMAGE_DIGEST=sha256:<digest>
GHOLA_ENTERPRISE_BASELINE_REDACTED_ENV_HASH=sha256:<hash>
GHOLA_ENTERPRISE_BASELINE_ARTIFACTS_HASH=sha256:<hash>
GHOLA_ENTERPRISE_BASELINE_FROZEN_AT=<iso8601>
GHOLA_EXTERNAL_SECURITY_REVIEW_STATUS=passed
GHOLA_EXTERNAL_SECURITY_REVIEW_FIRMS="Trail of Bits,NCC Group"
GHOLA_EXTERNAL_SECURITY_REVIEW_REPORT_HASH=sha256:<hash>
GHOLA_EXTERNAL_SECURITY_REVIEW_REPORT_DATE=<yyyy-mm-dd>
GHOLA_EXTERNAL_SECURITY_REVIEW_RETEST_STATUS=passed
GHOLA_EXTERNAL_SECURITY_REVIEW_RETEST_HASH=sha256:<hash>
GHOLA_CUSTODY_MODEL=self_custody
GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_STATUS=signed
GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_FIRM=<outside-counsel>
GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_HASH=sha256:<hash>
GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_DATE=<yyyy-mm-dd>
GHOLA_SOC2_TYPE2_STATUS=issued
GHOLA_SOC2_TYPE2_AUDITOR=<cpa-firm>
GHOLA_SOC2_TYPE2_REPORT_HASH=sha256:<hash>
GHOLA_SOC2_TYPE2_REPORT_DATE=<yyyy-mm-dd>
GHOLA_SOC2_TYPE2_PERIOD_START=<yyyy-mm-dd>
GHOLA_SOC2_TYPE2_PERIOD_END=<yyyy-mm-dd>
GHOLA_SOC2_TYPE2_CRITERIA=Security,Availability,Confidentiality
GHOLA_RUNBOOK_DRILLS_STATUS=accepted
GHOLA_RUNBOOK_DRILLS_EVIDENCE_HASH=sha256:<hash>
GHOLA_RUNBOOK_DRILLS_ACCEPTED_AT=<iso8601>
GHOLA_RUNBOOK_TABLETOP_DRILL_AT=<iso8601>
GHOLA_RUNBOOK_LIVE_DRILL_AT=<iso8601>
GHOLA_SECURITY_FINDINGS_CRITICAL_OPEN=0
GHOLA_SECURITY_FINDINGS_HIGH_OPEN=0
```

## Failed Proof Generation

Trigger: solver cannot produce a valid auction clearing witness/proof before
the close SLA.

Procedure:

1. Freeze new commits for the affected epoch by opening a replacement epoch.
2. Keep the failed epoch `open` until `closes_slot`; do not mark it cleared.
3. Export the epoch order root, order count, connector state, and solver logs.
4. Retry proof generation once with the same public inputs.
5. If retry fails, roll every committed order into the replacement epoch and
   record an audit note with the failed witness commitment.

Required evidence:

- auction epoch PDA
- `order_root`
- committed order count
- solver binary/version commitment
- witness commitment
- failure reason

## On-Chain Verification Failure

Trigger: Anchor `close_auction_epoch` rejects with `InvalidProof`,
`AuctionVerifierUnavailable`, or `AuctionProofPublicInputMismatch`.

Procedure:

1. Stop settlement for the affected epoch.
2. Compare proof public inputs with on-chain epoch fields:
   `auction_order_root`, `matched_count`, `rolled_count`,
   `settlement_commitment`, and `clearing_commitment`.
3. If inputs do not match, discard the proof and regenerate from the latest
   indexed epoch state.
4. If the verifier is unavailable, leave production disabled and redeploy only
   after the auction VK artifact has been reviewed.
5. If the proof still fails with matching inputs, escalate to cryptography
   review and keep orders rolled.

## Partial Fills And Rollover

The v1 circuit proves a deterministic partition:

- matched buys have price greater than or equal to the clearing bucket
- matched sells have price less than or equal to the clearing bucket
- rolled buys are below the clearing bucket
- rolled sells are above the clearing bucket
- matched buy count equals matched sell count

If buy/sell interest is imbalanced, unmatched committed orders must be rolled
into the next epoch. A partial-fill policy must be represented as a new circuit
revision; do not simulate partial fills off-chain while claiming this v1 proof.

Rollover procedure:

1. Preserve original order commitments and nullifiers.
2. Create replacement hidden order commitments with new nonces.
3. Link old-to-new rollover commitments in the audit export only, never in
   public route responses.
4. Submit replacement commitments to the next open epoch.

## Settlement Failure

Trigger: clearing is proven but venue/RFQ settlement fails or times out.

Procedure:

1. Keep `AuctionClearing.status=cleared`; do not mark settled.
2. Pause connector submissions for the affected venue.
3. Export connector request/response commitments and runtime envelope hashes.
4. Retry settlement under the same `settlement_commitment` if the venue accepts
   idempotent retry.
5. If settlement cannot be recovered, mark downstream settlement failed and
   roll affected user actions through a new auction or fallback rail.

## Dispute And Audit Handling

For a dispute, produce a selective-disclosure bundle containing:

- user-scoped view key commitment
- auction epoch commitment
- order commitment
- order nullifier commitment
- clearing commitment
- proof commitment
- matched/rolled root membership evidence
- connector result commitment
- settlement commitment or failure reason
- runtime attestation and policy commitments

The export must not expose raw order price, amount, venue account, or wallet
identity unless the institution's compliance policy explicitly authorizes that
scope.

## Connector Outage

Trigger: RFQ connector readiness is `missing`, `stale`, or `blocked`.

Procedure:

1. Disable live submit by setting connector readiness away from `ready`.
2. Let open epochs close normally, but force all affected orders to rollover.
3. Record venue outage time, connector manifest commitment, and health status.
4. Re-enable only after `/connectors/readiness` returns `ready` for the RFQ
   network and the operations owner accepts the incident note.

## Emergency Pause

Use the pool pause authority for on-chain proof or settlement integrity issues.
Use `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=true` for venue connector or operational
incidents.

After any emergency pause, the institutional auction readiness diagnostics
should be reviewed before reenabling live institutional auction operations.
