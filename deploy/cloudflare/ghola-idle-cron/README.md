# Ghola Idle Cron

Cloudflare Worker Cron that stops the Phala private-agent worker after Ghola's
server-side idle lease expires. This avoids paying for a continuously running
worker while keeping Vercel on the Hobby plan.

## Deploy

```bash
cd deploy/cloudflare/ghola-idle-cron
npx wrangler secret put GHOLA_IDLE_CRON_SECRET
npx wrangler deploy
```

Use the same value for the Vercel production env
`GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET`.

## Schedule

The Worker runs every 15 minutes:

```toml
[triggers]
crons = ["*/15 * * * *"]
```

Each run calls:

```txt
GET https://ghola.xyz/api/private-agent/idle
Authorization: Bearer <GHOLA_IDLE_CRON_SECRET>
```

The Ghola endpoint still checks the active runtime lease before stopping Phala,
so the Worker cannot stop an active session just because the schedule fired.

## Manual Checks

Health:

```bash
curl https://<worker-host>/health
```

Manual run, if `GHOLA_IDLE_MANUAL_TOKEN` is set:

```bash
curl -H "Authorization: Bearer $GHOLA_IDLE_MANUAL_TOKEN" \
  https://<worker-host>/run
```
