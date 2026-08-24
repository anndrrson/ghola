# Carry mainnet proof

This proof qualifies one exact worker image and adapter pair. It does not authorize production.

## Preconditions

1. `guard:carry-release` passes on committed sources.
2. One worker image digest and one Preview URL are pinned to the same commit.
3. Both owner-controlled venue accounts pass fresh no-submit checks.
4. The user separately confirms the capped paired trade after seeing venues, asset, notional, and exit policy.

## Lifecycle

1. Create one Carry Position at or below $25.
2. Submit each entry leg once. Reconcile only its exact client order identifier.
3. If any outcome is ambiguous, freeze and reconcile; never submit again.
4. Record at least one fresh funding-flip and margin-runway observation while both legs are reconciled.
5. Request a deterministic exit and close both exact filled quantities reduce-only.
6. Read both accounts after exit. Require zero exposure and zero open orders on each venue.
7. Finalize modeled-versus-realized funding, fees, slippage, capital cost, PnL, and net value.
8. Export `deploy/evidence/carry-mainnet-proof.json` and run `npm run verify:carry-release-evidence` from `apps/web`.

Funding, transfers, withdrawals, leverage changes, and credential rotation remain owner-only. A failed evidence check invalidates the proof.
