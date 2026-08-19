# Investor canary acceptance

Release gate for two independent, invite-only Hyperliquid mainnet investors. It never authorizes public launch and never automates Phantom or trade confirmation.

## GO means

- Both investors used one immutable web/worker release.
- Each redeemed a separate email-bound, one-use complimentary pass.
- Each sealed a distinct trade-only vault and completed one release-bound $11 graduation proof.
- Each then used the normal terminal for two distinct protected $11 limit IOC entries and the normal **Close HYPE · RO** control.
- A full human reload separated the two terminal round trips.
- Every successful entry had terminal venue fill proof beyond the gateway acknowledgment.
- Every entry's venue-native take-profit and stop-loss children had exact canceled readback and no fill after the reduce-only close.
- Every close had reduce-only fill/readback proof, completed PostgreSQL claims, and an independent venue-wide flat/zero-order snapshot.
- Global live trading stayed red; only the authenticated graduated owner was green in account_canary.
- Production observability/reconciliation checks were ready, and signed registry provenance independently bound the baked worker SHA to the deployed OCI digest.

GO applies only to the exact deployment, worker image, config fingerprint, and live verifier report.

## Why there is no third proof

Three distinct venue-account proofs promote capabilities for a public launch. This gate must remain private. The owner-scoped canary policy bypasses only that public promotion check for an authenticated owner whose v3 graduation matches the exact release. The harness therefore requires two investor graduations, not a third global proof, and requires /v1/private-account/live-trading/status to remain red.

## Before inviting

Pin:

- web and worker Git SHA;
- immutable web deployment ID;
- worker OCI digest and attestation;
- GitHub-signed registry provenance binding that digest to the exact worker Git SHA;
- live config fingerprint;
- canary launch-control record;
- rollback artifact, distinct prior-release artifact, incident owner, kill-control proof, and reduce-only recovery proof.

Verify:

- worker is mainnet, full-ticket, dry-run off, attested, and PostgreSQL-backed;
- `GHOLA_INVESTOR_WEB_ORIGIN=https://ghola.xyz`, the same 32+ character server-only `GHOLA_INVESTOR_CANARY_SECRET` is set on web and thumper-cloud, and `ADMIN_EMAILS` contains only authorized issuers/revokers;
- worker_execution_claims, worker_execution_attempts, and worker_idempotency are current;
- limit_order,cancel,reduce_only,stop_loss,take_profit are configured;
- kill and reduce-only recovery paths are ready;
- a process-restart replay returns the same receipt without another broadcast;
- `/api/health/ready` reports configured observability, ready reconciliation, ready database/circuit/worker, and configured venue/control connectivity;
- global live status is red/canary;
- an invited, graduated owner receives green account_canary;
- a different authenticated owner receives red/blocked.

Each pass must remain valid for more than 30 minutes and show, before every exposure-increasing action:

- starter or private_agent;
- access_source=complimentary_pass;
- at least 600 compute seconds and a free agent slot;
- live trading allowed, overage disabled, and at least $22 included filled-notional remaining.

## Issue passes without exposing them

The allowlisted operator issuer calls the backend contract exactly: authenticated `POST /api/billing/access-passes` with the admin-secret header and `{email,tier,grant_days,redeem_days,idempotency_key}`. Reusing the same key and payload returns the same pass. The response includes a non-secret opaque `pass_id` and an HTTPS URL on the pinned web origin with only `/account#access=<32–128 URL-safe characters>`. Revoke with `pass_id`; never send the redeem code to the revoke route. The client never redeems `?access=` query parameters because queries reach servers and intermediaries. It captures only a valid `#access=` fragment and immediately replaces the visible URL with the clean path before starting redemption or billing work.

Load the operator bearer and admin secret into the environment from the approved secret store; never put either on a command line. Also set the exact API base and pinned web origin:

    GHOLA_THUMPER_API_BASE
    GHOLA_OPERATOR_SESSION_TOKEN
    GHOLA_INVESTOR_PASS_ADMIN_SECRET
    GHOLA_INVESTOR_WEB_ORIGIN

Then use a new path in a private directory:

    cd apps/web
    umask 077
    npm run issue:investor:pass -- --email <bound-email> --idempotency-key <stable-unique-key> --out /protected/new-investor-invite.json

