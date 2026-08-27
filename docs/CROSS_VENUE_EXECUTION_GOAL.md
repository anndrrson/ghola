# Ghola cross-venue execution goal

Build Ghola into a self-custodial execution and risk manager for crypto-native
USDC holders and small treasuries, without adding trading-screen complexity.

## Product contract

- One objective and one signed risk mandate; model controls stay under Advanced.
- Turnkey owner retains funding, withdrawal, transfer, leverage, activation,
  revocation, and recovery authority. The agent may only place, cancel, or reduce
  permitted orders.
- Models—hosted or user-run OpenAI-compatible/Ollama/LM Studio/vLLM—emit typed
  proposals only. Deterministic code selects venue, size, leverage, and unwind.
- No pooled custody. Assets stay onchain or at the selected venue; Turnkey
  protects user-controlled signing keys but does not custody assets. Deposited
  collateral is held by that venue, and Coinbase assets remain in the user's
  Coinbase account.
- No promised returns, opaque yield, copy trading, martingale/grid escalation,
  autonomous withdrawals, or latency-arbitrage claims.

## Execution contract

Normalize Hyperliquid, Drift, Coinbase Advanced, and Jupiter state. Quarantine a
connector when quotes, positions, collateral, funding, fees, order state, or
reconciliation are stale or unverifiable.

Route only when modeled benefit remains positive after spread, slippage, fees,
funding, borrow, gas, latency, and liquidity penalties. Support best execution,
spot-perp hedging, delta-neutral carry, and exposure rebalancing. Multi-leg plans
must preflight every leg, use idempotent submission, reconcile partial fills, and
cancel/compensate/unwind deterministically within a bounded unhedged interval.

The first production-shaped lane is USDC-funded, delta-neutral spot/perpetual
carry across Coinbase Advanced and Hyperliquid. It opens matched base exposure,
holds to a bounded deadline, then closes both legs. Entry requires positive
modeled net edge after fees, slippage, basis, and a safety buffer. Exit and
restart recovery are reduce-only and require exact persisted fill quantities.
Drift remains quarantined until its adapter passes the same contract.

## Portfolio mandate

Enforce venue, asset, and strategy allowlists; leverage; liquidation distance;
gross/net exposure; concentration; turnover; daily loss and drawdown; funding and
basis bounds; freshness; open-order, fee, gas, and model budgets; expiry; kill
switch; reduce-only mode; and explicit owner mainnet activation.

## Evidence required

- Replay, shadow, paper, testnet, stale-data, partial-fill, late-fill, duplicate,
  venue-outage, adversarial-model, and deterministic-unwind tests.
- Signed audit receipts plus portfolio accounting and venue reconciliation.
- Execution-quality reporting: implementation shortfall, spread/slippage,
  fill/reject rate, modeled-versus-realized cost, hedge error, drawdown,
  liquidation distance, uptime, and recovery time.
- No paid deployment, mainnet activation, real order, or fund movement without
  separate explicit owner authorization.

## Implemented locally

- Normalized readiness, mandate, cost-aware routing, portfolio accounting,
  reconciliation, and execution-quality primitives.
- Durable multi-leg state machine with idempotent submission, targeted
  reconciliation, late-fill detection, cancellation, and exact reduce-only
  compensation for Coinbase Advanced and Hyperliquid.
- Hosted and local model adapters whose output is proposal-only; carry entry,
  sizing, venue selection, and exit remain deterministic.
- Replay-safe owner collateral reviews now remain non-custodial and are followed
  by fresh account-state checks that prove safe margin runway was restored,
  without claiming Ghola moved funds or caused the owner action.
- Existing web and mobile controls map to the new behavior without adding a
  trading terminal. No infrastructure was deployed and no live trade ran.

## Completion gate

Complete only when every enabled production adapter satisfies one normalized
contract (all others fail closed), the portfolio mandate gates every order path,
protected multi-leg recovery is durably wired to execution, accounting
reconciles after restart, web and mobile retain the simple surface, and the full
local test matrix passes.
