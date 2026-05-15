# Tier 2J — Private Information Retrieval for RAG / Context Fetch

Status: design, not yet implemented.
Owner: privacy + assistant runtime.
Targets the residual leak that survives sealed inference: when the
assistant fetches *context* — a user's vault doc, a calendar entry, an
embedding row from an external knowledge base, a web-search result —
the **retrieval query itself** reveals user intent. Pairs with Tier 2G
(anonymous credentials for the request-level identifier) and Tier 2F
(decentralised provider network, which Tier 2J v2 depends on). See the
peak-security plan's Tier 2J entry for the one-line scope this doc
expands.

This is the deep doc; tone and depth match
[cryptographic-primitives.md](./cryptographic-primitives.md) and its
siblings [tier-2k-shielded-payments.md](./tier-2k-shielded-payments.md)
and [tier-2g-anonymous-credentials.md](./tier-2g-anonymous-credentials.md).
All section references are to source files in this repo.

## 1. Threat model

### 1.1 The leak

Sealed inference (`apps/web/src/lib/sealed-stream.ts`) hides the
*content* of a user's prompt and the model's response. It does not
hide the *fetches the assistant performs to answer the prompt*. Today
those fetches are in plaintext-to-the-relay:

```
user prompt (sealed) ── assistant tool call ──▶ vault.fetch_doc(id="divorce-settlement.pdf")
                                              ──▶ knowledge_base.search(q="custody arrangement")
                                              ──▶ web.search(q="grounds for sole custody California")
```

Each of those is, structurally, an HTTPS request the relay observes
with a doc id, a search string, or an embedding bucket index. The
sealed envelope around the *chat message* doesn't help — the **tool
calls are separate HTTP round-trips** that the assistant runtime issues
on the user's behalf, and today they're not wrapped.

Three concrete leaks the current architecture has:

**(a) User vault query.** The chat client fetches documents from
`apps/web/src/lib/chat-vault.ts` (encrypted at rest, but addressed by
plaintext `session_id` + `doc_id`). The cloud sees "user U asked for
doc D at time T." Even though D is encrypted under the user's vault
key, the **filename or path is in the index** and the access pattern
itself fingerprints intent — pulling `divorce-settlement.pdf` leaks
more than the chat message ever would, because filenames are
human-chosen handles for topics.

**(b) External RAG.** When the assistant queries an external knowledge
base (a Pinecone-style embedding bucket, a Notion workspace via MCP, a
shared org corpus), the **embedding-bucket index** or the **filter
predicate** is observable to the corpus operator. "User queried the
'legal/family-law' bucket" is enough.

**(c) Web search.** A search-proxy tool call (`web.search(q=…)`) sends
the user's query string in the clear to whichever upstream search
provider we proxy to. This is structurally identical to sending Google
your search history — the *sealed inference* makes the chat private,
the *tool call* leaks the same intent one HTTP hop later.

### 1.2 Adversary capabilities

| Adversary | Capability | What they learn today |
|---|---|---|
| **Passive relay observer** | Reads tool-call HTTP traffic on the relay. | The `doc_id` of every vault fetch, the query string of every search, the bucket index of every RAG hit. Stable across sessions, often human-readable. |
| **External corpus operator** | Hosts the embedding store or KB the assistant queries. | The exact embedding vector or filter predicate every user issues. Builds a per-user query history without ever seeing the chat. |
| **Search proxy operator** | Operates the upstream search backend the relay proxies to. | The user's full search history, joined to the per-request identifier the relay attaches (Tier 2G removes this identifier; Tier 2J removes the query itself). |
| **Subpoenaed cloud operator** | Compelled to produce records keyed by user identity. | A retrieval log far more revealing than the (sealed) chat log. |

### 1.3 What we want to protect

The minimum acceptable property is **query-content obliviousness**:
given a corpus of N items, the server learns nothing about *which item
the client fetched* beyond the prior `1/N`. A stronger property is
**access-pattern obliviousness**: the server cannot distinguish
sequential accesses by the same client from independent accesses by
different clients (ORAM-strength). We target the weaker property in
v1; ORAM is out of scope.

## 2. Candidate primitives

### 2.1 SimplePIR / DoublePIR (single-server, lattice-based)

