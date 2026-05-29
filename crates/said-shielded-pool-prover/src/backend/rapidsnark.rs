//! `rapidsnark` Groth16 prover backend.
//!
//! Rapidsnark (https://github.com/iden3/rapidsnark) is the fast native
//! C++ prover for the same Groth16/BN254 circuits snarkjs uses. It
//! reads the same `circuit_final.zkey` and a pre-computed `.wtns`
//! witness file, and writes the same `proof.json` / `public.json`,
//! so the output-parsing path is shared with [`super::snarkjs`].
//!
//! Witness generation itself isn't part of rapidsnark — we delegate
//! that step to the circom-generated `witness_calculator` (via
//! `snarkjs wtns calculate`) for now. A future improvement: invoke
//! the `witness_calculator` C++ binary directly to avoid the snarkjs
//! dep entirely on the rapidsnark path.
//!
//! Why this matters: rapidsnark proves a typical shielded-transfer
//! circuit in ~200ms on a beefy server vs ~2-4s for snarkjs. We default
//! to snarkjs in dev, swap to rapidsnark in production (TEE / Phase 42).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use common_secrets::Zeroizing;
use said_shielded_pool_types::{ProofBundle, TransferWitness};
use tokio::process::Command;
use tokio::time::timeout;

use crate::backend::{Backend, SecureTempDir};
use crate::config::Config;
use crate::error::{Error, Result};

pub struct RapidsnarkBackend {
    cfg: Config,
}

impl RapidsnarkBackend {
    pub fn new(cfg: Config) -> Self {
        Self { cfg }
    }
}

#[async_trait]
impl Backend for RapidsnarkBackend {
    fn name(&self) -> &'static str {
        "rapidsnark"
    }

    async fn prove(&self, witness: TransferWitness) -> Result<ProofBundle> {
        let zkey = self.cfg.zkey_path();
        let wasm = self.cfg.wasm_path();
        ensure_exists(&zkey)?;
        ensure_exists(&wasm)?;

        // RAII: removes the dir on success, error, AND panic, with an
        // unpredictable 0700 name and overwrite-before-unlink. Replaces
        // the previous bare-`PathBuf` + manual `remove_dir_all` (which
        // leaked the witness on `?`-error, panic, or cancellation).
        let workdir = SecureTempDir::create_under(&self.cfg.artifacts_dir)?;
        let input_json = workdir.path().join("input.json");
        let witness_wtns = workdir.path().join("witness.wtns");
        let proof_json = workdir.path().join("proof.json");
        let public_json = workdir.path().join("public.json");

        // Use the SHARED circom mapping (decimal strings under circuit
        // signal names), not a verbatim serde dump of the witness — see
        // `super::snarkjs::circom_input_from_witness`. The serialized
        // bytes embed the spending key (as decimal), so we hold them in a
        // `Zeroizing<Vec<u8>>` that scrubs on drop. NOTE: the intermediate
        // `serde_json::Value` cannot be scrubbed (serde_json owns those
        // allocations); we drop it as soon as the bytes are produced.
        let input_bytes: Zeroizing<Vec<u8>> = {
            let circom_input = super::snarkjs::circom_input_from_witness(&witness)?;
            Zeroizing::new(serde_json::to_vec_pretty(&circom_input)?)
        };
        tokio::fs::write(&input_json, &*input_bytes).await?;
        drop(input_bytes);

        // Step 1: witness calculation — still via snarkjs/wasm. (See
        // module docs.)
        run_cmd(
            "snarkjs",
            &[
                "wtns",
                "calculate",
                wasm.to_str().unwrap(),
                input_json.to_str().unwrap(),
                witness_wtns.to_str().unwrap(),
            ],
            self.cfg.subprocess_timeout_ms,
        )
        .await?;

        // Step 2: proving — `rapidsnark <zkey> <wtns> <proof.json> <public.json>`
        run_cmd(
            "rapidsnark",
            &[
                zkey.to_str().unwrap(),
                witness_wtns.to_str().unwrap(),
                proof_json.to_str().unwrap(),
                public_json.to_str().unwrap(),
            ],
            self.cfg.subprocess_timeout_ms,
        )
        .await?;

        let proof_bytes = tokio::fs::read(&proof_json).await?;
        let public_bytes = tokio::fs::read(&public_json).await?;

        // Shared parsing with snarkjs — same JSON wire format.
        let bundle = super::snarkjs::__parse_for_rapidsnark(&proof_bytes, &public_bytes, &witness)?;

        // `workdir` Drop runs here and removes the dir + witness.
        Ok(bundle)
    }

    async fn vk(&self) -> Result<Vec<u8>> {
        let vk_path = self.cfg.vk_path();
        ensure_exists(&vk_path)?;
        Ok(tokio::fs::read(&vk_path).await?)
    }
}

fn ensure_exists(p: &PathBuf) -> Result<()> {
    if !p.exists() {
        return Err(Error::ArtifactsNotFound(p.clone()));
    }
    Ok(())
}

