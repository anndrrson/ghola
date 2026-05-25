# said-shielded-pool-testvectors

Deterministic, reproducible test vectors for the Ghola shielded pool
(Groth16 / BN254 over Solana). These vectors are the **source of truth**
shared between:

* the Circom circuits (`crates/said-shielded-pool-circuits/`),
* the on-chain program (`programs/said-shielded-pool/`),
* the prover service (`crates/said-shielded-pool-prover/`),
* the client SDK (`crates/said-shielded-pool-client/`),
* the indexer (`crates/said-shielded-pool-indexer/`), and
* third-party auditors.

The exact same JSON file should round-trip through every implementation:
the witness drives the prover, the public inputs drive on-chain
verification, and the commitment / nullifier expectations drive the
indexer and program state checks.

## Regenerating

From the workspace root:

```bash
cargo run -p said-shielded-pool-testvectors --bin gen-vectors
```

Outputs are written to `crates/said-shielded-pool-testvectors/vectors/`.

The generator is **deterministic**. The RNG (`StdRng::seed_from_u64`) is
seeded with `0xDEADBEEF` (exported as
`said_shielded_pool_testvectors::VECTOR_SEED`), and each scenario uses a
constant per-scenario offset of that seed. Re-running the generator
produces byte-for-byte identical JSON files; CI can therefore commit
generated vectors and diff against new runs to detect accidental
schema changes.

> If a future change intentionally rotates the vectors, bump
> `schema_version` in `index.json` (currently `1`) and document the
> reason in this README's changelog.

## File layout

```
vectors/
├── index.json
├── deposit_only.json
├── transfer_2in_2out_same_asset.json
├── transfer_1in_2out_split.json
├── transfer_2in_1out_merge.json
├── withdraw_full.json
├── partial_withdraw_with_change_note.json
├── invalid_value_conservation.json
├── invalid_asset_mismatch.json
├── double_spend_same_nullifier__first.json
├── double_spend_same_nullifier__replay.json
├── root_not_in_history.json
├── amount_overflow.json
└── ext_data_binding_mismatch.json
```

`index.json` lists every vector with its `should_prove` /
`should_verify` flags so test harnesses can enumerate without globbing.

## Encoding rules

* All 32-byte field elements (commitments, nullifiers, roots,
  `asset_id`, `owner_pubkey`, `blinding`, Merkle siblings,
  `ext_data_hash`, `spending_key`) are encoded as **lowercase hex strings,
  no `0x` prefix**, exactly 64 characters long.
