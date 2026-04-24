//! Ghola trust layer for x402 agent payments.
//!
//! Wraps the x402 payment flow with pre-payment trust verification via Ghola.
//! Agents use this to check merchant identity and reputation BEFORE signing a payment.
//!
//! # Retry behavior
//! `GholaX402Client` retries transient HTTP errors (connection refused, timeout) with
//! exponential backoff.  Trust-logic failures (low score, identity not found) are never
//! retried — they represent a definitive answer from the registry.
//!
//! # Fallback
//! The cloud API (`ghola_api`) is itself the authoritative fallback for on-chain data:
//! if the Solana RPC is unreachable, the cloud registry still serves cached identity and
//! reputation data.  No additional fallback layer is needed in this crate.
//!
//! # Example
//! ```ignore
//! let client = GholaX402Client::new("https://ghola-api.onrender.com/v1");
//! let assessment = client.assess_merchant("payTo_solana_address").await?;
//! if assessment.should_pay() {
//!     // proceed with x402 payment
//! }
//! ```

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

/// The payment proof sent in the `x402-Payment` request header.
///
/// After executing a Solana transfer, the agent encodes this as base64 JSON
/// and adds it to the retry request so the server can verify payment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X402PaymentPayload {
    #[serde(rename = "x402Version")]
    pub version: u32,
    pub scheme: String,
    pub network: String,
    pub payload: X402SolanaPayload,
}

/// Inner Solana-specific payment proof fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X402SolanaPayload {
    /// Base58 transaction signature returned by sendTransaction.
    pub signature: String,
    /// Base58 public key of the account that sent the payment.
    pub from: String,
}

impl X402PaymentPayload {
    /// Build a payment payload from a completed Solana transaction.
    pub fn from_solana_tx(network: &str, signature: &str, from_pubkey: &str) -> Self {
        Self {
            version: 1,
            scheme: "exact".to_string(),
            network: network.to_string(),
            payload: X402SolanaPayload {
                signature: signature.to_string(),
                from: from_pubkey.to_string(),
            },
        }
    }

    /// Encode as base64 JSON for the `x402-Payment` HTTP header.
    pub fn encode(&self) -> Result<String, X402TrustError> {
        let json = serde_json::to_vec(self)?;
        Ok(STANDARD.encode(json))
    }
}

// ── Retry configuration ────────────────────────────────────────────────────

/// Configuration for retry behavior in x402 HTTP operations.
#[derive(Clone, Debug)]
pub struct RetryConfig {
    /// Maximum number of additional attempts after the first (0 = no retries).
    pub max_retries: u32,
    /// Base delay in milliseconds; doubled on each attempt (exponential backoff).
    pub base_delay_ms: u64,
    /// Maximum delay cap in milliseconds.
    pub max_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 200,
            max_delay_ms: 5_000,
        }
    }
}

impl RetryConfig {
    /// No retries — fail immediately on first error.
    pub fn none() -> Self {
        Self {
            max_retries: 0,
            base_delay_ms: 0,
            max_delay_ms: 0,
        }
    }
}

// ── x402 types ────────────────────────────────────────────────────────────

/// x402 PaymentRequired response (parsed from the PAYMENT-REQUIRED header).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X402PaymentRequired {
    #[serde(rename = "x402Version")]
    pub version: u32,
    pub accepts: Vec<X402PaymentOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X402PaymentOption {
    pub scheme: String,
    pub network: String,
    #[serde(rename = "maxAmountRequired")]
    pub max_amount_required: String,
    pub resource: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "payTo")]
    pub pay_to: String,
    pub extra: Option<serde_json::Value>,
}

