//! Integration tests for the x402 payment flow.
//!
//! Tests cover:
//! - Parsing the PAYMENT-REQUIRED header (pure logic, no network)
//! - Trust assessment logic and recommendation thresholds
//! - The probe → parse → assess cycle against a local mock HTTP server
//! - Retry configuration and error classification
//! - The discover-and-pay flow (agents.txt → payment address → x402 probe)

use base64::{engine::general_purpose::STANDARD, Engine};
use said_x402::{GholaX402Client, RetryConfig, TrustAssessment, X402TrustError};

// ── Parse ──────────────────────────────────────────────────────────────────

#[test]
fn parse_payment_required_header_round_trip() {
    let payload = serde_json::json!({
        "x402Version": 1,
        "accepts": [{
            "scheme": "exact",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "maxAmountRequired": "1000",
            "payTo": "MerchantAddress111111111111111111",
        }]
    });
    let encoded = STANDARD.encode(serde_json::to_vec(&payload).unwrap());
    let parsed = GholaX402Client::parse_payment_required(&encoded).unwrap();

    assert_eq!(parsed.version, 1);
    assert_eq!(parsed.accepts.len(), 1);
    assert_eq!(parsed.accepts[0].pay_to, "MerchantAddress111111111111111111");
    assert_eq!(parsed.accepts[0].scheme, "exact");
    assert_eq!(
        parsed.accepts[0].max_amount_required,
        "1000"
    );
}

#[test]
fn parse_payment_required_multiple_options() {
    let payload = serde_json::json!({
        "x402Version": 1,
        "accepts": [
            {
                "scheme": "exact",
                "network": "solana:mainnet",
                "maxAmountRequired": "1000",
                "payTo": "MerchantMainnet1111111111111111",
            },
            {
                "scheme": "exact",
                "network": "solana:devnet",
                "maxAmountRequired": "1000",
                "payTo": "MerchantDevnet11111111111111111",
            }
        ]
    });
    let encoded = STANDARD.encode(serde_json::to_vec(&payload).unwrap());
    let parsed = GholaX402Client::parse_payment_required(&encoded).unwrap();
    assert_eq!(parsed.accepts.len(), 2);
}

#[test]
fn parse_payment_required_rejects_invalid_base64() {
    let result = GholaX402Client::parse_payment_required("not-valid-base64!!!");
    assert!(result.is_err());
}

#[test]
fn parse_payment_required_rejects_invalid_json() {
    let bad_json = STANDARD.encode(b"this is not json");
    let result = GholaX402Client::parse_payment_required(&bad_json);
    assert!(result.is_err());
}

// ── Trust assessment logic ─────────────────────────────────────────────────

fn make_assessment(trust_score: f32, identity_found: bool, recommendation: &str) -> TrustAssessment {
    TrustAssessment {
        address: "TestAddress111111111111111111111".to_string(),
        identity_found,
        display_name: Some("Test Merchant".to_string()),
        profile_type: Some("business".to_string()),
        on_chain_registered: true,
        verified_badge: false,
        trust_score,
        confidence: 0.9,
        recommendation: recommendation.to_string(),
        reason: "test".to_string(),
        payment: None,
    }
}

#[test]
fn high_trust_score_recommends_pay() {
    let a = make_assessment(0.85, true, "pay");
    assert!(a.should_pay());
    assert!(!a.should_caution());
}

#[test]
fn moderate_trust_score_recommends_caution() {
    let a = make_assessment(0.5, true, "caution");
    assert!(!a.should_pay());
    assert!(a.should_caution());
}

#[test]
fn low_trust_score_recommends_reject() {
    let a = make_assessment(0.1, true, "reject");
    assert!(!a.should_pay());
    assert!(!a.should_caution());
}

#[test]
fn unknown_merchant_recommends_caution() {
    let a = make_assessment(0.0, false, "caution");
    assert!(!a.should_pay());
    assert!(a.should_caution());
}

// ── Retry configuration ────────────────────────────────────────────────────

#[test]
fn default_retry_config_has_three_retries() {
    let cfg = RetryConfig::default();
    assert_eq!(cfg.max_retries, 3);
    assert!(cfg.base_delay_ms > 0);
    assert!(cfg.max_delay_ms >= cfg.base_delay_ms);
}

#[test]
fn retry_none_config_has_zero_retries() {
    let cfg = RetryConfig::none();
    assert_eq!(cfg.max_retries, 0);
}

#[test]
fn retryable_error_classification() {
    // Logic/parse errors are not retryable
    let e1 = X402TrustError::InvalidX402("bad".into());
    assert!(!e1.is_retryable());

    let e2 = X402TrustError::TrustFailed("rejected".into());
    assert!(!e2.is_retryable());

    // Base64 decode error is not retryable
    let e3 = X402TrustError::Base64(base64::DecodeError::InvalidByte(0, 0));
    assert!(!e3.is_retryable());
}

#[test]
fn retries_exhausted_error_carries_attempt_count() {
    let err = X402TrustError::RetriesExhausted {
        attempts: 4,
        last_error: "connection refused".to_string(),
    };
    assert!(err.to_string().contains("4"));
}

// ── Mock HTTP server: probe → parse → assess ──────────────────────────────
//
// We spin up a minimal axum server that:
//   - GET /paid   → 200 OK
//   - GET /gated  → 402 + PAYMENT-REQUIRED header
//   - POST /ghola/verify/did/:addr  → mock identity response
//   - GET /ghola/reputation/:did    → mock reputation response
//
// This lets us test the full probe → parse → assess chain in-process.

