# said-shielded-pool-prover

Off-chain Groth16 prover service for the Ghola Solana-native shielded
pool. Phase 37 deliverable.

The service takes a `TransferWitness` over HTTP, drives a Groth16
prover backend (snarkjs / rapidsnark / gnark), and returns a
`ProofBundle` already encoded for `groth16-solana` (big-endian field
elements, G1 `A` point negated).

## Run

```bash
PROVER_PORT=8787 \
ARTIFACTS_DIR=$PWD/crates/said-shielded-pool-circuits/build \
BACKEND=snarkjs \
    cargo run -p said-shielded-pool-prover
```

## Environment

| Var             | Default                     | Description                                     |
| --------------- | --------------------------- | ----------------------------------------------- |
| `PROVER_PORT`   | `8787`                      | TCP port for the axum server.                   |
| `ARTIFACTS_DIR` | `./artifacts`               | Directory holding the compiled circuit assets.  |
| `BACKEND`       | `snarkjs`                   | One of `snarkjs`, `rapidsnark`, `gnark` (stub). |

## Artifacts directory layout

```
$ARTIFACTS_DIR/
├── circuit_final.zkey      # final proving key from Powers-of-Tau ceremony
├── verification_key.json   # paired vk, served at GET /vk
└── transaction.wasm        # witness calculator (circom output)
```

These are produced by `crates/said-shielded-pool-circuits` and NOT
committed to the repo (they're tens of MB).

## HTTP API

| Route       | Method | Body                       | Response                |
| ----------- | ------ | -------------------------- | ----------------------- |
| `/healthz`  | GET    | —                          | `{ok, backend, ...}`    |
| `/vk`       | GET    | —                          | raw verification key JSON |
| `/prove`    | POST   | `TransferWitness` JSON     | `ProofBundle` JSON      |
| `/verify`   | POST   | `ProofBundle` JSON         | `{ok: bool}`            |

## Backends

- **snarkjs** (default): reference path. Spawns the `snarkjs` CLI for
  witness calc + proving. ~2–4s per shielded transfer. Easiest to debug.
- **rapidsnark**: native C++ prover. ~200ms per transfer. Uses snarkjs
  for the witness step (will be cut over to direct `witness_calculator`
  invocation later). Recommended for production.
- **gnark**: stub. Returns `BackendNotImplemented` on every call. See
  `src/backend/gnark.rs` for the TODO list.

## On-chain encoding (the part that matters)

Solana's `alt_bn128` syscalls — and therefore `groth16-solana` — expect:

1. Each field element BIG-ENDIAN over 32 bytes. snarkjs emits decimal
   strings; we parse them and pad to 32 BE bytes. See
   `src/encoding.rs::field_str_to_be_bytes_32`.
2. The G1 `A` point NEGATED. The on-chain verifier calls a single
   `alt_bn128_pairing` and needs the `e(-A, B)` form. snarkjs does NOT
   negate; we do. See `src/encoding.rs::negate_g1_a`.

The public-input order — `[root, in_nf_0, in_nf_1, out_cm_0, out_cm_1,
public_amount, asset_id, ext_data_hash]` — is baked into the circuit
and asserted in `src/backend/snarkjs.rs`.

## Security model — READ THIS

The prover service receives full `TransferWitness` payloads. A witness
contains the user's `spending_key`. The service:

- **Does not persist** any witness, proof, or key to disk (workdir is
  a per-request scratch directory, removed on success).
- **Does not hold** any long-lived keys of its own.
- **Has the ability** to exfiltrate any witness it receives — the
  service is part of the user's trust boundary for confidentiality.

In production this service runs inside a TEE (Intel TDX or AMD SEV-SNP)
with remote attestation, gated behind `said-attest` (Phase 42). For
dev/testing it runs as an ordinary process — only point clients at a
prover you control.

DO NOT publicly expose `POST /prove` until the TEE wrapping lands.