/// Trust assessment result from Ghola.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustAssessment {
    /// The address being assessed (from x402 payTo field).
    pub address: String,
    /// Whether a matching identity was found in Ghola.
    pub identity_found: bool,
    /// Display name of the merchant (if found).
    pub display_name: Option<String>,
    /// Profile type: "business", "consumer", or None.
    pub profile_type: Option<String>,
    /// Whether the identity is registered on-chain.
    pub on_chain_registered: bool,
    /// Whether the merchant has a verified badge.
    pub verified_badge: bool,
    /// Overall trust score (0.0 - 1.0).
    pub trust_score: f32,
    /// Confidence in the trust score (0.0 - 1.0).
    pub confidence: f32,
    /// Recommendation: "pay", "caution", or "reject".
    pub recommendation: String,
    /// Human-readable reason for the recommendation.
    pub reason: String,
    /// The x402 payment details (for reference).
    pub payment: Option<X402PaymentOption>,
}

impl TrustAssessment {
    /// Whether the agent should proceed with payment.
    pub fn should_pay(&self) -> bool {
        self.recommendation == "pay"
    }

    /// Whether the agent should exercise caution but may proceed.
    pub fn should_caution(&self) -> bool {
        self.recommendation == "caution"
    }
}

impl X402PaymentRequired {
    /// Find the best payment option for Solana (devnet or mainnet).
    /// Prefers devnet when `is_devnet` is true, falls back to any solana option,
    /// then falls back to the first option.
    pub fn best_solana_option(&self, is_devnet: bool) -> Option<&X402PaymentOption> {
        let devnet_id = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
        let mainnet_id = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
        let preferred = if is_devnet { devnet_id } else { mainnet_id };

        // Exact match first
        if let Some(opt) = self.accepts.iter().find(|o| o.network == preferred) {
            return Some(opt);
        }
        // Any solana network
        if let Some(opt) = self
            .accepts
            .iter()
            .find(|o| o.network.starts_with("solana:"))
        {
            return Some(opt);
        }
        self.accepts.first()
    }

    /// Parse `max_amount_required` as micro-USDC (u64).
    /// The field may be an integer string like "1000" or a decimal like "1.5".
    pub fn parse_amount(amount_str: &str) -> Option<u64> {
        if let Ok(v) = amount_str.parse::<u64>() {
            return Some(v);
        }
        // Fallback: parse as float and truncate
        amount_str.parse::<f64>().ok().map(|v| v as u64)
    }
}

// ── Error types ────────────────────────────────────────────────────────────

/// Error types for x402 trust operations.
#[derive(Debug, thiserror::Error)]
pub enum X402TrustError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid x402 response: {0}")]
    InvalidX402(String),
    #[error("Trust check failed: {0}")]
    TrustFailed(String),
    #[error("Base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
    /// Returned when all retry attempts are exhausted.
    #[error("All {attempts} retry attempt(s) failed; last error: {last_error}")]
    RetriesExhausted { attempts: u32, last_error: String },
}

impl X402TrustError {
    /// Returns true for transient errors that are safe to retry.
    pub fn is_retryable(&self) -> bool {
        match self {
            // Retry on connection/timeout; not on 4xx or logic failures.
            X402TrustError::Http(e) => e.is_connect() || e.is_timeout() || e.is_request(),
            _ => false,
        }
    }
}

// ── Internal retry helper ──────────────────────────────────────────────────

/// Execute `f` up to `1 + config.max_retries` times, sleeping between attempts.
/// Only retries when `X402TrustError::is_retryable()` returns true.
async fn retry_op<F, Fut, T>(config: &RetryConfig, f: F) -> Result<T, X402TrustError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, X402TrustError>>,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < config.max_retries && e.is_retryable() => {
                let delay = std::cmp::min(
                    config.base_delay_ms.saturating_mul(1u64 << attempt),
                    config.max_delay_ms,
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                attempt += 1;
            }
            Err(e) => {
                if attempt > 0 {
                    return Err(X402TrustError::RetriesExhausted {
                        attempts: attempt + 1,
                        last_error: e.to_string(),
                    });
                }
                return Err(e);
            }
        }
    }
}

// ── Client ────────────────────────────────────────────────────────────────

/// Ghola x402 trust client — verifies merchant identity before payment.
pub struct GholaX402Client {
    ghola_api: String,
    http: reqwest::Client,
    retry: RetryConfig,
}

impl GholaX402Client {
    /// Create a new client with default retry settings.
    pub fn new(ghola_api_url: &str) -> Self {
        Self {
            ghola_api: ghola_api_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            retry: RetryConfig::default(),
        }
    }

