//! Forester — background task that rolls batched insertions on the
//! on-chain insertion-queue PDA into a single new Merkle root.
//!
//! # Lifecycle
//!
//! 1. Every `FORESTER_POLL_SECS`, fetch the on-chain `insertion_queue`
//!    account for the active tree id.
//! 2. If `queue.len() >= FORESTER_QUEUE_THRESHOLD`, snapshot the queue's
//!    commitments and the local tree's `(root, next_index, filled_subtrees)`.
//! 3. Build a [`BatchedUpdateWitness`](witness::BatchedUpdateWitness) by
//!    simulating the inserts (see [`witness::build_witness`]).
//! 4. POST the witness to the prover service; receive a Groth16
//!    `ProofBundle`.
//! 5. Submit an `update_root_via_proof` instruction to the on-chain
//!    program, signing with the configured forester keypair.
//! 6. The on-chain program verifies the SNARK, applies the new root,
//!    drains the queue, and emits a `RootUpdated` event.
//! 7. The indexer's [`EventListener`](crate::listener::EventListener)
//!    picks up the event and the local tree is brought back into sync
//!    with the chain (technically the local tree is already at the same
//!    state because we built the witness by simulating the same inserts;
//!    the listener path provides a safety re-check).
//!
//! # Permissioning (v1)
//!
//! The on-chain program currently restricts `update_root_via_proof` to a
//! single configured `forester_authority` pubkey (= the program admin's
//! keypair). The architecture below cleanly accepts multiple foresters in
//! the future:
//!
//! - The keypair is loaded from `FORESTER_KEYPAIR_PATH` as a JSON byte
//!   array (the standard `solana-keygen` file format).
//! - The on-chain program's `forester_authority` will be replaced with a
//!   PDA-gated authority set in Phase 41, after which any operator who
//!   stakes the forester deposit can submit batched updates.
//! - Until then, attempting to run a forester role with the wrong keypair
//!   will produce a `ConstraintViolated(SignerNotForester)` error from
//!   the program; the forester logs and continues running (the indexer
//!   half is unaffected).

pub mod witness;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use said_shielded_pool_types::{
    BatchedUpdateWitness, Commitment, FieldBytes, ForesterProofBundle, ForesterPublicInputs,
    Groth16Proof, MerkleRoot, FORESTER_BATCH_SIZE, TREE_DEPTH,
};

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::tree::IncrementalMerkleTree;

/// Forester background task.
pub struct Forester {
    state: AppState,
    keypair_path: PathBuf,
    threshold: u32,
    poll: Duration,
    /// Loaded forester signing keypair. Consumed by `submit_root_update_tx`
    /// once the tx-builder lands; held here so the file is validated at
    /// startup rather than deferred until the first batched update.
    #[allow(dead_code)]
    keypair: ForesterKeypair,
    http: reqwest::Client,
}

impl Forester {
    /// Construct a Forester from the shared [`AppState`]. Requires that
    /// `cfg.forester_keypair_path` is `Some(...)` — call sites must check
    /// `cfg.forester_enabled()` first.
    pub fn new(state: AppState) -> Result<Self> {
        let keypair_path = state
            .cfg
            .forester_keypair_path
            .clone()
            .ok_or_else(|| Error::ConfigInvalid("FORESTER_KEYPAIR_PATH not set".into()))?;
        let keypair = ForesterKeypair::from_file(&keypair_path)?;
        let threshold = state.cfg.forester_queue_threshold;
        let poll = Duration::from_secs(state.cfg.forester_poll_secs.max(1));
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("reqwest client");
        Ok(Self {
            state,
            keypair_path,
            threshold,
            poll,
            keypair,
            http,
        })
    }

    /// Run forever. Intended to be spawned on a dedicated tokio task.
    pub async fn run(self: Arc<Self>) {
        // SAFE: `keypair` here is the FILE PATH of the forester signing
        // key on disk (operator-supplied, e.g. `/etc/ghola/forester.json`),
        // not the key material. Stream 7 audit 2026-05-23: confirmed
        // file path only; key bytes never reach this format string.
        info!(
            keypair = %self.keypair_path.display(),
            threshold = self.threshold,
            poll = ?self.poll,
            "forester started"
        );
        loop {
            if let Err(e) = self.tick().await {
                warn!("forester tick failed: {e:?}");
            }
            tokio::time::sleep(self.poll).await;
        }
    }

