# Tier 2H — zkML Proof of Inference

Status: design, not yet implemented.
Owner: inference + cryptography.
Targets the residual trust-the-provider gap in the v2 receipt path:
today a receipt only proves "an attested enclave signed off on these
hashes," not "the claimed model produced this output for this
prompt." Pairs with Tier 2G (anonymous credentials on the request
side), Tier 2K (shielded payments on the settlement side), and
Tier 1E (production attestation enforcement). See the peak-security
plan's Tier 2H entry for the one-line scope this doc expands.

This is the deep doc; tone and depth match
[cryptographic-primitives.md](./cryptographic-primitives.md) and its
siblings
[tier-2k-shielded-payments.md](./tier-2k-shielded-payments.md) and
[tier-2g-anonymous-credentials.md](./tier-2g-anonymous-credentials.md).
All section references are to source files in this repo.

## 1. Threat model

### 1.1 The leak

A v2 receipt (`apps/web/src/lib/receipt.ts:31`) carries the provider's
Ed25519 signature over the canonical body, plus an `attestation_hash`
and `measurement` that bind that signature to a measured Nitro
enclave. The verifier walks:

```
provider_signature   ←─ Ed25519(enclave_ed25519_pub, sha256(body))
enclave_ed25519_pub  ←─ AttestationDoc.user_data
AttestationDoc       ←─ Nitro NSM quote, chains to AWS root CA
PCRs                 ←─ measurement_hex (PCR0 ‖ PCR1 ‖ PCR2)
```

What this proves: *some* code identified by that PCR triple ran inside
an attested Nitro enclave and signed the body. What this does **not**
prove: that the code at that PCR triple actually executed the model
the receipt names against the prompt the receipt hashes. The receipt
says `model_id = "Llama-3.2-1B-Instruct-q4f16_1-MLC"` and
`output_token_hash = sha256(<some text>)`, but a malicious or
compromised enclave image (or a measurement-equivalent one with the
inference loop swapped out) could sign the receipt without ever
running that model. The integrity claim collapses to: trust the
measurement registry, and trust that the published measurement
corresponds to code that does what the README claims.

zkML closes the second half. A succinct proof attached to the receipt
shows: given the public commitments
`(prompt_hash, output_hash, model_id_hash)`, there exists a witness
`(prompt, output, weights)` such that `model(weights, prompt) =
output` and the three hashes commit to those values. The proof itself
is the trust; the enclave signature becomes belt-and-suspenders.

### 1.2 Adversary capabilities

| Adversary | Capability | What today's receipt defends against | What zkML adds |
|---|---|---|---|
| **Colluding provider operator** | Runs the relay + enclave; can in principle ship an enclave image whose PCRs match the published measurement but whose inference loop is replaced (e.g. responses come from a cheaper distilled model). | Attestation pins PCRs; an honest auditor who diffs against the open-source measurement chain catches the swap. | zkML closes the gap without requiring an auditor — every receipt carries an independently verifiable witness that the named model ran. |
| **Enclave-compromise adversary** | Has root inside the enclave (side-channel exfiltration, Nitro 0-day, supply-chain attack on the runtime image). | Once inside, can forge `provider_signature` for arbitrary bodies; attestation no longer helps. | Forging the proof requires breaking the underlying SNARK, not just stealing a signing key. A stolen `sk_provider` is useless without the model + prompt witness that satisfies the circuit. |
| **Mid-session model swap** | Server-side router silently moves traffic from `Llama-3.2-1B` to a cheaper draft model after the first attestation. | Not defended — the attestation is per-session, not per-message. | Per-message proof binds each response to a specific `model_id_hash`. A swap breaks verification on the very first swapped message. |
| **Subpoenaed provider** | Compelled to produce historical receipts and certify they "ran the claimed model." | Compliance theater — operator's word, no externally checkable artifact. | The proof is a self-contained, court-admissible cryptographic artifact. |

### 1.3 What we want to protect

