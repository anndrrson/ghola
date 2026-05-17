# Helius webhook setup

said-cloud uses a single Helius enhanced webhook to stream every on-chain
transaction that touches one of our agent wallets into the
`payment_transactions` table. This runbook walks through registering the
webhook once, wiring up the three env vars, and verifying delivery.

## One-time setup

1. **Get a Helius API key.** Sign in to <https://dashboard.helius.dev>,
   create (or select) a project, and copy the API key. The free tier is
   enough for development; production traffic should run on a paid plan
   so the credit budget covers the watchlist size.
2. **Decide on a shared secret.** Either let the register script generate
   one for you (recommended) or pre-generate with
   `openssl rand -hex 32` and pass it as `AUTH_HEADER`.
3. **Register the webhook** against the deployed said-cloud URL:

   ```sh
   HELIUS_API_KEY=hel_xxx \
   WEBHOOK_URL=https://ghola-api.onrender.com/v1/webhooks/helius \
     ./scripts/helius/register-webhook.sh
   ```

   The script prints the new `webhookID` plus a three-line env-var block.
   Copy that block — the secret is only shown once.

## Configure said-cloud

Set these three env vars on the deployment (Render dashboard → service →
Environment, or whatever the target uses):

| Variable              | Value                                         |
|-----------------------|-----------------------------------------------|
| `HELIUS_API_KEY`      | the same key you used to register             |
| `HELIUS_WEBHOOK_ID`   | the `webhookID` echoed by `register-webhook`  |
| `HELIUS_WEBHOOK_AUTH` | the shared secret echoed by `register-webhook`|

Restart the service. On boot you should see the reconcile log line
described below.

## Verify

Two log lines tell you the integration is healthy:

- **`Reconciling Helius watchlist`** — emitted once at startup from
  `crates/said-cloud/src/main.rs`. It means said-cloud read every active
  `agent_wallets.solana_address` row and pushed the union to Helius via
  `PUT /v0/webhooks/:id`.
- **`helius batch processed`** — emitted by
  `crates/said-cloud/src/routes/webhooks.rs` every time Helius delivers a
  batch. The structured fields (`batch_size`, `inserted`, `skipped`) tell
  you whether the rows landed.

Trigger one by sending a tiny SOL transfer to any agent wallet; within a
few seconds you should see the `helius batch processed` line and a fresh
row in `payment_transactions`.

If you see a 401 from Helius in their dashboard, the `Authorization`
header on the deployed service does not match the secret stored on the
webhook — re-run `list-webhooks.sh` and re-register if needed.

## What gets watched

The watchlist is the set of rows in `agent_wallets` where `active = true`.
There are two ways said-cloud keeps Helius in sync:

- **Startup reconcile** — `main.rs` fetches the full active set and pushes
  it as one `PUT /v0/webhooks/:id` so the webhook always reflects current
  state, even after manual DB edits or crashes mid-update.
- **Per-agent updates** — when an agent wallet is created, archived, or
  toggled, said-cloud incrementally adds/removes the address on the
  existing webhook (same `PUT` endpoint, smaller diff).

Old wallets created before `HELIUS_*` env vars are configured are not
lost — the next backend restart picks them up via the startup reconcile.

## Local dev

Helius cannot deliver to `localhost`. Two options:

- Run an `ngrok http 8080` tunnel and pass its public URL as
  `WEBHOOK_URL` when registering. Re-register whenever the tunnel URL
  changes (or use a reserved domain).
- Point at a deployed staging instance instead and let it write to a
  staging Postgres.

Either way you'll want a dedicated staging Helius webhook so prod
traffic isn't mixed in — register a second one and store its id under a
different env var name locally.

## Costs

One webhook covers every agent wallet — Helius prices on **webhooks** and
**credits**, not on watched addresses. Adding a thousand agents costs
the same as adding one, modulo the credit consumption from increased
transaction volume. Check the Helius dashboard for current plan limits.

## Endpoints used

said-cloud and these scripts touch exactly four Helius endpoints:

| When                         | Method | Path                          | Caller                       |
|------------------------------|--------|-------------------------------|------------------------------|
| Initial registration         | POST   | `/v0/webhooks`                | `register-webhook.sh`        |
| Startup + per-agent updates  | PUT    | `/v0/webhooks/:id`            | said-cloud (`helius` module) |
| Debug / cleanup inspection   | GET    | `/v0/webhooks` or `/:id`      | `list-webhooks.sh`           |
| Tear-down                    | DELETE | `/v0/webhooks/:id`            | `delete-webhook.sh`          |

All four take `?api-key=<HELIUS_API_KEY>` as a query param.