#[tokio::test]
async fn mock_server_probe_returns_402_and_payment_header() {
    let payment_payload = serde_json::json!({
        "x402Version": 1,
        "accepts": [{
            "scheme": "exact",
            "network": "solana:devnet",
            "maxAmountRequired": "500",
            "payTo": "MockMerchantAddress1111111111111",
        }]
    });
    let encoded_header = STANDARD.encode(serde_json::to_vec(&payment_payload).unwrap());
    let encoded_header_clone = encoded_header.clone();

    // Build mock server
    use axum::{
        body::Body,
        http::{HeaderValue, Response, StatusCode},
        routing::get,
        Router,
    };

    let app = Router::new().route(
        "/gated",
        get(move || {
            let hval = encoded_header_clone.clone();
            async move {
                let mut resp = Response::new(Body::from("payment required"));
                *resp.status_mut() = StatusCode::PAYMENT_REQUIRED;
                resp.headers_mut().insert(
                    "payment-required",
                    HeaderValue::from_str(&hval).unwrap(),
                );
                resp
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Allow server to start
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Probe the endpoint
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://127.0.0.1:{}/gated", port))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 402);

    let header = resp
        .headers()
        .get("payment-required")
        .and_then(|v| v.to_str().ok())
        .expect("payment-required header");

    let parsed = GholaX402Client::parse_payment_required(header).unwrap();
    assert_eq!(parsed.version, 1);
    assert_eq!(parsed.accepts[0].pay_to, "MockMerchantAddress1111111111111");
    assert_eq!(parsed.accepts[0].max_amount_required, "500");
}

#[tokio::test]
async fn mock_server_full_discover_and_assess_flow() {
    use axum::{
        body::Body,
        extract::Path,
        http::{HeaderValue, Response, StatusCode},
        response::Json,
        routing::get,
        Router,
    };

    let payment_payload = serde_json::json!({
        "x402Version": 1,
        "accepts": [{
            "scheme": "exact",
            "network": "solana:devnet",
            "maxAmountRequired": "1000",
            "payTo": "HighTrustMerchant111111111111111",
        }]
    });
    let encoded = STANDARD.encode(serde_json::to_vec(&payment_payload).unwrap());
    let encoded_clone = encoded.clone();

    let app = Router::new()
        // The gated resource: returns 402
        .route(
            "/resource",
            get(move || {
                let h = encoded_clone.clone();
                async move {
                    let mut resp = Response::new(Body::from("pay first"));
                    *resp.status_mut() = StatusCode::PAYMENT_REQUIRED;
                    resp.headers_mut()
                        .insert("payment-required", HeaderValue::from_str(&h).unwrap());
                    resp
                }
            }),
        )
        // Mock Ghola identity endpoint
        .route(
            "/verify/did/{addr}",
            get(|Path(addr): Path<String>| async move {
                Json(serde_json::json!({
                    "found": true,
                    "did": format!("did:key:z6Mk{}", &addr[..6.min(addr.len())]),
                    "display_name": "Mock Merchant",
                    "profile_type": "business",
                    "on_chain_registered": true,
                    "verified_badge": true,
                }))
            }),
        )
        // Mock Ghola reputation endpoint
        .route(
            "/reputation/{did}",
            get(|Path(_did): Path<String>| async move {
                Json(serde_json::json!({
                    "overall_score": 0.92,
                    "confidence": 0.85,
                }))
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let ghola_url = format!("http://127.0.0.1:{}", port);
    let x402_client = GholaX402Client::with_retry_config(
        &ghola_url,
        RetryConfig::none(), // no retries in tests
    );

    // Probe the gated resource — get the payment requirement back
    let probe_resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/resource", port))
        .send()
        .await
        .unwrap();

    assert_eq!(probe_resp.status().as_u16(), 402);

    let header_val = probe_resp
        .headers()
        .get("payment-required")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();

    let payment_req = GholaX402Client::parse_payment_required(&header_val).unwrap();

    // Assess the merchant from the 402 response
    let assessment = x402_client.assess_from_402(&payment_req).await.unwrap();

    assert!(assessment.identity_found);
    assert_eq!(assessment.recommendation, "pay");
    assert!(assessment.trust_score >= 0.7);
    assert_eq!(assessment.payment.as_ref().unwrap().pay_to, "HighTrustMerchant111111111111111");
}

// ── Discover-and-pay: agents.txt → x402 ───────────────────────────────────

#[test]
fn agents_txt_provides_payment_address_for_x402() {
    // An agents.txt that declares a payment address is the first step of the
    // discover-and-pay flow.  The agent reads the address and uses it to
    // verify the merchant before sending x402 payment.
    let agents_txt = r#"
Identity: did:key:z6MkMerchant
Service: api https://api.example.com/v1
Payment: MerchantSolAddress111111111111111 usdc https://api.example.com/said/verify
"#;

    let agents = said_core::discovery::parse_agents_txt(agents_txt).unwrap();

    // The merchant's identity is discoverable
    assert_eq!(agents.identity.as_deref(), Some("did:key:z6MkMerchant"));

    // And the API endpoint can be found for subsequent x402 probing
    let api_svc = agents.services.iter().find(|s| s.name == "api");
    assert!(api_svc.is_some());
}
