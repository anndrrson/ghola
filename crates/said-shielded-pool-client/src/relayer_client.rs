//! HTTP client for the Solana-native shielded-pool relayer.
//!
//! The relayer accepts fully-built withdraw instruction data and account
//! metas, queues the withdrawal, and returns only an opaque queue id plus
//! an ETA. It deliberately does not return the on-chain transaction
//! signature, preserving the request-to-chain unlinkability boundary.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use said_shielded_pool_types::ProofBundle;

use crate::error::{Error, Result};
use crate::tx_builder::{AccountMeta, RawInstruction};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Response returned by the relayer after accepting a shielded withdrawal.
#[derive(Debug, Clone, Deserialize)]
pub struct RelayResponse {
    /// Opaque relayer queue id.
    pub id: String,
    /// Coarse ETA in seconds. This is intentionally approximate.
    pub eta_seconds: u64,
}

#[derive(Debug, Serialize)]
struct RelayRequest {
    proof_bundle: serde_json::Value,
    recipient: String,
    fee: u64,
    relayer_fee: u64,
    instruction_data_hex: String,
    accounts: Vec<RelayAccountMeta>,
}

#[derive(Debug, Serialize)]
struct RelayAccountMeta {
    pubkey: String,
    is_signer: bool,
    is_writable: bool,
}

/// Thin JSON-over-HTTP client for `said-shielded-pool-relayer`.
#[derive(Debug, Clone)]
pub struct RelayerClient {
    base_url: String,
    http: reqwest::Client,
}

impl RelayerClient {
    /// Construct a client for a relayer base URL.
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .expect("reqwest client builder must not fail with default opts");
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    /// Construct with a custom HTTP client.
    pub fn with_http(base_url: impl Into<String>, http: reqwest::Client) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    /// Submit a fully-built withdraw instruction to the relayer.
    pub async fn relay_withdrawal(
        &self,
        proof: &ProofBundle,
        withdraw_ix: &RawInstruction,
        recipient: &[u8; 32],
        fee: u64,
        relayer_fee: u64,
    ) -> Result<RelayResponse> {
        if relayer_fee > fee {
            return Err(Error::Internal("relayer_fee > fee".into()));
        }
        let req = RelayRequest {
            proof_bundle: serde_json::to_value(proof).map_err(Error::Json)?,
            recipient: bs58::encode(recipient).into_string(),
            fee,
            relayer_fee,
            instruction_data_hex: hex::encode(&withdraw_ix.data),
            accounts: withdraw_ix
                .accounts
                .iter()
                .map(relay_account_meta)
                .collect(),
        };
        let resp = self
            .http
            .post(format!("{}/relay", self.base_url))
            .json(&req)
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
        resp.json::<RelayResponse>().await.map_err(Error::ProverHttp)
    }
}

fn relay_account_meta(meta: &AccountMeta) -> RelayAccountMeta {
    RelayAccountMeta {
        pubkey: bs58::encode(meta.pubkey).into_string(),
        is_signer: meta.is_signer,
        is_writable: meta.is_writable,
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut i = max;
        while !s.is_char_boundary(i) && i > 0 {
            i -= 1;
        }
        format!("{}...", &s[..i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_construction_trims_base_url() {
        let c = RelayerClient::new("https://relayer.example.com/");
        assert_eq!(c.base_url, "https://relayer.example.com");
    }

    #[test]
    fn account_meta_converts_to_base58() {
        let meta = AccountMeta {
            pubkey: [1u8; 32],
            is_signer: true,
            is_writable: false,
        };
        let wire = relay_account_meta(&meta);
        assert_eq!(wire.pubkey, bs58::encode([1u8; 32]).into_string());
        assert!(wire.is_signer);
        assert!(!wire.is_writable);
    }
}