The command refuses overwrite, creates the file mode 0600, validates the returned origin/path/fragment, and prints neither the invitation nor its path. The protected JSON contains the bound email, `pass_id`, idempotency key, and email-ready URL. Paste that URL directly into the intended email; never print it in a terminal or copy it into chat, logs, tickets, screenshots, or the acceptance dossier. Store only its SHA-256 commitment plus the non-secret `pass_id` in evidence, and delete the protected artifact under the secret-retention policy after redemption or expiry. Redemption requires an account whose bound email was verified by Google or Apple; password-only accounts are denied.

Before GO, issue passes only to the two designated supervised acceptance accounts. After GO, create a new, email-bound pass for the intended investor; never reuse an acceptance pass.

## Cohort

Investor A and B each need a distinct:

- email-bound Ghola account;
- Phantom wallet;
- Hyperliquid account;
- sealed trade-only API wallet/vault.

Start venue-wide flat with zero orders. Fund Hyperliquid with enough USDC for $11 isolated 1× exposure, three real round trips, fees, and a conservative buffer. Do not send SOL for this flow; Phantom signs authorization messages and does not fund Hyperliquid.

Use a clean Chrome profile per investor.

## Human run

1. Open the fragment-based invite. Sign in with the bound email. Confirm the URL is scrubbed and billing shows active complimentary access.
2. Confirm non-US eligibility, current terms, and risk disclosure.
3. Start the attested worker from the product. Connect the funded Hyperliquid master account through Phantom's Ethereum provider.
4. Phantom displays exactly one Hyperliquid `approveAgent` EIP-712 authorization. The investor verifies the Ethereum master account and approves it. Ghola generates the trade-only agent key in memory, seals it directly to the attested worker, proves that the worker can decrypt the exact account/agent binding without submitting a trade, and stores only ciphertext plus commitments. No one enters, copies, or sees a private key.
5. Record committed Hyperliquid clearinghouseState and openOrders evidence showing venue-wide flat/zero orders.
6. On /trade/mainnet-e2e, connect/select Phantom's Solana account. Direct connection requests no SIWS; only if Ghola displays **Continue with Phantom** does the investor approve the conditional SIWS stage. Solana needs no SOL.
7. After **Wallet verified**, the investor clicks **Sign and run real $11.00 round trip** once and approves exactly two scoped Solana messages in order: the wallet-binding challenge, then the exact graduation request.
8. Require a v3 graduation bound to the exact web SHA, worker SHA, image digest, config fingerprint, owner, venue account, and vault. Recheck venue-wide flat/zero orders.
9. Open the normal /trade terminal. Require:
   - `/v1/private-account/live-trading/status` red;
   - `/v1/private-account/live-trading/terminal-access` green with `access_mode=account_canary` for this owner;
   - all account requirements true;
   - current entitlement and worker evidence.
10. In normal order controls, select HYPE, limit IOC, $11, isolated 1×, and venue-native stop/take-profit protection. Create a fresh preview.
11. The investor opens the exact-order review, verifies the entry, venue take-profit, venue stop-loss, and protection slippage cap, then confirms. A normal entry requests no Phantom signature; the sealed trade-only agent submits the bound orders.
12. Treat the gateway response only as an acknowledgment. Require the matching worker_execution_claims row to be completed and exact-request-bound, plus a terminal Hyperliquid fill receipt and visible protected HYPE exposure.
13. In the live account blotter, the investor selects **Close HYPE · RO** and clicks **Sign + close** once. Phantom may first request SIWS if Solana sign-in is not current, then requests exactly two scoped messages: the wallet-binding challenge and the exact reduce-only close request.
14. Require a reconciled close receipt with filled reduce-only order/readback evidence. Require exact canceled/no-fill readback for both protection children. Independently re-query the entire venue account and require zero positions and zero orders.
15. Perform a full human browser reload.
16. Repeat steps 9–14 with a new preview, plan digest, idempotency commitment, work order, claim, venue order, and transaction. Do not rotate the vault.

At every wallet stage, one click must advance to the next named stage. A repeated same-stage prompt, unavailable sign-in bridge, account mismatch, or unexplained prompt is NO-GO; stop instead of confirming again or resubmitting.

### IOC no-fill

A terminal no-fill is not a successful trade. Retry only when the original work order has:

- a completed PostgreSQL claim;
- terminal final_no_fill_proven=true;
- terminal canceled/expired/rejected venue readback;
- a terminal IOC remainder; and
- no unknown or unresolved outcome.

Then create a new preview, plan digest, and idempotency key. Never resubmit the original request.

## Unavoidable human steps