    async fn tick(&self) -> Result<()> {
        let queue = self.fetch_queue().await?;
        // The forester circuit's batch size is fixed. We only attempt a
        // round when we have at least FORESTER_BATCH_SIZE pending
        // commitments AND we're at-or-above the configured threshold.
        // Smaller "tail" batches will land when a later tick crosses the
        // boundary.
        let usable_len = queue
            .commitments
            .len()
            .min((queue.commitments.len() / FORESTER_BATCH_SIZE) * FORESTER_BATCH_SIZE);
        if usable_len < self.threshold as usize || usable_len < FORESTER_BATCH_SIZE {
            debug!(
                queue_len = queue.commitments.len(),
                threshold = self.threshold,
                batch_size = FORESTER_BATCH_SIZE,
                "queue below threshold or not yet aligned to batch boundary"
            );
            return Ok(());
        }
        let batch: Vec<Commitment> = queue.commitments[..FORESTER_BATCH_SIZE].to_vec();
        info!(
            queue_len = queue.commitments.len(),
            batch_size = FORESTER_BATCH_SIZE,
            "queue reached threshold — generating batched-update SNARK"
        );

        let (snapshot, witness) = self.build_witness(&batch).await?;
        let proof = self.request_proof(&witness).await?;

        // Submit the on-chain ix. The actual tx-builder requires solana-sdk
        // (not in our dep tree) — the call below is the cleanly-bounded
        // TODO surface where the integration agent will wire it up.
        self.submit_root_update_tx(&snapshot, &batch, &proof).await?;
        Ok(())
    }

    /// Pull the on-chain insertion-queue account for the active tree id
    /// and parse its commitments out of the borsh layout.
    async fn fetch_queue(&self) -> Result<InsertionQueueSnapshot> {
        // The on-chain queue account's address is a PDA derived from
        // (program_id, b"queue", tree_id). Tree-id selection lives in
        // a follow-up; for now we always read the tree-0 queue.
        let queue_pubkey = derive_queue_pda_b58(&self.state.cfg.pool_program_id, 0);
        let data = match self.state.rpc.get_account_data(&queue_pubkey).await? {
            Some(d) => d,
            None => {
                return Ok(InsertionQueueSnapshot {
                    tree_id: 0,
                    commitments: vec![],
                });
            }
        };
        parse_insertion_queue(&data)
    }

    /// Snapshot the local tree and run [`witness::build_witness`].
    async fn build_witness(
        &self,
        commitments: &[Commitment],
    ) -> Result<(TreeSnapshot, BatchedUpdateWitness)> {
        let snapshot = {
            let tree = self.state.tree.read().await;
            TreeSnapshot {
                root: tree.root().0,
                next_index: tree.next_index(),
                // The IncrementalMerkleTree caches its filled_subtrees
                // internally; we re-derive them here from a path query
                // since the field is private to the tree module.
                //
                // For the depth-26 production tree this is ~26 sled reads.
                filled_subtrees: read_filled_subtrees(&tree)?,
            }
        };
        let w = witness::build_witness(
            snapshot.root,
            snapshot.next_index,
            snapshot.filled_subtrees,
            commitments,
        )?;
        Ok((snapshot, w))
    }