* `public_amount` is encoded as a JSON **string** containing a signed
  decimal integer (it is `i128` on the wire, may be negative for
  withdrawals, and JSON numbers are not safe to round-trip through every
  language's parser).
* `amount` (per-note) is a JSON number — a `u64` — and is packed into a
  32-byte field element big-endian, right-aligned, when fed into Poseidon
  (see "Hash rules" below).
* `path_bits` is a JSON array of booleans of length 26.
* `siblings` is a JSON array of 26 hex strings.
* `proof` is `null` in every vector. The Groth16 proof bytes are filled
  in by the prover service at consumption time; this crate intentionally
  does not depend on a prover so the vectors stay portable and auditable
  without snark machinery.

## Hash rules

The shielded pool uses Poseidon-BN254 (Circom-compatible). See
`docs/shielded-pool/SPEC.md` for the canonical specification; this crate
reproduces those rules in `src/poseidon.rs`:

| Use | Definition |
| --- | --- |
| `asset_id` | `Poseidon1(mint_bytes)` where `mint_bytes` is the 32-byte SPL mint pubkey |
| `commitment(note)` | `Poseidon4(amount_be32, asset_id, owner_pubkey, blinding)` where `amount_be32` is `u64` packed big-endian, right-aligned into 32 bytes |
| `nullifier(nk, commitment, leaf_index)` | `Poseidon3(nk, commitment, leaf_index_be32)` where `leaf_index_be32` is `u64` packed big-endian, right-aligned into 32 bytes |
| Merkle hash | `Poseidon2(left, right)` |

Empty-subtree precomputation: `zero[0] = [0u8; 32]`,
`zero[i+1] = Poseidon2(zero[i], zero[i])`. Tree depth is **26**.

## Vector schema (per file)

```jsonc
{
  "name": "transfer_2in_2out_same_asset",
  "description": "...",
  "should_prove": true,
  "should_verify": true,
  "notes": null,                // optional, free-form

  "witness": {
    "input_notes":    [ { "amount": 500, "asset_id": "...", "owner_pubkey": "...", "blinding": "..." }, ... ],
    "input_paths":    [ { "siblings": ["..."; 26], "path_bits": [false, ...; 26] }, ... ],
    "input_indices":  [0, 1],
    "output_notes":   [ ... ],
    "spending_key":   "...",
    "public_amount":  "0",     // signed decimal as string
    "asset_id":       "...",
    "ext_data_hash":  "..."
  },

  "expected_public_inputs": {
    "root":               "...",
    "input_nullifiers":   ["...", "..."],
    "output_commitments": ["...", "..."],
    "public_amount":      "0",
    "asset_id":           "...",
    "ext_data_hash":      "..."
  },

  "expected_commitment_chain": ["...", "..."],  // ordered, inserted into tree
  "expected_nullifiers":       ["...", "..."],  // ordered, marked spent

  "proof": null
}
```

## Consuming the vectors

### Rust (auditor or in-tree test)

```rust
use std::fs;
use serde_json::Value;

fn main() {
    let raw = fs::read_to_string("vectors/transfer_2in_2out_same_asset.json").unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();

    let root_hex = v["expected_public_inputs"]["root"].as_str().unwrap();
    let root: [u8; 32] = hex::decode(root_hex).unwrap().try_into().unwrap();

    // Feed `witness` to your prover, compare its public outputs against
    // `expected_public_inputs`. Feed `expected_public_inputs` + the
    // produced proof to the on-chain program; check the resulting
    // commitment / nullifier state matches `expected_commitment_chain`
    // and `expected_nullifiers`.
    let _ = root;
}
```

### JavaScript / TypeScript (client SDK or web auditor)

```ts
import { readFileSync } from "node:fs";

const vec = JSON.parse(
  readFileSync("vectors/transfer_2in_2out_same_asset.json", "utf8")
);

const rootBytes = Buffer.from(vec.expected_public_inputs.root, "hex");
if (rootBytes.length !== 32) throw new Error("bad root length");

// `public_amount` is a signed decimal string, parse as BigInt:
const pa = BigInt(vec.expected_public_inputs.public_amount);

console.log(
  vec.name,
  "should_prove =",
  vec.should_prove,
  "should_verify =",
  vec.should_verify,
  "public_amount =",
  pa.toString(),
);
```

## Scenario inventory

| Vector | `should_prove` | `should_verify` | Failure mode tested |
| --- | :-: | :-: | --- |
| `deposit_only` | yes | yes | (positive) |
| `transfer_2in_2out_same_asset` | yes | yes | (positive) |
| `transfer_1in_2out_split` | yes | yes | (positive) |
| `transfer_2in_1out_merge` | yes | yes | (positive) |
| `withdraw_full` | yes | yes | (positive) |
| `partial_withdraw_with_change_note` | yes | yes | (positive) |
| `invalid_value_conservation` | no | no | circuit constraint: sum-in + public ≠ sum-out |
| `invalid_asset_mismatch` | no | no | circuit constraint: per-asset uniformity |
| `double_spend_same_nullifier__first` | yes | yes | (step 1 of 2) |
| `double_spend_same_nullifier__replay` | yes | **no** | on-chain: nullifier already exists |
| `root_not_in_history` | yes | no | on-chain: root outside 256-deep history window |
| `amount_overflow` | no | no | circuit range check (sum > 2⁶⁴-1) |
| `ext_data_binding_mismatch` | yes | no | on-chain: program-recomputed ext_data_hash differs |

## Why no Groth16 proofs?

This crate intentionally has no SNARK dependency. The `proof` field is
`null` in every vector; consumers either (a) re-run the real prover to
produce one, or (b) test the program with a known-good or known-bad
proof from a separate fixture (e.g. for `should_verify = false` cases,
the cheapest test is to mutate one byte of a valid proof). Decoupling
"vector content" from "proof bytes" keeps auditors able to inspect every
input and expected output without first standing up a trusted-setup
ceremony or proving key.

## License

MIT OR Apache-2.0 — same as the rest of the Ghola workspace.
