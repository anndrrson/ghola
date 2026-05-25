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

use async_trait::async_trait;
use said_shielded_pool_types::{ProofBundle, TransferWitness};
use tokio::process::Command;

use crate::backend::Backend;
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

        let workdir = tempdir_under(&self.cfg.artifacts_dir)?;
        let input_json = workdir.join("input.json");
        let witness_wtns = workdir.join("witness.wtns");
        let proof_json = workdir.join("proof.json");
        let public_json = workdir.join("public.json");

        let circom_input = serde_json::to_value(&witness)?;
        tokio::fs::write(&input_json, serde_json::to_vec_pretty(&circom_input)?).await?;

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
        )
        .await?;

        let proof_bytes = tokio::fs::read(&proof_json).await?;
        let public_bytes = tokio::fs::read(&public_json).await?;

        // Shared parsing with snarkjs — same JSON wire format.
        let bundle = super::snarkjs::__parse_for_rapidsnark(&proof_bytes, &public_bytes, &witness)?;

        let _ = tokio::fs::remove_dir_all(&workdir).await;
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

fn tempdir_under(base: &PathBuf) -> Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!(".prover-rs-{nanos}"));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

async fn run_cmd(bin: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .await
        .map_err(|e| Error::BackendSpawnFailed(format!("{bin} {args:?}: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(Error::BackendSpawnFailed(format!(
            "{bin} exited {}: {stderr}",
            out.status
        )));
    }
    Ok(())
}
