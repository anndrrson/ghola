# Ghola Hyperliquid end-to-end proof

Date: 2026-08-06  
Status: **NOT PROVEN END TO END**

## Current production verification

- Production is deployment `dpl_GxNgC4qp2HJPTtBJT9D7YKYQWLgA`, built from pushed commit `80d6867e3392e4c28c8122ba2a10ff836d496b4a` with that SHA supplied as deployment metadata.
- `/founding` returns 200. `/v1/private-account/live-trading/status` is green for BYO Hyperliquid mainnet (`live_trading_enabled=true`); pooled trading remains red because its worker is unavailable.
- Production limits are $15/order, $25/day, and 50 bps. Their prior trailing-newline encoding was corrected without widening the configured limits.
- A synthetic user signed up in production, signed in again on `ghola.xyz`, and retained authentication after a hard reload.
- Founding capacity remained 0 claimed, 10 remaining before payment.
- Email-session billing was initially broken because authenticated `/api/billing/*` calls bypassed the cookie-to-bearer proxy. Commit `80d6867e` fixes all authenticated `/api/*` calls to use the same-origin proxy; 715 web tests pass.
- The same user now reaches a recoverable live Stripe Checkout for **Ghola Founding Trader — $29/month** without `Failed to fetch` or `unauthorized`. No payment was submitted.
- Stripe's current success/cancel return URL still points to the old Render frontend because `ghola-cloud` checkout code uses backend `BASE_URL`; payment should not be completed until the user accepts this recovery caveat or a separately authorized Render release fixes it.
- Chrome's official Hyperliquid UI showed the master account with $21.33 trading equity. A dedicated signer named `ghola-e2e-0806` was authorized for two days; the existing `ghola-main-26` signer was preserved.
- Ghola's read-only preflight passed mainnet selection, master-account recognition, connected-wallet match, signer authorization, unified account mode, 5–25 USDC collateral, and BTC/ETH/SOL market availability.
- Encrypted credential storage correctly failed closed with `trading_subscription_required` while the synthetic user remained free. The generated key remains only in the preserved browser tab; it was never printed, committed, or sent unencrypted.
- No order, preview, cancellation, or close was submitted.

## Initial production baseline

- `ghola.xyz/trade` loaded in a temporary tab in the user's existing Chrome profile. After asynchronous session verification, it showed `credentials required`, proving the current browser identity is admitted to the trade page but has no connected Hyperliquid credential.
- `/signup` returned HTTP 200, but no account was created and the isolated signed-out browser was unavailable.
- Hyperliquid/mainnet was selected; the account showed `credentials required` and `Connect Hyperliquid mainnet`.
- No credential, checkout, signup, or order control was submitted.
- Public Hyperliquid market data was live and non-stale.
- The authoritative production launch gate returned `live_trading_enabled=false`, `live_submit_mode=disabled`, `byo_live_trading_enabled=false`, and `pooled_live_trading_enabled=false`. Hyperliquid BYO was red because maximum-order and daily caps were missing; its funded full-ticket canary was also missing as an advisory. Hyperliquid pooled execution additionally lacked live mode and had a failed worker probe. Gate commitment: `live_trading_launch_gate_dcdabb5497debf882ef3db75ce0534dc5f96e36a3f102808`.
- The chart rendered live Coinbase BTC-USD data, not venue-matched Hyperliquid data.
- `/founding` returned 404; Settings exposed Free, Pro, Private Agents, Unlimited, and Enterprise plans, but no Founding Trader checkout.
- The production `Connect Hyperliquid` dialog incorrectly linked to `/account` with both `setup=coinbase_advanced` and `venue=coinbase_advanced`; this prevents the visible Hyperliquid onboarding action from reaching its verifier.
- `/api/billing/founding-cohort` reported capacity 10, claimed 0, remaining 10, and checkout open.
- Ten concurrent GETs all returned HTTP 200 and satisfied `claimed + remaining = 10`; no checkout or reservation was created.
- A fresh `/api/private-agent/status` read reported `remote_execution_ready=false`, no selected provider, and `no_attested_confidential_compute_provider`. The configured Phala CVM was previously observed stopped and lacking recipient/report-data binding.
- The candidate's no-credential production verifier completed as `routes_ready_credentials_required`; it sent no order and confirmed the Hyperliquid market endpoint was HTTP 200 and non-stale. Route availability is not execution readiness.

## Initial deployment provenance

- Current production deployment: `dpl_3vDWBTMwS12x2boMmB4w3f3d87Y4`.
- It was created by CLI without Git metadata; an exact Git commit cannot be attributed.
- The downloaded 609-file web source is preserved locally as commit `f204e865`.
- It is a dirty snapshot closest to the reviewed chart branch, not a clean repository commit.
- It omitted reviewed founding checkout, billing/admission helpers, funding preflight, runtime status, worker-shard, connector, and chart tests/wiring.

