# Ghola Shielded Pool — Specification (Phase 36: External Cryptography Audit Prep)

**Status:** Frozen for audit. Any change to a circuit, encoding, or public-input
ordering after this document is tagged `audit-v1` requires a new VK ceremony
and a governance proposal (see §9).

**Audience:** External cryptography auditors (OtterSec / Neodyme / Zellic class)
plus the Ghola protocol engineering team. This is not a tutorial; familiarity
with Groth16, BN254, Poseidon, and incremental Merkle trees is assumed.

**Canonical artifacts referenced by this document:**

| Artifact                | Path                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| Shared Rust types       | `crates/said-shielded-pool-types/src/lib.rs`                              |
| Anchor program          | `programs/said-shielded-pool/` (to be wired in Phase 37)                  |
| Circom circuits         | `circuits/{transaction,merkleProof,keypair}.circom` (frozen at `audit-v1`) |
| Verifier crate          | `Lightprotocol/groth16-solana` (vendored; pinned commit in `Cargo.toml`)  |
| Trusted-setup artifacts | `ceremony/audit-v1/` (zkey, vkey, transcript hashes, contributor list)    |
| Test vectors            | `crates/said-shielded-pool-types/testdata/` (Phase 36 deliverable)        |

All field-element values on-chain are **big-endian 32-byte** (`FieldBytes` in
the types crate). All Poseidon invocations are BN254-Poseidon as exposed by
the Solana `sol_poseidon` syscall (Light Protocol's parameter set, identical
to Circom's `circomlibjs` `poseidon` with t-arity matching the input count).

---

## 1. Overview & Threat Model

### 1.1 Purpose

The Ghola shielded pool is the cryptographic substrate for **anonymous on-chain
agents**: software agents that transact on behalf of a human principal without
publicly linking either the agent's individual actions to the principal or
successive actions of the same agent to each other.

A shielded note is a UTXO whose `(amount, asset_id, owner, blinding)` are
hidden behind a Poseidon commitment in a depth-26 Merkle forest. Spending a
note publishes a Groth16 proof that:

1. The note was a leaf in some recent commitment-tree root,
2. The spender holds a key authorized by the note,
3. A unique nullifier has been derived correctly,
4. Outputs preserve per-asset value (plus a signed `public_amount` for
   shield-in / unshield-out), and
5. The whole proof is bound to the transaction's external data (recipient
   address for unshields, fee, memo) via `ext_data_hash`.

### 1.2 Actors

| Actor               | Holds                                            | Trust assumption                                   |
| ------------------- | ------------------------------------------------ | -------------------------------------------------- |
| **Principal**       | `fvk = (ak, nk)`, `ivk`, master seed             | Honest. Root of trust.                             |
| **Agent**           | `sk` (= scalar with `ak = G·sk`), `ivk` copy     | Honest-but-bounded; assumed compromisable.         |
| **Relayer**         | Transaction bytes + proof                        | Honest-but-curious. Sees ciphertext + on-chain tx. |
| **Forester**        | Insertion-queue contents; runs the queue→tree SNARK | Liveness only; cannot forge or censor undetectably. |
| **Merchant / CP**   | Recipient pubkey, ext-data, on-chain transcript  | Adversarial. May be Sybil; may collude w/ relayer. |
| **Chain observer**  | Full on-chain state                              | Passive adversary; bounded by Groth16 soundness.   |

### 1.3 Threat model

**In scope:**

- **Linkability of agent actions** — a chain observer cannot link two spends
  of the agent to each other or to the funding principal beyond what the
  amount-graph and timing leak. This is the standard mixer property,
  strengthened by the FVK audit hierarchy so the principal retains full
  ex-post view of agent activity *without* needing to relay through the agent.
- **Theft of funds** — outputs preserve value; only key-holders can spend;
  nullifiers prevent double-spend.
- **Proof malleability** — an adversary who observes a valid `(proof,
  public_inputs)` cannot rebind it to a different recipient, fee, or memo
  (enforced by `ext_data_hash`).
- **Replay** — once a nullifier is in the persisted set, the same note cannot
  be re-spent regardless of which historical root the proof references.
- **Verifier-key substitution** — the `vk_hash` is committed at pool init and
  changing it requires governance multisig + a published ceremony transcript.

**Out of scope (Phase 36):** see §16.

**Explicitly NOT trusted:**

- The relayer. The relayer learns ciphertext only; it cannot decrypt notes,
  forge proofs, or reorder/alter the (proof, public_inputs, ext_data) tuple
  without invalidating the proof.
- The forester. A malicious forester can stall the insertion queue (liveness
  attack) but cannot insert a commitment without producing a valid root-update
  SNARK whose pre-state matches the on-chain root (see §8).
- The agent post-compromise. The principal retains nullifier-derivation
  capability via `nk` and can therefore detect every future spend the agent
  attempts; the principal also retains funds in any note whose commitment has
  not yet been spent (the agent's `sk` is required to spend, but the principal
  reconstructs `sk` from the master seed — see §3).

### 1.4 Non-goals

- We do not hide the *fact* that a transaction occurred, only its contents.
  Solana's transaction-level metadata (fee payer, instruction count, slot)
  is visible.
- We do not hide aggregate per-asset flow into/out of the pool boundary
  (the `public_amount` and `asset_id` fields are public).
- We do not provide post-quantum security. Groth16 + BN254 + Poseidon are all
  classically secure only.

---

## 2. Data Model

All structs are defined in `crates/said-shielded-pool-types/src/lib.rs`. This
section is a pointer + invariants, not a redefinition. See that file for the
canonical Rust declarations.

| Type                          | Definition                                                  | On-chain encoding |
| ----------------------------- | ----------------------------------------------------------- | ----------------- |
| `FieldBytes`                  | `[u8; FIELD_BYTES]` = 32 bytes, big-endian                  | 32 B              |
| `AssetId`                     | `Poseidon(token_mint_pubkey)`                               | 32 B              |
| `Commitment`                  | `Poseidon(amount, asset_id, owner_pubkey, blinding)`        | 32 B              |
| `Nullifier`                   | `Poseidon(nk, commitment, leaf_index)`                      | 32 B              |
| `MerkleRoot`                  | Root of a depth-`TREE_DEPTH` Poseidon Merkle tree           | 32 B              |
| `Note`                        | `{amount: u64, asset_id, owner_pubkey, blinding}`           | off-chain only    |
| `SpendingKey`                 | Agent's authorization scalar                                | off-chain only    |
| `FullViewingKey`              | `{ak, nk}` — principal-held audit key                       | off-chain only    |
| `IncomingViewingKey`          | `ivk` — decrypts incoming-note ciphertext                   | off-chain only    |
| `Groth16Proof`                | `{a: [u8;64], b: [u8;128], c: [u8;64]}` BN254 affine, BE    | 256 B compressed: 32+64+32; uncompressed used off-chain |
| `PublicInputs`                | See §4.1 for canonical ordering                             | concatenated 32-B field elements |

**Constants (`said-shielded-pool-types`):**

