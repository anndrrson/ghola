# Worker Deploy Runbook (free, dev-attestation)

Stand up the private-agent worker so the agent can run and users can connect accounts.
**Cost: $0** (Fly.io free volume + machine). ~15 min. Nothing here funds a trading account.

The worker is a Docker image (`apps/private-agent-worker/Dockerfile`): Node 20 + Python HL SDK,
listens on **8787**, persists its X25519 recipient key to **`/data`** (`server.js`), and refuses
unauthenticated execution unless `PRIVATE_AGENT_EXECUTION_TOKEN` is set.

> Persistent volume matters: the recipient key lives in `/data`. On an ephemeral host it regenerates
> every restart, which invalidates already-connected users. Fly free volumes solve this. (For a one-off
> demo recording, ephemeral is fine.)

## 0. Two secrets (run locally, save them)
```sh
# shared worker<->web bearer token
openssl rand -hex 32      # -> EXEC_TOKEN
# web request-proof HMAC secret (no "dev"/"test" substrings)
openssl rand -hex 32      # -> PROOF_SECRET
```

## 1. Deploy the worker — Render (recommended; auto-binds Render's $PORT)
1. Render dashboard → **New → Web Service** → connect the `ghola` repo.
2. **Root Directory:** `apps/private-agent-worker` (it has a Dockerfile — Render auto-detects it).
3. **Instance Type:** Free.
4. **Environment variables:**
   ```
   PRIVATE_AGENT_EXECUTION_TOKEN = <EXEC_TOKEN>
   PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = true
   PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = true
   PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = full_ticket
   PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD = 1000
   PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD = 5000
   PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = 100
   # leave PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT off until the no-submit canary passes
   ```
5. Create. When live, open `https://<service>.onrender.com/.well-known/private-agent-recipient` →
   a JSON blob with `x25519_pub_hex` means it's working.

> Free-tier caveat: it sleeps after ~15 min idle and **regenerates its identity key on wake** — fine
> for first deploy + demo. To make it permanent (so connected users don't break), pin the identity by
> generating an X25519 keypair once and setting `PRIVATE_AGENT_RECIPIENT_ID`,
> `PRIVATE_AGENT_X25519_PUB_HEX`, `PRIVATE_AGENT_X25519_PRIVATE_KEY_PKCS8_PEM`
> (`loadRecipient`, `server.js:189`). A small paid disk mounted at `/data` also works.

## 1-alt. Deploy the worker (Fly.io)
```sh
# one-time: brew install flyctl && fly auth signup   (free)
cd apps/private-agent-worker
fly launch --no-deploy --copy-config --name ghola-agent-worker   # detects the Dockerfile; pick a region
fly volumes create data --size 1 --region <same-region>          # free 1GB volume for /data
```
In the generated `fly.toml` set the internal port and mount:
```toml
[http_service]
  internal_port = 8787
  force_https = true

[[mounts]]
  source = "data"
  destination = "/data"
```
Set env (secrets):
```sh
fly secrets set \
  PRIVATE_AGENT_EXECUTION_TOKEN=<EXEC_TOKEN> \
  PRIVATE_AGENT_ALLOW_UNATTESTED_DEV=true \
  PRIVATE_AGENT_DATA_DIR=/data \
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true \
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket \
  PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=1000 \
  PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD=5000 \
  PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=100
# Leave PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT OFF until the no-submit canary passes.
fly deploy
```
Verify the worker is serving its key:
```sh
curl https://ghola-agent-worker.fly.dev/.well-known/private-agent-recipient
# -> { "recipient_id": "...", "x25519_pub_hex": "..." }
```
(Render works too but its free tier has no persistent disk — recipient regenerates on restart.)

## 2. Point the web at it (Vercel env)
```
GHOLA_PRIVATE_AGENT_EXECUTION_URL = https://ghola-agent-worker.fly.dev
GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = <EXEC_TOKEN>        # same token as the worker
GHOLA_PRIVATE_AGENT_SPEND_ARMED = true
# do NOT set GHOLA_PRIVATE_AGENT_JIT_PROVISIONING (no Phala)
GHOLA_SEEKER_AUTOPILOT_REQUIRED = false

# BYO Hyperliquid live gate (exact values required by live-trading/status):
GHOLA_LIVE_TRADING_PUBLIC_ENABLED = true
GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = <PROOF_SECRET>
GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD = 1000
GHOLA_LIVE_TRADING_DAILY_CAP_USD = 5000
GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS = 100
GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = true
PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = true
PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = full_ticket
PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD = 1000
PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD = 5000
PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = 100
```
Redeploy the web.

## 3. Confirm green (no funds yet)
```sh
# from a signed-in browser session (or with the request-proof), check:
GET /api/private-agent/status                         -> a ready provider with sealed_recipient
GET /v1/private-account/live-trading/status           -> hyperliquid not red
GET /v1/private-account/autopilot/readiness?product_id=BTC-USD  -> can_arm: true
```

When `/api/private-agent/status` returns a recipient, the worker is live — that unblocks the
Connect-Hyperliquid UI build (it seals user keys to that recipient).

## Next (after this)
1. I build the Connect-Hyperliquid UI against the live recipient.
2. Verify $0: testnet fill (private) + mainnet **no-submit** canary (`LIVE_SUBMIT` off).
3. One tiny real fill (a few $), then flip `PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=true` and promote.
