# Hyperliquid Mainnet Launch Contract

This is the sole public live-trading path. It is BYO Hyperliquid mainnet only. Phoenix, Coinbase,
Jupiter, market orders, automation, leverage changes, and advanced order types stay hidden until
their own proof gates pass.

## Fixed policy

- Eligible paid, non-US users only; explicit terms and risk attestation required.
- Trade-only sealed API wallet; no withdrawal authority.
- First account proof: exactly $11.00 HYPE entry and reduce-only exit.
- Public order: limit IOC, isolated margin, 1× leverage.
- Caps: $100/order, $500 rolling 24 hours, 50 bps default, 100 bps hard maximum.
- Three fresh, consecutive, funded mainnet round trips from distinct actual venue accounts per
  visible capability. Distinctness is the validated Hyperliquid account commitment in independently
  queried worker evidence; rotating Ghola accounts, vaults, or API wallets does not create another subject.
- Web SHA, worker SHA, worker image digest, config fingerprint, caps, and capabilities must match.
- Durable launch states: `disabled`, `canary`, `public`, `killed`.
- Live-release validation requires `GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED=false`.
- Risk-reducing orders bypass launch, eligibility, billing, and opening caps after identity and vault checks.

## Required flow

1. Deploy the exact web and attested worker release with durable Postgres state.
2. Keep launch state `disabled`; verify `/ready` identities and configuration.
3. Set launch state to `canary` through the internal control route.
4. Three authorized canary accounts each complete the funded $11.00 round trip. Successful worker
   reports record capability evidence automatically; a failed canary attempt records red evidence and
   resets the consecutive sequence.
5. Verify restart/idempotency, rejection, timeout, reconciliation, kill, and reduce-only behavior.
6. Activate `public` only with the exact confirmation phrase. No code path activates it automatically.

## Public activation

All calls require `Authorization: Bearer $GHOLA_LIVE_TRADING_CONTROL_TOKEN`.

```sh
curl -sS https://ghola.xyz/api/internal/live-trading/launch \
  -H "Authorization: Bearer $GHOLA_LIVE_TRADING_CONTROL_TOKEN"

curl -sS https://ghola.xyz/api/internal/live-trading/launch \
  -X POST \
  -H "Authorization: Bearer $GHOLA_LIVE_TRADING_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"state":"public","updated_by":"operator","confirmation":"ACTIVATE HYPERLIQUID MAINNET LIVE TRADING"}'
```

Use only after funded-proof authorization. This repository work does not authorize spending,
deployment, or public activation.

## Kill

```sh
curl -sS https://ghola.xyz/api/internal/live-trading/launch \
  -X POST \
  -H "Authorization: Bearer $GHOLA_LIVE_TRADING_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"state":"killed","updated_by":"operator","confirmation":"KILL HYPERLIQUID MAINNET LIVE TRADING"}'
```

The durable kill is absorbing: stale canary/public writes cannot reopen it. It commits before any
worker readiness or network probe and closes exposure-creating authorization immediately. Keep the
worker global kill switch and deployment rollback available as independent controls.

Reset only after the incident is resolved. Read the killed control's exact `revision`, then use the
separate, strong `GHOLA_LIVE_TRADING_RESET_TOKEN` (never the control token):

```sh
curl -sS https://ghola.xyz/api/internal/live-trading/launch \
  -X POST \
  -H "Authorization: Bearer $GHOLA_LIVE_TRADING_RESET_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"state":"disabled","updated_by":"operator","expected_revision":42,"confirmation":"RESET KILLED LIVE TRADING TO DISABLED"}'
```

The reset fails unless state is still `killed` at exactly that revision. Canary/public activation
must then use the ordinary control flow again.

## Proof standard

A green capability proof must be mainnet, funded, broadcast, venue-accepted, reconciled, flat at the
end, and leave zero open orders. It must prove isolated 1× configuration, atomic venue-native TP/SL,
terminal protection cleanup, and bind to the exact release. A crash-left active-canary manifest must
recover flat before another canary starts. Manual API submissions cannot create green evidence.

## Verification without funds

Unit, integration, build, local browser, testnet, and mainnet no-submit checks are safe. A funded
round trip is intentionally impossible without an eligible account, explicit confirmation, enabled
proof gate, paid entitlement, canary state, and armed remote execution.
