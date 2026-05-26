//! Submission layer.
//!
//! Given a batch of withdrawals, submit each as a separate Solana
//! transaction with randomized inter-submission delay and exponential
//! retry. The actual on-chain call is hidden behind the [`Submitter`]
//! trait so production code can wire a real Solana JSON-RPC client and
//! tests can inject a mock.
//!
//! # On-chain construction
//!
//! The relayer treats the proof bundle and Anchor instruction data as
//! opaque blobs (see [`crate::queue::ProofBlob`] /
//! [`crate::queue::QueuedWithdrawal::instruction_data`] for the
//! rationale). The client (see `said-shielded-pool-client::tx_builder`)
//! builds the `withdraw` instruction bytes and account list and sends
//! both via `/relay`. The relayer's submitter:
//!
//! 1. Loads the relayer fee-paying keypair from disk.
//! 2. Calls `getLatestBlockhash` on the configured RPC.
//! 3. Builds a legacy Solana message with the relayer pubkey as fee
//!    payer (signer) plus the client-supplied accounts/data.
//! 4. Signs with Ed25519, base64-encodes, calls `sendTransaction`.
//! 5. Polls `getSignatureStatuses` until Confirmed or final failure.
//!
//! We deliberately avoid `solana-client`/`solana-sdk` — the workspace
//! already keeps those out for dep-graph reasons (see
//! `crates/said-shielded-pool-indexer/src/solana.rs` and
//! `crates/said-receipts-service/src/solana.rs`).
//!
//! # Privacy invariants
//!
//! - We SHUFFLE the batch before submission so that the on-chain
//!   ordering is uncorrelated with queue insertion order.
//! - We DO NOT carry the queue id into the on-chain payload (no memo,
//!   no compute-budget note, no instruction-discriminator suffix).
//! - We DO NOT log proof contents, public inputs, recipient, amount,
//!   tx signature, or queue id above DEBUG.
//! - The transaction signature is held in-memory only for confirmation
//!   polling and is NEVER returned via any HTTP endpoint or persisted
//!   into the queue record.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use common_secrets::Zeroizing;
use ed25519_dalek::{Signer, SigningKey};
use rand::seq::SliceRandom;
use rand::Rng;
use zeroize::Zeroize;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::metrics::Metrics;
use crate::queue::{QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus};

/// 11111111111111111111111111111111
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// Trait abstracting the actual on-chain submission. Implementors must:
///   - Build a Solana transaction from the queued payload.
///   - Sign with the relayer keypair.
///   - Submit to RPC and wait for at least Confirmed.
///   - Return Ok(()) on success, Err on failure (caller will retry).
#[async_trait]
pub trait Submitter {
    async fn submit_one(&self, w: &QueuedWithdrawal) -> Result<()>;

    /// Submit a no-op decoy transaction.
    async fn submit_decoy(&self) -> Result<()>;
}

/// Default [`Submitter`] backed by a Solana JSON-RPC endpoint.
///
/// Loads the signing key lazily on first use so a missing keypair only
/// breaks submission, not the entire relayer process (so `/healthz` and
/// `/metrics` still answer and the queue keeps absorbing requests
/// during a key-rotation window).
pub struct RpcSubmitter {
    pub rpc_url: String,
    pub keypair_path: std::path::PathBuf,
    pub program_id: [u8; 32],
    pub http: reqwest::Client,
    /// Cached signing-key bytes — the raw 64-byte `[seed (32) || pub (32)]`
    /// form as written by `solana-keygen`. We store the bytes (not the
    /// reconstructed [`SigningKey`]) so we can `zeroize` them in-place on
    /// shutdown.
    ///
    /// # Lifecycle
    ///
    /// 1. `OnceLock` is empty at construction (lazy load — see comment on
    ///    [`Self::new_with_program`] for the rationale).
    /// 2. First call to [`Self::with_signer`] reads the file, parses
    ///    the 64-byte array, wraps it in `Zeroizing` and stores it
    ///    inside a `Mutex` so callers can both read it (to derive a
    ///    `SigningKey` per signature) and zero it out (on SIGTERM).
    /// 3. On graceful shutdown (`main.rs` installs a `tokio::signal`
    ///    handler), the process calls [`Self::zeroize_signer`] which
    ///    `Zeroize::zeroize` the inner array. Subsequent signing
    ///    attempts will produce signatures over an all-zeros seed —
    ///    intentionally invalid so an attacker who races the shutdown
    ///    can't get a useful signature through.
    /// 4. `SigningKey` is reconstructed per-signature from the seed.
    ///    The reconstructed value lives only on the signing stack and
    ///    `SigningKey` itself implements `Zeroize` (ed25519-dalek 2.x
    ///    derives it on the `SecretKey` interior), so it is cleared
    ///    when the helper returns.
    signer: std::sync::OnceLock<Mutex<Zeroizing<[u8; 64]>>>,
}