    /// Create a new client with a custom retry configuration.
    pub fn with_retry_config(ghola_api_url: &str, retry: RetryConfig) -> Self {
        Self {
            ghola_api: ghola_api_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            retry,
        }
    }

    /// Parse an x402 PaymentRequired header (base64 JSON).
    pub fn parse_payment_required(
        header_value: &str,
    ) -> Result<X402PaymentRequired, X402TrustError> {
        let bytes = STANDARD.decode(header_value)?;
        let parsed: X402PaymentRequired = serde_json::from_slice(&bytes)?;
        Ok(parsed)
    }

    /// Assess a merchant by their Solana address (from x402 payTo field).
    /// Returns a trust assessment with a recommendation.
    /// Retries transient HTTP errors with exponential backoff.
    pub async fn assess_merchant(&self, address: &str) -> Result<TrustAssessment, X402TrustError> {
        // 1. Check identity in Ghola cloud registry (which caches on-chain data as
        //    a fallback when the Solana RPC is unreachable).
        let did_url = format!("{}/verify/did/{}", self.ghola_api, address);
        let http = self.http.clone();

        let did_data: serde_json::Value = retry_op(&self.retry, || {
            let url = did_url.clone();
            let h = http.clone();
            async move {
                let resp = h
                    .get(&url)
                    .timeout(std::time::Duration::from_secs(10))
                    .send()
                    .await?;
                let data: serde_json::Value = resp.json().await.unwrap_or_default();
                Ok(data)
            }
        })
        .await
        .unwrap_or_default();

        let identity_found = did_data
            .get("found")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let display_name = did_data
            .get("display_name")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let profile_type = did_data
            .get("profile_type")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let on_chain = did_data
            .get("on_chain_registered")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let verified = did_data
            .get("verified_badge")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // 2. Get reputation score if identity was found.
        let (trust_score, confidence) = if identity_found {
            let did = did_data
                .get("did")
                .and_then(|v| v.as_str())
                .unwrap_or(address)
                .to_string();
            let rep_url = format!("{}/reputation/{}", self.ghola_api, did);
            let http2 = self.http.clone();

            let rep_data: serde_json::Value = retry_op(&self.retry, || {
                let url = rep_url.clone();
                let h = http2.clone();
                async move {
                    let resp = h
                        .get(&url)
                        .timeout(std::time::Duration::from_secs(10))
                        .send()
                        .await?;
                    let data: serde_json::Value = resp.json().await.unwrap_or_default();
                    Ok(data)
                }
            })
            .await
            .unwrap_or_default();

            let score = rep_data
                .get("overall_score")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as f32;
            let conf = rep_data
                .get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as f32;
            (score, conf)
        } else {
            (0.0, 0.0)
        };

        // 3. Make recommendation.
        let (recommendation, reason) = if !identity_found {
            (
                "caution".to_string(),
                "Merchant not found in Ghola registry. Proceed with caution — unverified merchant."
                    .to_string(),
            )
        } else if trust_score >= 0.7 {
            (
                "pay".to_string(),
                format!(
                    "Merchant verified with trust score {:.2}. Safe to proceed.",
                    trust_score
                ),
            )
        } else if trust_score >= 0.3 {
            (
                "caution".to_string(),
                format!(
                    "Merchant found but trust score is moderate ({:.2}). Consider the amount before proceeding.",
                    trust_score
                ),
            )
        } else {
            (
                "reject".to_string(),
                format!(
                    "Merchant has low trust score ({:.2}). Payment not recommended.",
                    trust_score
                ),
            )
        };

        Ok(TrustAssessment {
            address: address.to_string(),
            identity_found,
            display_name,
            profile_type,
            on_chain_registered: on_chain,
            verified_badge: verified,
            trust_score,
            confidence,
            recommendation,
            reason,
            payment: None,
        })
    }

