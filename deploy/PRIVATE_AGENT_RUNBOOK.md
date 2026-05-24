# Private Agent Runtime Runbook

This runbook wires `/strategies` session-key agents to remote confidential
compute. The product must remain fail-closed: if attestation, sealed-recipient
publishing, subscription entitlement, or shielded settlement is missing, Ghola
allows local preparation only.

## Subscription wiring

The web route accepts encrypted session requests only after billing confirms a
paid private-agent entitlement. Configure the Thumper Cloud billing service with
the Stripe price IDs:

```bash
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_PRIVATE_AGENT=price_...
STRIPE_PRICE_UNLIMITED=price_...
```

`private_agent`, `unlimited`, and `enterprise` users can create sealed cloud
agent sessions. Free users remain limited to local encrypted strategy
preparation.

## Runtime contract

Web:

- `GET /api/private-agent/status` reports provider-neutral runtime status.
- `POST /api/private-agent/sessions` accepts only encrypted strategy bundles.
- Plaintext `source`, `prompt`, `policy`, `strategy`, or `messages` fields are
  rejected before billing or provider forwarding.

Provider:

- Accepts `POST /private-agent/sessions`.
- Receives `encrypted_strategy_bundle.ciphertext`, a `said-envelope-v1` payload
  sealed to the provider's attestation-bound X25519 key.
- Must verify the envelope signature, associated data, strategy policy hash, and
  user-approved caps before creating any background watcher or session key.
- Must not submit public AMM, public unshield, known-wallet, unique-amount, or
  unsafe calldata proposals.

## Phala first provider

Build and deploy the provider worker before changing web readiness flags:

```bash
gh workflow run build-private-agent-worker-image.yml \
  -f ref_to_build=<git-ref-or-sha> \
  -f image=ghcr.io/anndrrson/ghola-private-agent-worker:<tag>
```

Current built worker image:

```text
ghcr.io/anndrrson/ghola-private-agent-worker:private-agent-worker-58d0feb@sha256:11c02472d1c1ab85453fd0c887c5c1d917990a0e2ce28cfe748a1abc3dd0ed9f
```

Deploy `apps/private-agent-worker/docker-compose.phala.yml` as the Phala CVM
payload, then fetch the worker recipient metadata:

```bash
curl -fsS https://<phala-agent-host>/.well-known/private-agent-recipient
curl -fsS https://<phala-agent-host>/ready
```

The recipient key is the public key browsers seal strategy bundles to. Treat it
as production-ready only after the attestation verifier proves the quote,
measurement, image digest, and recipient key binding. The worker itself also
rejects plaintext strategy fields and refuses sessions until attestation env is
complete.

Set these on the web deployment after deploying and verifying the Phala CVM:

```bash
GHOLA_PRIVATE_AGENT_PROVIDER=phala
GHOLA_PRIVATE_AGENT_EXECUTION_URL=https://<phala-agent-host>
PHALA_CLOUD_API_KEY=<secret>
PHALA_ATTESTATION_VERIFIER_URL=https://<verifier-host>
PHALA_CVM_IMAGE_DIGEST=<verified-image-digest>
PHALA_ENCLAVE_KEY_ID=<attestation-bound-key-id>
PHALA_ENCLAVE_X25519_PUB_HEX=<32-byte-x25519-public-key-hex>
PHALA_CVM_MEASUREMENT_HEX=<measurement-hex>
PHALA_ATTESTATION_HASH=<attestation-doc-hash>
GHOLA_PRIVATE_AGENT_ATTESTED_READY=true
```

Set the matching worker env inside the CVM:

```bash
PRIVATE_AGENT_PROVIDER_ID=phala
PRIVATE_AGENT_TEE_KIND=phala
PRIVATE_AGENT_EXECUTION_TOKEN=<same-secret-as-PHALA_CLOUD_API_KEY>
PRIVATE_AGENT_ATTESTED_READY=true
PHALA_CVM_IMAGE_DIGEST=<verified-image-digest>
PHALA_CVM_MEASUREMENT_HEX=<measurement-hex>
PHALA_ATTESTATION_HASH=<attestation-doc-hash>
```

Do not set `GHOLA_PRIVATE_AGENT_ATTESTED_READY=true` until the verifier has
checked the CVM quote, image digest, measurement, and X25519 key binding. The
status API treats a missing recipient key as not ready even when the endpoint
and API key are configured.

## Gensyn future provider

Gensyn remains optional until it can publish the same confidentiality contract:

```bash
GHOLA_PRIVATE_AGENT_PROVIDER=gensyn
GENSYN_PRIVATE_AGENT_EXECUTION_URL=https://<gensyn-agent-host>
GENSYN_API_KEY=<secret>
GENSYN_ATTESTATION_VERIFIER_URL=https://<verifier-host>
GENSYN_ENCLAVE_KEY_ID=<attestation-bound-key-id>
GENSYN_ENCLAVE_X25519_PUB_HEX=<32-byte-x25519-public-key-hex>
GENSYN_MEASUREMENT_HEX=<measurement-hex>
GENSYN_ATTESTATION_HASH=<attestation-doc-hash>
GENSYN_CONFIDENTIAL_EXECUTION_READY=true
```

If the provider cannot prove sealed execution and publish a recipient key, leave
it configured but not ready.

## Checks

```bash
GHOLA_BASE_URL=https://ghola.xyz bash scripts/canary/private-agent-runtime.sh
```

Expected ready state:

- `remote_execution_ready: true`
- `selected_provider: "phala"` or another intended provider
- selected provider has `sealed_recipient`
- `shielded_rail_ready: true`
- `blocking_reasons: []`

Plaintext rejection canary:

```bash
GHOLA_BASE_URL=https://ghola.xyz bash scripts/canary/private-agent-runtime.sh --require-ready
```

The first command is safe before provider launch and verifies fail-closed
behavior. The `--require-ready` form is for production after Phala or another
attested provider and the shielded settlement rail are live.

## Rollback

Unset the provider readiness flag first:

```bash
GHOLA_PRIVATE_AGENT_ATTESTED_READY
GENSYN_CONFIDENTIAL_EXECUTION_READY
```

Then redeploy. `/strategies` should return to local-only strategy preparation
while saved encrypted strategies remain available on the user's device.
