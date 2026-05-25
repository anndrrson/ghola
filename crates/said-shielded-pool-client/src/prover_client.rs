//! HTTP client for the [`said-shielded-pool-prover`] service.
//!
//! The prover speaks a tiny JSON-over-HTTP API:
//!
//! ```text
//! POST /prove
//!   body:     TransferWitness
//!   response: ProofBundle
//!
//! GET /health
//!   response: 200 OK / "ok"
//! ```
//!
//! The client is `Clone` + cheap (wraps an [`Arc`]-flavored `reqwest::Client`).
//!
//! ## Security
//!
//! The witness payload includes the spending key. Use HTTPS only in
//! production. The prover service is trusted-for-availability AND
//! trusted-for-confidentiality. Phase 42 puts it in a TEE; until then,
//! treat the prover endpoint as a privileged service.

use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use said_shielded_pool_types::{
    AssetId, Commitment, Groth16Proof, MerkleRoot, Nullifier, ProofBundle, PublicInputs,
    TransferWitness,
};

use crate::error::{Error, Result};

/// Default request timeout — proofs are slow (5–60s typical).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Wire format returned by `said-shielded-pool-prover`.
#[derive(Debug, Clone, Deserialize)]
struct ProofBundleWire {
    a: String,
    b: String,
    c: String,
    root: String,
    input_nullifiers: Vec<String>,
    output_commitments: Vec<String>,
    public_amount: i128,
    asset_id: String,
    ext_data_hash: String,
}

/// HTTP client for the prover service.
#[derive(Debug, Clone)]
pub struct ProverClient {
    base_url: String,
    http: Client,
}

impl ProverClient {
    /// Build a client pointed at `base_url` (e.g. `https://prover.ghola.xyz`).
    ///
    /// Panics if reqwest can't build a default client (effectively never).
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .expect("reqwest client builder must not fail with default opts");
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    /// Build a client with a custom `reqwest::Client` (testing, custom TLS).
    pub fn with_http(base_url: impl Into<String>, http: Client) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    /// `GET /health`. Returns `Ok(())` on 2xx, `Err` otherwise.
    pub async fn health(&self) -> Result<()> {
        let resp = self
            .http
            .get(format!("{}/health", self.base_url))
            .send()
            .await?;
        let status = resp.status();
        if status.is_success() {
            Ok(())
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(Error::ProverStatus {
                status: status.as_u16(),
                body: truncate(&body, 512),
            })
        }
    }

    /// `POST /prove`. Submits a witness and returns a proof bundle.
    pub async fn prove(&self, witness: &TransferWitness) -> Result<ProofBundle> {
        let resp = self
            .http
            .post(format!("{}/prove", self.base_url))
            .json(witness)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::ProverStatus {
                status: status.as_u16(),
                body: truncate(&body, 1024),
            });
        }
        let parsed: ProofBundleWire = resp.json().await?;
        parsed.into_bundle()
    }
}

impl ProofBundleWire {
    fn into_bundle(self) -> Result<ProofBundle> {
        Ok(ProofBundle {
            proof: Groth16Proof {
                a: hex_to_array::<64>(&self.a)?,
                b: hex_to_array::<128>(&self.b)?,
                c: hex_to_array::<64>(&self.c)?,
            },
            public_inputs: PublicInputs {
                root: MerkleRoot(hex_to_array::<32>(&self.root)?),
                input_nullifiers: self
                    .input_nullifiers
                    .iter()
                    .map(|s| hex_to_array::<32>(s).map(Nullifier))
                    .collect::<Result<Vec<_>>>()?,
                output_commitments: self
                    .output_commitments
                    .iter()
                    .map(|s| hex_to_array::<32>(s).map(Commitment))
                    .collect::<Result<Vec<_>>>()?,
                public_amount: self.public_amount,
                asset_id: AssetId(hex_to_array::<32>(&self.asset_id)?),
                ext_data_hash: hex_to_array::<32>(&self.ext_data_hash)?,
            },
        })
    }
}

fn hex_to_array<const N: usize>(s: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(s)?;
    bytes
        .try_into()
        .map_err(|_| Error::Encoding(format!("expected {N} bytes of hex")))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Don't slice mid-char.
        let mut i = max;
        while !s.is_char_boundary(i) && i > 0 {
            i -= 1;
        }
        format!("{}…", &s[..i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_construction() {
        let c = ProverClient::new("https://prover.example.com/");
        assert_eq!(c.base_url, "https://prover.example.com");
    }

    #[test]
    fn truncate_handles_unicode() {
        let s = "héllo".to_string() + &"x".repeat(2000);
        let t = truncate(&s, 100);
        assert!(t.ends_with('…'));
    }
}
