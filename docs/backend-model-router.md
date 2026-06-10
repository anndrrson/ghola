# Backend Model Router

Ghola exposes backend model routing at:

- `GET /v1/model-routes`
- `GET /v1/model-routes/models`
- `POST /v1/model-routes/chat/completions`

The router is intentionally separate from private trading execution. It may send
prompt text to model providers, but it rejects venue credentials, private keys,
raw transactions, signed transactions, and order-submission payloads.

## Production Configuration

Use the `Configure backend model router` GitHub Actions workflow. It only edits
Vercel model-router env vars and redeploys the web backend. It does not start
Phala, provision a CVM, arm private-agent spend, or install venue credentials.

Required GitHub repository secret:

- `VERCEL_TOKEN`

Optional GitHub repository secrets:

- `VENICE_API_KEY` or `GHOLA_VENICE_API_KEY`
- `GHOLA_LOCAL_OPENAI_BASE_URL`
- `GHOLA_LOCAL_OPENAI_API_KEY`

Optional GitHub repository variables:

- `GHOLA_LOCAL_OPENAI_BASE_URL`
- `GHOLA_MODEL_ROUTER_ALLOWED_ENDPOINT_HOSTS`

## Route Behavior

`venice` is enabled when `VENICE_API_KEY` or `GHOLA_VENICE_API_KEY` is present.
The default base URL is `https://api.venice.ai/api/v1`.

`local_openai_compatible` is enabled when `GHOLA_LOCAL_OPENAI_BASE_URL` is set.
This is for a server-reachable, OpenAI-compatible endpoint such as a self-hosted
model gateway. It is not the path for dialing a user's laptop from `ghola.xyz`.

Request-supplied endpoints stay disabled by default. If they are enabled, the
workflow requires an explicit host allowlist and keeps localhost/private-network
routing off unless an operator deliberately changes those inputs.

`local_webgpu` and `local_ghola_home` are advertised as client-local routes. The
backend does not proxy those calls; browser or native local-model code owns that
execution path.

`sealed_ghola` is the private execution path. Trading instructions and venue
credentials should go through the private-agent/private-account APIs, not the
generic model router.
