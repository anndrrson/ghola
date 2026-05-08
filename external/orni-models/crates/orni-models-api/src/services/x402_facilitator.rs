//! Thin client for an x402 facilitator (Coinbase's at x402.org/facilitator by
//! default). Verifies and settles X-Payment payloads on behalf of merchants
//! so we don't have to write Solana RPC verification ourselves.
//!
//! Strategic posture: Ghola is a *consumer* of x402 rails (per
//! project_ghola_headless_merchant.md). This client is the integration point.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum FacilitatorError {
    #[error("facilitator http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("facilitator returned non-2xx: {status} body={body}")]
    BadStatus { status: u16, body: String },
    #[error("payment invalid: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize)]
struct VerifyOrSettleRequest<'a> {
    #[serde(rename = "x402Version")]
    x402_version: u8,
    #[serde(rename = "paymentPayload")]
    payment_payload: &'a str, // base64-encoded JSON, exactly as received in X-Payment header
    #[serde(rename = "paymentRequirements")]
    payment_requirements: &'a Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerifyResponse {
    #[serde(default, rename = "isValid")]
    pub is_valid: bool,
    #[serde(default, rename = "invalidReason")]
    pub invalid_reason: Option<String>,
    #[serde(default)]
    pub payer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SettleResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub transaction: Option<String>,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub payer: Option<String>,
    #[serde(default, rename = "errorReason")]
    pub error_reason: Option<String>,
}

#[derive(Clone)]
pub struct X402Client {
    http: reqwest::Client,
    base_url: String,
}

impl X402Client {
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// POST /verify — does the payload satisfy the requirements?
    /// Cheap; does not settle. Use it to fail-fast before kicking off inference.
    pub async fn verify(
        &self,
        payment_payload: &str,
        requirements: &Value,
    ) -> Result<VerifyResponse, FacilitatorError> {
        self.post("/verify", payment_payload, requirements).await
    }

    /// POST /settle — execute the on-chain transfer. Must be called *before*
    /// the merchant grants service so the funds are guaranteed to land.
    pub async fn settle(
        &self,
        payment_payload: &str,
        requirements: &Value,
    ) -> Result<SettleResponse, FacilitatorError> {
        self.post("/settle", payment_payload, requirements).await
    }

    async fn post<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        payment_payload: &str,
        requirements: &Value,
    ) -> Result<T, FacilitatorError> {
        let url = format!("{}{}", self.base_url, path);
        let body = VerifyOrSettleRequest {
            x402_version: 2,
            payment_payload,
            payment_requirements: requirements,
        };
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(FacilitatorError::BadStatus {
                status: status.as_u16(),
                body,
            });
        }
        Ok(resp.json::<T>().await?)
    }
}