    /// POST `BatchedUpdateWitness` to the prover service. The endpoint
    /// is `${PROVER_URL}/prove/batched-update` and returns a
    /// [`ForesterProofBundleWire`] JSON body, which we decode into a
    /// [`ForesterProofBundle`] for downstream tx construction.
    async fn request_proof(
        &self,
        witness: &BatchedUpdateWitness,
    ) -> Result<ForesterProofBundle> {
        let url = format!(
            "{}/prove/batched-update",
            self.state.cfg.prover_url.trim_end_matches('/')
        );
        let resp = self
            .http
            .post(&url)
            .json(witness)
            .send()
            .await
            .map_err(|e| Error::Prover(format!("prove POST: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| Error::Prover(format!("prove body read: {e}")))?;
        if !status.is_success() {
            return Err(Error::Prover(format!("{status}: {text}")));
        }
        let wire: ForesterProofBundleWire = serde_json::from_str(&text)
            .map_err(|e| Error::Prover(format!("prove decode: {e}; body={text}")))?;
        wire.into_bundle()
            .map_err(|e| Error::Prover(format!("forester bundle decode: {e}")))
    }
}

/// Hex-encoded wire shape returned by the prover at
/// `${PROVER_URL}/prove/batched-update`. Mirrors
/// `said_shielded_pool_prover::wire::ForesterProofBundleWire` (duplicated
/// here to avoid a heavy cross-crate dep).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForesterProofBundleWire {
    pub a: String,
    pub b: String,
    pub c: String,
    pub old_root: String,
    pub new_root: String,
    pub start_index: u64,
    pub commitments: Vec<String>,
}

impl ForesterProofBundleWire {
    fn into_bundle(self) -> Result<ForesterProofBundle> {
        let a = hex_to_n::<64>(&self.a)?;
        let b = hex_to_n::<128>(&self.b)?;
        let c = hex_to_n::<64>(&self.c)?;
        Ok(ForesterProofBundle {
            proof: Groth16Proof { a, b, c },
            public_inputs: ForesterPublicInputs {
                old_root: MerkleRoot(hex_to_n::<32>(&self.old_root)?),
                new_root: MerkleRoot(hex_to_n::<32>(&self.new_root)?),
                start_index: self.start_index,
                commitments: self
                    .commitments
                    .iter()
                    .map(|s| hex_to_n::<32>(s).map(Commitment))
                    .collect::<Result<Vec<_>>>()?,
            },
        })
    }
}

fn hex_to_n<const N: usize>(s: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(s).map_err(|e| Error::Prover(format!("hex: {e}")))?;
    if bytes.len() != N {
        return Err(Error::Prover(format!(
            "expected {N} bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

impl Forester {

    /// Build and submit the `update_root_via_proof` transaction.
    ///
    /// Constructs the canonical Anchor-serialized `UpdateRootArgs` payload
    /// (matching the on-chain `programs/said-shielded-pool/src/instructions/
    /// update_root.rs` definition) and logs the encoded bytes alongside the
    /// proof/public-input summary. The actual JSON-RPC `sendTransaction`
    /// call requires a Solana SDK (not in our dep tree) — flagged TODO for
    /// the integration agent.
    async fn submit_root_update_tx(
        &self,
        snapshot: &TreeSnapshot,
        commitments: &[Commitment],
        proof: &ForesterProofBundle,
    ) -> Result<()> {
        if commitments.len() != FORESTER_BATCH_SIZE {
            return Err(Error::Forester(format!(
                "forester batch size mismatch: got {} commitments, expected {FORESTER_BATCH_SIZE}",
                commitments.len()
            )));
        }
        let args_data = encode_update_root_args(snapshot, commitments, proof)?;
        // Prepend the 8-byte Anchor instruction discriminator —
        //   sha256("global:update_root_via_proof")[..8].
        let mut ix_data = anchor_method_discriminator("global:update_root_via_proof").to_vec();
        ix_data.extend_from_slice(&args_data);

        // SAFE: `old_root` / `new_root` are Merkle-tree roots —
        // PUBLIC structural state (every node in the network sees them
        // on-chain); not on the deny-list. `start_index`, `batch_size`,
        // `ix_data_len` are aggregate counters. Stream 7 audit 2026-05-23.
        info!(
            old_root = %hex::encode(snapshot.root),
            new_root = %hex::encode(proof.public_inputs.new_root.0),
            start_index = proof.public_inputs.start_index,
            batch_size = commitments.len(),
            ix_data_len = ix_data.len(),
            "forester: update_root_via_proof ix encoded; building tx"
        );

        // Load + decode the forester keypair (Ed25519 seed, the standard
        // `solana-keygen` 64-byte JSON file). Mirrors the relayer pattern in
        // `crates/said-shielded-pool-relayer/src/submit.rs`.
        let signing_key = self.keypair.signing_key()?;
        let forester_pubkey = signing_key.verifying_key().to_bytes();

        // Resolve the program id and the four PDAs we need to pass in.
        let program_id_b58 = self.state.cfg.pool_program_id.clone();
        let program_id = decode_pubkey_b58(&program_id_b58)?;
        let pool_config = derive_pool_config_pda(&program_id);
        let verifier_key = derive_verifier_key_pda(&program_id, &pool_config);
        let mint = decode_pubkey_b58(&self.state.cfg.pool_mint)?;
        let merkle_tree = derive_merkle_tree_pda(&program_id, &pool_config, &mint);

        let ix = RawInstruction {
            program_id,
            accounts: vec![
                AccountMeta { pubkey: forester_pubkey, is_signer: true, is_writable: true },
                AccountMeta { pubkey: pool_config, is_signer: false, is_writable: false },
                AccountMeta { pubkey: verifier_key, is_signer: false, is_writable: false },
                AccountMeta { pubkey: mint, is_signer: false, is_writable: false },
                AccountMeta { pubkey: merkle_tree, is_signer: false, is_writable: true },
            ],
            data: ix_data,
        };

        let blockhash = self.state.rpc.get_latest_blockhash().await?;
        let msg = build_message(&[ix], &forester_pubkey, &blockhash);
        let tx_bytes = sign_and_serialize(&msg, &signing_key);
        let tx_b64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(&tx_bytes)
        };

        let signature = self.state.rpc.send_transaction_base64(&tx_b64, false).await?;
        // Stream 7 audit 2026-05-23: `signature` is on the deny-list
        // (linkable to the on-chain root-update tx, which is itself
        // public — but operators don't need it at INFO to correlate;
        // queue depth + new_root above already give that). Demote to
        // DEBUG and emit a scrubbed prefix so an operator running
        // `RUST_LOG=debug` for a focused investigation still has a
        // disambiguator without writing the full b58 sig to disk.
        debug!(
            signature = %common_log::scrub_str(&signature),
            "forester: update_root_via_proof tx submitted; polling for confirmation"
        );

        // Poll up to 60 s for confirmation. Pattern mirrored from
        // `crates/said-shielded-pool-relayer/src/submit.rs::RpcSubmitter::confirm`.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            match self.state.rpc.get_signature_status(&signature).await? {
                Some((_conf, Some(err))) => {
                    return Err(Error::Forester(format!(
                        "update_root_via_proof tx failed on chain: {err}"
                    )));
                }
                Some((conf, None)) if conf == "confirmed" || conf == "finalized" => {
                    // Stream 7 audit 2026-05-23: `signature` demoted to
                    // DEBUG + scrubbed (deny-list); `commitment` here is
                    // the literal string "confirmed" or "finalized" —
                    // NOT a commitment hash. Rename the field at INFO so
                    // future readers (and the redaction layer) aren't
                    // confused by the overloaded term.
                    debug!(
                        signature = %common_log::scrub_str(&signature),
                        "forester: tx confirmed (debug-only sig prefix)"
                    );
                    info!(
                        confirmation_status = %conf,
                        "forester: root rotated on chain"
                    );
                    return Ok(());
                }
                _ => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(Error::Forester(format!(
                    "update_root_via_proof tx {signature} not confirmed within 60s"
                )));
            }
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        }
    }
}

// --------------------------------------------------------------
// Solana wire format + Anchor helpers.
//
// Deliberately inline (no `solana-sdk`/`solana-client` dep — see the rationale
// in `crates/said-shielded-pool-relayer/src/submit.rs`). The encoder below is
// the same pattern used by the relayer's `RpcSubmitter` and the receipts
// service, just specialized to the forester's single-ix shape.
// --------------------------------------------------------------

/// `sha256("global:" + method_name)[..8]` — Anchor's method discriminator.
fn anchor_method_discriminator(prefix_and_method: &str) -> [u8; 8] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(prefix_and_method.as_bytes());
    let h = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

fn decode_pubkey_b58(s: &str) -> Result<[u8; 32]> {
    let v = bs58::decode(s)
        .into_vec()
        .map_err(|e| Error::SolanaRpc(format!("bs58 pubkey '{s}': {e}")))?;
    v.try_into()
        .map_err(|_: Vec<u8>| Error::SolanaRpc(format!("pubkey '{s}' not 32 bytes")))
}

fn derive_pool_config_pda(program_id: &[u8; 32]) -> [u8; 32] {
    let (pk, _bump) = find_program_address(&[b"pool_config"], program_id);
    pk
}

fn derive_verifier_key_pda(program_id: &[u8; 32], pool_config: &[u8; 32]) -> [u8; 32] {
    let (pk, _) = find_program_address(&[b"verifier_key", pool_config.as_ref()], program_id);
    pk
}

fn derive_merkle_tree_pda(
    program_id: &[u8; 32],
    pool_config: &[u8; 32],
    mint: &[u8; 32],
) -> [u8; 32] {
    let (pk, _) = find_program_address(
        &[b"merkle_tree", pool_config.as_ref(), mint.as_ref()],
        program_id,
    );
    pk
}

/// Pure-Rust `Pubkey::find_program_address`. Iterates `bump` from 255 down to
/// 0 and runs the Solana PDA hash `sha256(seeds || bump || program_id || "ProgramDerivedAddress")`,
/// returning the first result that's NOT on the Ed25519 curve. For the PDAs
/// the on-chain program declares, this always finds a valid bump within ~3
/// iterations in practice.
fn find_program_address(seeds: &[&[u8]], program_id: &[u8; 32]) -> ([u8; 32], u8) {
    use sha2::Digest;
    const MARKER: &[u8] = b"ProgramDerivedAddress";
    for bump in (0u8..=255u8).rev() {
        let mut hasher = sha2::Sha256::new();
        for s in seeds {
            hasher.update(s);
        }
        hasher.update(&[bump]);
        hasher.update(program_id);
        hasher.update(MARKER);
        let h: [u8; 32] = hasher.finalize().into();
        if !point_is_on_curve(&h) {
            return (h, bump);
        }
    }
    // Astronomically improbable; the on-chain runtime would also fail here.
    panic!("PDA derivation: no valid bump found");
}

/// Returns true iff the 32-byte value decompresses to a valid point on the
/// Ed25519 curve. Mirrors `solana_program::pubkey::Pubkey::is_on_curve`
/// (which uses `curve25519-dalek::edwards::CompressedEdwardsY::decompress`).
/// We approximate via `ed25519_dalek::VerifyingKey::from_bytes`, which
/// internally calls the same decompress.
fn point_is_on_curve(bytes: &[u8; 32]) -> bool {
    ed25519_dalek::VerifyingKey::from_bytes(bytes).is_ok()
}

#[derive(Clone, Debug)]
struct AccountMeta {
    pubkey: [u8; 32],
    is_signer: bool,
    is_writable: bool,
}

#[derive(Clone, Debug)]
struct RawInstruction {
    program_id: [u8; 32],
    accounts: Vec<AccountMeta>,
    data: Vec<u8>,
}

fn encode_compact_u16(val: u16) -> Vec<u8> {
    let mut out = Vec::new();
    let mut v = val;
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
    out
}

fn build_message(
    instructions: &[RawInstruction],
    payer: &[u8; 32],
    recent_blockhash: &[u8; 32],
) -> Vec<u8> {
    use std::collections::BTreeMap;
    let mut account_map: BTreeMap<[u8; 32], (bool, bool)> = BTreeMap::new();
    account_map.insert(*payer, (true, true));
    for ix in instructions {
        account_map.entry(ix.program_id).or_insert((false, false));
        for meta in &ix.accounts {
            let entry = account_map.entry(meta.pubkey).or_insert((false, false));
            entry.0 |= meta.is_signer;
            entry.1 |= meta.is_writable;
        }
    }

    let mut writable_signers = Vec::new();
    let mut readonly_signers = Vec::new();
    let mut writable_nonsigners = Vec::new();
    let mut readonly_nonsigners = Vec::new();
    for (&pk, &(is_signer, is_writable)) in &account_map {
        if pk == *payer {
            continue;
        }
        match (is_signer, is_writable) {
            (true, true) => writable_signers.push(pk),
            (true, false) => readonly_signers.push(pk),
            (false, true) => writable_nonsigners.push(pk),
            (false, false) => readonly_nonsigners.push(pk),
        }
    }

    let mut accounts: Vec<[u8; 32]> = Vec::new();
    accounts.push(*payer);
    accounts.extend(writable_signers.iter().copied());
    accounts.extend(readonly_signers.iter().copied());
    accounts.extend(writable_nonsigners.iter().copied());
    accounts.extend(readonly_nonsigners.iter().copied());

    let account_index: BTreeMap<[u8; 32], u8> = accounts
        .iter()
        .enumerate()
        .map(|(i, &pk)| (pk, i as u8))
        .collect();

    let num_required_signatures = (1 + writable_signers.len() + readonly_signers.len()) as u8;
    let num_readonly_signed = readonly_signers.len() as u8;
    let num_readonly_unsigned = readonly_nonsigners.len() as u8;

    let mut msg = Vec::new();
    msg.push(num_required_signatures);
    msg.push(num_readonly_signed);
    msg.push(num_readonly_unsigned);
    msg.extend_from_slice(&encode_compact_u16(accounts.len() as u16));
    for a in &accounts {
        msg.extend_from_slice(a);
    }
    msg.extend_from_slice(recent_blockhash);
    msg.extend_from_slice(&encode_compact_u16(instructions.len() as u16));
    for ix in instructions {
        msg.push(account_index[&ix.program_id]);
        msg.extend_from_slice(&encode_compact_u16(ix.accounts.len() as u16));
        for meta in &ix.accounts {
            msg.push(account_index[&meta.pubkey]);
        }
        msg.extend_from_slice(&encode_compact_u16(ix.data.len() as u16));
        msg.extend_from_slice(&ix.data);
    }
    msg
}

fn sign_and_serialize(message: &[u8], signer: &ed25519_dalek::SigningKey) -> Vec<u8> {
    use ed25519_dalek::Signer as _;
    let signature = signer.sign(message);
    let mut tx = Vec::new();
    tx.extend_from_slice(&encode_compact_u16(1));
    tx.extend_from_slice(&signature.to_bytes());
    tx.extend_from_slice(message);
    tx
}

/// Borsh-encode the on-chain `UpdateRootArgs` struct (NOT including the
/// 8-byte Anchor method discriminator — the caller prepends that).
///
/// Layout (mirrors `programs/said-shielded-pool/src/instructions/update_root.rs`):
///   proof_a:      [u8; 64]
///   proof_b:      [u8; 128]
///   proof_c:      [u8; 64]
///   old_root:     [u8; 32]
///   new_root:     [u8; 32]
///   start_index:  u64  (little-endian per Anchor's BorshSerialize)
///   commitments:  [[u8; 32]; FORESTER_BATCH_SIZE]  (fixed-size; serialized
///                 as the concatenation of the inner arrays, no length prefix)
fn encode_update_root_args(
    snapshot: &TreeSnapshot,
    commitments: &[Commitment],
    proof: &ForesterProofBundle,
) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(64 + 128 + 64 + 32 + 32 + 8 + 32 * FORESTER_BATCH_SIZE);
    buf.extend_from_slice(&proof.proof.a);
    buf.extend_from_slice(&proof.proof.b);
    buf.extend_from_slice(&proof.proof.c);
    buf.extend_from_slice(&snapshot.root);
    buf.extend_from_slice(&proof.public_inputs.new_root.0);
    buf.extend_from_slice(&proof.public_inputs.start_index.to_le_bytes());
    for c in commitments.iter() {
        buf.extend_from_slice(&c.0);
    }
    Ok(buf)
}

/// Snapshot of the local tree taken at witness-build time.
#[derive(Clone, Debug)]
pub struct TreeSnapshot {
    pub root: FieldBytes,
    pub next_index: u64,
    pub filled_subtrees: [FieldBytes; TREE_DEPTH],
}

/// On-chain insertion queue, parsed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InsertionQueueSnapshot {
    pub tree_id: u64,
    pub commitments: Vec<Commitment>,
}

/// Forester signing key — Ed25519 seed loaded from a `solana-keygen` JSON
/// file (a 64-byte array: `[secret_seed (32) || public (32)]`).
///
/// # Lifecycle
///
/// - Constructed once at indexer startup ([`Forester::new`]).
/// - Held by `&self` for the entire lifetime of the forester task —
///   we never `Clone` it (the wrapping `Zeroizing<Vec<u8>>` is `Clone`
///   but cloning would defeat the on-drop scrub guarantee for the
///   original).
/// - On graceful shutdown the `Zeroizing` drop runs and zeroes the
///   backing storage. On panic-unwind the same drop runs.
/// - [`Self::signing_key`] reconstructs an `ed25519_dalek::SigningKey`
///   per-signature from the seed half; the reconstructed `SigningKey`
///   drops with its own zeroize-on-drop (`SecretKey` in `ed25519-dalek`
///   2.x derives `Zeroize`).
struct ForesterKeypair {
    /// Raw 64-byte `[seed (32) || pub (32)]` blob, zeroized on drop.
    bytes: common_secrets::Zeroizing<Vec<u8>>,
}

impl ForesterKeypair {
    fn from_file(path: &PathBuf) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| Error::ForesterKey(format!("read {}: {e}", path.display())))?;
        let arr: Vec<u8> = serde_json::from_str(&raw)
            .map_err(|e| Error::ForesterKey(format!("parse {}: {e}", path.display())))?;
        if arr.len() != 64 {
            return Err(Error::ForesterKey(format!(
                "expected 64-byte keypair, got {} bytes",
                arr.len()
            )));
        }
        Ok(Self {
            bytes: common_secrets::Zeroizing::new(arr),
        })
    }