The minimum acceptable property is **per-message model-execution
integrity**: given a receipt body and the on-chain published verifying
key for the claimed model, any third party can verify in
`O(milliseconds)` that the named model — pinned by weight hash,
identical to what `ghola-model-registry` advertises — actually
produced the response, without learning the prompt, the response,
or the weights beyond what's already hashed into the receipt.

A stronger property is **per-token streaming proofs**: each emitted
token carries (or recurses into) a proof that incremental autoregressive
state is consistent, so the UX of "watch the model think" survives.
That's the v2 (Modulus / recursive) target; v1 ships per-response.

## 2. Candidate proof systems

### 2.1 EZKL (Halo2 over BN254)

EZKL ([ezkl.xyz](https://ezkl.xyz),
[Halo2 paper / book](https://zcash.github.io/halo2/)) compiles an ONNX
graph to a Halo2 circuit over the BN254 pairing-friendly curve, then
runs a GPU-accelerated prover over the witness produced by an actual
forward pass. The Halo2 proving system is the production zk stack
behind the Zcash Orchard pool and the Scroll / PSE Ethereum zkEVMs;
it has the deepest implementation lineage of any SNARK in shipping
infrastructure. EZKL's contribution is the lookup-argument-heavy
gadget library for the non-arithmetic operations ML circuits trip
over: fixed-point quantisation, ReLU, softmax, layer norm, attention
masks. Their published benchmarks show small transformers
(<100M params, quantised) proving in tens of minutes on an H100, with
proofs ~10–50 KB and verifier time ~5–20 ms in WASM
([EZKL benchmarks blog](https://blog.ezkl.xyz/)).

**Pros.** Production tooling: ONNX importer that already ingests the
quantised Llama family ghola SRI-pins in
`apps/web/src/lib/webgpu-inference.ts:25`. GPU prover. BN254 is
EVM-friendly (precompile-verifiable on every L1/L2 that matters) and
also Solana-verifiable via the `alt_bn128_compression` /
`alt_bn128_addition` / `alt_bn128_multiplication` /
`alt_bn128_pairing` syscalls Solana added in v1.18 — meaning we can
anchor verification on the same chain we already use for the receipts
batcher (`crates/said-receipts-service`) and the model registry
(`programs/ghola-model-registry`). The Halo2 prover is well-audited;
the EZKL ONNX-to-circuit translation is the surface that needs
auditing, but the surface area is much smaller than re-implementing
a model in arithmetic gates.

**Cons.** Proving cost. The honest number for `Llama-3.2-1B-q4f16_1`
is ~10–30 minutes on a single H100 per response. That is *not*
real-time inference UX; v1 is opt-in. Memory footprint for the witness
is large (tens of GB peak). The circuit is fixed per model — a new
model means a new circuit, which means a new ~2–3 week compile +
trusted-setup-equivalent (Halo2 needs a universal SRS, which has been
publicly generated, so no per-circuit ceremony, but per-model circuit
parameters still need publishing).

### 2.2 Risc Zero zkVM (STARK over Baby Bear)

Risc Zero ([risczero.com](https://risczero.com),
[Risc Zero specification](https://dev.risczero.com/api/zkvm/)) is a
general-purpose zkVM: you compile (almost) arbitrary Rust to a RISC-V
binary, run it inside the zkVM, and get back a STARK proof of correct
execution. The proof system is a FRI-based STARK over the Baby Bear
prime field, with optional Groth16 wrapping for short verifier
bytecode on EVM-class chains.

**Pros.** Conceptual simplicity. You write the inference loop in Rust
the same way you'd write `crates/thumper-gpu-provider/src/enclave.rs`,
and the zkVM produces a proof of that exact execution. No
circuit-compiler-induced semantic drift between what the model
actually computes and what the circuit "thinks" it computes — the
circuit is the RISC-V execution trace. Recursive proof composition is
native (used to keep proof size constant as cycle count grows).
No trusted setup.

**Cons.** Worse than EZKL on ML-specific workloads by ~1–2 orders of
magnitude. The zkVM's RISC-V model is general-purpose: a matrix
multiply unrolls to ~`n²` cycle-level operations, each adding
proving cost, where EZKL's purpose-built lookup gadgets express the
same multiplication in a few hundred constraints. Risc Zero's GPU
prover is younger than Halo2's; benchmarks for transformer inference
are in the multi-hour range per response on commodity GPUs.
Verifier-on-Solana story is improving (Groth16 wrap + alt_bn128
precompiles work, but the wrapping step adds ~minute of overhead).

### 2.3 Modulus Labs / recursive proof streaming

Modulus Labs ([moduluslabs.xyz](https://www.moduluslabs.xyz/),
[Cost of Intelligence](https://moduluslabs.xyz/whitepapers/Cost%20Of%20Intelligence.pdf)
whitepaper, their Mina-style recursive proving pipeline) targets the
streaming-inference UX explicitly. The pattern: each token's
autoregressive step is its own small circuit; a recursion verifier
folds the prior proof into the new one (Nova / SuperNova /
HyperNova-class folding, depending on which paper you take as canon).
The user sees tokens stream as usual; behind the scenes a per-token
proof is generated in seconds and accumulated into a single
~constant-size final proof attached to the receipt.

**Pros.** This is the only candidate that preserves the streaming
UX users actually demand. Per-token proving cost can be amortised
during emission rather than blocking the response. Final aggregate
proof is constant-size regardless of response length. Right shape
for chat.

**Cons.** Bleeding edge. The folding-scheme primitives (Nova et al.)
are 2-to-3 years old as production deployments go; recursive ML
specifically is a research target, not a product. Modulus does not
publish a downloadable open-source library at the maturity level
EZKL does; we'd be either contracting with them or rebuilding
significant pieces. Most importantly: per-token proof time still
needs to land below per-token inference time, and at current
benchmarks for fold-friendly ML circuits we're not there yet on
1B-class models — probably true at the 100M-class.

## 3. Recommendation

**Ship EZKL (§2.1) for v1.** Specifically: per-response Halo2 proof
over BN254, produced by a sidecar prover the provider runs alongside
each `thumper-gpu-provider` enclave, attached to the v3 receipt
as an optional field, verified client-side in WASM at the same
trust boundary that already runs the SRI integrity check.

Justification:

1. **Threat fit, today.** The receipt-as-trust-artifact thesis (Tier
   2H's whole reason for existing) is satisfied by EZKL with a
   verifier path that is *literally already shaped like the
   verifiers ghola ships*: WASM, called from
   `apps/web/src/lib/webgpu-inference.ts`, anchored against an
   on-chain published key. The Halo2 verifier in WASM is a few hundred
   KB and runs in ms; this fits inside the existing client-trust
   posture, not next to it.

2. **Production maturity.** Halo2 has shipped in Zcash Orchard
   since 2022. EZKL has a years-long lineage of production zkML
   bounties and demo deployments. Risc Zero is mature but not
   specialised for ML; Modulus's recursive pipeline is the right
   long-term shape but not productisable in the next ~6 months.

3. **Stack fit.** ghola's web stack already imports `@noble/curves`
   for the Ed25519 + X25519 + (soon, Tier 2G) BLS12-381 path. EZKL's
   BN254 curve plugs in without a third pairing engine — `@noble/curves`
   ships BN254 (also called `bn128`) and the WASM verifier from EZKL
   uses the same hash-to-curve / pairing primitives. Solana's
   `alt_bn128_pairing` syscall (v1.18+) means an on-chain verifier is
   a single-tx affair, not a bridge. The model artefacts ghola
   already SRI-pins (Llama 3.2 1B at q4f16_1) are precisely the ONNX
   class EZKL ingests.

4. **Cost trajectory.** GPU proving cost for fixed-circuit Halo2 ML
   has been halving roughly every 9 months for two years (PSE
   benchmarks, EZKL public benchmarks, IRREDUCIBLE / Hyrax /
   Lasso-class lookup improvements all compounding). The 10–30 min
   number we ship at v1 is plausibly 1–3 min by 2028 and per-message
   real-time by 2030. The migration path in §6 is built around that
   curve, not around hoping for a new SNARK.

Modulus-style recursion (§2.3) is the **v2 upgrade**. We design v1
so the receipt schema can carry either `proof_system = "ezkl"` or
`proof_system = "modulus-fold"` without a wire break; once
per-token folding lands at production quality, we drop in a second
prover behind the same receipt field.

The cost we accept: v1 is opt-in. Most users will not pay 10–30 min
of GPU time per response. The set of users who *will* — enterprise
audit, regulated industries, journalism, anyone whose use-case is
"prove this AI ran the model it claimed" — is the set who will pay
the entire premium of a verifiable-inference tier, and it's the set
ghola is uniquely placed to serve.

## 4. Concrete integration sketch

### 4.1 New code locations

| Concern | Location |
|---|---|
| Prover sidecar (Rust) | new crate `crates/ghola-zkml-prover` |
| Shared types (proof, public inputs, circuit id) | new crate `crates/ghola-zkml-types` |
| TS verifier wrapper (WASM bindings around EZKL's verifier) | new module `apps/web/src/lib/zkml-verify.ts` |
| Verifier-key pinning + circuit id resolution | extend `apps/web/src/lib/webgpu-inference.ts` next to `DEFAULT_WEBGPU_MODEL_INTEGRITY` |
| Receipt schema bump (v3) | `apps/web/src/lib/receipt.ts` — new optional `zkml_proof` field |
| Provider integration | `crates/thumper-gpu-provider` calls into `ghola-zkml-prover` after inference completes |
| Registry program update | `programs/ghola-model-registry/src/lib.rs` — add `zkml_verifying_key_hash: Option<[u8; 32]>` and `zkml_circuit_id: Option<String>` |
| On-chain verifier (optional, v1.1) | new program `programs/ghola-zkml-verifier` using `alt_bn128_pairing` |

### 4.2 Prover sidecar architecture

The prover is a **separate process from the enclave**. The enclave
(`crates/thumper-gpu-provider`) runs the model and emits the response
+ a witness manifest (prompt tokens, output tokens, intermediate
activations needed by the circuit) over a local Unix socket to the
sidecar. The sidecar runs EZKL's GPU prover against the pinned
circuit, produces the proof, hands it back to the enclave, the
enclave attaches it to the receipt and signs.

Rationale for the split:

- **Resource isolation.** The prover's peak memory (tens of GB) and
  multi-minute GPU saturation should not block the inference enclave
  from serving other requests. The enclave streams the response to
  the user the moment it's ready; the proof is computed
  asynchronously and the receipt is delivered when the proof
  completes (UX: response renders immediately with a "proof
  pending — verifying" badge that flips to "verified" on completion,
  typically 10–30 min later).
- **Attack surface.** The prover doesn't need access to the model
  weights as a runtime secret — they're public on the registry — and
  it doesn't need access to the user's identity keys. It runs
  outside the Nitro boundary because nothing about the proof
  generation needs to be confidential. The witness *does* contain
  the prompt and the response, so the sidecar inherits the same
  privacy posture as the enclave: data deleted after proof
  emission, no logging, runs colocated on the same operator-trusted
  host.
- **Future v2 swap.** Replacing EZKL with Modulus-recursion later is
  a sidecar swap, not a relay or receipt-schema change.

### 4.3 Receipt schema bump (v3)

Today `ReceiptV1` (see `apps/web/src/lib/receipt.ts:31`) is the only
shape. We bump to v3 by adding one optional field; the canonical
signing-key order (`RECEIPT_BODY_KEYS` at `receipt.ts:75`) appends
the new field at the end so v2-receipt verifiers continue to compute
the same digest when the field is absent.

```ts
export interface ReceiptV3 extends ReceiptV1 {
  version: 3;
  /** Null on v1/v2 receipts. Present when the provider also attached
   *  a zkML proof of inference for this response. */
  zkml_proof: ZkmlProof | null;
}

export interface ZkmlProof {
  /** "ezkl" for v1. "modulus-fold" reserved for the recursive v2. */
  system: "ezkl" | "modulus-fold";
  /** Circuit identifier — sha256 of (model_id || circuit_params).
   *  Indexes into ghola-model-registry to fetch the verifying key. */
  circuit_id: string;
  /** Halo2 proof, base64. ~10-50 KB for a 1B-param transformer. */
  proof_b64: string;
  /** Public inputs the verifier hashes into the transcript. The
   *  prompt_hash and output_hash match the existing
   *  input_token_hash / output_token_hash receipt fields by
   *  construction; model_id_hash binds the proof to a specific
   *  registered weight hash. */
  public_inputs: {
    prompt_hash: string;     // hex, equals receipt.input_token_hash
    output_hash: string;     // hex, equals receipt.output_token_hash
    model_id_hash: string;   // hex, equals registry.weights_hash for this model_id
  };
  /** Unix ms when the proof completed — distinct from receipt.issued_at
   *  because the proof may complete asynchronously after the response.*/
  proved_at: number;
}
```

Backward compatibility: `zkml_proof: null` is identical in canonical
encoding to "field absent" when serialised with the existing
canonicalisation discipline. v1 and v2 verifiers ignore unknown
fields and continue to work. v3 verifiers run the extra check when
the field is present, skip it when null.

### 4.4 Client-side verifier

The verifier lives in `apps/web/src/lib/zkml-verify.ts` and is called
from the same trust boundary that already runs SRI integrity checks
on the WebGPU model artefacts
(`apps/web/src/lib/webgpu-inference.ts`):

```ts
// Pinned verifying keys per circuit_id. The hashes here pin the EZKL
// WASM blob (so a tampered verifier can't claim "verified" on
// arbitrary proofs) and the per-circuit verifying key fetched from
// ghola-model-registry on first use, cached locally.
export const DEFAULT_ZKML_VERIFIER_INTEGRITY = {
  ezkl_verifier_wasm: "sha256-…",  // SRI pin
};

export async function verifyZkmlProof(
  proof: ZkmlProof,
  registry: ModelRegistry,
): Promise<{ ok: boolean; reason?: string }>;
```

The verifier (a) fetches the verifying key from
`ghola-model-registry` keyed by `proof.circuit_id`, (b) verifies the
`proof.proof_b64` against `proof.public_inputs` using the WASM
verifier, (c) cross-checks that
`public_inputs.{prompt_hash, output_hash}` equal the receipt's
`{input_token_hash, output_token_hash}`, (d) cross-checks that
`public_inputs.model_id_hash` matches the on-chain `weights_hash`
for `receipt.model_id`. All four are required.

### 4.5 Verifying key on chain

The verifying key for each EZKL circuit (a few hundred KB to a few
MB depending on circuit size) is too large to put inline in a Solana
account, but a 32-byte hash of it fits trivially. `Model` in
`programs/ghola-model-registry/src/lib.rs` already carries
`weights_hash` (the binary integrity anchor) and would gain:

```rust
pub zkml_verifying_key_hash: Option<[u8; 32]>,  // sha256 of vk blob
pub zkml_verifying_key_url:  Option<String>,    // off-chain location
pub zkml_circuit_id:         Option<String>,    // matches ZkmlProof.circuit_id
```

The verifier fetches the blob by URL, checks its sha256 against the
on-chain hash, then uses it. Same trust model as the existing
WebLLM SRI pin: the on-chain hash is the root of trust, the URL is
mutable. Registry-program account growth handled by `realloc` on
next update, mirroring the Tier 2K registry change.

### 4.6 Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Prover sidecar offline | Enclave's local socket call times out. | Response ships with `zkml_proof: null` and a UI flag "verifiable mode unavailable, falling back to attestation-only." Receipt is still v2-valid. |
| Proof generation fails (e.g. quantisation overflow, OOM) | Sidecar returns error. | Same as above; logged for the provider operator. |
| Verifying key blob hash mismatches on-chain hash | Client-side, in `verifyZkmlProof`. | Treated as a tamper; receipt flagged red in the UI. |
| Public-input mismatch (proof valid but for different prompt/output) | Client-side cross-check. | Treated as a tamper. |
| Verifier WASM SRI mismatch | Loader rejects, same as today's model-artefact path. | Engine construction halts. |
| Proof completes after the chat session ends | Async delivery via the receipts service (`submitReceiptToService` already exists). | UI shows "proof posted" on the historic message when the client next polls `/v1/receipts/{hash}`. |

## 5. What this does NOT solve

zkML proves the math; it does not prove the meaning. Honest limits:

- **Real-time inference UX.** At v1 proving costs (10–30 min per
  response on a 1B model) this is not a streaming chat experience.
  It is a verifiable-batch experience. Users in the verifiable
  tier accept the latency or wait for v2 recursion. Default-on is a
  v3 (3–5 year) milestone, not v1.
- **Side-channel attacks on the prover GPU.** A compromised host can
  exfiltrate the witness (prompt + response) from the prover process
  even though the proof itself reveals nothing. The prover inherits
  the enclave's privacy posture; that posture is "trust the operator
  not to log," which we mitigate via decentralisation (Tier 2F) not
  via the proof system.
- **The model itself being malicious.** zkML proves
  `model(weights, prompt) = output` for the *registered* model. If
  the registered model is itself backdoored, or trained to behave
  differently on a watermarked input class, zkML certifies the bad
  behaviour with equal cryptographic confidence. Model alignment is
  out of scope; the mitigation is reproducible weights (Tier 1C
  follow-up) and weight provenance (registry signatures).
- **Quantisation drift.** EZKL's fixed-point arithmetic is not bit-
  identical to the IEEE-754 floats WebGPU uses on the inference path.
  We accept a small numerical gap and the registry pins the
  quantised circuit's reference output; "model produced this output"
  technically means "the quantised circuit equivalent of this model
  produced this output," which is what the user is paying us to
  certify.
- **Liveness / DoS on the prover.** A provider that simply never
  produces proofs degrades to v2 attestation. The economic incentive
  to keep proofs flowing is the verifiable-tier premium.

## 6. Migration path

Four phases, mirroring Tier 2G / 2K rollout cadence:

1. **Phase 0 — opt-in verifiable, attestation default.** Ship EZKL
   support behind a per-request flag. Receipt v3 schema rolls out;
   clients send `verifiable: true` if they want a proof attached.
   Default off. Verifier exists in the web app but only runs when
   `zkml_proof != null`. Single supported model: Llama 3.2 1B at the
   already-SRI-pinned quant.

2. **Phase 1 — verifiable tier as a paid feature.** Surface in the
   pricing model as "Verifiable" tier (premium SKU). Receipts in this
   tier are always v3 with `zkml_proof != null`; refunds issued on
   proof failure. Expand circuit coverage to ~3 model families
   (a 1B chat model, a 3B reasoning model, a 70B opt-in).

3. **Phase 2 — recursive token streaming (v2 prover swap).** Replace
   the EZKL backend with a Modulus-class folding prover for the
   models where it's available. Same `zkml_proof.system` field,
   value `"modulus-fold"`. Per-token UX matches the existing
   streaming experience. Verifiable-tier latency drops from "minutes"
   to "the inference itself plus seconds."

4. **Phase 3 — verifiable by default.** Once GPU cost for proving
   falls below the cost of inference itself, the default flips.
   Attestation-only receipts persist as a legacy lane for clients
   whose verifier doesn't yet ship the WASM blob. ETA per current
   benchmarks: 2030 ± 18 months.

## 7. Engineering effort estimate

Honest, 1 engineer-week = ~40 focused hours; multiply by ~1.6 for
calendar weeks at 60% allocation.

| Layer | Effort |
|---|---|
| EZKL integration + ONNX import for Llama-3.2-1B-q4f16_1; quantisation tuning; vector tests against reference forward pass | 2.5 wk |
| `crates/ghola-zkml-prover` — sidecar service, local socket IPC with `thumper-gpu-provider`, GPU prover invocation, async result delivery, witness lifecycle (delete-after-prove) | 2.0 wk |
| `crates/ghola-zkml-types` — shared `ZkmlProof` + `CircuitId` + public-inputs types, canonical encoding | 0.5 wk |
| Receipt v3 schema bump in `apps/web/src/lib/receipt.ts` + canonicalisation discipline + golden-vector tests | 1.0 wk |
| `apps/web/src/lib/zkml-verify.ts` — WASM verifier wrapper, SRI pinning, public-input cross-check, registry fetch + vk-hash check | 1.5 wk |
| `programs/ghola-model-registry` — `zkml_verifying_key_hash` + `zkml_circuit_id` fields, realloc, migration tool for existing model accounts | 1.0 wk |
| Verifier UI at `/r/[hash]` — render proof status, "verified by zkML" badge, retry on async-late proof delivery | 0.5 wk |
| End-to-end tests on devnet: prompt → enclave inference → sidecar prove → receipt v3 → web verifier → registry-anchored verifying key | 1.5 wk |
| Optional on-chain verifier program (`programs/ghola-zkml-verifier`) using `alt_bn128_pairing` — parked for v1.1, listed for sizing | 1.5 wk |
| Internal threat-model review + audit window (EZKL circuit translation is the highest-value audit target) | 3.0 wk |
| **Total (v1, ex. on-chain verifier)** | **~11.5 engineer-weeks** |

That's the optimistic number — one default model, one circuit, GPU
prover behaves. Realistic with quantisation surprises and audit
findings: **13–15 wk**. Each additional model family is ~2–3 wk for
circuit compile + verifying-key publish + integration test, dominated
by the EZKL ONNX importer's idiosyncrasies on each new architecture
(attention variant, KV-cache format, position-embedding scheme).

## 8. References

- EZKL — [docs](https://docs.ezkl.xyz/), [GitHub](https://github.com/zkonduit/ezkl), [benchmarks blog](https://blog.ezkl.xyz/)
- Halo2 — [the Halo2 book](https://zcash.github.io/halo2/), Bowe/Grigg/Hopwood, "Halo: Recursive Proof Composition without a Trusted Setup" ([eprint 2019/1021](https://eprint.iacr.org/2019/1021))
- Risc Zero — [zkVM specification](https://dev.risczero.com/api/zkvm/)
- Modulus Labs — [Cost of Intelligence whitepaper](https://moduluslabs.xyz/whitepapers/Cost%20Of%20Intelligence.pdf)
- Nova / SuperNova / HyperNova folding schemes — Kothapalli/Setty/Tzialla ([eprint 2021/370](https://eprint.iacr.org/2021/370)), Kothapalli/Setty ([eprint 2022/1758](https://eprint.iacr.org/2022/1758))
- Solana alt_bn128 syscalls — Solana v1.18 release notes (`alt_bn128_addition`, `alt_bn128_multiplication`, `alt_bn128_pairing`)
- `apps/web/src/lib/receipt.ts` — current receipt shape (v1/v2)
- `apps/web/src/lib/webgpu-inference.ts:39` — `DEFAULT_WEBGPU_MODEL_INTEGRITY`, the SRI pinning pattern the zkML verifier mirrors
- `crates/thumper-gpu-provider/src/enclave.rs` — where the prover sidecar IPC attaches
- `programs/ghola-model-registry/src/lib.rs` — registry to extend with verifying-key fields
- `docs/security/cryptographic-primitives.md` — sibling deep doc
- `docs/security/tier-2k-shielded-payments.md` — payment-side companion
- `docs/security/tier-2g-anonymous-credentials.md` — identity-side companion

## Next concrete action

Open a PR that introduces `crates/ghola-zkml-types` with the
`ZkmlProof`, `CircuitId`, and `PublicInputs` wire types (no prover
yet, just serde + canonical encoding + golden-vector tests against
EZKL's reference proof format), so the prover sidecar, receipt
schema bump, web verifier, and registry-program change can all
start typing against the same shape while the EZKL integration
lands behind it.