SimplePIR ([Henzinger, Hong, Corrigan-Gibbs, Meiklejohn, Vaikuntanathan
2023](https://eprint.iacr.org/2022/949), USENIX Sec '23) is the
state-of-the-art simple single-server PIR construction. It uses
Regev-style LWE encryption with an offline-online split: the server
preprocesses the corpus into a **public hint** (a matrix-vector product
over the database); the client downloads the hint once and afterwards
each online query costs `O(√N)` upload and `O(√N)` download with no
further preprocessing.

```
Setup(DB):     hint = A · DB        # A public LWE matrix, DB is N×d
Query(i):      qᵢ = A·sᵢ + eᵢ + uᵢ·DB[i,:]    # masked one-hot row pick
Answer(qᵢ):    aᵢ = DB · qᵢ          # linear scan, O(N·d) at server
Recover:       DB[i,:] ≈ aᵢ − hint · sᵢ       # client decodes LWE noise
```

Concrete numbers from the SimplePIR paper for `N = 2²⁰` records of
256 bytes: hint ≈ 16 MiB (downloaded once), query ≈ 120 KiB, answer
≈ 120 KiB, server time ≈ 200 ms on a single core. DoublePIR (same
paper) halves online bandwidth at the cost of a second preprocessing
pass. Both are linear in `N` at the server — that's the structural
cost of single-server PIR; it cannot be avoided without non-collusion.

Implementations: the [SimplePIR reference impl](https://github.com/ahenzinger/simplepir)
in Go, a [Rust port `pir-rs`](https://github.com/blyssprivacy/sdk), and
the broader [Microsoft Research SealPIR](https://github.com/microsoft/SealPIR)
in C++ (BFV-based, an earlier construction in the same family, with a
maintained Rust binding). The Blyss SDK is the most production-ready
single-server option as of 2026 — it ships WASM bindings.

Good fit for **small corpora** (≤ 1M items) where the linear scan is
tolerable and the offline-hint download amortises across many queries.
The user's personal vault is exactly this case.

### 2.2 OnionPIR / multi-server XOR-share PIR

Multi-server PIR ([Chor, Goldreich, Kushilevitz, Sudan 1995](https://dl.acm.org/doi/10.1145/293347.293350),
modernised by [OnionPIR, Mughees et al. 2021](https://eprint.iacr.org/2021/879))
replaces the cryptographic hardness assumption with a **non-collusion
assumption**: k ≥ 2 servers each hold a full replica of the corpus;
the client splits its query into k additive (XOR for binary corpora,
modular for larger fields) shares such that any k−1 shares are
information-theoretically uniform random. Each server computes its
share of the answer; the client XORs the responses together to recover
the row.

```
Query(i):    sample r₁, …, r_{k−1} ∈ {0,1}^N uniform
             r_k = eᵢ ⊕ r₁ ⊕ … ⊕ r_{k−1}
Answer_j:    aⱼ = ⊕_{ℓ : rⱼ[ℓ]=1} DB[ℓ]
Recover:     DB[i] = a₁ ⊕ a₂ ⊕ … ⊕ a_k
```

Concrete properties: with k = 2 servers, upload is `N/8` bytes per
server, download is `|row|` bytes per server, server work is one XOR
pass over the corpus per query. OnionPIR layers somewhat-homomorphic
encryption (RLWE) on top to compress the upload from `O(N)` to
polylogarithmic, at the cost of higher server compute — it's the
right point on the curve when N is in the hundreds of millions.

Non-collusion is the load-bearing assumption. ghola already commits to
operator diversity via Tier 2F (decentralised provider network); the k
PIR servers map naturally onto k independently-operated relay nodes.
The privacy guarantee degrades to nothing if all k collude — but it
also degrades to nothing if `sk_bbs` is stolen in Tier 2G, and we ship
that anyway because the threat surface is independent.

Implementations: [OnionPIR reference impl](https://github.com/mhmughees/onionPIR)
in C++/SEAL, [`spiral-rs`](https://github.com/menonsamir/spiral-rs)
(Spiral, a closely related construction with a maintained Rust impl),
and Google's experimental [`private-retrieval`](https://github.com/google/private-retrieval).
Best fit for **large corpora** (≥ 10M items) where SimplePIR's hint
size or linear scan becomes prohibitive.

### 2.3 FrodoPIR (single-server, hint-reuse-optimised LWE)

FrodoPIR ([Davidson, Pestana, Celi 2023](https://eprint.iacr.org/2022/981))
is a more recent single-server LWE PIR explicitly tuned for **hint
reuse across many queries**. The server still publishes a one-time
hint (`O(N)` work, comparable to SimplePIR), but FrodoPIR's parameter
selection lets the client reuse the *same* hint indefinitely without a
re-randomisation step, and shrinks the online-query payload by ~3×
vs SimplePIR at equal security level. Online server cost is slightly
higher than SimplePIR (the inner product is over a wider modulus).

Concrete numbers from the paper for `N = 2²⁰`, 1 KiB records: hint
~16 MiB (one-time), online query ~36 KiB, online answer ~128 KiB,
server compute ~350 ms single-core. The advantage over SimplePIR is
that the **same hint** verifies thousands of queries — a per-user
vault PIR with 1000 fetches per session sees ~3× less total bandwidth
than SimplePIR.

Single-server, no non-collusion needed. Slightly slower online than
SimplePIR; meaningfully cheaper if the same hint is reused many times.
Reference implementation: [`frodo-pir`](https://github.com/brave-experiments/frodo-pir)
(Brave, Rust). A reasonable v1.5 if SimplePIR's hint-refresh frequency
turns out to dominate bandwidth in production telemetry.

## 3. Recommendation

**Ship SimplePIR for v1 (user-vault PIR). Plan OnionPIR for v2
(multi-operator external RAG).** Specifically: a single-server
SimplePIR over the user's encrypted vault index, with the server side
co-located at the relay; an OnionPIR scaffold targeting Tier 2F's
multi-operator network for external corpora once that network is live.

Justification:

1. **Corpus size matches the primitive.** A user's personal vault is
   small. Realistic numbers from observed Pro-tier usage: median user
   has ~200 docs, p95 ~3 000, the tail at most 10 000. SimplePIR's
   linear scan at `N = 10⁴` is sub-millisecond on the relay; the hint
   is ~150 KiB; the online query is ~5 KiB. We are nowhere near the
   regime where FrodoPIR's bandwidth optimisation matters or where
   OnionPIR's multi-server cost pays off. **External RAG** corpora
   (a shared knowledge base across all users, an embedding index of
   public docs) cross 10⁸ items quickly; SimplePIR's hint and linear
   scan blow up; OnionPIR is the only construction that scales there.

2. **Trust model matches the primitive.** SimplePIR makes a
   cryptographic assumption (LWE) and trusts no one with the query —
   exactly the right guarantee for the **user's own vault**, where the
   adversary is the cloud operator itself. OnionPIR makes a
   non-collusion assumption — exactly the right guarantee for an
   **external corpus** where the relay nodes are already separately
   operated under Tier 2F and where colluding-the-whole-network is a
   visible, attestable event.

3. **UX fit.** SimplePIR's preprocess-once-query-many model fits the
   vault flow: the user adds a doc, the relay precomputes the new
   hint, the assistant fires many fetches against the same hint over a
   long chat session. The hint refresh only happens on add/remove —
   not every query — so the amortised online cost is what dominates.

4. **Implementations exist.** The Blyss `pir-rs` SDK ships SimplePIR
   in Rust with WASM bindings already proven in production; SealPIR
   has a Microsoft-Research-maintained Rust binding for the BFV
   variant; the SimplePIR paper's authors maintain a reference impl.
   We're not on the critical path for any cryptographic engineering —
   this is integration work.

The cost is the per-user hint storage. We accept it explicitly: §4.5
specifies that the hint is materialised lazily and stored at the
cloud's existing object-storage tier, addressed by the user's DID
commitment, and bounded to a few MiB per user even at p99 vault size.

## 4. Concrete integration sketch (SimplePIR v1, user vault)

### 4.1 New code locations

| Concern | Location |
|---|---|
| SimplePIR server (Rust) | new crate `crates/said-pir-server` |
| SimplePIR client (TS, WASM-backed) | new module `apps/web/src/lib/pir-client.ts` |
| Shared wire types | new crate `crates/said-pir-types` (or merge into `said-types`) |
| Vault index format + hint precompute | hooks into `apps/web/src/lib/chat-vault.ts` and the cloud-side vault index |
| Hint-storage endpoints | new `GET /v1/pir/hint?vault_id=…` and `POST /v1/pir/query` in `crates/thumper-cloud` |
| Hint invalidation hooks | wherever vault add/remove lands today (`chat-vault.ts` write path) |

### 4.2 Server-side index + hint

The vault is already encrypted at rest under the user's vault X25519
key (`apps/web/src/lib/vault-x25519.ts`). Today the relay serves
`vault.fetch(doc_id)` by indexing into a flat list of encrypted blobs.
Under PIR:

```
VaultIndex {
  records: Vec<EncryptedBlob>,   // existing, untouched
  hint:    LweHint,              // SimplePIR public hint over `records`
  hint_epoch: u64,                // increments on add/remove
}
```

`hint` is computed by the relay when the vault is mutated. It is
**public** — no privacy property depends on the hint being secret.
Any user (or any client) can fetch it; it's safe to serve over a CDN.
The privacy benefit is that *every* query against the vault index
returns one encrypted blob whose internal addressing the relay cannot
recover.

### 4.3 Client-side request shape

`apps/web/src/lib/pir-client.ts` exposes a single async function:

```ts
// pseudocode
async function pirFetch(
  vaultId: string,
  docIndex: number,            // numeric row in the vault, not a name
): Promise<Uint8Array> {       // returns the encrypted blob; caller decrypts
  const hint = await getCachedHint(vaultId);
  const { query, recoverState } = simplePir.buildQuery(hint, docIndex);
  const answer = await fetch("/v1/pir/query", {
    method: "POST",
    body: encodePirQuery(vaultId, hint.epoch, query),
  }).then(r => r.arrayBuffer());
  return simplePir.recover(recoverState, answer);
}
```

The query encodes a masked one-hot vector of dimension `√N`; for `N =
10⁴` that's ~5 KiB on the wire. The answer is one encrypted row's
worth, ~120 B–1 KiB depending on doc-size bucketing. The relay's
`/v1/pir/query` handler runs the SimplePIR `Answer` step — one matrix-
vector product over the encrypted-record table — and returns the
ciphertext blob. The relay never sees `docIndex`.

The chat client maps the human-facing doc handle (filename, vault
entry id) to `docIndex` **client-side**, using a small index manifest
the user holds locally. The manifest itself is fetched via PIR on
first vault touch — bootstrapping the index by PIR-fetching index row
0 — so the relay never sees a doc-handle → docIndex lookup either.

### 4.4 Latency budget

Target: end-to-end PIR fetch < 100 ms p50 for a 10 000-doc vault on
modest user hardware. Component budget:

| Component | Budget |
|---|---|
| Client query build (WASM) | 5 ms |
| Wire upload (~5 KiB, OHTTP-wrapped) | 10–30 ms |
| Server `Answer` (single core, `N = 10⁴`) | 5 ms |
| Wire download (~1 KiB) | 10–30 ms |
| Client recover (WASM) | 2 ms |
| **Total (excluding network)** | ~12 ms |
| **Total (with typical network)** | ~40–80 ms |

This is well under the assistant's tool-call timeout and within the
"feels instant" UI envelope. At `N = 100 000` (worst-case vault), the
server step grows to ~50 ms and the totals land around ~150 ms — still
within tool-call budget.

### 4.5 Hint storage and refresh

The hint is **per-vault**, recomputed on add/remove, and stored at
`said-cloud` as a binary blob addressed by `vault_id` (a per-user
commitment, not the user's DID directly — keeps the hint URL from
being a deanonymising handle in its own right).

Hint refresh strategy:

- Hint is computed eagerly on the relay's write path whenever the
  vault changes. We accept this latency penalty on writes (writes are
  rare compared to reads) to make the read path always-hot.
- Client fetches the hint lazily on first PIR query of a session and
  caches it under `localStorage` keyed by `(vault_id, hint_epoch)`.
- If the client's `hint_epoch` is stale, the server responds with a
  `409 Hint-Stale` plus the new `hint_epoch`; the client refetches
  the hint and replays the query. Stale-hint replays are bounded by
  vault-mutation rate, which is low.
- Hint size scales as `O(√N · d)` where `d` is the record dimension;
  for a 10 000-doc vault with 1 KiB record buckets, the hint is ~3 MiB.
  At p99 vault size (100 000 docs), ~30 MiB. We bound the per-user hint
  budget at 50 MiB and force record-size bucketing to keep `d` small.

## 5. Beyond the user vault — OnionPIR scaffold for v2

External corpora — the shared embedding index, a public KB, an MCP
server's catalogue — are too large for SimplePIR. v2 layers OnionPIR
over Tier 2F's decentralised provider network:

```
                   ┌──── relay-A (replica) ────┐
client ── share_1 ─┤                            ├── answer_1 ┐
client ── share_2 ─┤ ─── relay-B (replica) ─── ├── answer_2 ┼─▶ XOR ─▶ row
client ── share_3 ─┤                            ├── answer_3 ┘
                   └──── relay-C (replica) ────┘
```

- k = 3 independently-operated relay nodes each hold a synced replica
  of the external corpus (the same way they already replicate the
  model registry and DID set). Replica freshness is bounded by the
  Tier 2F gossip cadence.
- Client splits its query into 3 RLWE-encrypted shares using OnionPIR's
  query-compression layer; uploads each share to a different relay
  over OHTTP (so source IPs aren't trivially correlatable across the
  three legs).
- Each relay runs the OnionPIR `Answer` step; client homomorphically
  combines the three responses to recover the row.

Privacy property: no single operator learns the row id; only a
collusion of all 3 does, which is structurally observable (Tier 2F's
attestation chain shows whether the 3 operators are independent).

Prerequisite: Tier 2F decentralised provider network must be live.
Until then v2 is a paper design — we ship v1 first and harden it.

## 6. What this does NOT solve

PIR closes the query-content channel. Several adjacent channels remain
open after Tier 2J ships:

- **Timing correlation.** The assistant fires a PIR query at `T₀` and
  the user types something embarrassing at `T₀ + Δ`; an observer who
  sees both timestamps (relay traffic + client-side keystroke timing
  leaking through analytics, or a malicious extension) correlates them
  and infers the topic. PIR does not address this. Mitigation: Tier 2H
  (cover traffic) and query batching (§7 below).
- **Result-size correlation.** A 50-MiB doc and a 50-byte doc produce
  PIR responses of materially different sizes. The relay can bucket
  encrypted records into fixed-size chunks at index time (1 KiB / 16
  KiB / 256 KiB / 4 MiB), at the cost of bandwidth amplification. We
  ship fixed bucketing in v1; the chosen buckets are documented at
  index time so the user can predict the cost.
- **Behavioural fingerprint.** A user who only ever queries about
  family-law topics fingerprints their interests via the *embedding
  region* their queries cluster in, even if no individual query is
  recoverable. PIR does not address embedding-space fingerprinting.
  Mitigation: client-side query padding (issue cover queries to
  unrelated buckets) plus the anonymity-set machinery from Tier 2G —
  the moat is the size of the credential set, not the cleverness of
  any individual query.
- **Hint-fetch side channel.** The hint URL is keyed by `vault_id`; a
  relay operator who sees the hint fetch learns "this user has a vault
  of this size." We accept this — it's a far weaker signal than the
  query content and is amortised across an entire session.
- **Encrypted-blob index reconstruction.** PIR hides which row was
  fetched; it does not hide that *some* row was fetched. A relay
  operator who controls vault ingestion sees the user's filenames at
  upload time. Mitigation: filenames are stripped at vault-ingest time
  in `chat-vault.ts`; the relay sees only opaque doc ids. (This is
  already the design for the encrypted-at-rest path; PIR does not
  weaken it.)

The honest framing: PIR is a *necessary* layer once sealed inference
and shielded payments land, because the retrieval channel becomes the
dominant leak. It is not sufficient on its own. The full privacy
guarantee is the conjunction of Tier 2G + Tier 2J + Tier 2H + Tier 2K.

## 7. Migration path

Three phases, mirroring Tier 2K and Tier 2G:

1. **Phase 0 — opt-in PIR for vault fetches.** Ship SimplePIR client +
   server. New per-user setting `settings.private_retrieval`. Default
   off. Existing plaintext-id vault fetch remains the primary path.
   The assistant runtime checks the setting and routes vault tool calls
   through the PIR client if enabled. Goal: live testing on real
   vaults at realistic sizes, perf telemetry on hint refresh.

2. **Phase 1 — PIR default for vault fetches.** Flip the default
   client-side. Plaintext-id fetch remains available as an explicit
   developer override for tooling that hasn't migrated. Surface a
   subtle UI affordance ("private retrieval on") so the user knows.

3. **Phase 1.1 — PIR mandatory for vault.** Remove the plaintext-id
   fetch path from the relay. The vault index is now PIR-only. This
   is the structural commitment; the plaintext fetch is not a
   permanent escape hatch.

4. **Phase 2 — OnionPIR for external RAG.** Once Tier 2F's 3-operator
   network is live, ship the OnionPIR scaffold for external corpora.
   The MCP tool-call layer routes external-RAG tool calls through the
   OnionPIR client; the existing plaintext path is deprecated. Per-MCP
   feature flag during rollout; mandatory once each MCP server has
   either migrated or been migrated away from.

## 8. Engineering effort estimate

Honest, 1 engineer-week = ~40 focused hours; multiply by ~1.6 for
calendar weeks at 60% allocation.

### v1: SimplePIR over the user vault

| Layer | Effort |
|---|---|
| SimplePIR Rust crate adoption (Blyss `pir-rs` or own port), WASM bindings, perf tuning for browser bigint arithmetic | 3.5 wk |
| `apps/web/src/lib/pir-client.ts` — query build, hint cache, recover, integration with the assistant tool-call runtime in `chat-stream.ts` | 2.0 wk |
| `crates/said-pir-server` — `Answer` endpoint, hint precompute on write, hint epoch tracking, OHTTP-compatible request shape | 2.0 wk |
| Hint storage in `thumper-cloud` — blob endpoint, eviction, `vault_id` commitment derivation | 1.0 wk |
| Hint invalidation hooks on vault add/remove + record-size bucketing | 1.0 wk |
| End-to-end tests across realistic vault sizes (100, 1 000, 10 000, 100 000 docs), latency telemetry, hint-refresh fault injection | 2.0 wk |
| Internal threat-model review + external audit (PIR is in scope of the same crypto audit window as Tier 2G) | 1.5 wk |
| **v1 Total** | **~13 engineer-weeks** |

That's the optimistic number assuming the Blyss SDK behaves and WASM
perf isn't a surprise. Realistic with WASM tuning and hint-refresh bug
budget: **15–18 wk**. We commit to the higher number for planning.
This matches the order-of-magnitude estimate in the peak-security plan
(~10–12 wk) once the audit slice is excluded.

### v2: OnionPIR for external RAG

Prerequisite: Tier 2F multi-operator network live (not before).
Additional effort on top of v1:

| Layer | Effort |
|---|---|
| OnionPIR Rust integration (`spiral-rs` or `onionPIR` port), RLWE parameter selection, WASM tuning for the homomorphic combine step | 3.0 wk |
| 3-replica corpus sync layer on Tier 2F (piggybacks the existing gossip; non-trivial because corpus updates are larger than DID-set updates) | 2.0 wk |
| Client-side share splitting, multi-leg OHTTP routing, response combination | 2.0 wk |
| External-RAG tool-call routing in the MCP layer (`crates/thumper-mcp`) | 1.5 wk |
| **v2 Total (on top of v1, and after Tier 2F)** | **~8–10 engineer-weeks** |

## 9. References

- SimplePIR / DoublePIR — [Henzinger et al., USENIX Security 2023](https://eprint.iacr.org/2022/949)
- OnionPIR — [Mughees, Chen, Ren, CCS 2021](https://eprint.iacr.org/2021/879)
- FrodoPIR — [Davidson, Pestana, Celi, PETS 2023](https://eprint.iacr.org/2022/981)
- SealPIR — [Angel, Chen, Laine, Setty, IEEE S&P 2018](https://eprint.iacr.org/2017/1142)
  with reference impl at [microsoft/SealPIR](https://github.com/microsoft/SealPIR)
- Blyss `pir-rs` SDK — [blyssprivacy/sdk](https://github.com/blyssprivacy/sdk)
- Spiral PIR — [`menonsamir/spiral-rs`](https://github.com/menonsamir/spiral-rs)
- Brave `frodo-pir` — [brave-experiments/frodo-pir](https://github.com/brave-experiments/frodo-pir)
- Original CGKS multi-server PIR — [Chor, Goldreich, Kushilevitz, Sudan, J. ACM 1998](https://dl.acm.org/doi/10.1145/293347.293350)
- `apps/web/src/lib/chat-vault.ts` — vault-fetch entry point (today's plaintext path)
- `apps/web/src/lib/vault-x25519.ts` — at-rest encryption that PIR layers on top of
- `apps/web/src/lib/sealed-stream.ts` — sealed-inference client (sibling channel)
- `crates/thumper-relay/src/auth.rs` — where the PIR query endpoint will live alongside `/v1/sealed`
- `docs/security/cryptographic-primitives.md` — sibling deep doc
- `docs/security/tier-2g-anonymous-credentials.md` — request-identifier companion
- `docs/security/tier-2k-shielded-payments.md` — payment-side companion

## Next concrete action

Open a PR that introduces `crates/said-pir-types` with the SimplePIR
query, hint, answer, and epoch wire types (serde + canonical encoding
+ golden vectors derived from the reference impl, no crypto yet), so
the server crate, TS client, and chat-vault integration can all start
typing against the same shape while the SimplePIR implementation lands
behind it.