    #[allow(dead_code)]
    fn public_bytes(&self) -> &[u8] {
        &self.bytes[32..]
    }

    /// Decode the 32-byte secret seed half of the keypair file into an
    /// `ed25519_dalek::SigningKey`. The 64-byte solana-keygen format is
    /// `secret_seed (32) || public_key (32)`.
    ///
    /// Takes `&self` (never moves the key out). The intermediate `seed`
    /// array is wrapped in `Zeroizing` so the stack copy is scrubbed
    /// on return.
    fn signing_key(&self) -> Result<ed25519_dalek::SigningKey> {
        if self.bytes.len() != 64 {
            return Err(Error::ForesterKey(format!(
                "expected 64-byte keypair, got {}",
                self.bytes.len()
            )));
        }
        let mut seed = common_secrets::Zeroizing::new([0u8; 32]);
        seed.copy_from_slice(&self.bytes[..32]);
        Ok(ed25519_dalek::SigningKey::from_bytes(&seed))
    }
}

/// PDA derivation stub for the insertion-queue account.
///
/// Real derivation: `Pubkey::find_program_address(&[b"queue", &tree_id.to_le_bytes()], &program_id)`.
/// We don't depend on `solana-sdk` so we return a deterministic placeholder
/// — the forester `fetch_queue` call will return `None`/empty from the
/// RPC and the forester will simply idle until the proper derivation
/// (and on-chain program) lands.
fn derive_queue_pda_b58(program_id_b58: &str, tree_id: u64) -> String {
    // Defensive: include both inputs in the placeholder so the log line
    // is debuggable; the value itself is not a real on-chain pubkey.
    format!("{program_id_b58}-queue-{tree_id}")
}

