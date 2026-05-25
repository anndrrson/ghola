//! Configuration parsed from environment variables.
//!
//! - `PROVER_PORT`: TCP port for the axum server (default: 8787).
//! - `ARTIFACTS_DIR`: directory containing `circuit_final.zkey`,
//!    `verification_key.json`, `transaction.wasm`.
//! - `BACKEND`: one of `snarkjs` (default), `rapidsnark`, `gnark`.
//! - `PROVER_SUBPROCESS_TIMEOUT_MS`: hard wall-clock cap on each snarkjs
//!    subprocess invocation (default: 30000 = 30 s). Privacy reason: the
//!    `input.json` written to the temp dir contains the spending key and
//!    blinding factors in clear; capping the subprocess lifetime caps
//!    how long that file can sit on disk before our RAII guard deletes
//!    it. Operationally, this also stops a hung snarkjs from blocking
//!    the forester / client poll loop.

use std::path::PathBuf;

use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendKind {
    Snarkjs,
    Rapidsnark,
    Gnark,
}

impl BackendKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "snarkjs" => Ok(Self::Snarkjs),
            "rapidsnark" => Ok(Self::Rapidsnark),
            "gnark" => Ok(Self::Gnark),
            other => Err(Error::ConfigInvalid(format!(
                "unknown BACKEND={other} (expected snarkjs|rapidsnark|gnark)"
            ))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Snarkjs => "snarkjs",
            Self::Rapidsnark => "rapidsnark",
            Self::Gnark => "gnark",
        }
    }
}

/// Default subprocess timeout (30 seconds). Picked so a sluggish forester
/// proof (worst measured: ~12 s on M1) has ~2x headroom while still
/// bounding the worst-case witness-on-disk window.
pub const DEFAULT_SUBPROCESS_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub artifacts_dir: PathBuf,
    pub backend: BackendKind,
    /// Hard wall-clock cap on each snarkjs subprocess invocation, in
    /// milliseconds. See module-level docs for the privacy rationale.
    pub subprocess_timeout_ms: u64,
}

impl Config {
    /// Load from environment with documented defaults.
    pub fn from_env() -> Result<Self> {
        let port = std::env::var("PROVER_PORT")
            .ok()
            .map(|s| s.parse::<u16>())
            .transpose()
            .map_err(|e| Error::ConfigInvalid(format!("PROVER_PORT: {e}")))?
            .unwrap_or(8787);

        let artifacts_dir = std::env::var("ARTIFACTS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./artifacts"));

        let backend = std::env::var("BACKEND")
            .ok()
            .as_deref()
            .map(BackendKind::parse)
            .transpose()?
            .unwrap_or(BackendKind::Snarkjs);

        let subprocess_timeout_ms = std::env::var("PROVER_SUBPROCESS_TIMEOUT_MS")
            .ok()
            .map(|s| s.parse::<u64>())
            .transpose()
            .map_err(|e| Error::ConfigInvalid(format!("PROVER_SUBPROCESS_TIMEOUT_MS: {e}")))?
            .unwrap_or(DEFAULT_SUBPROCESS_TIMEOUT_MS);

        Ok(Self {
            port,
            artifacts_dir,
            backend,
            subprocess_timeout_ms,
        })
    }

    pub fn zkey_path(&self) -> PathBuf {
        self.artifacts_dir.join("circuit_final.zkey")
    }

    pub fn vk_path(&self) -> PathBuf {
        self.artifacts_dir.join("verification_key.json")
    }

    pub fn wasm_path(&self) -> PathBuf {
        self.artifacts_dir.join("transaction.wasm")
    }

    // ---- forester (batched commitment-insertion) circuit ----
    //
    // Layout convention (matches the ceremony in
    // `crates/said-shielded-pool-circuits/ceremony/`):
    //   - `batchedUpdate_final.zkey` lives ALONGSIDE the ptau files in
    //     the ceremony dir, NOT under artifacts_dir. The prover service
    //     therefore symlinks or copies it next to the transfer artifacts.
    //   - `forester_verification_key.json` and the wasm sit under
    //     `artifacts/` (and `artifacts/batchedUpdate_js/`).

    pub fn forester_zkey_path(&self) -> PathBuf {
        self.artifacts_dir.join("batchedUpdate_final.zkey")
    }

    pub fn forester_vk_path(&self) -> PathBuf {
        self.artifacts_dir.join("forester_verification_key.json")
    }

    pub fn forester_wasm_path(&self) -> PathBuf {
        self.artifacts_dir
            .join("batchedUpdate_js")
            .join("batchedUpdate.wasm")
    }
}