impl RpcSubmitter {
    pub fn new(rpc_url: String, keypair_path: std::path::PathBuf) -> Self {
        Self::new_with_program(
            rpc_url,
            keypair_path,
            crate::config::DEFAULT_POOL_PROGRAM_ID.to_string(),
        )
    }

    pub fn new_with_program(
        rpc_url: String,
        keypair_path: std::path::PathBuf,
        pool_program_id_b58: String,
    ) -> Self {
        let program_id = decode_pubkey_b58(&pool_program_id_b58).unwrap_or([0u8; 32]);
        Self {
            rpc_url,
            keypair_path,
            program_id,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            signer: std::sync::OnceLock::new(),
        }
    }

    /// Load the keypair bytes (lazy, once) and return a handle to the
    /// cached `Mutex`. We do NOT return a `&SigningKey` because the
    /// signing-key must be reconstructed per-call from the (zeroizable)
    /// seed bytes — otherwise the reconstructed key would outlive any
    /// SIGTERM zeroize.
    fn signer_bytes(&self) -> Result<&Mutex<Zeroizing<[u8; 64]>>> {
        if let Some(s) = self.signer.get() {
            return Ok(s);
        }
        let raw = std::fs::read_to_string(&self.keypair_path).map_err(|e| {
            Error::Submit(format!(
                "read keypair {}: {}",
                self.keypair_path.display(),
                e
            ))
        })?;
        let arr: Vec<u8> = serde_json::from_str(&raw)
            .map_err(|e| Error::Submit(format!("parse keypair JSON: {e}")))?;
        if arr.len() != 64 {
            return Err(Error::Submit(format!(
                "expected 64-byte solana keypair, got {}",
                arr.len()
            )));
        }
        let mut bytes = [0u8; 64];
        bytes.copy_from_slice(&arr);
        let cached = Mutex::new(Zeroizing::new(bytes));
        // First writer wins; ignore the Err side if a concurrent caller
        // populated it (they'd write the same value).
        let _ = self.signer.set(cached);
        Ok(self.signer.get().expect("set above"))
    }

