# BYO Mainnet Agent Launch — Build & Verify Plan

Goal: a connected user draws a plan on `/trade`, arms an agent, and the agent executes it on
**their own Hyperliquid account** — credible enough to promote publicly, with **$0 cost to the
operator** (users fund their own accounts; the worker runs on a free host).

## Honest framing (build the messaging on this, or get called out)
- We are **not** running real TEE attestation yet (Phala costs money). On a self-hosted worker the
  operator could in principle read a connected key. So **do not claim zero-trust TEE**.
- What is true and defensible: **users connect a trade-only Hyperliquid API wallet** — the seal
  hard-blocks `withdraw`/`vault_transfer`/`leverage_escalation` (`hyperliquid-vault-seal.ts:203-204`),
  and a user can revoke the API wallet anytime. Bounded risk, no withdrawal access. This is the
  standard trading-bot model. TEE attestation = the "coming next" upgrade.
- Launch copy: *"Connect a trade-only Hyperliquid API wallet (cannot withdraw your funds, revoke
  anytime). Draw a plan; the agent executes it. Caps: $1k/order, $5k/day."*

## Current state
- ✅ **Agent strategy shipped** (PR #19 on `main`): `level_trigger_v1` watches the level, fires one
  bounded entry with a satisfied condition proof, manages stop + horizon. 120 tests.
- ✅ **BYO backend + crypto exist**: `POST /v1/private-account/hyperliquid/vault` → `sealHyperliquidVaultFromBody`
  (`_lib.ts:~3000`); client seal lib `buildHyperliquidExecutionVaultBundle` (`hyperliquid-vault-seal.ts`);
  worker self-generates its recipient key on boot (`server.js:177`) and publishes it
  (`GET /.well-known/private-agent-recipient`); `providerReadyForPrivateAgents` accepts a self-hosted
  recipient (`private-agent-runtime.ts:102`).
- ❌ **No "Connect your account" UI** — the front door is missing. (Main remaining web build; contract fully traced below.)
- ❌ **Worker not deployed** — gates everything (connect seals to the live worker's key).
- 🟡 **Real-money safety rails** — done in the arm flow (explicit "places real orders on your account"
  confirmation + caps/side/stop summary + kill control in `ArmAgentButton`). Per-order cap default +
  order-mode reconcile still pending.

---

## A. Build — Connect-Hyperliquid UI (the front door)
New self-contained client component (e.g. `apps/web/src/components/trade/ConnectHyperliquidButton.tsx`),
additive next to `ArmAgentButton`. Reuses the existing lib end-to-end:
1. `fetchPrivateAgentRuntimeStatus()` → confirm a ready recipient exists (worker live). If not, show
   "agent runtime offline".
2. Form: network (mainnet), `hyperliquid_account_address` (0x…40), `api_wallet_private_key` (0x…64),
   optional `agent_name`. Validate with `validateHyperliquidExecutionCredentialDraft`; support paste via
   `parseHyperliquidCredentialImport`.
3. `buildHyperliquidExecutionVaultBundle({ accountCommitment, ownerWalletAddress, credential, signBytes, fetchRuntimeStatus })`
   — seals client-side to the worker recipient.
4. `POST /v1/private-account/hyperliquid/vault` with the bundle (add a thin client fn in
   `private-account-client.ts`).
5. On success → venue shows connected; the trade page `venueLiveStatus` reflects the BYO vault.

**Confirmed contract (traced from `TriVenueArbConsole.tsx` — the existing arm-with-signing flow):**
- **Wallet**: `window.solana` (`solanaProvider()`), `connect()` → `publicKey` → wallet address;
  `signBytes = (bytes) => provider.signMessage(bytes, "utf8")` (returns sig bytes). Helpers to lift
  from `TriVenueArbConsole.tsx:711-792` (`signFreshChallenge`, `walletSignBytes`, `solanaProvider`,
  `postJson`) — **extract them to a shared `lib/wallet-request-proof.ts`** instead of duplicating.
- **`accountCommitment`**: `GET /v1/private-account/hyperliquid/vault` returns
  `{ account_commitment, hyperliquid_execution_vault }` (`_lib.ts:hyperliquidVaultStatusForOwner`,
  vault is null until connected — also use this to render "connected" state).
- **`ownerWalletAddress`**: the connected wallet address.
- **Request-proof**: `POST /v1/private-account/hyperliquid/vault` runs `privateAccountLiveGuard` →
  needs `{ wallet_pubkey, message, signature_b64 }` from a server-issued HMAC challenge. Confirm which
  challenge route the guard accepts (candidates: `wallet-bindings/challenge`, or add a vault challenge);
  this is the one remaining contract detail to pin during the build.
- **Seal + post**: `buildHyperliquidExecutionVaultBundle({ accountCommitment, ownerWalletAddress, credential, signBytes, fetchRuntimeStatus })`
  → `POST .../hyperliquid/vault` with `{ ...proof, ...bundle.encrypted_execution_vault }`.
- Key handling: never log the key; clear form state after seal; plaintext never leaves the browser
  except as ciphertext sealed to the worker recipient.
- **Untestable until the worker is live** (needs a real recipient from `/api/private-agent/status`) —
  build it, then end-to-end test interactively against the deployed worker before trusting real keys.

## B. Build — Real-money safety rails (in the arm flow)
- `ArmAgentButton`: a two-step confirm — *"This will place REAL orders on your connected Hyperliquid
  account (max $X/order, stop at $Y). Continue?"* before `armLevelTriggerAgent`.
- Show caps + the stop in the confirm. Surface **pause/kill** controls for a running agent
  (`controlPrivateAutopilotSession` already exists) in the AGENT ACTIVITY panel.
- Default small per-order notional bucket ("5"/"10") for the launch regardless of drawn size, until
  proven; widen later.
- Reconcile the **order mode**: BYO readiness requires worker `PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket`,
  but the agent instruction sets `live_order_mode:"tiny_fill"` (`level-trigger.js` instructionForVenue,
  copied from autopilot). Confirm the worker accepts the agent's order under `full_ticket` (or set the
  instruction's mode to match). **This is the most important correctness item to verify before live.**

## C. Ops — Deploy the worker free (you; I'll script it)
- Host: Render free / Fly.io free / Railway. Build `apps/private-agent-worker/Dockerfile` (Node, port **8787**, `node src/server.js`).
- Env (minimum, dev-attestation):
  - `PRIVATE_AGENT_ALLOW_UNATTESTED_DEV=true` (run without Phala)
  - `PRIVATE_AGENT_WORKER_CAPABILITY_SECRET=<32+ rand>` and provider bearer/execution token to match web
  - persistent disk for the recipient key file (so the recipient is stable across restarts)
  - `PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true`, `PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket`,
    `PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=1000`, `…_DAILY_NOTIONAL_CAP_USD=5000`,
    `PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=100`
  - `PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=true` (after canary)
- Verify: `GET https://<worker>/.well-known/private-agent-recipient` returns a recipient.

## D. Ops — BYO mainnet web gates (Vercel env)
Point web at the worker + open the BYO Hyperliquid gate (exact values required by
`live-trading/status/route.ts:byoLiveGateFailures` + `venueByoLiveGate`):
- `GHOLA_PRIVATE_AGENT_EXECUTION_URL=https://<worker>`, `…_EXECUTION_TOKEN=<token>`, capability secret
- `GHOLA_PRIVATE_AGENT_SPEND_ARMED=true`; leave `GHOLA_PRIVATE_AGENT_JIT_PROVISIONING` unset (no Phala)
- `GHOLA_LIVE_TRADING_PUBLIC_ENABLED=true`; `GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET=<32+ rand, no dev/test words>`
- `GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD=1000`, `GHOLA_LIVE_TRADING_DAILY_CAP_USD=5000`, `GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS=100`
- `GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true`, `PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true`,
  `PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket`, `PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=1000`,
  `PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD=5000`, `PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=100`
- `GHOLA_SEEKER_AUTOPILOT_REQUIRED=false` (clears the advisory can_arm blocker)
- Verify: `GET /v1/private-account/live-trading/status` → hyperliquid green; `…/autopilot/readiness` → `can_arm`/`can_live_submit` true.

## E. Verify — $0, before promoting
1. **Testnet fill (private):** connect a *testnet* API wallet (faucet funds), arm a plan, force the
   trigger, confirm a real testnet fill + the managed stop. Proves the full mechanic for free.
2. **Mainnet no-submit canary:** with `PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT` off, arm on mainnet — the
   loop runs `verifyAutopilotProposalNoSubmit` against the real HL mainnet API and returns
   `broadcast_performed:false`. Proves construction + auth + venue acceptance on mainnet, $0.
3. **One tiny real fill (final confidence):** a few dollars from anyone, `LIVE_SUBMIT=true`, smallest
   cap, kill switch (`GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN`) ready. Reconcile against the HL account.
4. Only then promote.

## F. Launch copy (honest)
- Hero: "Autonomous on-chain trading agents. Draw your plan — the agent executes it on your Hyperliquid account."
- Trust line: "Trade-only API wallet — can't withdraw your funds. Revoke anytime. $1k/order · $5k/day caps."
- Roadmap line: "TEE-sealed execution (Phala) in progress."

## Sequence
1. ✅ Merge #19.  2. Build A (connect UI) + B (safety) — me, on `feat/byo-mainnet-launch`.
3. Deploy worker (C) — you, with my runbook.  4. Open web gates (D).  5. Verify (E).  6. Launch copy (F) + promote.

## Open risks
- **Order-mode reconciliation** (full_ticket vs tiny_fill) — verify before any live fill.
- **Trust framing** — keep the "trade-only, no withdraw, attestation-coming" copy exact.
- **No real-fill test without funds** — testnet + mainnet-no-submit de-risk it; one tiny real fill is the last gate.
