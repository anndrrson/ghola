# said-shielded-pool-circuits

Circom 2 circuits for the Ghola SAID Solana-native zk-shielded pool
(anonymous-agents track, Phase 37).

Structural baseline: [Tornado Nova](https://github.com/tornadocash/tornado-nova).
Deltas vs. Nova:

- `asset_id` carried inside the note tuple; all input + output notes in a
  single proof must share one `asset_id`.
- Nullifier is bound to `leaf_index` (Penumbra-style) to avoid
  identical-content collisions.
- `ext_data_hash` is a public binding signal (not recomputed in-circuit) that
  prevents proof malleability against off-circuit fields (recipient, relayer
  fee, memo).
- Poseidon-BN254 only — the same hash is recomputable on Solana via
  `sol_poseidon` so on-chain verification can re-derive note commitments and
  Merkle roots when needed.

## Files

| File | Purpose |
| --- | --- |
| `transaction.circom`  | Main 2-in / 2-out transfer circuit (depth-26). |
| `auctionClearing.circom` | Shielded batch-auction clearing proof for 64-order epochs. |
| `merkleProof.circom`  | Depth-26 Poseidon Merkle inclusion proof. |
| `keypair.circom`      | `ak = Poseidon(sk)` + Penumbra-style nullifier. |
| `commitment.circom`   | `cm = Poseidon4(amount, asset_id, owner_pubkey, blinding)`. |

## Public signals (locked order)

Must match `said-shielded-pool-types::PublicInputs` and `SPEC.md`:

```
[ root,
  input_nullifier_0,
  input_nullifier_1,
  output_commitment_0,
  output_commitment_1,
  public_amount,
  asset_id,
  ext_data_hash ]
```

## Auction clearing public signals

`auctionClearing.circom` intentionally uses eight public inputs so it can share
the Anchor verifier wrapper shape:

```text
[ auction_order_root,
  clearing_price_commitment,
  matched_root,
  rolled_root,
  matched_count,
  rolled_count,
  settlement_commitment,
  clearing_commitment ]
```

The v1 policy proves a deterministic partition: active orders are exactly
matched or rolled, matched buy/sell counts are equal, matched prices cross the
uniform clearing price, and rolled prices do not. Bumping the batch size or
policy requires a new circuit, ceremony, and compiled verifier key.

## Prerequisites

- Node.js **20+**
- circom **2.1.5+** — install from <https://github.com/iden3/circom>
- snarkjs **0.7+** — `npm i -g snarkjs` (or use the local devDependency)

## Install dependencies

```bash
npm install
```

This pulls `circomlib` into `node_modules/`. The circuits import from
`node_modules/circomlib/circuits/...`.

## Compile

```bash
npm run compile
```

For the auction circuit:

```bash
npm run compile:auction
```

Outputs into `../artifacts/`:

- `transaction.r1cs`
- `transaction.sym`
- `transaction_js/transaction.wasm`
- `transaction_js/generate_witness.js`

## Trusted setup (Groth16, Phase 2)

The pool uses Hermez's universal Powers-of-Tau (BN254) ceremony for Phase 1.
Download a `.ptau` file sized for the circuit (≥ 2^16 constraints — confirm
the actual constraint count after `circom` reports it, and bump to 2^17
if needed):

```bash
curl -L \
  https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_16.ptau \
  -o ../artifacts/pot16_final.ptau
```

Phase 2 (circuit-specific):

```bash
# initial zkey
snarkjs groth16 setup \
  ../artifacts/transaction.r1cs \
  ../artifacts/pot16_final.ptau \
  ../artifacts/circuit_0000.zkey

# contributor 1
snarkjs zkey contribute \
  ../artifacts/circuit_0000.zkey \
  ../artifacts/circuit_0001.zkey \
  --name="Ghola contributor 1" -v

# additional contributors (repeat — each call produces the next zkey)
snarkjs zkey contribute \
  ../artifacts/circuit_0001.zkey \
  ../artifacts/circuit_0002.zkey \
  --name="Ghola contributor 2" -v

# beacon + final
snarkjs zkey beacon \
  ../artifacts/circuit_0002.zkey \
  ../artifacts/circuit_final.zkey \
  0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20 10 \
  -n="Final Beacon phase2"

# export verifying key
snarkjs zkey export verificationkey \
  ../artifacts/circuit_final.zkey \
  ../artifacts/verification_key.json
```

> **Production note**: SPEC.md §13 requires a real multi-party ceremony.
> The single-contributor sequence above is for development only. Coordinate
> the production ceremony per the SAID governance doc.

## Witness generation

Inputs go in `input.json` (private + public, named to match the signals in
`transaction.circom`).

```bash
node ../artifacts/transaction_js/generate_witness.js \
  ../artifacts/transaction_js/transaction.wasm \
  input.json \
  ../artifacts/witness.wtns
```

## Proof generation

```bash
snarkjs groth16 prove \
  ../artifacts/circuit_final.zkey \
  ../artifacts/witness.wtns \
  ../artifacts/proof.json \
  ../artifacts/public.json
```

## Verify (off-chain sanity check)

```bash
snarkjs groth16 verify \
  ../artifacts/verification_key.json \
  ../artifacts/public.json \
  ../artifacts/proof.json
```

On Solana, the same verifying key is loaded into the shielded-pool program
and Groth16 verification runs via `solana-bn254` / `alt_bn128_*` syscalls.
The 8-element `public.json` ordering above must match the on-chain
`PublicInputs` struct exactly.