    /// Run `f` with a freshly-reconstructed [`SigningKey`].
    ///
    /// The signing key only lives for the duration of `f`; on return
    /// the local seed copy goes out of scope and `SigningKey` itself
    /// drops with its zeroize-on-drop semantics.
    fn with_signer<R>(&self, f: impl FnOnce(&SigningKey) -> R) -> Result<R> {
        let cell = self.signer_bytes()?;
        let guard = cell
            .lock()
            .map_err(|e| Error::Submit(format!("signer mutex poisoned: {e}")))?;
        // Pull the 32-byte seed out of the 64-byte keypair. The seed
        // copy below is itself a stack-local that we explicitly
        // zeroize before returning.
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&guard[..32]);
        let sk = SigningKey::from_bytes(&seed);
        let r = f(&sk);
        seed.zeroize();
        Ok(r)
    }

    /// Explicitly zero the cached signing key bytes. Call on SIGTERM /
    /// graceful shutdown so a forensic memory dump can't recover the
    /// secret seed.
    ///
    /// Safe to call multiple times; if the cache was never populated
    /// (no submit attempts yet), this is a no-op.
    pub fn zeroize_signer(&self) {
        if let Some(cell) = self.signer.get() {
            if let Ok(mut guard) = cell.lock() {
                guard.zeroize();
            }
        }
    }

    /// Relayer's fee-paying / signing pubkey.
    pub fn signer_pubkey(&self) -> Result<[u8; 32]> {
        self.with_signer(|sk| sk.verifying_key().to_bytes())
    }

    /// Send a 1-lamport self-transfer and confirm it. This is a SMOKE-TEST
    /// helper ONLY — it exercises the keypair-load → blockhash → sign → send
    /// → confirm RPC chain end-to-end without touching the shielded-pool
    /// program. It is NOT a decoy (a self-transfer provides zero cover and is
    /// trivially distinguishable from a `withdraw`; see `submit_decoy`).
    pub async fn devnet_self_transfer_smoketest(&self) -> Result<()> {
        let payer = self.signer_pubkey()?;
        let ix = build_self_transfer_ix(&payer, 1);
        let signature = self.sign_and_send(ix).await?;
        self.confirm(signature).await
    }

    async fn rpc(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let resp = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Rpc(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| Error::Rpc(e.to_string()))?;
        if !status.is_success() {
            return Err(Error::Rpc(format!("{status}: {text}")));
        }
        let raw: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| Error::Rpc(format!("json: {e}")))?;
        if let Some(err) = raw.get("error") {
            return Err(Error::Rpc(err.to_string()));
        }
        raw.get("result")
            .cloned()
            .ok_or_else(|| Error::Rpc("missing result".into()))
    }

    async fn latest_blockhash(&self) -> Result<[u8; 32]> {
        let r = self
            .rpc(
                "getLatestBlockhash",
                serde_json::json!([{"commitment": "confirmed"}]),
            )
            .await?;
        let s = r["value"]["blockhash"]
            .as_str()
            .ok_or_else(|| Error::Rpc("missing blockhash".into()))?;
        let bytes = bs58::decode(s)
            .into_vec()
            .map_err(|e| Error::Rpc(e.to_string()))?;
        bytes
            .try_into()
            .map_err(|_: Vec<u8>| Error::Rpc("blockhash not 32 bytes".into()))
    }

    /// Sign and broadcast a single instruction. The relayer pubkey is
    /// prepended as the fee payer / signer.
    ///
    /// The signing key is reconstructed inside [`Self::with_signer`]
    /// and lives only on the synchronous stack frame for the duration
    /// of `sign_and_serialize`. We do the network RPC AFTER releasing
    /// the signer scope so the cache mutex is held for the minimum
    /// possible time.
    async fn sign_and_send(&self, ix: RawInstruction) -> Result<String> {
        let blockhash = self.latest_blockhash().await?;
        let (payer, tx_bytes) = self.with_signer(|signer| {
            let payer = signer.verifying_key().to_bytes();
            let msg = build_message(&[ix], &payer, &blockhash);
            let tx_bytes = sign_and_serialize(&msg, signer);
            (payer, tx_bytes)
        })?;
        let _ = payer; // currently unused beyond the closure
        let b64 = base64::engine::general_purpose::STANDARD.encode(&tx_bytes);
        let res = self
            .rpc(
                "sendTransaction",
                serde_json::json!([
                    b64,
                    {
                        "encoding": "base64",
                        "preflightCommitment": "confirmed",
                        // We DO NOT skip preflight; preflight failures
                        // surface invalid-proof errors fast so we don't
                        // burn retries against an unconfirmable tx.
                        "skipPreflight": false,
                    }
                ]),
            )
            .await?;
        res.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| Error::Rpc("missing signature".into()))
    }

    /// Poll `getSignatureStatuses` until the tx is Confirmed/Finalized,
    /// errored, or the deadline expires.
    ///
    /// Privacy: the signature is taken by value and dropped at the end
    /// of this function. We never log it at INFO/WARN.
    async fn confirm(&self, signature_b58: String) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let poll = Duration::from_millis(750);
        loop {
            let r = self
                .rpc(
                    "getSignatureStatuses",
                    serde_json::json!([[signature_b58], {"searchTransactionHistory": false}]),
                )
                .await?;
            if let Some(v) = r["value"].as_array() {
                if let Some(first) = v.first() {
                    if !first.is_null() {
                        if let Some(err) = first.get("err") {
                            if !err.is_null() {
                                tracing::debug!(error = %err, "tx failed on-chain");
                                return Err(Error::Submit(format!("tx err: {err}")));
                            }
                        }
                        let conf = first
                            .get("confirmationStatus")
                            .and_then(|s| s.as_str())
                            .unwrap_or("");
                        if conf == "confirmed" || conf == "finalized" {
                            return Ok(());
                        }
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(Error::Submit("confirmation timeout".into()));
            }
            tokio::time::sleep(poll).await;
        }
    }
}

