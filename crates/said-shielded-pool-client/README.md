# said-shielded-pool-client

Client SDK for the Ghola Solana-native shielded pool.

Used by the CLI, daemon, and downstream SDK consumers to construct
shielded notes, talk to the off-chain prover service, and assemble the
Solana instructions that drive the on-chain `said-shielded-pool`
program.

## At a glance

| Module            | Purpose                                                              |
|-------------------|----------------------------------------------------------------------|
| `keypair`         | `ShieldedKeypair`, `FullViewingKey`, `IncomingViewingKey`            |
| `note`            | `NoteBuilder` — random blinding, owner derived from `ak`             |
| `witness`         | `WitnessBuilder` — assemble a `TransferWitness` for the prover       |
| `prover_client`   | `ProverClient` — async HTTP client for `POST /prove`                 |
| `tx_builder`      | `build_deposit_ix` / `build_transfer_ix` / `build_withdraw_ix`       |
| `encryption`      | Note-memo seal/open (ChaCha20-Poly1305 + HKDF). **To-be-audited.**   |
| `scan`            | `Scanner::scan` — discover incoming notes via IVK. Stubbed.          |

## Example

```rust,no_run
use said_shielded_pool_client::{
    NoteBuilder, ProverClient, ShieldedKeypair, WitnessBuilder,
    tx_builder::{self, DepositAccounts, ExtData, PoolAccounts},
    program_id,
};
use said_shielded_pool_types::AssetId;

# async fn run() -> Result<(), Box<dyn std::error::Error>> {
// 1. Derive your shielded keys (e.g. from a Turnkey-signed seed).
let kp = ShieldedKeypair::from_seed(&[0u8; 32]);
let fvk = kp.fvk();
let ivk = kp.ivk();

// 2. ---- DEPOSIT ----
//    Build an output note for yourself, then ask the prover to prove
//    that the new commitment is well-formed with `public_amount = -100`.
let mint = [9u8; 32];
let out = NoteBuilder::new()
    .amount(100)
    .asset_id_from_mint(&mint)
    .owner_from_keypair(&kp)
    .build();

let asset_id = out.asset_id;
let ext = ExtData {
    recipient: [0u8; 32],
    mint,
    fee: 0,
    relayer_fee: 0,
    memo_commitments: vec![],
};
let ext_hash = tx_builder::compute_ext_data_hash(&ext);

let witness = WitnessBuilder::new()
    .spending_key(kp.sk)
    .public_amount(-100)
    .asset_id(asset_id)
    .ext_data_hash(ext_hash)
    .add_output(out.clone())
    .try_build()?;

let prover = ProverClient::new("https://prover.ghola.xyz");
let bundle = prover.prove(&witness).await?;

let deposit_accts = DepositAccounts {
    depositor: [0u8; 32], pool_config: [0u8; 32], mint,
    merkle_tree: [0u8; 32], depositor_token_account: [0u8; 32],
    escrow_ata: [0u8; 32], commitment_record: [0u8; 32],
    token_program: [0u8; 32], system_program: [0u8; 32],
};
// Deposit is NOT proof-gated: pass the output note's commitment (the
// poseidon hash of `out.commitment_inputs()`) directly; no proof bundle.
let commitment = [7u8; 32]; // placeholder for poseidon(out.commitment_inputs())
let _deposit_ix = tx_builder::build_deposit_ix(&program_id(), &deposit_accts, 100, commitment)?;

// 3. ---- TRANSFER ----  (consume `out`, produce a note owned by `recipient_ak`)
//    Same shape as above, plus `add_input(out, path, leaf_index)` and
//    `public_amount(0)`.

// 4. ---- WITHDRAW ----  (consume an owned note, public_amount = +amount)
# let _ = (fvk, ivk);
# Ok(()) }
```

## Crypto status

Poseidon hashing (`asset_id`, commitment, nullifier, viewing-key
derivation) uses Circom-compatible Poseidon-BN254 via `light-poseidon`,
mirroring the on-chain `sol_poseidon` syscall and the
`said-shielded-pool-testvectors` crate byte-for-byte. The canonical
wrappers live in [`src/poseidon.rs`](src/poseidon.rs).

`ext_data_hash` is `keccak256(borsh(ExtData))` — a binding-only public
signal. The Circom circuit does not recompute it from the witness; it
only constrains the proof to commit to whatever public value is given.
The on-chain program recomputes the keccak from the tx payload and
rejects on mismatch.

## Security caveats

- `ShieldedKeypair::sk` is zeroized on drop. `Debug` redacts it.
- `TransferWitness` payloads include the spending key — only send them
  over TLS to the prover, and treat the prover as
  trusted-for-confidentiality (Phase 42 puts it in a TEE).
- `encryption` module is explicitly **TO-BE-AUDITED**.

## Status

Phase 38 (client SDK skeleton).  Integration tests are `#[ignore]`-d
pending the prover service implementation + on-chain program build.