/// Run a prover subprocess (`snarkjs` or `rapidsnark`) with a hard
/// wall-clock timeout, mirroring [`super::snarkjs::run_snarkjs`].
///
/// On timeout we explicitly SIGKILL the child before returning the typed
/// `Error::SnarkjsTimeout`, and the child is configured with
/// `kill_on_drop(true)` so tokio's reaper sends SIGKILL even if the
/// kill-await is itself preempted or this future is cancelled.
///
/// Privacy reason: the witness file in the temp dir contains the
/// spending key and per-input blindings. A hung native prover could
/// otherwise sit on that file forever; the `Command::output()` form
/// previously used here had NO timeout. The `SecureTempDir` guard
/// deletes the file when the attempt returns; this timeout ensures the
/// attempt DOES return.
async fn run_cmd(bin: &str, args: &[&str], timeout_ms: u64) -> Result<()> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Critical: SIGKILL automatically if the Child value is dropped
        // without being explicitly killed — covers future-cancellation.
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::BackendSpawnFailed(format!("{bin} {args:?}: {e}")))?;

    let wait = child.wait();
    match timeout(Duration::from_millis(timeout_ms), wait).await {
        Ok(Ok(status)) => {
            if !status.success() {
                // Drain stderr for diagnostics. The child has exited; we
                // just slurp its captured pipe.
                let stderr = match child.stderr.take() {
                    Some(mut s) => {
                        use tokio::io::AsyncReadExt;
                        let mut buf = String::new();
                        let _ = s.read_to_string(&mut buf).await;
                        buf
                    }
                    None => String::new(),
                };
                // PRIVACY: the wrapped `snarkjs wtns calculate` step echoes
                // `input.json` (which contains the spending key in clear)
                // on validation failure. Redact the stderr at the point of
                // capture so no raw child stderr can ever enter the
                // `Error` value. Shared with the snarkjs backend via
                // `crate::backend::redact`.
                let safe_stderr = crate::backend::redact::redact_stderr(&stderr);
                return Err(Error::BackendSpawnFailed(format!(
                    "{bin} exited {}: {safe_stderr}",
                    status
                )));
            }
            Ok(())
        }
        Ok(Err(e)) => Err(Error::BackendSpawnFailed(format!("{bin} {args:?} io: {e}"))),
        Err(_elapsed) => {
            tracing::warn!(
                bin,
                args = ?args,
                timeout_ms,
                "prover subprocess exceeded timeout; sending SIGKILL"
            );
            // SIGKILL the child explicitly. We don't wait on it (could
            // hang on uninterruptible sleep); the kill_on_drop fallback
            // catches that when `child` falls out of scope.
            let _ = child.kill().await;
            Err(Error::SnarkjsTimeout(timeout_ms))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BackendKind, Config, DEFAULT_SUBPROCESS_TIMEOUT_MS};
    use said_shielded_pool_types::{AssetId, FieldBytes, Note, TransferWitness};

    /// Zero-leakage regression: when `prove` returns `Err` (here: the
    /// `snarkjs wtns calculate` step fails — either snarkjs is absent, so
    /// spawn errors, or it rejects our dummy wasm), the `SecureTempDir`
    /// guard must STILL remove the scratch dir that held `input.json` (the
    /// spending key in clear). No `.prover-*` dir may survive under the
    /// artifacts dir.
    #[tokio::test]
    async fn prove_error_leaves_no_temp_dir() {
        // Isolated artifacts dir with dummy (non-empty) zkey + wasm so
        // `ensure_exists` passes and we reach the workdir-creating path.
        let base = std::env::temp_dir().join(format!("zl-rapidsnark-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("circuit_final.zkey"), b"not-a-real-zkey").unwrap();
        std::fs::write(base.join("transaction.wasm"), b"not-a-real-wasm").unwrap();

        let cfg = Config {
            port: 0,
            artifacts_dir: base.clone(),
            backend: BackendKind::Rapidsnark,
            // Short cap so even if snarkjs IS present and hangs, the test
            // finishes via timeout-error rather than blocking.
            subprocess_timeout_ms: 2_000.min(DEFAULT_SUBPROCESS_TIMEOUT_MS),
        };
        let backend = RapidsnarkBackend::new(cfg);

        // Minimal deposit witness (no real inputs, one output).
        let mut asset_bytes = [0u8; 32];
        asset_bytes[31] = 0xAA;
        let asset = AssetId(asset_bytes);
        let owner_sk: FieldBytes = [7u8; 32];
        let note = Note {
            amount: 1000,
            asset_id: asset,
            owner_pubkey: [0u8; 32],
            blinding: [3u8; 32],
        };
        let w = TransferWitness {
            input_notes: vec![],
            input_paths: vec![],
            input_indices: vec![],
            output_notes: vec![note],
            spending_key: owner_sk,
            public_amount: -1000,
            asset_id: asset,
            ext_data_hash: [0u8; 32],
        };

        let res = backend.prove(w).await;
        assert!(res.is_err(), "expected prove to fail on dummy artifacts");

        // No leftover scratch dir under the artifacts dir.
        let leftovers: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".prover-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp dir(s) survived prove error: {:?}",
            leftovers.iter().map(|e| e.path()).collect::<Vec<_>>()
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
