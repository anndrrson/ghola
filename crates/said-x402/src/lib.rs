//! Ghola trust layer for x402 agent payments.
//!
//! Wraps the x402 payment flow with pre-payment trust verification via Ghola.
//! Agents use this to check merchant identity and reputation BEFORE signing a payment.
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
    pub fn from_solana_tx(
        network: &str,
        signature: &str,
        from_pubkey: &str,
    ) -> Self {
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
        if let Some(opt) = self.accepts.iter().find(|o| o.network.starts_with("solana:")) {
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
}

/// Ghola x402 trust client — verifies merchant identity before payment.
pub struct GholaX402Client {
    ghola_api: String,
    http: reqwest::Client,
}

impl GholaX402Client {
    /// Create a new client pointing at a Ghola API instance.
    pub fn new(ghola_api_url: &str) -> Self {
        Self {
            ghola_api: ghola_api_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    /// Parse an x402 PaymentRequired header (base64 JSON).
    pub fn parse_payment_required(header_value: &str) -> Result<X402PaymentRequired, X402TrustError> {
        let bytes = STANDARD.decode(header_value)?;
        let parsed: X402PaymentRequired = serde_json::from_slice(&bytes)?;
        Ok(parsed)
    }

    /// Assess a merchant by their Solana address (from x402 payTo field).
    /// Returns a trust assessment with a recommendation.
    pub async fn assess_merchant(&self, address: &str) -> Result<TrustAssessment, X402TrustError> {
        // 1. Check if this address is known to Ghola via DID lookup
        let did_resp = self
            .http
            .get(format!("{}/verify/did/{}", self.ghola_api, address))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        let did_data: serde_json::Value = did_resp.json().await.unwrap_or_default();

        let identity_found = did_data.get("found").and_then(|v| v.as_bool()).unwrap_or(false);
        let display_name = did_data.get("display_name").and_then(|v| v.as_str()).map(|s| s.to_string());
        let profile_type = did_data.get("profile_type").and_then(|v| v.as_str()).map(|s| s.to_string());
        let on_chain = did_data.get("on_chain_registered").and_then(|v| v.as_bool()).unwrap_or(false);
        let verified = did_data.get("verified_badge").and_then(|v| v.as_bool()).unwrap_or(false);

        // 2. Get reputation score if identity exists
        let (trust_score, confidence) = if identity_found {
            let did = did_data.get("did").and_then(|v| v.as_str()).unwrap_or(address);
            let rep_resp = self
                .http
                .get(format!("{}/reputation/{}", self.ghola_api, did))
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await?;

            let rep_data: serde_json::Value = rep_resp.json().await.unwrap_or_default();
            let score = rep_data.get("overall_score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let conf = rep_data.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            (score, conf)
        } else {
            (0.0, 0.0)
        };

        // 3. Make recommendation
        let (recommendation, reason) = if !identity_found {
            ("caution".to_string(), "Merchant not found in Ghola registry. Proceed with caution — unverified merchant.".to_string())
        } else if trust_score >= 0.7 {
            ("pay".to_string(), format!("Merchant verified with trust score {:.2}. Safe to proceed.", trust_score))
        } else if trust_score >= 0.3 {
            ("caution".to_string(), format!("Merchant found but trust score is moderate ({:.2}). Consider the amount before proceeding.", trust_score))
        } else {
            ("reject".to_string(), format!("Merchant has low trust score ({:.2}). Payment not recommended.", trust_score))
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
        let option = payment_required
            .accepts
            .first()
            .ok_or_else(|| X402TrustError::InvalidX402("No payment options in 402 response".into()))?;

        let mut assessment = self.assess_merchant(&option.pay_to).await?;
        assessment.payment = Some(option.clone());
        Ok(assessment)
    }

    /// Full flow: send request, get 402, assess trust, return assessment.
    /// Does NOT make the payment — the caller decides based on the assessment.
    pub async fn check_before_pay(
        &self,
        url: &str,
    ) -> Result<(TrustAssessment, X402PaymentRequired), X402TrustError> {
        // Send initial request
        let resp = self
            .http
            .get(url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;

        if resp.status().as_u16() != 402 {
            return Err(X402TrustError::InvalidX402(format!(
                "Expected HTTP 402, got {}",
                resp.status()
            )));
        }

        // Parse the PAYMENT-REQUIRED header
        let header = resp
            .headers()
            .get("payment-required")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                X402TrustError::InvalidX402("Missing PAYMENT-REQUIRED header".into())
            })?;

        let payment_required = Self::parse_payment_required(header)?;
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
}