    /// Assess a merchant from an x402 PaymentRequired response.
    /// Extracts the payTo address and runs the trust check.
    pub async fn assess_from_402(
        &self,
        payment_required: &X402PaymentRequired,
    ) -> Result<TrustAssessment, X402TrustError> {
        let option = payment_required.accepts.first().ok_or_else(|| {
            X402TrustError::InvalidX402("No payment options in 402 response".into())
        })?;

        let mut assessment = self.assess_merchant(&option.pay_to).await?;
        assessment.payment = Some(option.clone());
        Ok(assessment)
    }

    /// Full probe → parse → assess flow against a URL.
    ///
    /// Sends an initial GET; if it returns 402, parses the PAYMENT-REQUIRED header
    /// and runs the trust assessment.  Does NOT sign or submit a payment.
    /// The caller decides whether to proceed based on the returned `TrustAssessment`.
    pub async fn check_before_pay(
        &self,
        url: &str,
    ) -> Result<(TrustAssessment, X402PaymentRequired), X402TrustError> {
        let url_owned = url.to_string();
        let http = self.http.clone();

        // Probe the endpoint — retry transient failures.
        let payment_required = retry_op(&self.retry, || {
            let url_owned = url_owned.clone();
            let http = http.clone();
            async move {
                let resp = http
                    .get(&url_owned)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await?;

                if resp.status().as_u16() != 402 {
                    return Err(X402TrustError::InvalidX402(format!(
                        "Expected HTTP 402, got {}",
                        resp.status()
                    )));
                }

                let header = resp
                    .headers()
                    .get("payment-required")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| {
                        X402TrustError::InvalidX402("Missing PAYMENT-REQUIRED header".into())
                    })?
                    .to_string();

                Self::parse_payment_required(&header)
            }
        })
        .await?;

        let assessment = self.assess_from_402(&payment_required).await?;
        Ok((assessment, payment_required))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_assessment_recommendations() {
        let mut a = TrustAssessment {
            address: "test".into(),
            identity_found: true,
            display_name: Some("Test".into()),
            profile_type: Some("business".into()),
            on_chain_registered: false,
            verified_badge: false,
            trust_score: 0.8,
            confidence: 0.5,
            recommendation: "pay".into(),
            reason: "test".into(),
            payment: None,
        };

        assert!(a.should_pay());
        assert!(!a.should_caution());

        a.recommendation = "caution".into();
        assert!(!a.should_pay());
        assert!(a.should_caution());
    }

    #[test]
    fn test_parse_payment_required() {
        let payload = serde_json::json!({
            "x402Version": 1,
            "accepts": [{
                "scheme": "exact",
                "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                "maxAmountRequired": "1000",
                "payTo": "SoMeAdDrEsS123",
            }]
        });

        let encoded = STANDARD.encode(serde_json::to_vec(&payload).unwrap());
        let parsed = GholaX402Client::parse_payment_required(&encoded).unwrap();

        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.accepts.len(), 1);
        assert_eq!(parsed.accepts[0].pay_to, "SoMeAdDrEsS123");
        assert_eq!(parsed.accepts[0].scheme, "exact");
    }

    #[test]
    fn test_retry_config_default() {
        let cfg = RetryConfig::default();
        assert_eq!(cfg.max_retries, 3);
        assert!(cfg.base_delay_ms > 0);
        assert!(cfg.max_delay_ms >= cfg.base_delay_ms);
    }

    #[test]
    fn test_retry_config_none() {
        let cfg = RetryConfig::none();
        assert_eq!(cfg.max_retries, 0);
    }

    #[test]
    fn test_logic_errors_are_not_retryable() {
        let e1 = X402TrustError::InvalidX402("bad".into());
        assert!(!e1.is_retryable());

        let e2 = X402TrustError::TrustFailed("rejected".into());
        assert!(!e2.is_retryable());

        let e3 = X402TrustError::Base64(base64::DecodeError::InvalidByte(0, 0));
        assert!(!e3.is_retryable());
    }

    #[test]
    fn test_retries_exhausted_carries_attempt_count() {
        let err = X402TrustError::RetriesExhausted {
            attempts: 4,
            last_error: "connection refused".to_string(),
        };
        assert!(err.to_string().contains("4"));
    }
}
