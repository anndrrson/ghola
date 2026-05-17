# Tier 3 — Frontier Privacy Primitives (Research Track)

Status: research, **not** on the engineering roadmap. Owner: privacy
research. Survey of three frontier primitives that go beyond what Tier
2 ships, with an honest assessment of which (if any) ghola should bet
on at the 5-year horizon.

This is the deep doc; tone and depth match
[tier-2k-shielded-payments.md](./tier-2k-shielded-payments.md) and
[tier-2g-anonymous-credentials.md](./tier-2g-anonymous-credentials.md).
Where Tier 2H zkML proves a single-pass inference was computed faithfully
on a fixed model, the three primitives here go further: they remove
*the operator* (MPC), the *plaintext substrate* (FHE), or the *network
identity* (mixnets) from the trust surface. Every Tier 2 control still
trusts some component — Tier 2A trusts the enclave, Tier 2K trusts the
Aleo bridge, Tier 2G trusts the credential issuer to be honest about
who's a Pro subscriber. Tier 3 is the world after we stop trusting all
of those.

The purpose of this doc is not to commit. It is to demonstrate that the
privacy roadmap has a credible 5-year horizon for investors who think
in terms of the full stack (ZK + MPC + TEE + FHE + mixnets), and to
mark — explicitly — which lines we are *not* spending engineering on
right now and why.

## 1. MPC Inference (Multi-Party Computation)

### 1.1 The primitive in plain terms

Secret-share the model. Take a transformer's weight matrices and split
each one across `k` independent servers using additive or Shamir secret
sharing: server `i` holds a share `[W]ᵢ` such that the public weight
`W = Σᵢ [W]ᵢ` (mod p), but any individual share is computationally
indistinguishable from random. The user's prompt is shared the same
way: `[x]ᵢ` to each server. Inference proceeds via interactive secure
multiplication on shares (Beaver triples, GMW, or BGW depending on
honest-majority assumptions) — at every linear and non-linear layer,
the servers exchange masked intermediate values, never reconstructing
plaintext. The final logits are shared back to the user, who
reconstructs locally.

No single server ever sees the prompt, the weights in the clear, or
the output. An attacker who compromises `k-1` of `k` servers learns
*nothing*: the privacy threshold is information-theoretic in the
honest-majority case, computational in the dishonest-majority case.

### 1.2 What it closes for ghola

Tier 1 trusts the enclave attestation. Tier 2A confirms the enclave
binary is the audited one. Tier 2H proves the model output is what the
fixed weights produced. None of these survive a **compromised
operator** — an SGX zero-day, a malicious cloud insider with hypervisor
access, a state actor with an undisclosed enclave vuln. MPC inference
makes that compromise irrelevant: the operator is `k` distinct entities,
collusion of any minority is harmless.

This is the only Tier 3 primitive that closes the "operator is the
adversary" gap. Every Tier 2 control assumes the enclave's silicon is
honest. MPC removes silicon trust entirely.

### 1.3 State of the art (2026)

| System | Construction | Status |
|---|---|---|
| **Nillion** | Nilvm + LRS secret sharing, 3+ node cluster, blind compute API | Mainnet live since 2025; public Llama-3.2-1B demo at ~30 s/token on 4 nodes |
| **Sycamore (Stanford / Inpher)** | Replicated secret sharing over rings, GPU-aware | Research; Llama-7B inference benchmark ~45 s/token on 3 servers in same DC |
| **Crypten** (Meta, archived) | PyTorch-native MPC, semi-honest 2PC | Reference impl; superseded by purpose-built systems |
| **CrypTFlow / EzPC** (Microsoft) | Function-secret-sharing, optimised for CNNs | Production for medical-image inference; LLM support immature |
| **Concrete-MPC** (Zama-adjacent) | Boolean-circuit MPC, complements their FHE stack | Experimental |

Concrete numbers as of Q1 2026: for a 7B-parameter LLM, the best
reported end-to-end MPC inference is on the order of `~30–60 s/token`
on a 3-server LAN cluster (Sycamore, Iron benchmarks). For sub-1B
models the gap to plaintext compresses to ~10–100× (Nillion's recent
"BlindLLM" preview). Communication cost is the bottleneck — each
non-linear (GeLU, softmax, layer-norm) requires multiple rounds of
share exchange, totalling **gigabytes of inter-server traffic per
prompt** for context lengths > 1k tokens.

