//! Thin Solana JSON-RPC client used by the backfill scanner and the
//! forester's queue watcher.
//!
//! We deliberately avoid pulling in `solana-client`/`anchor-client` here:
//! - The crate already needs to talk to a generic HTTP prover service,
//!   so `reqwest` is mandatory anyway.
//! - The Solana RPC surface we actually use is small: `getSignaturesForAddress`,
//!   `getTransaction`, `getAccountInfo`, `sendTransaction`, `getLatestBlockhash`.
//! - Pulling `solana-client` would bring in a heavy native dep tree that
//!   none of the other ghola workspace crates need.
//!
//! When we eventually need on-chain transaction construction for the
//! forester `update_root_via_proof` ix, this module will gain a Borsh-encoded
//! ix builder that mirrors the on-chain program's instruction layout.
//! For now the forester is wired up to that path as a stub that returns
//! `Error::Prover("forester tx submission not yet implemented")`.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Clone)]
pub struct SolanaRpcClient {
    http: reqwest::Client,
    url: String,
}

impl SolanaRpcClient {
    pub fn new(url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            http,
            url: url.into(),
        }
    }

    /// `getAccountInfo(pubkey, { encoding: "base64" })`. Returns `None` if
    /// the account does not exist.
    pub async fn get_account_data(&self, pubkey_b58: &str) -> Result<Option<Vec<u8>>> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAccountInfo",
            "params": [pubkey_b58, { "encoding": "base64" }],
        });
        let resp: JsonRpcEnvelope<AccountInfoResp> = self.post(&body).await?;
        let val = match resp.result.value {
            Some(v) => v,
            None => return Ok(None),
        };
        // data is [base64, "base64"]
        let b64 = val
            .data
            .first()
            .ok_or_else(|| Error::SolanaRpc("account data array empty".into()))?;
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| Error::SolanaRpc(format!("account data base64: {e}")))?;
        Ok(Some(bytes))
    }

    /// `getSignaturesForAddress(program, { limit, before })`.
    /// Returns confirmed signatures in newest-first order.
    pub async fn get_signatures_for_address(
        &self,
        address_b58: &str,
        limit: u32,
        before: Option<&str>,
    ) -> Result<Vec<SignatureRecord>> {
        let mut params = serde_json::Map::new();
        params.insert("limit".into(), serde_json::json!(limit));
        if let Some(b) = before {
            params.insert("before".into(), serde_json::json!(b));
        }
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSignaturesForAddress",
            "params": [address_b58, params],
        });
        let resp: JsonRpcEnvelope<Vec<SignatureRecord>> = self.post(&body).await?;
        Ok(resp.result)
    }

    /// `getLatestBlockhash` — returns the 32-byte recent blockhash.
    /// Used by the forester's transaction submitter (see
    /// `crate::forester::mod::submit_root_update_tx`).
    pub async fn get_latest_blockhash(&self) -> Result<[u8; 32]> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getLatestBlockhash",
            "params": [{ "commitment": "confirmed" }],
        });
        let resp: JsonRpcEnvelope<serde_json::Value> = self.post(&body).await?;
        let s = resp.result["value"]["blockhash"]
            .as_str()
            .ok_or_else(|| Error::SolanaRpc("missing blockhash".into()))?
            .to_string();
        let bytes = bs58::decode(&s)
            .into_vec()
            .map_err(|e| Error::SolanaRpc(format!("bs58 blockhash: {e}")))?;
        bytes
            .try_into()
            .map_err(|_: Vec<u8>| Error::SolanaRpc("blockhash != 32 bytes".into()))
    }

    /// `sendTransaction(base64_tx, { encoding, preflightCommitment, skipPreflight })`.
    /// Returns the signature (base58) on success.
    pub async fn send_transaction_base64(
        &self,
        tx_b64: &str,
        skip_preflight: bool,
    ) -> Result<String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [
                tx_b64,
                {
                    "encoding": "base64",
                    "preflightCommitment": "confirmed",
                    "skipPreflight": skip_preflight,
                }
            ],
        });
        let resp: JsonRpcEnvelope<serde_json::Value> = self.post(&body).await?;
        resp.result
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| Error::SolanaRpc("missing signature".into()))
    }

    /// `getSignatureStatuses([sig], {searchTransactionHistory: false})`.
    /// Returns Ok(Some(("confirmed"|"finalized", err))) once the signature is
    /// known, Ok(None) if not yet observed.
    pub async fn get_signature_status(
        &self,
        signature_b58: &str,
    ) -> Result<Option<(String, Option<serde_json::Value>)>> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSignatureStatuses",
            "params": [[signature_b58], { "searchTransactionHistory": false }],
        });
        let resp: JsonRpcEnvelope<serde_json::Value> = self.post(&body).await?;
        let arr = resp.result["value"]
            .as_array()
            .ok_or_else(|| Error::SolanaRpc("value not array".into()))?;
        let first = arr.first().ok_or_else(|| Error::SolanaRpc("empty status array".into()))?;
        if first.is_null() {
            return Ok(None);
        }
        let conf = first
            .get("confirmationStatus")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let err = first.get("err").filter(|v| !v.is_null()).cloned();
        Ok(Some((conf, err)))
    }

    /// `getTransaction(sig, { encoding: "json", maxSupportedTransactionVersion: 0 })`.
    pub async fn get_transaction(&self, signature_b58: &str) -> Result<Option<TransactionResp>> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [signature_b58, {
                "encoding": "json",
                "maxSupportedTransactionVersion": 0,
                "commitment": "confirmed",
            }],
        });
        let resp: JsonRpcEnvelope<Option<TransactionResp>> = self.post(&body).await?;
        Ok(resp.result)
    }

    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        body: &serde_json::Value,
    ) -> Result<JsonRpcEnvelope<T>> {
        let resp = self.http.post(&self.url).json(body).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(Error::SolanaRpc(format!("{status}: {text}")));
        }
        // Check for { "error": {...} } before parsing into the expected envelope.
        let raw: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| Error::SolanaRpc(format!("json: {e}; body={text}")))?;
        if let Some(err) = raw.get("error") {
            return Err(Error::SolanaRpc(err.to_string()));
        }
        let env: JsonRpcEnvelope<T> = serde_json::from_value(raw)
            .map_err(|e| Error::SolanaRpc(format!("envelope: {e}")))?;
        Ok(env)
    }
}

#[derive(Debug, Deserialize)]
pub struct JsonRpcEnvelope<T> {
    pub result: T,
    #[allow(dead_code)]
    #[serde(default)]
    pub id: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AccountInfoResp {
    #[serde(default)]
    pub context: serde_json::Value,
    #[serde(default)]
    pub value: Option<AccountInfo>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AccountInfo {
    /// `[base64, "base64"]`
    pub data: Vec<String>,
    pub executable: bool,
    pub lamports: u64,
    pub owner: String,
    #[serde(default)]
    pub rent_epoch: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SignatureRecord {
    pub signature: String,
    #[serde(default)]
    pub slot: Option<u64>,
    #[serde(default)]
    pub err: Option<serde_json::Value>,
    #[serde(default)]
    pub block_time: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TransactionResp {
    pub slot: u64,
    #[serde(default)]
    pub meta: Option<TransactionMeta>,
    #[serde(default)]
    pub transaction: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TransactionMeta {
    #[serde(default)]
    pub err: Option<serde_json::Value>,
    /// Anchor logs come through here as `Program data: <base64>` lines.
    #[serde(default)]
    pub log_messages: Option<Vec<String>>,
}
