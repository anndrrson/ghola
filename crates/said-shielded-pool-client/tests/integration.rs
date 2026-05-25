//! Integration tests for the shielded-pool client SDK.
//!
//! Every test in this file is `#[ignore]`-d for now: they require the
//! prover service to be running on `PROVER_URL` and (for the on-chain
//! flow) a localnet `solana-test-validator` with the `said-shielded-pool`
//! program deployed at the canonical program ID.
//!
//! Run a single test:
//!
//! ```bash
//! PROVER_URL=http://localhost:8081 \
//!   cargo test -p said-shielded-pool-client --test integration -- \
//!     --ignored deposit_transfer_withdraw_happy_path
//! ```

use said_shielded_pool_client::{
    program_id,
    tx_builder::{self, ExtData, PoolAccounts},
    NoteBuilder, ProverClient, ShieldedKeypair, WitnessBuilder,
};

fn prover_url() -> String {
    std::env::var("PROVER_URL").unwrap_or_else(|_| "http://localhost:8081".to_string())
}

#[tokio::test]
#[ignore = "requires running prover service"]
async fn prover_health_ok() {
    let p = ProverClient::new(prover_url());
    p.health().await.expect("prover should be healthy");
}

#[tokio::test]
#[ignore = "requires running prover service"]
async fn deposit_proof_roundtrip() {
    let kp = ShieldedKeypair::from_seed(&[1u8; 32]);
    let mint = [9u8; 32];

    let out = NoteBuilder::new()
        .amount(1_000)
        .asset_id_from_mint(&mint)
        .owner_from_keypair(&kp)
        .build();

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
        .public_amount(-1_000)
        .asset_id(out.asset_id)
        .ext_data_hash(ext_hash)
        .add_output(out)
        .try_build()
        .unwrap();

    let prover = ProverClient::new(prover_url());
    let _bundle = prover.prove(&witness).await.expect("prover prove");
    // Once on-chain wiring lands, also build_deposit_ix(&program_id(), ..., &_bundle)
    // and submit via the relayer.
}

#[tokio::test]
#[ignore = "requires prover + on-chain program"]
async fn deposit_transfer_withdraw_happy_path() {
    // Sketch of the full flow once we have everything wired:
    //
    // 1. ALICE.deposit(100) → out0
    // 2. ALICE.transfer(out0) → bob_note (owned by BOB.ak)
    // 3. BOB.scan(chain) → bob_note discovered
    // 4. BOB.withdraw(bob_note, 100) → BOB's user_ata receives 100 tokens
    //
    // Each step:
    //   - NoteBuilder + WitnessBuilder → TransferWitness
    //   - ProverClient::prove → ProofBundle
    //   - tx_builder::build_{deposit,transfer,withdraw}_ix → RawInstruction
    //   - Submit via said-shielded-pool-relayer (or directly via Solana RPC)
    //
    // After step 4 we read the on-chain SPL balance to confirm.
    let _alice = ShieldedKeypair::from_seed(&[1u8; 32]);
    let _bob = ShieldedKeypair::from_seed(&[2u8; 32]);
    let _pid = program_id();
    let _ = PoolAccounts {
        payer: [0u8; 32],
        pool_config: [0u8; 32],
        merkle_tree: [0u8; 32],
        mint: [0u8; 32],
        escrow_ata: [0u8; 32],
        user_ata: [0u8; 32],
        token_program: [0u8; 32],
        system_program: [0u8; 32],
        nullifiers: vec![],
    };
    // TODO: end-to-end once prover + program land.
}