#[async_trait]
impl Submitter for RpcSubmitter {
    async fn submit_one(&self, w: &QueuedWithdrawal) -> Result<()> {
        // We treat both the instruction data and the account list as
        // opaque (relayer doesn't structurally decode the proof).
        if w.instruction_data.is_empty() || w.accounts.is_empty() {
            return Err(Error::Submit(
                "queued payload missing instruction_data or accounts".into(),
            ));
        }
        let mut metas = Vec::with_capacity(w.accounts.len());
        for a in &w.accounts {
            let pk = decode_pubkey_b58(&a.pubkey)
                .map_err(|e| Error::Submit(format!("bad account pubkey: {e}")))?;
            metas.push(AccountMeta {
                pubkey: pk,
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            });
        }
        let ix = RawInstruction {
            program_id: self.program_id,
            accounts: metas,
            data: w.instruction_data.clone(),
        };
        let signature = self.sign_and_send(ix).await?;
        // Confirm and drop the signature. We deliberately do NOT log it
        // at any level; even at DEBUG it could be cross-referenced
        // against the queue id. The retry loop above is the only piece
        // of code that ever sees the value.
        self.confirm(signature).await
    }

    async fn submit_decoy(&self) -> Result<()> {
        // V2 (design-gated): decoys are NOT implemented.
        //
        // The previous implementation here broadcast a 1-lamport
        // system-program self-transfer. That provided ZERO cover: a
        // self-transfer is trivially distinguishable on-chain from a
        // `withdraw` instruction (different program ID, different ix shape,
        // different account set), so it does not mix into the real-withdrawal
        // traffic at all. Worse, `decoy.rs` documented decoys as
        // byte-indistinguishable `withdraw{amount:0}` txs — a claim the
        // self-transfer did not satisfy. Shipping a fake decoy is more
        // dangerous than shipping none, because an operator could believe
        // they have cover when they do not.
        //
        // A real decoy needs a program-level entrypoint that emits an
        // on-chain-indistinguishable `withdraw{amount:0, relayer_fee:0}`
        // bound to a live root + disposable nullifier, plus the prover/
        // forester wiring to keep a `DecoyPool` populated. None of that
        // exists yet. Until it does, this is a HARD no-op that returns an
        // explicit error so the caller (and metrics/logs) reflect reality.
        Err(Error::Submit(
            "decoys not implemented (V2): no program entrypoint for an \
             indistinguishable withdraw{amount:0} cover tx; refusing to \
             emit a fake/distinguishable decoy"
                .into(),
        ))
    }
}

/// Build a Solana system-program `transfer` instruction from `from` to
/// itself. Used by the devnet smoke test (NOT by the decoy path — see
/// `submit_decoy`, which is a hard no-op until real decoys exist).
pub fn build_self_transfer_ix(from: &[u8; 32], lamports: u64) -> RawInstruction {
    // System program transfer instruction discriminator is `2u32 LE`
    // followed by the lamport amount (u64 LE).
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    RawInstruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![
            AccountMeta {
                pubkey: *from,
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: *from,
                is_signer: false,
                is_writable: true,
            },
        ],
        data,
    }
}