/// Parse the borsh-encoded insertion-queue account body.
///
/// Layout (matches the on-chain program's `InsertionQueueAccount`):
/// ```text
/// pub struct InsertionQueueAccount {
///     pub tree_id: u64,
///     pub commitments: Vec<[u8; 32]>,
/// }
/// ```
/// with an 8-byte Anchor account discriminator prefix.
fn parse_insertion_queue(data: &[u8]) -> Result<InsertionQueueSnapshot> {
    use borsh::BorshDeserialize;
    if data.len() < 8 {
        return Err(Error::SolanaRpc("queue account too short".into()));
    }
    let body = &data[8..];
    let mut cursor = body;
    let tree_id = <u64 as BorshDeserialize>::deserialize(&mut cursor)
        .map_err(|e| Error::SolanaRpc(format!("queue tree_id: {e}")))?;
    let commitments: Vec<[u8; 32]> =
        <Vec<[u8; 32]> as BorshDeserialize>::deserialize(&mut cursor)
            .map_err(|e| Error::SolanaRpc(format!("queue commitments: {e}")))?;
    Ok(InsertionQueueSnapshot {
        tree_id,
        commitments: commitments.into_iter().map(Commitment).collect(),
    })
}

/// Replay the tree's leaves to recover the current `filled_subtrees`
/// without exposing the field publicly from `tree.rs`.
fn read_filled_subtrees(tree: &IncrementalMerkleTree) -> Result<[FieldBytes; TREE_DEPTH]> {
    use crate::tree::poseidon2_be;
    let leaves = tree.leaves_snapshot()?;
    let zh = crate::zero_hashes::zero_hashes();
    let mut filled = [[0u8; 32]; TREE_DEPTH];
    // Replay the same algorithm as `insert` over all leaves to rebuild
    // the filled-subtrees array.
    for (i, leaf) in leaves.iter().enumerate() {
        let mut current = *leaf;
        let mut current_idx = i as u64;
        for d in 0..TREE_DEPTH {
            let (left, right) = if current_idx & 1 == 0 {
                filled[d] = current;
                (current, zh[d])
            } else {
                (filled[d], current)
            };
            current = poseidon2_be(&left, &right)?;
            current_idx >>= 1;
        }
    }
    Ok(filled)
}

// Silence unused-field warnings on the keypair container until signing
// lands in the follow-up PR.
#[allow(dead_code)]
fn _force_use_keypair(k: &ForesterKeypair) -> &[u8] {
    &k.bytes[..]
}

// Suppress unused-import warnings until the tx-builder lands.
#[allow(dead_code)]
const _USES_RW_LOCK: Option<&RwLock<()>> = None;
