# Carry mainnet proof

This proof qualifies one exact worker image and adapter pair. It does not authorize production.

## Preconditions

1. `guard:carry-release` passes on committed sources.
2. `verify:carry-shadow` passes three consecutive complete samples across five venues and BTC, ETH, and SOL; one lucky snapshot is not qualification.
3. One worker image digest and one Preview URL are pinned to the same commit.
4. The owner completes the single guided Carry setup. It resumes the next safe missing connection, can skip a venue blocked on external activation, and unlocks verification only after Hyperliquid, Lighter, and Aster are connected.
5. All three owner-controlled venue accounts pass fresh no-submit checks.
6. All six directed Hyperliquid/Lighter/Aster collateral routes have fresh, positive-capacity, all-in quotes bound to the same three accounts. They remain read-only and require owner approval.
7. The Turnkey owner signs the exact Carry risk mandate: owner commitment, owner wallet, position ID, venue pair, asset, notional, risk limits, issue time, and expiry.
8. The worker independently recovers the owner signature and binds its commitment to storage, entry, monitoring, recovery, and release evidence.
9. The user separately confirms the capped paired trade after seeing venues, asset, notional, and exit policy.

Before any live proof, run the authenticated `carry_execution_no_submit_matrix` through the Preview. It must return Hyperliquid, Lighter, and Aster evidence together, `no_submit_ready: true`, `transaction_broadcast: false`, and an empty `failures` list. This check never authorizes a trade.

## Lifecycle

1. Create one Carry Position at or below $25.
2. Recheck the exact owner-signed mandate before entry. A changed or expired mandate cannot open risk.
3. Submit each entry leg once. Reconcile only its exact client order identifier.
4. If any outcome is ambiguous, freeze and reconcile; never submit again.
5. Record at least one fresh funding-flip and margin-runway observation while both legs are reconciled. Recheck the mandate on every observation; expiry permits only a reduce-only exit.
6. Request a deterministic exit and close both exact filled quantities reduce-only.
7. Read both accounts after exit. Require zero exposure and zero open orders on each venue.
8. Finalize modeled-versus-realized funding, fees, slippage, capital cost, PnL, and net value.
9. Refresh and verify all six directed collateral routes without moving funds.
10. Export `deploy/evidence/carry-mainnet-proof.json` and run `npm run verify:carry-release-evidence` from `apps/web`. The verifier must independently recover the owner signature, recompute the mandate commitment, and reject incomplete collateral-route coverage.

Funding, transfers, withdrawals, leverage changes, and credential rotation remain owner-only. A failed evidence check invalidates the proof.