### 1.4 Gap to production for ghola

Enormous, and structurally hard.

- **Latency.** ghola's first-token SLO is `<2 s`. MPC inference on
  anything past 1B parameters is 30–60 s/token today. Even an
  order-of-magnitude improvement (which the literature does not
  promise) leaves us at 3–6 s/token — a chat experience that feels
  broken. The Tier 2A enclave path delivers 50–100 ms/token. Two
  orders of magnitude is not a "tune the implementation" gap.
- **Coordination surface.** The relay (`crates/thumper-relay`) would
  have to be re-architected from a passive forwarder into an active
  MPC coordinator: routing each sealed envelope to `k` enclaves in
  lockstep, handling per-round commit/reveal traffic, detecting
  protocol-level failures (one of the `k` nodes drops mid-token and
  the rest stall waiting for shares). This is a different operational
  posture from anything in our stack today.
- **Bandwidth economics.** At ~1 GB of inter-server traffic per chat
  message, on-call costs become bandwidth-dominated. Cross-DC MPC
  inference is unrealistic at consumer per-call pricing.
- **Model marketplace incompatibility.** Tier 2F lets us route to
  third-party model providers. MPC requires every provider in the
  set to cooperate in the same protocol with the same weight sharing
  — incompatible with the heterogeneous Together.ai-style mesh we
  rely on.

### 1.5 Five-year roadmap if it becomes practical

MPC inference probably ships for ghola first as a **premium high-stakes
mode**, not the default. The realistic shape:

1. **Year 1–2 (2026–2027).** Track Nillion + Sycamore benchmarks
   quarterly. Maintain a contact at one of the teams. No engineering.
2. **Year 2–3.** If a credible Llama-3-8B benchmark lands at <5 s/token
   with <500 MB of inter-server traffic, scope a Tier 3M "high-stakes
   query" mode: user opts into a slow lane, pays ~$10/query, accepts
   30–60 s latency, gets MPC-inference-backed privacy. Target use
   cases: legal Q&A, medical-record-equivalent disclosures,
   whistleblower drafting.
3. **Year 3–5.** If GPU-aware MPC matures (FFT-based Beaver-triple
   preprocessing, GPU-friendly share representations), revisit. Default
   chat on MPC remains unlikely on this horizon.

### 1.6 Verdict

**Backup plan.** ghola tracks Nillion and Sycamore quarterly; we do
not commit engineering. If a major performance breakthrough lands — in
particular GPU-resident share preprocessing, or a constant-rounds GeLU
construction — revisit. Until then this primitive is mentioned in
investor decks as "tracked," not "shipping."

## 2. FHE Inference (Fully Homomorphic Encryption)

### 2.1 The primitive in plain terms

Encrypt the user's prompt under an FHE scheme — typically CKKS for
floating-point arithmetic, TFHE for boolean, or BGV for integer. The
inference provider runs the model forward pass directly on the
ciphertext: every matrix multiplication, activation, and attention
operation is a homomorphic operation that produces a new ciphertext.
The final logits come back encrypted. Only the user, holding the
secret key, can decrypt.

The provider never sees plaintext at any point. Not in memory, not in
registers, not in the GPU's HBM. The model weights themselves may be
in the clear (the standard setting) or also encrypted (the much more
expensive "two-key" setting). In the standard setting, the operator
learns the *model* is being run, but not on what input or with what
output.

### 2.2 What it closes for ghola

The most extreme version of the privacy promise. Even a *fully
compromised* provider — root on the machine, debugger attached to the
inference process, full silicon control — learns nothing about the
prompt or the response. There is no enclave to break, no attestation
chain to forge, no operator to compel: the ciphertext is mathematically
opaque under standard cryptographic assumptions (RLWE).

This is the privacy ceiling. Nothing goes further. FHE is what people
mean when they say "homomorphic AI" in the abstract; it is the version
of the pitch that does not require trusting silicon.

### 2.3 State of the art (2026)

