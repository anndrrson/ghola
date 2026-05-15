# Security

ghola is a private AI product. The privacy claim is meaningless without a
threat model, a disclosure policy, and an auditable trust chain. This
document is the source of truth for all three.

## Threat model

We assume an attacker who can:

- Operate any provider in the network, including a malicious provider
  who controls a Nitro / H100 enclave host.
- Inspect every network request between the user and ghola's relay
  and between ghola's relay and providers.
- Compromise ghola's content delivery network and serve a tampered
  copy of the web client JS.
- Run a malicious browser extension on the victim's machine with
  access to the page DOM.
- Front-run, replay, or censor transactions on Solana.
- Coerce ghola the company itself into a court order or NSL.

We aim to defeat the first five categories cryptographically and to
honestly disclose the limits of what we can do about the sixth.

## What's protected today

| Property | How |
|---|---|
| User prompt confidentiality in Private mode | X25519 sealed envelope to an attested enclave's per-session key. Relay forwards opaque bytes; it cannot decrypt. See `apps/web/src/lib/sealed-stream.ts`, `apps/web/src/lib/envelope.ts`. |
| User prompt confidentiality in Local mode | In-browser WebGPU inference. No network call per message. `apps/web/src/lib/webgpu-inference.ts`. |
| Provider integrity | AWS Nitro attestation with PCR verification. Release builds **cannot** be configured to skip attestation — the `THUMPER_ALLOW_UNATTESTED` env var is compile-time-disabled under `--release`. See `crates/thumper-relay/src/handlers.rs::allow_unattested`. |
| Receipt integrity | Ed25519 signature over canonical body, optional in-enclave provider co-signature, Merkle-batched and anchored to Solana every interval. Public verifier at `/r/[hash]`. |
| Replay defense | Per-session AAD binding in the envelope; nonce + replay cache on the relay's auth path. |
| Coercion resistance | Wallet-native identity (Turnkey-held Ed25519). ghola the company never holds the user's signing key in plaintext; export is encrypted P-256 to browser. |

## What is NOT protected today (honest list)

- **Browser-side enforcement of the SRI manifest.** The
  `/.well-known/sri-manifest.json` is published per-build and the
  build is reproducible (two runs at the same git SHA produce
  byte-identical manifests, verified by CI). Reviewers can audit
  out-of-band, but the runtime browser does NOT yet auto-reject a
  script whose hash doesn't match — that requires a Next.js plugin
  or a service-worker shim that lands in the same Tier 1C window.
- **Runtime weight integrity.** The integrity badge in chat reads a
  deterministic registry PDA but does not yet byte-compare the
  WebLLM-loaded weights to a published hash. Tier 1A.5.
- **Anonymity sets.** Tier 1 today is a single-operator network. The
  Yahya-style "winner-take-most via anonymity set" property requires the
  decentralized provider network (Tier 2F).
- **Payment metadata privacy.** Once x402 micropayments turn on,
  per-call settlements are visible on Solana. The shielded payment rail
  (Tier 2K) is what closes this.
- **Browser-extension attackers.** Any extension with page access on
  the user's machine can read the chat DOM. We cannot solve this in
  software; the mitigation is the native ghola-home install path.

## Reporting a vulnerability

Email **security@ghola.xyz**. PGP key fingerprint is published at
[ghola.xyz/.well-known/security.txt](https://ghola.xyz/.well-known/security.txt).

We will:

1. Acknowledge receipt within 48 hours.
2. Triage and confirm in-scope within 5 business days.
3. Coordinate a fix and a disclosure window. Default window is 90 days;
   shorter for actively exploited issues.
4. Credit the reporter publicly unless they request anonymity.

**Out of scope:** denial-of-service on public endpoints, social
engineering of ghola staff, vulnerabilities in third-party services we
depend on (Solana validators, Turnkey enclave, Render).

## Reproducible verification

Open [`/security/status`](https://ghola.xyz/security/status) — every
claim above resolves to a live probe in your own browser. A regression
on any indicator can be reproduced without running our code locally.

A determined reviewer can also verify:

- **Web bundle integrity** — fetch
  `https://ghola.xyz/.well-known/sri-manifest.json`. The manifest
  lists every JS/CSS artifact served by ghola.xyz with both SHA-256
  (hex) and SHA-384 (SRI form). Each artifact at its path is hashable
  by the reviewer (curl + sha256sum) and must match. The top-level
  `manifest_sha256` is a single value that summarises the whole
  manifest. The build is **reproducible** — two independent builds
  at the same source SHA produce byte-identical manifest hashes (CI
  enforces this on every commit via
  `apps/web/scripts/verify-reproducible-build.sh`). To verify the
  deployed bundle yourself:
  ```
  git clone https://github.com/anndrrson/ghola && cd ghola/apps/web
  git checkout <commit-from-manifest.git_commit>
  GIT_COMMIT=$(git rev-parse HEAD) npm run build
  diff <(jq -S . public/.well-known/sri-manifest.json) \
       <(curl -s https://ghola.xyz/.well-known/sri-manifest.json | jq -S .)
  ```
  Mismatch = the deployed bundle did not come from this source.
- **Receipt math** — open `/r/[hash]`, paste any receipt JSON exported
  from chat. The verifier runs entirely client-side and prints the
  full chain.
- **Attestation chain** — fetch the attestation document at
  `GET <relay>/attestations/{hash}` and verify the AWS Nitro PCR
  chain against the public NSM CA.
- **Source provenance** — every commit that ships to ghola.xyz is on
  `main` of [github.com/anndrrson/ghola](https://github.com/anndrrson/ghola).
  The web client is built from `apps/web/`; the relay from
  `crates/thumper-relay/`.

## Roadmap to peak

Tracked in the peak-security plan
([zesty-giggling-charm.md](https://github.com/anndrrson/ghola/tree/main/.claude/plans)).
Tier 1 hygiene closes by quarter-end; Tier 2 moat work runs through Q3.