```rust
pub const TREE_DEPTH:         usize = 26;
pub const ROOT_HISTORY_SIZE:  usize = 256;
pub const NULLIFIER_BYTES:    usize = 32;
pub const COMMITMENT_BYTES:   usize = 32;
pub const FIELD_BYTES:        usize = 32;
```

`TREE_DEPTH = 26` gives a per-tree capacity of `2^26 ≈ 67.1M` leaves. The pool
maintains a forest of such trees; once a tree fills (or rolls per the
forester's policy), a new one is opened and roots from prior trees remain
spendable via the root-history window (§10).

**Field element range invariant.** Every `FieldBytes` value that the program
treats as a Poseidon/BN254 scalar MUST be canonical: `0 ≤ x < p` where

```
p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

(the BN254 scalar field modulus). The Anchor program rejects public inputs
that fail this range check before invoking the verifier syscall; see §15 for
the non-canonicalness pitfall.

---

## 3. Key Hierarchy

The hierarchy mirrors Zcash Sapling, restricted to the components needed for
the agent/principal split. HD derivation paths are deferred (§16).

```
           seed  (256-bit master, principal-only)
             |
             |  HKDF-SHA512 with context="ghola/audit-v1/sk"
             v
            sk   (BN254 scalar)         <-- SpendingKey
             |
             +------------------+
             |                  |
   ak = G · sk                  nk = PRF^expand(sk; "nk")
   (G a fixed BN254 generator)  (BN254 scalar, derived from sk)
             |                  |
             +------ fvk -------+         <-- FullViewingKey { ak, nk }
                      |
                      v
            ivk = Poseidon(ak, nk)        <-- IncomingViewingKey (truncated to 251 bits)
```

### 3.1 Roles

- **`sk` (SpendingKey, agent-held).** Authorizes spends. Required as a private
  input to `transaction.circom`. If `sk` leaks, the agent's *future* outbound
  spends are forgeable by the holder of `sk`; the principal mitigates by
  rotating to a new `sk` and shielding remaining notes to that new key.

- **`ak` (public component of spend authority).** Equals `G · sk` for the
  fixed generator `G`. Used inside `keypair.circom` to bind `sk` to `ak`
  without revealing `sk`. `ak` appears in every commitment via
  `owner_pubkey = Poseidon(ak)` (see §7).

- **`nk` (NullifierKey, principal-held).** Derives all nullifiers (`§6`).
  Crucially, the principal — who never holds `sk` — can compute every
  nullifier the agent will emit, providing a complete ex-post audit of agent
  spending without spending capability.

- **`fvk = (ak, nk)` (FullViewingKey).** The principal's audit handle. Given
  `fvk` and the public transcript, the principal can detect every agent spend
  by matching observed on-chain nullifiers against locally-derived candidates.

- **`ivk` (IncomingViewingKey).** Decrypts incoming-note ciphertexts (which
  reveal `(amount, asset_id, blinding)` to the recipient). `ivk =
  Poseidon(ak, nk) mod 2^251` to land in the BN254 scalar field with margin.
  *Note: the ciphertext format itself is deferred to Phase 37; the FVK→IVK
  derivation is fixed here so circuits and key-storage agree.*

### 3.2 Why split spending from viewing?

A pure "the agent has a private key and that's the whole identity" design
fails the principal-audit goal: a compromised or rogue agent can spend and
the principal cannot even *observe* the loss, because nullifier derivation
would require the agent's secret. By separating `nk` (which we entrust to
the principal) from `sk` (which only the agent needs), we get:

- Compromise of the agent reveals `sk` → attacker can spend `sk`'s notes,
  but **cannot** see notes received by *any other* key held by the principal,
  and **cannot** forge `nk` to mask their tracks. The principal's `nk` lets
  them detect the attacker's spends in real time and front-run rotation.
- Compromise of the principal's `fvk` (e.g. backup leak) reveals all *history*
  to the attacker but does not grant spend authority.

This matches Zcash Sapling's auditability story; Orchard adds further
delegation we are not yet using. See [Hopwood et al., Zcash Protocol Spec
§4.2.2 (Sapling)] for prior art.

### 3.3 Out of scope (deferred)

- HD path derivation `(seed, path) → sk_path` (BIP-32-style). Phase 37 will
  pick either Sapling's ZIP-32 or a custom Poseidon-based ladder.
- Diversified addresses (multiple `pk_d` per `ivk`).
- Outgoing viewing key `ovk` for self-decryption of sent notes.

---

## 4. Circuits

Three Circom 2 circuits ship in `circuits/`, compiled with `circom 2.1.x` and
fixed at the `audit-v1` git tag. All wire indices in the compiled R1CS are
deterministic given a fixed circom version; the `audit-v1` tag pins the
compiler version in `.circomversion`.

### 4.1 `transaction.circom`

The main spend circuit. Implements a Tornado-Nova-style 2-in/2-out UTXO
join-split, extended with a public `asset_id` input for Penumbra-style
multi-asset value conservation.

**Template signature:**

```
template Transaction(nIns, nOuts, treeDepth)
```

The `audit-v1` instantiation is `Transaction(2, 2, 26)`.

**Public signals (canonical order — MUST match `PublicInputs` in the types
crate):**

```
signal input  root;                       // 1
signal input  inputNullifiers[nIns];      // nIns       (= 2)
signal input  outputCommitments[nOuts];   // nOuts      (= 2)
signal input  publicAmount;               // 1          (signed-as-field, see below)
signal input  assetId;                    // 1
signal input  extDataHash;                // 1
// total public input count for (2,2,26): 1 + 2 + 2 + 1 + 1 + 1 = 8
```

The Anchor program serializes `PublicInputs` in **exactly this order**, with
each entry as a 32-byte big-endian field element, before invoking
`groth16-solana`. Any deviation breaks the verifier.

`publicAmount` is encoded as a signed value `v ∈ [-(p-1)/2, (p-1)/2]` mapped
to the field: positive `v` are themselves; negative `v` are `p - |v|`. The
prover's allowed range is **further constrained** to `|v| < 2^64` inside the
circuit (range-check on `publicAmount` and `-publicAmount`) so that a single
i128 covers the protocol-level range with margin and overflow is impossible.

**Private (witness) inputs:**

```
signal input  inputAmounts[nIns];
signal input  inputBlindings[nIns];
signal input  inputPathIndices[nIns];     // bit-decomposition of leaf index
signal input  inputPathElements[nIns][treeDepth];
signal input  outputAmounts[nOuts];
signal input  outputBlindings[nOuts];
signal input  outputOwnerPubkeys[nOuts];
signal input  spendingKey;                // sk
// asset_id is public; inputs/outputs all share it (single-asset per tx)
```

**Constraints (informal — see circuit source for the canonical R1CS):**

1. **Keypair consistency.** Instantiate `Keypair()` (`§4.3`) to derive
   `ak = G · sk` and `ownerHash = Poseidon(ak)`. Every input note's owner
   field must equal `ownerHash` — i.e. only the holder of `sk` can spend
   notes assigned to its `ak`.

2. **Input note well-formedness.** For each `i ∈ [0, nIns)`:
   - `inputCommitment[i] = Poseidon(inputAmounts[i], assetId,
     ownerHash, inputBlindings[i])` (the canonical commitment of §7).

3. **Merkle membership.** For each non-zero input (`inputAmounts[i] != 0`),
   instantiate `MerkleProof(treeDepth)` (`§4.2`) and constrain the computed
   root to equal the public `root`. Zero-amount inputs are exempt to allow
   1-in transactions without requiring a dummy real leaf.

4. **Nullifier derivation.** For each input,
   `inputNullifiers[i] = Poseidon(nk, inputCommitment[i], leafIndex[i])`,
   where `nk` is derived inside the circuit from `sk` (see §6 for the
   `nk = PRF^expand(sk; "nk")` instance — implemented as a fixed-input
   Poseidon).

5. **Output commitment well-formedness.** For each `j ∈ [0, nOuts)`,
   `outputCommitments[j] = Poseidon(outputAmounts[j], assetId,
   outputOwnerPubkeys[j], outputBlindings[j])`.

6. **Range checks.**
   - Each `inputAmounts[i]`, `outputAmounts[j]`: `< 2^64` (`Num2Bits(64)`).
   - `publicAmount`: enforced via the signed-range trick described above.

7. **Per-asset value conservation.** With `Σin = Σ inputAmounts[i]` and
   `Σout = Σ outputAmounts[j]`, constrain
   `Σin + publicAmount == Σout`. Because all inputs and outputs share the
   single public `assetId`, this is a per-asset constraint by construction.
   Negative `publicAmount` (positive shield-in) accumulates; positive
   `publicAmount` (unshield-out) drains. See §11 for the multi-asset model
   spanning multiple transactions.

8. **Ext-data binding.** `extDataHash` enters the constraint system as a
   public input that is *not* used arithmetically; it is bound to the proof
   solely by being part of the proof's public-input vector. The on-chain
   program independently hashes the transaction's external data and rejects
   mismatches (§12).

**Output:** the Groth16 proof (`a, b, c`) plus the public-input vector
above, ready for `groth16-solana::verify`.

### 4.2 `merkleProof.circom`

Standard fixed-depth Poseidon Merkle inclusion proof.

**Template signature:**

```
template MerkleProof(treeDepth)
```

**Inputs:**

```
signal input  leaf;
signal input  pathElements[treeDepth];
signal input  pathIndices[treeDepth];     // each ∈ {0, 1}
signal output root;
```

**Constraints:**

1. For each level `k`:
   - `pathIndices[k]` constrained to `{0, 1}` via `pathIndices[k] *
     (pathIndices[k] - 1) === 0`.
   - `(left, right) = pathIndices[k] == 0 ? (cur, sibling) :
     (sibling, cur)`.
   - `next = Poseidon(left, right)` using the BN254 arity-2 Poseidon.
2. `root` ← final accumulator after `treeDepth` levels.

**Notes for auditors:**

- The Poseidon arity-2 instance MUST match `sol_poseidon`'s parameter set
  exactly (Light Protocol parameters, full=8, partial=57 rounds for arity 2).
  A mismatch would silently produce a different hash and the on-chain
  tree-update SNARK would still verify (it uses the same circuit-side
  Poseidon), but newly inserted leaves would be invisible to the agent's
  prover. Test vectors in §14 pin this.
- Empty subtrees use the precomputed constant ladder
  `Z[0] = Poseidon(0,0); Z[k] = Poseidon(Z[k-1], Z[k-1])` up to `Z[25]`.
  The Anchor program stores `Z[]` as a constant table; the circuit does not
  need to know about empty subtrees because the witness supplies an
  authentic sibling regardless.

### 4.3 `keypair.circom`

Binds spending key to commitment owner hash.

**Template signature:**

```
template Keypair()
```

**Inputs:**

```
signal input   spendingKey;
signal output  ownerHash;     // = Poseidon(ak)
```

The internal computation of `ak = G · sk` and `nk = PRF^expand(sk; "nk")`
is done with a Poseidon-based PRF over a fixed domain separator. Concretely:

```
ak       = Poseidon(spendingKey, DOMAIN_AK)
nk       = Poseidon(spendingKey, DOMAIN_NK)
ownerHash = Poseidon(ak)
```

where

```
DOMAIN_AK = Poseidon("ghola/audit-v1/ak")
DOMAIN_NK = Poseidon("ghola/audit-v1/nk")
```

(string-to-field via UTF-8 → BE bytes → reduce mod p; the constant values are
fixed in `circuits/constants.circom` and reproduced in test vectors §14.)

**Important departure from Sapling.** Sapling uses `ak = SpendAuthSig.G · sk`
over Jubjub. We have no native Jubjub on Solana, so we substitute a
Poseidon-PRF derivation. The security claim becomes: `ak` is
indistinguishable from random in the ROM for the BN254-Poseidon PRF, and
inverting `Poseidon(sk, DOMAIN_AK)` to recover `sk` is hard under the
Poseidon one-wayness assumption. This is weaker than the elliptic-curve
discrete-log assumption that Sapling uses, but it avoids a costly in-circuit
Jubjub scalar mult (which would dominate `transaction.circom`'s constraint
count). Auditors are asked to validate the PRF assumption framing
(see §15.2).

### 4.4 Constraint-count budget (target, not normative)

| Circuit        | Constraints (target) | Proving time on 4-core x86 |
| -------------- | -------------------- | -------------------------- |
| `Transaction(2,2,26)` | ~120k–160k    | ~3–6 s (rapidsnark)        |
| `MerkleProof(26)`     | ~5k           | n/a (subcircuit)           |
| `Keypair()`           | ~1k           | n/a (subcircuit)           |

These are budget targets; actual numbers will be reported in
`ceremony/audit-v1/circuit-stats.json` and are not load-bearing for
correctness.

---

## 5. Proof Statements

The Groth16 proof produced by `transaction.circom` is a non-interactive
zero-knowledge argument of the following statement.

**Statement (informal).** I (the prover) know

```
sk,
(amount_i, blinding_i, owner_i, path_i, leafIndex_i)  for i ∈ {0, 1},
(amount_j', blinding_j', owner_j')                    for j ∈ {0, 1}
```

such that, with `nk := Poseidon(sk, DOMAIN_NK)`,
`ak := Poseidon(sk, DOMAIN_AK)`, `ownerHash := Poseidon(ak)`, and
`cm_i := Poseidon(amount_i, assetId, owner_i, blinding_i)`:

1. For every `i` with `amount_i ≠ 0`: `owner_i = ownerHash` and `cm_i` is a
   leaf of the Merkle tree rooted at the public `root` at position
   `leafIndex_i`, witnessed by `path_i`.
2. For every `i`: the public `inputNullifiers[i]` equals
   `Poseidon(nk, cm_i, leafIndex_i)`.
3. For every `j`: the public `outputCommitments[j]` equals
   `Poseidon(amount_j', assetId, owner_j', blinding_j')`.
4. All `amount_i, amount_j' ∈ [0, 2^64)` and `publicAmount` ∈
   `(-2^64, 2^64)` (signed-field encoding).
5. `Σ amount_i + publicAmount = Σ amount_j'`.
6. `extDataHash` is consistent — by being a public input it is bound to the
   (proof, public-inputs) tuple; the on-chain program enforces the value.

**What this DOES NOT assert (and why that's fine):**

- It does NOT assert that the `inputNullifiers` have never been used before.
  That is the Anchor program's responsibility (§10).
- It does NOT assert that `root` is the *current* on-chain root. The program
  checks `root` against the 256-entry root history (§10).
- It does NOT assert anything about the recipient of an unshield. That is
  encoded in `extDataHash` and bound by §12.
- It does NOT assert single-spender identity across multiple transactions.
  The nullifier set provides single-use; cross-tx linking is intentionally
  prevented by re-blinded outputs.

---

## 6. Nullifier Derivation Rule

```
nullifier := Poseidon(nk, commitment, leafIndex)
```

This is enforced *inside* the `transaction` circuit and recomputed *outside*
the circuit by both the principal (using `nk` and the on-chain commitment +
the leaf index the prover used) and the on-chain program (it does no
recomputation, only set-membership checks).

**Why all three components are bound:**

| Component   | If we dropped it                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nk`        | The nullifier would be a public-function of public data (`commitment`, `leafIndex`), so the chain observer could pre-compute the nullifier set for every commitment in the tree and link spends trivially. Including `nk` makes the nullifier a pseudorandom function under the principal's secret.                                                                            |
| `commitment`| Two notes that happen to be assigned the same `leafIndex` (impossible in honest operation but constructible by a malicious tree updater) would collide nullifiers and enable double-spend. Including the commitment ensures each leaf has a unique nullifier even in pathological tree states.                                                                                  |
| `leafIndex` | A note re-inserted at a later index (e.g. due to a chain reorg or a tree-versioning bug) would produce the same nullifier as the original, allowing the protocol to mistakenly reject a fresh-but-distinct note. Including `leafIndex` makes the nullifier position-bound, so legitimate re-insertion at a new position produces a new nullifier and forces the spender to re-prove. |

This matches the Tornado Nova nullifier formula and is intentionally
identical so that prior-art analysis carries over.

**Concretely (Poseidon arity 3):**

```
nullifier_bytes = sol_poseidon([nk, commitment, leafIndex_padded_to_32B])
```

`leafIndex` is a `u64` packed into the bottom 8 bytes of a 32-byte BE field
element (matching the `amount` packing in §7).

---

## 7. Commitment Derivation Rule

```
commitment := Poseidon(amount, asset_id, owner_pubkey, blinding)
```

(Poseidon arity 4.) This matches `Note::commitment_inputs()` in the types
crate exactly. Encoding details:

| Field         | Type      | Encoding to FieldBytes                                                            |
| ------------- | --------- | --------------------------------------------------------------------------------- |
| `amount`      | `u64`     | BE-packed into the **bottom 8 bytes** of a 32-byte BE field element (top 24 zero) |
| `asset_id`    | `AssetId` | Already a `FieldBytes`; passed through                                            |
| `owner_pubkey`| `FieldBytes` | = `Poseidon(ak)`; principal's `ownerHash` for outputs they control            |
| `blinding`    | `FieldBytes` | Uniform 32-byte sample, reduced mod p off-chain                                |

**Blinding sampling.** Off-chain wallets MUST sample `blinding` as `r ∈
{0,1}^{256}` then reject-sample if `r ≥ p`. Failure to reject-sample creates
a biased distribution at the top of the field — small bias, but a real-world
side channel (an attacker who suspects a particular RNG's wrap behavior could
narrow the candidate space). The wallet reference implementation in
`crates/said-shielded-wallet/` (Phase 37) will use `reject-sample` and ship a
unit test covering the boundary.

**Why amount packing is BE.** Solana's `alt_bn128` syscalls and `sol_poseidon`
treat inputs as big-endian. Packing `u64` as BE into the low 8 bytes of a
32-byte BE word is unambiguous and matches the natural integer interpretation
in the circuit, which uses `Num2Bits(64)` on the `amount` signal.

**Domain separation.** We do *not* add an explicit "commitment" domain tag.
The 4-arity of Poseidon and the position-dependent constants suffice to
distinguish commitments from nullifiers (arity 3) and from owner hashes
(arity 1). Auditors should verify there is no arity-collision attack
(see §15.5).

---

## 8. Root Update Rule

The pool maintains a **forest** of depth-26 Merkle trees. Each tree has:

1. An on-chain `MerkleTreeAccount` storing the current root, the next-leaf
   index, and the most recent 256 historical roots.
2. An on-chain `InsertionQueueAccount` storing commitments awaiting batched
   insertion.
3. An off-chain `Forester` process that periodically pulls a batch from the
   queue, computes the post-insertion root *off-chain*, and submits a
   Groth16 proof attesting to correct insertion.

### 8.1 Batched insertion (steady-state)

A user's `transaction` proof produces `nOuts` output commitments and (in
steady state) appends them to the `InsertionQueueAccount` — NOT directly to
the tree. The queue is a simple FIFO of `(commitment, slot)` pairs.

Periodically (every `BATCH_SIZE` queue entries, currently `64`), the forester:

1. Reads the on-chain tree state: `(root_pre, nextIndex, frontier)` where
   `frontier` is the path of right-sibling nodes for the next-to-insert
   position (32 KiB per tree).
2. Reads the next `BATCH_SIZE` queued commitments.
3. Computes `root_post` by inserting all `BATCH_SIZE` leaves and updating
   `frontier`.
4. Generates a Groth16 proof using a separate `treeUpdate.circom` circuit
   (out of Phase 36 scope as a *spec deliverable* — its spec is in §8.4)
   that asserts: starting from `root_pre`, applying these `BATCH_SIZE`
   commitments in order yields `root_post`.
5. Submits `update_tree(root_pre, root_post, proof, batch)` to the Anchor
   program.

The program:

- Verifies `root_pre` matches its current root.
- Verifies the proof.
- Verifies the batch contents match the queue head.
- Sets `root = root_post`.
- Pushes the old `root_pre` into the 256-entry root history ring.
- Advances `nextIndex` by `BATCH_SIZE`.
- Pops `BATCH_SIZE` entries off the queue.

The forester is liveness-only: any single party can run one, and proofs are
publicly verifiable.

### 8.2 In-tx insertion path ("proof by index" pre-insertion)

When the queue is below a low-water mark (or for time-sensitive operations),
the program supports an alternate path: the Anchor instruction itself appends
the commitment to the queue *and immediately allows it to be cited by index
in a follow-up transaction within the same slot*. This requires the
follow-up proof to reference a special `pending` root that equals the
queue-extended tree root — this root is computed deterministically from the
on-chain queue contents at instruction-handler time.

**Important:** the pending-root path is **OUT OF SCOPE for `audit-v1`**.
The spec mentions it for completeness because the types crate's
`MerklePath` is sized to support it, but the `audit-v1` Anchor program
will reject any proof whose `root` is not in the 256-entry committed-root
history. Pending-root acceptance will be a separate audit pass.

### 8.3 Root history window

The program maintains `ROOT_HISTORY_SIZE = 256` historical roots in a ring
buffer per tree. A proof's public `root` is accepted iff it appears in the
current root or any of the 256 prior roots of *the tree being referenced*.
This gives a finite-but-generous window for client-side proof construction:
even at maximum batch throughput (one batch per slot, 64 leaves per batch),
256 roots ≈ 102 seconds at 400ms slots, which is comfortably longer than
typical client proof-generation latency (~6s).

A proof referencing a root older than 256 batches back is rejected and the
client must re-prove against a current root. The note itself is not lost —
the client simply re-runs the prover with a fresh Merkle path.

### 8.4 `treeUpdate.circom` (spec sketch — not audited in Phase 36)

```
template TreeUpdate(treeDepth, batchSize)
```

Public inputs: `rootPre, rootPost, batchCommitmentsHash`.
Private inputs: `frontier[treeDepth], commitments[batchSize],
nextIndex_bits[treeDepth]`.

Constraints: starting from `(rootPre, frontier, nextIndex_bits)`, applying
`commitments` in order using the standard incremental-Merkle right-frontier
update yields `(rootPost, frontier', (nextIndex+batchSize)_bits)`, and
`batchCommitmentsHash = Poseidon(commitments)`.

This circuit is implemented but its formal audit is **Phase 38**. For Phase
36, auditors should sanity-check that the *interaction* between
`transaction.circom`'s acceptance of root-history members and
`treeUpdate.circom`'s production of those members is sound under the
assumption that `treeUpdate.circom` is itself sound (i.e. there is no
cross-circuit attack distinct from a bug inside `treeUpdate`).

---

## 9. Verifier-Key Commitment Scheme

The Groth16 verifying key (`vk`) for each circuit instance is large
(~400 bytes for `transaction(2,2,26)` after compression). Storing the full
`vk` on-chain at fixed cost is wasteful and exposes it to corruption via
buggy upgrade paths. We adopt a hash-and-pin scheme.

### 9.1 PoolConfig commitment

At pool init time the `PoolConfig` PDA stores:

```rust
pub struct PoolConfig {
    pub admin_multisig: Pubkey,           // governance authority
    pub vk_hash_transaction: [u8; 32],    // SHA-256 of canonically-serialized vk
    pub vk_hash_tree_update: [u8; 32],
    pub ceremony_transcript_hash: [u8; 32], // SHA-256 of ceremony manifest
    pub audit_tag: [u8; 16],              // ASCII "audit-v1"
    pub frozen_at_slot: u64,              // slot of init, immutable
    // ...
}
```

The full `vk` bytes are NOT stored on-chain. They are stored:

- In the verifier crate as a compile-time constant (Light Protocol's
  groth16-solana takes `vk` as a `&'static` parameter).
- In `ceremony/audit-v1/vk-{circuit}.bin` (public artifact, content-addressed
  by the committed hash).

On every verifier call, the program asserts
`sha256(vk_bytes) == PoolConfig.vk_hash_*`. Because the vk bytes are baked
into the program binary, this is an in-program integrity check, not an
external lookup — the failure mode it catches is "someone deployed a build
with the wrong embedded vk."

### 9.2 VK rotation

Changing `vk_hash_*` requires:

1. A new Phase-2 MPC ceremony for the affected circuit (§13).
2. The ceremony transcript hash is published.
3. A governance proposal signed by `admin_multisig` calls `rotate_vk` with
   `(new_vk_hash, new_ceremony_transcript_hash, audit_report_uri)`.
4. The new program binary embedding the new `vk` is deployed via Solana
   upgrade authority (also held by `admin_multisig`).

A rotation invalidates all in-flight proofs against the old `vk`. Wallets
fetch the active `audit_tag` and `vk_hash_*` and refuse to construct proofs
against a deprecated circuit version.

### 9.3 Ceremony provenance recording

`ceremony_transcript_hash` is the SHA-256 of a JSON manifest with shape:

```json
{
  "audit_tag": "audit-v1",
  "circuit": "transaction(2,2,26)",
  "phase1_artifact": {
    "name": "Hermez Powers of Tau 2^28",
    "sha256": "...",
    "url": "https://..."
  },
  "phase2_contributions": [
    { "contributor": "Alice Foo (alice@example.com)",
      "timestamp": "2026-05-...",
      "contribution_hash": "...",
      "attestation_signature": "..." },
    ...
  ],
  "final_zkey_sha256": "...",
  "final_vk_sha256": "..."
}
```

Anyone can independently verify the chain of contributions by running
`snarkjs zkey verify` from `phase1_artifact` through each contribution to
`final_zkey_sha256`, and then recomputing `vk` from the final zkey and
hashing it.

---

## 10. Anchor History & Replay Protection

### 10.1 Per-tree root history

```rust
pub struct MerkleTreeAccount {
    pub tree_index: u32,
    pub current_root: MerkleRoot,
    pub next_leaf_index: u64,
    pub root_history: [MerkleRoot; ROOT_HISTORY_SIZE],  // ring buffer
    pub root_history_head: u8,                          // wrap-around
    // ... frontier kept in a sibling account due to size
}
```

`ROOT_HISTORY_SIZE = 256`. The program accepts a `transaction` proof iff
its public `root` equals `current_root` or any entry in `root_history`.

When `root` is updated via §8 the prior `current_root` is written to
`root_history[root_history_head]` and `root_history_head` is incremented
modulo 256. The very first entry overwrites the all-zero initial slot.

### 10.2 Nullifier set

Nullifiers are stored in a separate program-owned account family, sharded
by the leading byte of the nullifier (256 shards). Each shard is a
sorted-set vector or a Light-Protocol-style indexed Merkle tree (TBD —
the storage layout is a Phase 37 decision and not audit-load-bearing here,
because the *semantic* guarantee is what matters: insertion-or-fail with
no false negatives).

**Replay rule (audit-load-bearing):**

For every `n ∈ inputNullifiers`:

```
if nullifier_set.contains(n) { reject }
nullifier_set.insert(n)
```

This is atomic with proof acceptance: either all of the proof's nullifiers
are newly inserted and the proof's outputs are queued, or the transaction
aborts and nothing changes. Solana's account-locking model gives us this
atomicity for free at the slot level.

### 10.3 Why a 256-root window is safe

A proof `(π, public_inputs)` against an old root `r_k` proves only that *at
the time of `r_k`*, the input notes were leaves of the tree. The nullifier
set is *global* across all roots; a note spent at root `r_k` produces the
same nullifier as if it were spent at root `r_{k+50}`, because the nullifier
binds `(nk, commitment, leafIndex)` and none of these change as the root
evolves. So accepting historical roots cannot cause double-spend; it only
allows clients more wall-clock leeway.

---

## 11. Asset Model

### 11.1 Single-pool, multi-asset

A single deployment of the program supports an arbitrary number of asset
types. Each asset is identified by

```
asset_id = Poseidon(token_mint_pubkey)
```

(arity 1). The `token_mint_pubkey` is the SPL Token mint of the
shielded-equivalent on the public side. Native SOL is represented by the
sentinel mint `So11111111111111111111111111111111111111112` (wSOL).

### 11.2 Per-asset value conservation

The `transaction` circuit takes a single public `assetId` and constrains
all input/output amounts to that asset (§4.1, constraint 7). To transfer
across assets, a user must perform a separate transaction for each asset,
each producing its own proof. This is the Penumbra design choice — it
trades a small efficiency loss (more proofs for multi-asset operations)
for circuit-design simplicity and a sharper public-input contract (one
amount sum, not a vector).

### 11.3 Boundary tracking

The program maintains a `(asset_id → public_balance)` map. On shield-in,
`public_amount < 0` (note convention: a negative public delta means tokens
*entered* the shielded pool); the program transfers
`|public_amount|` tokens of `assetId` from a public SPL account into a
program-controlled vault and increments `public_balance[assetId]`. On
unshield-out, the reverse.

This is the only place asset semantics intersect Solana's public token
ledger. Inside the pool, asset routing is purely cryptographic.

### 11.4 Why not encode asset_id as a private input?

We considered making `asset_id` private and using a per-asset commitment
binding to prevent observers from seeing which asset moved. Two reasons we
chose public:

1. Anonymity-set fragmentation: if asset is hidden, each transaction's
   anonymity set is *all* transactions, but a side channel (the
   public-token-account credit) immediately reveals it anyway. Hiding it
   in the circuit is mostly theater.
2. Cost: hiding asset would require a per-tx range-check that
   `Σ_{inputs of asset A} amount = Σ_{outputs of asset A} amount` *for all
   A simultaneously*, blowing up the constraint count.

Auditors who disagree with this tradeoff should flag it — but be aware that
the public-token-account boundary leak makes private-asset cosmetic.

---

## 12. Ext-Data Binding

The `transaction` proof binds to the transaction's external data — the
recipient of any unshield, the fee paid to the relayer, and a free-form
memo — via the public `ext_data_hash` input.

### 12.1 `ExtData` structure

```rust
pub struct ExtData {
    pub recipient: Pubkey,        // for unshields; zero-pubkey for internal-only
    pub relayer: Pubkey,
    pub fee: u64,
    pub encrypted_outputs: Vec<u8>,   // per-output ciphertext (Phase 37 format)
    pub memo: Vec<u8>,                // application data, length-prefixed
}

ext_data_hash = Poseidon(
    domain_tag_ext,
    Poseidon(recipient_field, relayer_field, fee_field),
    Poseidon(blake3(encrypted_outputs).into_field()),
    Poseidon(blake3(memo).into_field())
)
```

The blake3 inner hashes compress variable-length byte slices into the
field; their outputs are reduced mod p (with rejection on overflow).
`domain_tag_ext = Poseidon("ghola/audit-v1/extdata")`.

### 12.2 Verification flow

```
1. Client computes ext_data_hash off-chain and includes it as a public input.
2. Client submits (proof, public_inputs, ExtData) to the relayer.
3. Relayer forwards to the Anchor program.
4. Program:
     a. Re-derives ext_data_hash from the provided ExtData fields.
     b. Asserts equality with public_inputs.ext_data_hash.
     c. Verifies the Groth16 proof.
     d. If verified: applies effects (transfer recipient, pay fee, queue commits).
```

A malicious relayer trying to redirect funds to a different `recipient` would
change `ext_data_hash`, which is bound to the proof; the program would reject.

### 12.3 Why we do not bind via signature

A common alternative is to sign the ExtData with the spending key (Sapling's
"binding signature"). We considered this and rejected it for two reasons:

1. Solana has no built-in Jubjub/Ed25519-redjubjub verifier; we would need a
   custom syscall or in-program verifier (~80k CUs).
2. Binding via Groth16 public input is *strictly stronger*: a binding
   signature can be re-signed by any holder of the spending key, but a
   Groth16 proof bound to `ext_data_hash` is non-malleable to the prover.

The cost: clients cannot decide ext-data after proof generation, which is
fine — the relayer is the same party that constructed the proof in our
deployment model.

---

## 13. Trusted Setup Ceremony

### 13.1 Phase 1 (universal Powers of Tau)

We reuse the **Hermez Powers of Tau 2^28** ceremony (`pot28_final.ptau`).
This is the largest publicly available, multi-contribution Phase-1 transcript
suitable for BN254 Groth16 circuits and is used by Polygon Hermez, Tornado
Nova, and many others. Its security relies on the assumption that at least
one of the ~70 named Hermez contributors was honest and erased their toxic
waste.

`phase1_artifact.sha256` is published in `ceremony/audit-v1/manifest.json`
and pinned to the byte-exact upstream Hermez release. Auditors should
verify this hash matches the upstream-published value.

### 13.2 Phase 2 (per-circuit MPC)

For each circuit (`transaction`, `merkleProof` if exported separately,
`keypair` if exported separately, `treeUpdate`), we run a per-circuit
Phase-2 MPC via `snarkjs zkey contribute`. Procedure:

1. `snarkjs groth16 setup transaction.r1cs pot28_final.ptau transaction_0000.zkey`
   produces the initial zkey.
2. Each contributor `i` runs
   `snarkjs zkey contribute transaction_{i-1:04}.zkey transaction_{i:04}.zkey \
     --name="<contributor name>" --entropy="<256+ bits>"`
3. The contribution emits a transcript line `(prev_hash, new_hash, contribution_hash)`
   signed by the contributor's Ethereum/Solana key.
4. After all `n ≥ 10` contributions, the chair runs
   `snarkjs zkey beacon final.zkey beacon.zkey 0x<beacon_value> 10 --name="final beacon"`
   using a public verifiable beacon (next-Bitcoin-block hash + slot, fixed
   in advance and published before the beacon is observable).
5. `snarkjs zkey verify` runs from `pot28_final.ptau` through every
   intermediate zkey to the final beacon-applied zkey. The whole transcript
   is published.

### 13.3 Contributor list

≥ 10 contributors total, with at least 3 from outside the Ghola team. Each
contributor publishes:

- Their identity (real name OR a long-standing pseudonymous identity tied to
  a public PGP key).
- The hardware they ran the contribution on (model + OS).
- A signed attestation that they destroyed the entropy source after
  contributing.

Contributors include (provisional list, finalized at ceremony start):

1. Ghola core team — 3 contributors.
2. Light Protocol engineering — 1 contributor.
3. External cryptographers — ≥ 3 (recruited via Zcash Foundation / a16z
   crypto / direct outreach).
4. Trusted-setup specialists (P0n2, ceremony-mc.xyz operators) — ≥ 2.
5. Random selection from a public application form — ≥ 1.

### 13.4 Artifact publication

`ceremony/audit-v1/` (a git-tracked directory in this repo) contains:

```
manifest.json                          # transcript hashes + contributor list
pot28_final.ptau.sha256                # pinned Hermez Phase-1
transaction_0000.zkey ... transaction_NNNN.zkey  # all Phase-2 intermediates
transaction_final.zkey                 # post-beacon
transaction.vk.json                    # exported vk
transaction.vk.sha256                  # SHA-256 of canonically-serialized vk
contributions/<NNNN>-<name>.attestation # per-contributor signed attestation
verify.sh                              # reproduces snarkjs zkey verify chain
```

A CI job in `.github/workflows/ceremony-verify.yml` runs `verify.sh` weekly
and on every PR that touches `ceremony/`.

### 13.5 Key burn ritual at sunset

When `audit-v1` is deprecated (e.g. circuit changes for `audit-v2`):

1. The `audit-v1` `vk_hash_*` is *not deleted* from `PoolConfig` history —
   it remains in a `superseded_vk_hashes` list for archival.
2. The program rejects new proofs against the old vk.
3. The full proving keys (zkey files) remain published — they were never
   secret (a Groth16 proving key reveals nothing the verifier doesn't
   already let an attacker compute). The "key burn" terminology is
   ceremonial; what is actually burned is *trust* in the old vk, which
   happens automatically by setting the program to reject it.

---

## 14. Test Vector Format

Test vectors are JSON files in `crates/said-shielded-pool-types/testdata/`.
Each file is one of three kinds: `keypair`, `commitment`/`nullifier`
(hash test vectors), or `transaction` (full end-to-end).

### 14.1 Top-level schema

```json
{
  "vector_kind": "transaction",
  "audit_tag": "audit-v1",
  "circuit_instance": "Transaction(2,2,26)",
  "description": "Two-input, two-output, single asset, internal-only",
  "witness": { ... },
  "expected_public_inputs": { ... },
  "expected_proof": { ... },
  "expected_program_effects": { ... }
}
```

### 14.2 `witness` schema (mirrors `TransferWitness` in the types crate)

```json
"witness": {
  "input_notes": [
    { "amount": "1000000",
      "asset_id": "0xab...",       // 32 BE bytes hex
      "owner_pubkey": "0x...",
      "blinding": "0x..." },
    ...
  ],
  "input_paths": [
    { "siblings":   ["0x...", ...],  // length = 26
      "path_bits":  [false, true, ...] // length = 26
    },
    ...
  ],
  "input_indices": ["0", "1"],
  "output_notes": [ { ... }, { ... } ],
  "spending_key": "0x...",
  "public_amount": "0",                 // signed decimal string (i128)
  "asset_id": "0x...",
  "ext_data_hash": "0x..."
}
```

### 14.3 `expected_public_inputs` schema

```json
"expected_public_inputs": {
  "ordered_field_elements_hex": [
    "0x<root>",
    "0x<input_nullifier_0>",
    "0x<input_nullifier_1>",
    "0x<output_commitment_0>",
    "0x<output_commitment_1>",
    "0x<public_amount_field_encoded>",
    "0x<asset_id>",
    "0x<ext_data_hash>"
  ],
  "ordered_field_elements_count": 8
}
```

The `ordered_field_elements_hex` array IS the verifier's public-input vector
verbatim. If any test-vector consumer (program, prover, client) produces a
different ordering or encoding, it has a bug.

### 14.4 `expected_proof` schema

```json
"expected_proof": {
  "a": "0x<64 bytes uncompressed G1>",
  "b": "0x<128 bytes uncompressed G2>",
  "c": "0x<64 bytes uncompressed G1>",
  "a_compressed": "0x<32 bytes>",
  "b_compressed": "0x<64 bytes>",
  "c_compressed": "0x<32 bytes>"
}
```

Because Groth16 proofs are randomized, fully-deterministic proof bytes
require pinning the prover's randomness. We do so via a deterministic
`r, s` derivation: `r = blake3("ghola/audit-v1/r" || witness_hash)` and
`s = blake3("ghola/audit-v1/s" || witness_hash)`, both reduced mod r_BN254.
This is **only for test vectors** — production wallets MUST sample `r, s`
from a secure CSPRNG, never deterministically.

### 14.5 `expected_program_effects` schema

```json
"expected_program_effects": {
  "nullifiers_inserted": ["0x...", "0x..."],
  "commitments_queued":  ["0x...", "0x..."],
  "public_balance_delta": { "<asset_id_hex>": "0" },
  "tree_root_unchanged_until_forester": true
}
```

This captures the post-instruction state of the program for replay-test
purposes.

### 14.6 Minimum coverage

The `audit-v1` test-vector set MUST include, at a minimum:

1. **Hash vectors:** ≥ 8 vectors covering Poseidon arity 1, 2, 3, 4, 5
   (one per arity the protocol uses), comparing against `circomlibjs`
   reference outputs.
2. **Keypair vectors:** ≥ 4, including the all-zero spending key (a
   deliberate edge case) and a random key.
3. **Merkle proof vectors:** ≥ 4, including (a) leaf at index 0,
   (b) leaf at index `2^26 - 1` (last position), (c) leaf at index 1
   (testing the path-bit branch), (d) intentionally-wrong sibling
   (negative test).
4. **Transaction vectors:** ≥ 6, including
   - Two-input two-output internal-only transfer.
   - One-input one-output (using zero-amount dummy second input).
   - Shield-in: `public_amount < 0`, no input notes.
   - Unshield-out: `public_amount > 0`, output of zero-value dummy + real.
   - Wrong ext-data-hash (negative test, must not verify).
   - Reused nullifier (negative test, proof verifies but program rejects).

Each vector is independently regenerated by a `cargo test
--features test-vectors` run in `crates/said-shielded-pool-types/` and
must match the committed file byte-for-byte.

---

## 15. Auditor Notes — Known Pitfalls

This section is a deliberately concrete list of the classes of bug we
expect auditors to probe. If a finding is in scope of this list it is
*expected*; findings outside this list are doubly valuable.

### 15.1 Endianness

- All Poseidon inputs and outputs are 32-byte big-endian field elements.
- The Anchor program parses public inputs as `&[u8; 32]` slices and feeds
  them to `groth16-solana` in declaration order without further conversion.
- The off-chain prover (Rust + `ark-bn254`) uses LE internally and converts
  to BE at the syscall boundary. The conversion lives in exactly one place
  (`said-shielded-pool-types::FieldBytes` codec). Auditors should verify
  that no other code path does a redundant byte-swap.
- The `u64` `amount` and `u64` `leaf_index` pack into the **bottom 8 bytes**
  of a 32-byte BE word with the upper 24 zero. A LE-pack would shift the
  value by 192 bits and produce wildly different commitments / nullifiers.

### 15.2 Poseidon as PRF for `ak`, `nk`

§4.3 derives `ak = Poseidon(sk, DOMAIN_AK)` instead of `ak = G · sk`. This
substitutes a one-wayness assumption on Poseidon for the discrete-log
assumption on a curve. The known-plaintext attack surface is small (the
domain tag is public, but `sk` is uniform 256-bit and Poseidon-BN254 is
believed PRF-secure with the Light Protocol parameter set), but it is
weaker than EC-DLog. Auditors are asked to either
(a) bless this substitution explicitly, or
(b) suggest a constraint-cheap alternative (e.g. RedJubjub via custom
syscall — likely Phase 38).

### 15.3 A-negation (Groth16 malleability)

Groth16 has a well-known malleability: given a valid proof `(A, B, C)`, the
tuple `(-A, B, C + neg_alpha_g1)` is also a valid proof for the same
public inputs. `groth16-solana` does NOT canonicalize against this, so
duplicate proofs verifying the same statement are detectable by the
adversary. Our protocol does not rely on proof uniqueness (the nullifier
set absorbs replay), so this malleability is **not exploitable**, but
auditors should confirm the analysis.

### 15.4 Public-input field-range check

Every public input is verified to be `< p` (BN254 scalar field modulus)
before invoking `alt_bn128_pairing`. The syscall does not check this and
will produce wrong results on non-canonical inputs (technically: it will
interpret `x mod p`, allowing two distinct on-chain encodings to verify the
same proof — a replay-equivalence we explicitly disallow). The range check
lives in `programs/said-shielded-pool/src/groth16.rs::verify_public_inputs`.

### 15.5 Arity collision in Poseidon

We use Poseidon at arities 1, 2, 3, 4, and 5 across the protocol. Each
arity has *different* round constants, so cross-arity collisions are
infeasible under the Poseidon-BN254 security assumption. Auditors should
nonetheless flag any path where a value computed at one arity could be
re-interpreted as input to another arity in a way that lets an adversary
forge a commitment/nullifier/owner-hash.

### 15.6 Position binding

The nullifier includes `leafIndex` (§6). Be alert to: (a) a prover supplying
a Merkle path for index `i` but a nullifier computed at index `j`, with
`i != j`. The circuit binds these via the keypair-and-membership constraints
(the `pathIndices` bit decomposition fed into `MerkleProof` is the same
bit-decomposition fed into the nullifier-derivation Poseidon as the
`leafIndex` input). Confirm there is no path through the circuit where
these two inputs diverge.

### 15.7 Empty input handling

`transaction(2,2,26)` allows zero-amount input notes (to support 1-input
transactions). The circuit skips Merkle membership for zero-amount inputs.
A subtle bug class: a malicious prover supplies a *nonzero* amount
alongside a fake Merkle path that happens to satisfy the constraints
because the membership check was elided. Verify the elision is guarded by
`amount == 0`, not by `path == zero`.

### 15.8 Blinding bias

§7 warns about non-rejecting sampling of `blinding`. The bias is small
(probability of wrap ≈ `2^256 - p` over `2^256` ≈ 2^-128 of the time the
top 4 bits matter) but for distinguishability proofs it matters. Confirm
the reference wallet rejects.

### 15.9 Ext-data hash domain confusion

`ext_data_hash` is computed from blake3-into-field of variable-length
fields. If a blake3 output happens to be `≥ p`, naive reduction creates
two preimages for one field element. The codec rejects on overflow and
re-hashes with a salt counter; confirm the loop terminates with
overwhelming probability and that the salt counter does not itself become
an oracle.

### 15.10 Verifier vs prover Poseidon parameter mismatch

The most dangerous silent failure: the off-chain prover's Poseidon
parameters drift from the on-chain `sol_poseidon` parameters. The §14 test
vectors pin the bytewise output of every Poseidon invocation against the
on-chain syscall on a Solana localnet, and CI runs this check on every PR
touching circuits, the prover crate, or the types crate.

---

## 16. Out of Scope for Phase 36

The following are explicitly deferred. Auditors should flag if any of
these intersect a Phase-36 deliverable in a way that breaks the
"audit-now, design-later" boundary.

| Item                                              | Defer to                         |
| ------------------------------------------------- | -------------------------------- |
| HD derivation paths (BIP-32 / ZIP-32 analog)      | Phase 37                         |
| Diversified `pk_d` per `ivk`                      | Phase 37                         |
| Outgoing viewing key (`ovk`)                      | Phase 37                         |
| Viewing-key memo encryption format                | Phase 37 (Sapling-style ChaCha20-Poly1305 over ECDH-on-Jubjub-substitute) |
| Pending-root in-tx insertion path                 | Phase 38 audit                   |
| `treeUpdate.circom` formal audit                  | Phase 38 audit                   |
| Compliance screening hooks (sanctioned-address gating, regulator viewing keys) | Phase 39 — governance/policy decision, no protocol changes assumed |
| Cross-asset proofs in a single circuit            | Indefinitely; explicitly not planned |
| Post-quantum migration                            | Indefinitely; tracked as protocol research item |
| Multi-sig spending keys (threshold `sk`)          | Phase 40+, requires circuit changes |
| Account abstraction / sponsored proofs            | Out of crypto scope (Solana platform work) |

---

## Appendix A — Prior Art References

- **Tornado Nova** — the 2-in/2-out UTXO + nullifier set design. `transaction.circom` is structurally a Nova circuit with `assetId` added and `keypair` swapped to Poseidon-PRF. Source: https://github.com/tornadocash/tornado-nova
- **Penumbra** — multi-asset value conservation with `asset_id` as a circuit-visible parameter. See Penumbra Protocol Specification §5 ("Note"). https://protocol.penumbra.zone
- **Zcash Sapling (Hopwood et al.)** — `fvk = (ak, nk)` hierarchy and the audit-without-spend property. ZIP-32 / ZIP-216. https://zips.z.cash
- **Zcash Orchard** — current Zcash production circuit, Pasta-curves + Halo2; reference for ivk derivation and `pk_d` diversification (the latter deferred to Phase 37).
- **Light Protocol** — Solana-native shielded pool; source of the `groth16-solana` verifier, the `sol_poseidon` parameter set, and the batched-insertion forester pattern. https://github.com/Lightprotocol/light-protocol
- **Iden3 / circom-pairing / circomlibjs** — Poseidon-BN254 reference and Groth16 toolchain.

## Appendix B — Constants

```
p (BN254 scalar field modulus):
  21888242871839275222246405745257275088548364400416034343698204186575808495617

q (BN254 base field modulus, used in pairing):
  21888242871839275222246405745257275088696311157297823662689037894645226208583

Poseidon-BN254 (Light Protocol / circomlibjs match):
  - full rounds = 8
  - partial rounds = 56 for arity 2; 57 for arity 3; 56 for arity 4; 60 for arity 5
  - alpha = 5 (x^5 S-box)
  - MDS / round constants: per Grassi et al., Poseidon paper §5.1

DOMAIN_AK   = Poseidon( field-encoding-of("ghola/audit-v1/ak") )
DOMAIN_NK   = Poseidon( field-encoding-of("ghola/audit-v1/nk") )
DOMAIN_EXT  = Poseidon( field-encoding-of("ghola/audit-v1/extdata") )
```

Concrete values for the three `DOMAIN_*` constants are committed in
`circuits/constants.circom` and `crates/said-shielded-pool-types/src/constants.rs`
(to be added in the Phase-37 wiring PR; for Phase 36 the auditor receives
them as part of the test vectors §14).

---

**End of `audit-v1` specification.**