- Account sign-up/sign-in and eligibility attestation.
- Phantom unlock and separate Ethereum/Solana account selection.
- The Phantom Ethereum connection and exactly one Hyperliquid trade-only `approveAgent` authorization.
- Conditional Solana SIWS only when **Continue with Phantom** is shown.
- Graduation risk checkbox, trade confirmation, wallet-binding message, and exact-request message.
- Exact normal-terminal order review and confirmation for each entry.
- **Close · RO**, **Sign + close**, and the two scoped Solana messages for each exit; SIWS may precede them only when sign-in is not current.
- Full page reload between terminal round trips.

The operator may collect and sanitize evidence, but cannot perform those actions for the investor.

## Evidence

An operator-authored offline dossier can be useful for diagnosis, but it always returns NO-GO and is never authoritative. The live gate accepts no general dossier/config JSON or caller-asserted machine-result booleans. It reads the production APIs, both PostgreSQL stores, Hyperliquid mainnet, and cryptographically verified GitHub registry provenance directly.

Two narrowly scoped attestations cover facts unavailable from those sources. Both must be regular, non-symlink files owned by the current user with mode 0600. They remain separately labelled and never become machine evidence.

The human file contains no email, address, token, order reference, transaction, signature, or ciphertext. Each investor object must contain every flag below, all `true`, plus the exact label and an `observed_at` after that investor's final venue fill:

    {
      "version": 1,
      "scope": "human_observations_only",
      "investors": [
        {
          "label": "A",
          "participant_is_non_operator": true,
          "invitation_email_opened": true,
          "verified_email_signup_or_signin_completed": true,
          "invite_fragment_scrubbed_before_redeem": true,
          "clean_chrome_profile_used": true,
          "worker_started_from_product": true,
          "phantom_evm_account_connected": true,
          "phantom_approve_agent_confirmed": true,
          "phantom_solana_account_connected": true,
          "phantom_siws_completed_if_requested": true,
          "graduation_wallet_binding_signature_confirmed": true,
          "graduation_exact_request_signature_confirmed": true,
          "first_terminal_entry_review_confirmed": true,
          "first_close_wallet_binding_signature_confirmed": true,
          "first_close_exact_request_signature_confirmed": true,
          "full_reload_between_round_trips": true,
          "second_terminal_entry_review_confirmed": true,
          "second_close_wallet_binding_signature_confirmed": true,
          "second_close_exact_request_signature_confirmed": true,
          "normal_terminal_entries_required_no_phantom_signature": true,
          "no_unexplained_repeated_prompt_or_stage_stall": true,
          "no_cli_dashboard_devtools_or_secret_setup": true,
          "confirmations_personally_completed": true,
          "observed_at": "ISO-8601"
        },
        {
          "label": "B",
          "participant_is_non_operator": true,
          "invitation_email_opened": true,
          "verified_email_signup_or_signin_completed": true,
          "invite_fragment_scrubbed_before_redeem": true,
          "clean_chrome_profile_used": true,
          "worker_started_from_product": true,
          "phantom_evm_account_connected": true,
          "phantom_approve_agent_confirmed": true,
          "phantom_solana_account_connected": true,
          "phantom_siws_completed_if_requested": true,
          "graduation_wallet_binding_signature_confirmed": true,
          "graduation_exact_request_signature_confirmed": true,
          "first_terminal_entry_review_confirmed": true,
          "first_close_wallet_binding_signature_confirmed": true,
          "first_close_exact_request_signature_confirmed": true,
          "full_reload_between_round_trips": true,
          "second_terminal_entry_review_confirmed": true,
          "second_close_wallet_binding_signature_confirmed": true,
          "second_close_exact_request_signature_confirmed": true,
          "normal_terminal_entries_required_no_phantom_signature": true,
          "no_unexplained_repeated_prompt_or_stage_stall": true,
          "no_cli_dashboard_devtools_or_secret_setup": true,
          "confirmations_personally_completed": true,
          "observed_at": "ISO-8601"
        }
      ]
    }

