# Cloudflare OHTTP Relay — Operations Runbook (v3.5 Phase 2)

This document covers registering the Ghola Gateway with Cloudflare's
public Oblivious HTTP (RFC 9458) relay so that the Cloudflare edge sees
end-user IPs but **not** request bodies, while the Ghola Gateway sees
bodies but **not** end-user IPs. Apple PCC's architecture, applied to
sealed-inference.

```
Browser ──► Cloudflare OHTTP relay ──► ghola-relay (OHTTP Gateway) ──► enclave
              │                            │
              sees: IP + ciphertext         sees: request body + Cloudflare IP
              does NOT see: request body    does NOT see: end-user IP
```

## 1. Mint the gateway keypair

On a workstation with the relay binary:

```
$ cargo run -p thumper-relay --bin thumper-relay -- generate-ohttp-key --key-id 1
# OHTTP gateway keypair (RFC 9458)
# key_id = 1
GHOLA_OHTTP_KEY_SECRET_HEX=<32-byte hex>
GHOLA_OHTTP_KEY_PUBLIC_HEX=<32-byte hex>
GHOLA_OHTTP_KEYCONFIG_HEX=<41-byte hex>
```

Pipe the **secret line only** into AWS SSM:

```
aws ssm put-parameter --name /ghola/prod/ohttp/key_secret_hex \
    --type SecureString --overwrite --value "<paste secret hex>"
```

Set `GHOLA_OHTTP_KEY_SECRET_HEX` on the `ghola-relay` Render service
(referenced from SSM via the Render → AWS integration; see
`deploy/runbook.md` §Secrets). Once the env var is present, the relay
will auto-mount:

- `GET  /ohttp-keys` — serves the RFC 9458 §3 keyconfig (binary,
  `Content-Type: application/ohttp-keys`)
- `POST /ohttp-gateway` — accepts `Content-Type: message/ohttp-req`,
  returns `Content-Type: message/ohttp-res`

Confirm with:

```
curl -sS -o /tmp/cfg.bin -w "%{http_code}\n" https://ghola-relay.onrender.com/ohttp-keys
xxd /tmp/cfg.bin | head
```

You should get HTTP 200 and a 41-byte body starting with
`<key_id> 00 20 …`. The public-key portion (bytes 3..35) must match
`GHOLA_OHTTP_KEY_PUBLIC_HEX`.

## 2. Register with Cloudflare's public OHTTP relay

> TODO: confirm Cloudflare's current OHTTP relay URL before going
> live. As of v3.5 cut, the relay is in invite-only beta; reach out to
> Cloudflare contacts (or the public form at
> <https://cloudflare.com/onion-routing>) for onboarding.

Expected information Cloudflare will ask for:

- **Gateway keyconfig URL** — `https://ghola-relay.onrender.com/ohttp-keys`
- **Gateway request URL** — `https://ghola-relay.onrender.com/ohttp-gateway`
- **Gateway operator contact** — `security@ghola.xyz`
- **Suite** — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM
- **Rate-limit posture** — relay-side rate limiting per source IP;
  Cloudflare may impose its own limits at the edge
- **Privacy posture** — gateway never logs the source IP (only the
  Cloudflare IP) and never logs decrypted request bodies (logged
  metrics are limited to status code + size + latency)

Cloudflare assigns a gateway id and gives you a URL of the form
(placeholder until ops confirms):

```
https://ohttp.example.cloudflare.com/relay/<gateway-id>
```

Set this in the web frontend env:

```
NEXT_PUBLIC_OHTTP_RELAY_URL=https://ohttp.example.cloudflare.com/relay/<gateway-id>
```

The next deploy of `apps/web` will switch the sealed-inference path
to the OHTTP transport automatically (see `apps/web/src/lib/sealed-stream.ts`).
When unset, the client falls back to the legacy direct POST against
`https://ghola-relay.onrender.com/inference/sealed`.

## 3. Verifying end-to-end

From a workstation **outside** Cloudflare's network:

```
curl -i -X POST \
  -H "Content-Type: message/ohttp-req" \
  --data-binary @/tmp/test-capsule.bin \
  "$NEXT_PUBLIC_OHTTP_RELAY_URL"
```

(where `/tmp/test-capsule.bin` was produced via `apps/web/src/lib/ohttp.ts`'s
`encapsulateRequest`). You should see:

- HTTP 200
- `Content-Type: message/ohttp-res`
- A binary response that decapsulates to a BHTTP 200 with the
  expected `application/json` body

Then on the relay logs (`render logs --service ghola-relay`):

- The remote IP recorded is Cloudflare's (e.g. `162.158.x.x`), never the
  workstation's
- No plaintext request body appears (the BHTTP layer is opaque to the
  trace)

## 4. Key rotation (manual in v3.5)

Rotation is fully manual in v3.5; we'll move to automated weekly
rotation in v3.6. Steps:

1. `thumper-relay generate-ohttp-key --key-id N+1` on a workstation;
   pipe the secret into SSM under a fresh parameter name.
2. Configure the relay with both keys, prioritising the new one:
   - `GHOLA_OHTTP_KEY_SECRET_HEX` = new secret
   - `GHOLA_OHTTP_KEY_ID` = new key id
3. After 60 minutes (matches the `KEYCONFIG_TTL_MS` cache TTL in
   `sealed-stream.ts`), the web frontend will pick up the new
   keyconfig automatically.
4. Once metrics show zero requests landing against the old key id
   (check `/metrics` on the relay), drop the old key from SSM.

For an emergency rotation (suspected key compromise), set the relay
to reject the old key id immediately by overwriting the secret hex —
clients will see a fresh `GET /ohttp-keys` payload on the next chat
turn and re-encapsulate.

## 5. Rollback

To disable OHTTP without a deploy:

- Unset `NEXT_PUBLIC_OHTTP_RELAY_URL` (Render env on the `apps/web`
  service). The frontend reverts to the legacy direct path.
- Optionally unset `GHOLA_OHTTP_KEY_SECRET_HEX` on `ghola-relay` to
  drop the `/ohttp-*` routes entirely. The legacy
  `POST /inference/sealed` route is unaffected by this and stays up.

## 6. Open items

- TODO: confirm Cloudflare's current OHTTP relay URL once invite-only
  beta clears.
- TODO: harden CSP `connect-src` to the exact production OHTTP relay
  host (currently includes `https://*.ohttp.cloudflare.com` as a
  wildcard placeholder in `apps/web/src/middleware.ts`).
- TODO: wire `/ohttp-keys` 404s into Render alerting so the relay
  paging through a key rotation never serves a stale config.
