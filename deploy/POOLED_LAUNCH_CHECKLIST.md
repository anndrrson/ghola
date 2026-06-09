# Pooled Trading Launch Checklist — ghola.xyz

Ordered steps to take the private-account pooled trading stack (branch
`claude/sweet-davinci-z7m2io`, commit `ac57d2a`) from repo to a working
service at ghola.xyz. Steps marked OPERATOR need dashboard access
(Vercel, Phala Cloud, Neon, Hyperliquid) that only a human operator has.

## Already done (in this branch)

- [x] Pooled vault double-entry ledger, NAV share accounting, withdrawal
      route, and pool audit (`apps/web/.../pool/{allocate,withdraw,audit}`)
- [x] Sealed worker pool-balance probe (`POST /venues/pools/balance`) and
      audit solvency check
- [x] Lifecycle + probe tests green (web 569/569, worker 89/89)
- [x] Worker image build triggered for `ac57d2a` →
      `ghcr.io/anndrrson/ghola:private-agent-worker-ac57d2a`
      (grab the `digest`/`pinned` value from the workflow run summary)

## Zero-capital launch path

The service can go fully live without operator capital:

1. **BYO mode on mainnet** (already built): users import their own
   Hyperliquid API wallet and trade their own funds. No pooled account
   needed at all.
2. **Pooled vaults on Hyperliquid testnet**: set
   `PRIVATE_AGENT_HYPERLIQUID_POOLED_NETWORK=testnet` on the worker and
   install a testnet account (`network: "testnet"` in
   `PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON`) funded from the
   Hyperliquid testnet faucet (free mock USDC at
   app.hyperliquid-testnet.xyz). Testnet skips the
   `ALLOW_MAINNET`/`LIVE_MODE` gates; notional/slippage caps still
   apply. The full lifecycle — allocate, NAV shares, audit, withdraw —
   runs against real venue infrastructure with zero capital at risk.
3. **Mainnet pooled later, funded by users**: user deposits through the
   funding rail are real USDC arriving at Ghola-controlled
   destinations; relaying them to the pooled venue account funds the
   pool. The operator's own requirement is only the canary float
   (~$25: Hyperliquid's $10 min order + the $5 needs-funds threshold +
   buffer). Flip `PRIVATE_AGENT_HYPERLIQUID_POOLED_NETWORK` back to
   `mainnet` when ready; cap allocations to the small buckets until
   deposits accumulate.

## 1. Deploy the web surface — OPERATOR

Do NOT merge this branch into `main`: the branch tree drops 149 files
that `main`'s backend services (orni-models-api, thumper images) still
deploy from. The branch's `apps/web` is a strict superset of `main`'s,
so deploy the web app from this branch directly:

- Vercel → ghola.xyz project → Settings → Git → set the production
  branch to `claude/sweet-davinci-z7m2io` (or promote a branch deploy).
- Backend services on Render/Fly keep deploying from `main`; nothing
  else changes.

## 2. Web environment variables (Vercel) — OPERATOR

Persistence (without this, pooled state is in-memory and dies on deploy):

```
GHOLA_PRIVATE_ACCOUNT_DATABASE_URL=<neon-postgres-url>
```

Worker wiring and pilot gates (see deploy/PRIVATE_AGENT_RUNBOOK.md):

```
GHOLA_PRIVATE_AGENT_PROVIDER=phala
GHOLA_PRIVATE_AGENT_JIT_PROVISIONING=true
GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME=ghola-private-agent-worker
GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola:private-agent-worker-ac57d2a
GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST=sha256:<digest-from-workflow-summary>
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN=<random-worker-token>
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<worker-funding-signer-spki-b64>
GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true
GHOLA_HYPERLIQUID_LIVE_MODE=tiny_fill
GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS=ready
PHALA_CLOUD_API_KEY=<phala-cloud-api-key>
```

Audit tolerance (optional, defaults shown):

```
GHOLA_POOL_AUDIT_TOLERANCE_MICRO_USDC=1000000
GHOLA_POOL_AUDIT_TOLERANCE_BPS=50
```

## 3. Worker enclave (Phala CVM) — OPERATOR

Per the runbook "Phala first provider" section:

- [ ] Deploy the pinned `ac57d2a` image to the CVM (JIT provisioning
      will also do this on first paid session if configured above).
- [ ] Worker env: `PRIVATE_AGENT_VENUE_DRY_RUN=false`,
      `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false`,
      `PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true`, live-mode and
      cap envs per the runbook readiness list, shared state store
      (Neon) or `PRIVATE_AGENT_STATE_SINGLE_CVM_OK=true`.
- [ ] Install pooled Hyperliquid credentials with
      `scripts/bootstrap-phala-pooled-credentials.mjs` (sealed to the
      attested recipient; raw keys never leave the enclave).
- [ ] Fund the pooled Hyperliquid account with USDC.

## 4. Verification gates — run in order, each must pass

```bash
# 1. Runtime attested and ready
curl -s https://ghola.xyz/api/private-agent/status

# 2. Hyperliquid pilot live
curl -s https://ghola.xyz/v1/private-account/hyperliquid/status
#    expect pilot_stage: "live_pilot", empty reason_codes

# 3. Pooled worker + venue readiness
node scripts/canary/private-agent-pooled-readiness.mjs

# 4. Books vs venue solvency (after the worker is up)
curl -s https://ghola.xyz/v1/private-account/venues/hyperliquid/pool/audit
#    expect status: "balanced" (balanced_internal means the worker
#    balance probe is unreachable; discrepancy means stop)

# 5. Full user lifecycle against production (uses a canary account's
#    Ghola balance; allocate -> audit -> withdraw -> balance round-trip)
GHOLA_VERIFY_EMAIL=... GHOLA_VERIFY_PASSWORD=... \
GHOLA_VERIFY_POOLED_CYCLE_CONFIRM=I_UNDERSTAND_THIS_MOVES_BALANCE \
node scripts/canary/pooled-withdraw-cycle.mjs

# 6. Hyperliquid execution path (no order, then tiny live fill)
GHOLA_VERIFY_EMAIL=... GHOLA_VERIFY_PASSWORD=... \
node apps/web/scripts/verify-prod-hyperliquid.mjs
```

## Known limits at launch (disclose to users)

- Pooled withdrawals settle to the user's internal Ghola balance;
  venue-side USDC settlement out of the pooled exchange account is a
  worker operation that is still blocked by policy.
- Only Hyperliquid supports the venue solvency probe; Phoenix/Jupiter/
  Coinbase audits stop at `balanced_internal`.
- Pooling user funds in a Ghola-operated venue account is custody;
  the compliance/custody statement (deploy/CUSTODY.md scope) does not
  yet cover it.