## Automated proof

- Exact production-source targeted tests: 90 passed.
- Exact production-source auth tests: 9 passed.
- Six focused signup/session tests passed, covering same-origin protection, cookie-backed routing, upstream failure handling, and backend-verified identity.
- Restored production-based candidate: 134 test files and 714 tests passed; one opt-in PostgreSQL file/test is skipped in the ordinary suite and run separately against a disposable database.
- Ghola Cloud backend: 136 tests passed.
- Founding page tests prove the exact ten-seat display, logged-out signup redirect, and sold-out suppression.
- Confidential worker: 147 tests passed; focused Hyperliquid/policy tests passed.
- Browser and worker validation now independently reject a private key whose signer equals the master Hyperliquid account; withdrawals, vault transfers, and leverage escalation remain blocked.
- Worker tests prove sealed-only ingress, entitlement gates, venue-result classification, collateral handling, position refresh, and reduce-only policy with mocked venue responses—not a live fill.
- Candidate close controls seal an explicit exact-close marker without a user-supplied size. The worker derives the full base size, validates the requested reducing side against live venue position state, uses reduce-only IOC, and reports flat-position proof only after a post-order venue account read.
- A venue-proven close fill and a venue-proven flat account are kept as separate evidence states; residual or unavailable state cannot be labeled flat.
- A disposable local PostgreSQL 16 database proved 11 concurrent founding reservations admit exactly 10 and reject the eleventh.
- The database-backed signed-webhook test proved idempotent, ordered paid-entitlement activation and restoration.
- A disposable PostgreSQL 16 database proved the actual backend lifecycle for a new email user: signup issued a verified free-tier JWT; the same subject returned 10 available seats; a correctly signed paid-checkout webhook activated `founding_trader` and changed capacity to 1 claimed/9 remaining; re-signin preserved the user ID and returned the paid tier. Cleanup left zero users and zero seats.
- The web admission boundary forwards that same bearer identity to billing, admits `founding_trader`, and denies `free` with `subscription_required`.
- The candidate canonicalizes perpetual setup to `setup=hyperliquid` and `venue=hyperliquid`; its regression test starts with the production-bug state (`venue=coinbase_advanced`) and proves neither Coinbase value survives in the generated Hyperliquid setup URL.
- Credential reload/isolation tests passed against a private-Blob adapter.
- A disposable PostgreSQL 16.11 database proved sealed mainnet-vault persistence across two separate web test processes: the first wrote one account and one encrypted vault, and the second detected the verified connection from durable state. Both JSONB records were database objects; the public status exposed commitments/readiness but no ciphertext or wallet-key material.
- The persistence audit found and fixed two candidate gaps: ordinary PostgreSQL URLs now use a TCP driver instead of Neon HTTP, and JSONB writes are forced through text to prevent driver-dependent double encoding.
- Lint: 0 errors, 20 pre-existing warnings.
- Production build passed, including auth client-bundle and SRI checks.
- Current implementation head: `80d6867e` on pushed branch `codex/production-e2e-proof-20260806`.
- Current production deployment: `dpl_GxNgC4qp2HJPTtBJT9D7YKYQWLgA`.

## Safety incident

- A local production environment file was unintentionally printed during inspection.
- Its credentials must be treated as compromised and rotated before promotion claims or trading verification.
- No exposed value was reused or repeated, and no credential was rotated without authorization.

## Not proven

- Production payment completion, paid entitlement, and atomic admission into the ten-seat cohort. Checkout creation now works; no charge was submitted.
- Encrypted storage of the authorized scoped Hyperliquid API wallet. Venue authorization and read-only preflight are proven; storage is correctly blocked until entitlement.
- Durable credential detection in production after reload and deployment. Cross-process persistence is proven only against disposable infrastructure.
- Account-, network-, worker-, market-, and collateral-specific live readiness.
- Venue-authoritative order acceptance, fill, position, reduce-only close, and final flat state.

## Required completion sequence

1. Complete or authorize the $29 Stripe payment; then verify webhook-driven entitlement and 1/10 admission. A Render change is separately required to correct Stripe's return URL.
2. Store the already-authorized scoped wallet from the preserved browser tab; verify secret-free persistence across reload and deployment.
3. Rotate all exposed production credentials and redeploy safely.
4. Start and attest the confidential worker; verify exact recipient, image, signer, and report-data bindings.
5. Confirm venue/account/network/worker/market/collateral readiness from authenticated production APIs.
6. Obtain fresh authorization stating account, BTC side, exact size/notional cap, order type, limit/slippage, and maximum loss.
7. Submit one bounded opening order; retain venue order/fill IDs and reconcile the exact position.
8. Submit an exact reduce-only close; confirm the venue reports no residual position or open order.