| Library | Scheme | Domain |
|---|---|---|
| **TFHE-rs** (Zama) | TFHE | Boolean / lookup-table, fast bootstrapping |
| **Concrete-ML** (Zama) | TFHE under the hood | Sklearn-style ML over FHE; production for small models |
| **OpenFHE** | BGV / BFV / CKKS / TFHE | Reference impl, broad scheme coverage |
| **Microsoft SEAL** | BFV / CKKS | Production-stable but unmaintained; CKKS bug retracted in 2024 |
| **Lattigo** (EPFL → Tune Insight) | BGV / CKKS / RGSW | Go-native, ML-focused |
| **Intel HEXL / NVIDIA cuFHE** | GPU acceleration of underlying NTT / number-theoretic transforms | 5–50× speedup on the polynomial layer |

Concrete numbers as of Q1 2026: Zama published an FHE inference of a
small encoder model (Llama-style, ~100M parameters) at ~5 minutes per
token on a beefy CPU. For a 1B-parameter model — still tiny by chat
standards — the extrapolation lands at hours per token. The Zama
"large LLM" target for 2027 is 10–100× faster bootstrapping; even
optimistic, that brings a 1B model to tens of seconds per token, still
unusable for chat. CKKS bootstrapping (the operation that lets you do
more than ~10 multiplications before the noise floor kills the
ciphertext) is the hard part; it is the bottleneck behind every FHE-NN
performance number.

The gap to plaintext for non-trivial transformer inference is
currently **~10,000×**, and the field's published "next milestone"
targets shave roughly an order of magnitude per year — meaning realtime
parity is a 10+ year horizon, not 5.

### 2.4 Gap to production for ghola

Larger than MPC by another two orders of magnitude.

- **Latency.** Multi-minute-to-multi-hour per query. Chat is ruled out.
  Even batch-mode AI — "submit a query, get a response tomorrow" — is
  marginal for anything beyond a 100M-parameter model.
- **Memory.** FHE ciphertexts are ~1000–10000× larger than plaintext.
  A single hidden-state ciphertext for a 7B model exceeds typical GPU
  HBM. Practical FHE inference requires CPU-side big-RAM machines or
  specialised ASICs (Intel/DARPA-funded, not commercially available).
- **Non-linearity approximation.** Transformer non-linearities (GeLU,
  softmax, layer-norm) are not natively expressible in FHE; they have
  to be replaced with low-degree polynomial approximations that
  degrade model accuracy. Every FHE-NN benchmark is on a model that
  has been *retrained* with FHE-friendly activations, not on the
  original weights. ghola's whole proposition — route to arbitrary
  off-the-shelf models — breaks here.
- **No incremental shipping path.** Unlike MPC, where a degraded slow
  lane is plausible, FHE doesn't have a "30 seconds for an
  unimportant query" mode for non-toy models in 2026.

### 2.5 Five-year roadmap if it becomes practical

1. **Year 1–3 (2026–2028).** Track Zama and Lattigo benchmarks
   annually. Read the Zama Concrete-ML papers. No code.
2. **Year 3–5.** If a 1B-parameter model achieves <30 s/token FHE
   inference on commodity hardware, scope a Tier 3F "submit-and-wait"
   mode for very-high-stakes single-shot queries (think: encrypted
   legal-document analysis, single API call, response within 24 hours).
   This would not be conversational.
3. **Year 5+.** Realtime chat over FHE is not on the 5-year horizon. We
   do not plan for it.

### 2.6 Verdict

**Backup plan, very long horizon.** ghola tracks Zama's FHE-NN
publications. We do not engineer toward it. We revisit at the 5-year
mark, by which time we expect to know whether the field is on the
trajectory to commodity-batch FHE or whether it has stalled at small
encoder models. Today's honest assessment is the latter is more
likely.

## 3. Onion-Routed Inference (Nym / Tor for AI traffic)

### 3.1 The primitive in plain terms

Wrap each sealed request in `k` layers of encryption. Route it through
`k` independent mixnet nodes; each node strips exactly one layer,
revealing only the address of the next hop. The exit node delivers the
innermost ciphertext to the inference provider (or to the relay, which
then forwards to the enclave), but knows nothing about the originating
user. Reverse the route for the response.

