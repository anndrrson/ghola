# Ghola Private Agent Worker

Provider-side session intake for sealed private-agent execution.

The worker is intentionally fail-closed. It accepts only encrypted strategy
bundles, requires a provider bearer token when configured, publishes the
recipient key that the browser seals to, and refuses sessions until attestation
metadata is present unless `PRIVATE_AGENT_ALLOW_UNATTESTED_DEV=true` is set for
local testing.

## Endpoints

- `GET /health`
- `GET /ready`
- `GET /.well-known/private-agent-recipient`
- `POST /private-agent/sessions`

## Required production env

- `PRIVATE_AGENT_EXECUTION_TOKEN`
- `PRIVATE_AGENT_PROVIDER_ID=phala`
- `PRIVATE_AGENT_TEE_KIND=phala`
- `PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true`
- `PHALA_CVM_IMAGE_DIGEST`

When `PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true`, the worker requests a dstack
quote over `/var/run/dstack.sock` with report data derived from the published
recipient id and X25519 public key. `GET /.well-known/private-agent-recipient`
then exposes the quote hash and report-data binding so Ghola can refuse payload
forwarding unless the recipient key is tied to attested runtime evidence.

Static `PRIVATE_AGENT_ATTESTED_READY=true`, `PHALA_CVM_MEASUREMENT_HEX`, and
`PHALA_ATTESTATION_HASH` are still supported for manually verified deployments,
but JIT Phala deployments should prefer the dstack quote path.

If `PRIVATE_AGENT_X25519_PUB_HEX` and `PRIVATE_AGENT_RECIPIENT_ID` are not set,
the worker generates and persists an X25519 recipient key in
`PRIVATE_AGENT_DATA_DIR`, default `/data`. In production this directory must be
sealed CVM storage or replaced by an attestation-bound key service.

## Local test

```bash
npm test
PRIVATE_AGENT_ALLOW_UNATTESTED_DEV=true PRIVATE_AGENT_EXECUTION_TOKEN=dev npm start
```