The release-operations file pins the exact release and commitments for rollback, the distinct prior artifact, incident ownership, kill/recovery proof, the complete operator-email set, and one observed process-restart receipt replay:

    {
      "version": 1,
      "scope": "release_operations_attestation",
      "release_identity": {
        "contract_version": 2,
        "web_git_sha": "40 lowercase hex",
        "worker_git_sha": "same 40 lowercase hex",
        "worker_image_digest": "sha256:64 lowercase hex",
        "config_fingerprint": "live_trading_config_<48 lowercase hex>"
      },
      "rollback": {
        "rollback_artifact_commitment": "sha256:64 lowercase hex",
        "prior_release_artifact_commitment": "sha256:64 lowercase hex",
        "incident_owner_commitment": "sha256:64 lowercase hex",
        "kill_control_commitment": "sha256:64 lowercase hex",
        "reduce_only_recovery_commitment": "sha256:64 lowercase hex",
        "operator_email_commitments": ["sha256:64 lowercase hex"],
        "operator_email_set_complete": true,
        "prepared_at": "ISO-8601"
      },
      "restart_replay": {
        "work_order_commitment": "live_trade_work_order_<48 lowercase hex>",
        "receipt_commitment": "sha256:64 lowercase hex",
        "process_restart_observed": true,
        "receipt_replayed": true,
        "rebroadcast_performed": false,
        "broadcast_count_before": 1,
        "broadcast_count_after": 1,
        "observed_at": "ISO-8601"
      }
    }

`prepared_at` must precede the acceptance start by no more than seven days; the prior artifact commitment must differ from the current release commitment. The replay work order and receipt commitment must match an actual acceptance entry claim, and `observed_at` must follow that claim. Each operator email commitment is SHA-256 over canonical key-sorted JSON `{"email":"lowercase-address","kind":"operator_email_v1"}`; build the complete set through approved secret tooling. The verifier hashes each authenticated investor email the same way and rejects membership.

Load these values from the approved secret store into environment variables. Never place a value on a command line or in shell history:

    GHOLA_INVESTOR_ACCEPTANCE_STARTED_AT
    GHOLA_INVESTOR_ACCEPTANCE_MAIN_DATABASE_URL
    GHOLA_INVESTOR_ACCEPTANCE_WORKER_DATABASE_URL
    GHOLA_INVESTOR_ACCEPTANCE_HUMAN_FILE
    GHOLA_INVESTOR_ACCEPTANCE_OPERATIONS_FILE
    GHOLA_INVESTOR_ACCEPTANCE_GITHUB_TOKEN
    GHOLA_INVESTOR_A_SESSION_TOKEN
    GHOLA_INVESTOR_B_SESSION_TOKEN
    GHOLA_INVESTOR_A_HYPERLIQUID_ACCOUNT
    GHOLA_INVESTOR_B_HYPERLIQUID_ACCOUNT

Use a current GitHub CLI with `gh attestation verify`; the registry package must be readable by the configured identity. The GitHub token needs only read access to repository/package attestations and is passed to `gh` through the child-process environment, never the command line. The verifier runs `gh attestation verify` against `oci://ghcr.io/anndrrson/ghola@<deployed digest>`, pins repository `anndrrson/ghola`, signer workflow `.github/workflows/build-private-agent-worker-image.yml`, the exact source SHA, and GitHub-hosted runners, then independently checks the SLSA subject digest. BuildKit metadata or worker self-report alone is insufficient. A missing signed attestation is NO-GO.

`/api/health/ready` may return 503 while public BYO remains intentionally blocked in canary. The verifier still parses that authoritative response and requires its database, trading-circuit, worker, observability, reconciliation, venue-connectivity, and trading-control subchecks to be ready/configured.

The harness pins `https://ghola.xyz`, the production Thumper API, Hyperliquid mainnet, the worker registry repository, and provenance signer in code. It requires two different verified profiles/tokens/accounts; current complimentary, zero-overage access; account-canary terminal access; automatic worker-verified vaults; exact-release v3 graduations; two distinct filled terminal entries and two distinct reduce-only close roots per investor; exact canceled/no-fill readback for four TP/SL children per investor; matching worker claims/attempts/idempotency; no unresolved claims; configured production observability and ready reconciliation; and venue-wide final flat with zero normal or frontend orders. It reads production status again at the end and rejects release drift. Output contains only commitments, counts, release identity, timestamps, and fixed failure codes.

Run locally after the two complete human journeys:

    cd apps/web
    npm run test:investor:canary
    npm run verify:investor:canary:live

Only the live command's `"status": "GO"` permits sending the invitation email for that exact immutable release. Human and operations attestations are labelled separately and are never represented as machine facts. The offline dossier validator always returns NO-GO.

## NO-GO / rollback

Stop for any mismatch, Phantom warning, expiry/allowance failure, stale access, release drift, unknown submit outcome, incomplete claim, partial/unproven fill, non-reduce-only close, remaining position, or open order.

Do not retry an unknown outcome. Disable exposure increase, use the release-bound reduce-only path, cancel residual orders, independently prove venue-wide flat/zero orders, reconcile the original claim, preserve sanitized evidence, and keep launch state canary.