This is orthogonal to the inference encryption itself. The sealed
envelope (`apps/web/src/lib/sealed-stream.ts`) already protects the
*content*. Onion routing protects the **network-layer metadata**:
source IP, request timing as observed by the relay, request size as
observed by any single intermediary.

In practice this means integrating a mixnet client into the ghola web
app and providing a mixnet-aware ingress on the relay side, so a
"paranoid mode" user pays a latency premium for unlinkability of
*every* request from their network position.

### 3.2 What it closes for ghola

The metadata leak the relay sees today. Even after the sealed envelope
and Tier 2G anonymous credentials (no stable DID), the relay still
observes:

- Source IP (mitigated by OHTTP per `apps/web/src/lib/ohttp.ts`, but
  OHTTP trusts the OHTTP relay operator not to log).
- Per-request timing fingerprint.
- Request size distribution.
- A consistent TLS fingerprint per browser session.

A network-layer adversary at the relay's ingress — or a subpoenaed
OHTTP relay operator — can fingerprint a user's traffic pattern even
with full content encryption. Onion routing destroys this: the relay's
view becomes "a packet from one of N mixnet exits," indistinguishable
from any other mixnet user's traffic.

This is the only Tier 3 primitive that closes a leak we can articulate
*today*, against an adversary who already exists today (any well-funded
network observer with passive access at the relay's hosting provider).

### 3.3 State of the art (2026)

| System | Construction | Status |
|---|---|---|
| **Nym** | Sphinx packet format, Loopix-style mixing with cover traffic, incentivised mainnet (NYM token) | Mainnet live since 2023, ~50k packets/s aggregate, ~200–500 ms latency added per hop, 3-hop default |
| **Tor** | Onion routing without timing mix, volunteer relays | Mature, ~10× larger network than Nym, but exit-node hostility and high latency variance |
| **HOPR** | Mixnet with proof-of-relay incentives | Smaller, focused on RPC traffic |
| **I2P** | Garlic routing, no incentive layer | Stable but stagnant |

Nym is the credible contender for application integration: it has
working Rust SDKs (`nym-sdk`, `nym-sphinx`), a published WASM client
suitable for browser embedding, and a documented WebSocket-bridge
pattern for arbitrary application-layer traffic. Latency added per hop
is `~200–500 ms` empirically on the mainnet; with the standard 3-hop
route plus return, total added latency is ~600–1500 ms first-byte. The
Nym SDK supports a "low-latency" mode that reduces mixing rounds at
some unlinkability cost — a tunable knob ghola can expose.

Tor over the same path is similar in latency but with higher variance
(seconds-to-tens-of-seconds tail) because Tor doesn't compensate for
adversarial path selection.

### 3.4 Gap to production for ghola

Genuinely tractable. The integration is plumbing, not cryptographic
engineering.

- **Client transport.** Add a `transport: "nym"` variant to
  `apps/web/src/lib/sealed-stream.ts`. The existing sealed envelope is
  unchanged — it is wrapped in a Sphinx packet via the Nym WASM SDK
  before going on the wire. Behind a feature flag,
  `settings.network_privacy`. Initial work: ~2 wk.
- **Relay ingress.** Either run a Nym-aware service endpoint (a Nym
  client process that bridges to `thumper-relay` over localhost) or use
  a third-party Nym SOCKS5 exit that forwards to our public relay. The
  former is cleaner and avoids trusting a third-party exit; ~2–3 wk of
  ops setup.
- **Latency budget.** +600–1500 ms first-token. For chat this is at
  the edge of usable. Acceptable for a "paranoid privacy" tier, not
  default. We surface it as a user-visible toggle with a latency
  badge.
- **Cost.** Nym charges via NYM credentials (`zk-nyms`) per packet.
  For ghola usage we'd pre-fund a service account and bill it to the
  same Pro subscription pool. Bandwidth cost on the order of $0.001
  per request; negligible.
- **Stream semantics.** Streaming responses (SSE) over a mixnet require
  multiplexing replies through Nym's surb (single-use reply block)
  mechanism. This is supported but adds a wrinkle to the existing SSE
  path. ~1 wk.

Total engineering: **8–12 calendar weeks** for opt-in v1 behind a
feature flag.

### 3.5 Five-year roadmap

This is the most practical of the three.

1. **Year 0–1 (now–2027).** Ship Tier 3N v1 as opt-in "Tor-like" mode,
   ~3–6 months of work, off the existing Tier 1/2 stack. Default off.
   Target audience: users who already use Mullvad, Tor, or Signal.
2. **Year 1–3.** Drive the latency down by optimising route selection,
   reducing default hops where the threat model permits, and
   integrating Nym's faster-path enhancements as they ship. Goal:
   sub-500 ms added latency.
3. **Year 3–5.** Evaluate default-on. The blocker is normie UX: chat
   that adds 500 ms of first-byte latency is noticeable; we don't
   flip this default until either the network gets faster or our
   target user shifts toward the privacy-maximalist demographic.

### 3.6 Verdict

**Bet.** ghola should prototype Nym transport within the year.
Tractable engineering (8–12 weeks), real privacy gain against an
adversary that already exists, fits the threat model of the user we
are already targeting (people who use Tor, Mullvad, Signal). This is
the only Tier 3 primitive worth current engineering attention.

## 4. Combined recommendation

Three primitives, three different verdicts:

- **Tier 3N (onion-routed inference, Nym).** Active engineering bet.
  Prototype this year. Ship opt-in v1 in 3–6 months. The latency cost
  is real but acceptable for the paranoid-privacy tier, and the threat
  it closes — network-layer metadata at the relay — is the most
  realistic adversary in our model today.
- **Tier 3M (MPC inference, Nillion/Sycamore).** Research-tracked, not
  on the roadmap. The performance gap (30–60 s/token for 7B models)
  rules out chat. We follow quarterly benchmarks and maintain a
  contact at one of the teams; we revisit if GPU-resident share
  preprocessing or constant-rounds non-linearities land.
- **Tier 3F (FHE inference, Zama).** Research-tracked at lowest
  cadence. The gap is ~10,000× and the published trajectory shaves
  ~10× per year. Realtime chat is a 10-year horizon, not 5. We read
  the papers; we do not engineer.

For investor framing this is the honest version of the privacy-stack
pitch: ZK already ships (Tier 2H zkML proves single-pass inference;
Tier 2G credentials, Tier 2K shielded payments use SNARKs in
production). Mixnets are coming next (Tier 3N). MPC and FHE are
research-tracked with realistic horizons named, not waved at. We
believe naming the gap is more credible than overpromising.

The point of this tier is to demonstrate that the team has thought
through the frontier, picked the one frontier primitive worth current
investment (mixnets), and has explicit, honest reasons for deferring
the other two. Yahya's privacy-stack framing
(ZK + MPC + TEE + FHE + mixnets) is still credible because every
component is named with a real horizon, not because we claim to be
shipping all of them.

## 5. References

- Nym whitepaper — "Nym: A Practical Architecture for Mixnet
  Anonymous Communication," Diaz et al., 2021
- Loopix design — "The Loopix Anonymity System," USENIX Security 2017
- Nillion technical paper — "Nil Message Compute," 2023
- Sycamore — "Practical MPC Inference for LLMs," Stanford, 2025
- Zama Concrete-ML — "Privacy-Preserving Machine Learning with
  Concrete," 2024–2026 series
- TFHE — "Faster Fully Homomorphic Encryption: Bootstrapping in Less
  Than 0.1 Seconds," Chillotti et al., 2016, plus subsequent
  Zama-led optimisations
- CKKS — "Homomorphic Encryption for Arithmetic of Approximate
  Numbers," Cheon et al., 2017
- `apps/web/src/lib/sealed-stream.ts` — current client transport
  layer; the integration point for any Tier 3N work
- `apps/web/src/lib/ohttp.ts` — current network-metadata mitigation,
  superseded (additively, not replaced) by Nym in Tier 3N
- `crates/thumper-relay` — relay; new Nym-aware ingress endpoint
  lives here

## Next concrete action

Open a PR that adds a `transport: "nym"` variant to the existing
sealed-stream client in `apps/web/src/lib/sealed-stream.ts`, behind a
`settings.network_privacy` feature flag, wired to the `nym-sdk`
WASM client with a hardcoded development-time mixnet entry node and a
no-op relay-side handler — call it the "transport-stub" PR so the
client surface lands first while the relay-side Nym ingress is built
in a follow-up.