/// Submit a batch with Poisson-jittered spacing and per-item exponential retry.
///
/// On success: item set to `Submitted` then `Confirmed`.
/// On final failure: item set to `Failed`.
pub async fn submit_batch(
    submitter: &(dyn Submitter + Send + Sync),
    queue: &WithdrawalQueue,
    config: &Config,
    metrics: &Metrics,
    mut batch: Vec<QueuedWithdrawal>,
) -> Result<()> {
    // Decorrelate on-chain order from queue order.
    {
        let mut rng = rand::thread_rng();
        batch.shuffle(&mut rng);
    }

    for w in batch {
        let delay_secs = poisson_delay(config.jitter_lambda);
        tokio::time::sleep(Duration::from_secs_f64(delay_secs)).await;

        let outcome = submit_with_retry(submitter, queue, config, metrics, &w).await;
        match outcome {
            Ok(()) => {
                let _ = queue.set_status(w.id, WithdrawalStatus::Confirmed);
                metrics.record_submit_success();
            }
            Err(e) => {
                // Privacy: log only that *a* submission failed.
                tracing::warn!(error = %e, "withdrawal submission gave up");
                let _ = queue.set_status(w.id, WithdrawalStatus::Failed);
                metrics.record_submit_failure();
            }
        }
    }
    Ok(())
}

async fn submit_with_retry(
    submitter: &(dyn Submitter + Send + Sync),
    queue: &WithdrawalQueue,
    config: &Config,
    metrics: &Metrics,
    w: &QueuedWithdrawal,
) -> Result<()> {
    queue.set_status(w.id, WithdrawalStatus::Submitted)?;

    let mut delay = Duration::from_millis(config.retry_initial_delay_ms);
    let max_delay = Duration::from_millis(config.retry_max_delay_ms);
    let started = std::time::Instant::now();

    for attempt in 0..config.max_retries {
        match submitter.submit_one(w).await {
            Ok(()) => {
                metrics.observe_submit_latency(started.elapsed());
                let _ = queue.increment_attempts(w.id);
                return Ok(());
            }
            Err(e) => {
                let attempts = queue.increment_attempts(w.id).unwrap_or(attempt + 1);
                tracing::debug!(
                    attempts,
                    max = config.max_retries,
                    error = %e,
                    "submit attempt failed, will retry"
                );
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(max_delay);
            }
        }
    }
    Err(Error::Submit("max retries exhausted".into()))
}

/// Sample a Poisson-process inter-arrival time with rate `lambda` per second.
fn poisson_delay(lambda: f64) -> f64 {
    if lambda <= 0.0 {
        return 0.0;
    }
    let mut rng = rand::thread_rng();
    let u: f64 = rng.gen_range(f64::EPSILON..1.0);
    -u.ln() / lambda
}

// -----------------------------------------------------------------
// Solana wire format. Same pattern as said-receipts-service.
// -----------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AccountMeta {
    pub pubkey: [u8; 32],
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Debug, Clone)]
pub struct RawInstruction {
    pub program_id: [u8; 32],
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
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

fn sign_and_serialize(message: &[u8], signer: &SigningKey) -> Vec<u8> {
    let signature = signer.sign(message);
    let mut tx = Vec::new();
    tx.extend_from_slice(&encode_compact_u16(1));
    tx.extend_from_slice(&signature.to_bytes());
    tx.extend_from_slice(message);
    tx
}

fn decode_pubkey_b58(s: &str) -> Result<[u8; 32]> {
    let v = bs58::decode(s)
        .into_vec()
        .map_err(|e| Error::Submit(format!("bs58: {e}")))?;
    v.try_into()
        .map_err(|_: Vec<u8>| Error::Submit("pubkey not 32 bytes".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_u16_short_and_long() {
        assert_eq!(encode_compact_u16(0), vec![0]);
        assert_eq!(encode_compact_u16(127), vec![127]);
        assert_eq!(encode_compact_u16(128), vec![0x80, 0x01]);
        assert_eq!(encode_compact_u16(16384), vec![0x80, 0x80, 0x01]);
    }

    #[test]
    fn poisson_delay_zero_lambda_is_zero() {
        assert_eq!(poisson_delay(0.0), 0.0);
        assert_eq!(poisson_delay(-1.0), 0.0);
    }

    #[test]
    fn self_transfer_ix_shape() {
        let from = [7u8; 32];
        let ix = build_self_transfer_ix(&from, 1);
        assert_eq!(ix.program_id, SYSTEM_PROGRAM_ID);
        assert_eq!(ix.accounts.len(), 2);
        assert_eq!(&ix.data[..4], &2u32.to_le_bytes());
        assert_eq!(&ix.data[4..12], &1u64.to_le_bytes());
    }
}
