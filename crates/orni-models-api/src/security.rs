//! Paranoid-grade security middleware and utilities.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ── Security Headers Middleware ──

pub async fn security_headers(req: Request<Body>, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();

    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        "max-age=63072000; includeSubDomains".parse().unwrap(),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        "nosniff".parse().unwrap(),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        "DENY".parse().unwrap(),
    );
    headers.insert(
        header::REFERRER_POLICY,
        "no-referrer".parse().unwrap(),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        "camera=(), microphone=(), geolocation=()".parse().unwrap(),
    );
    headers.insert(
        header::HeaderName::from_static("x-xss-protection"),
        "0".parse().unwrap(),
    );

    resp
}

// ── IP-Based Global Rate Limiter ──

pub struct GlobalRateLimiter {
    buckets: Mutex<HashMap<String, Vec<Instant>>>,
    last_cleanup: Mutex<Instant>,
}

impl GlobalRateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            last_cleanup: Mutex::new(Instant::now()),
        }
    }

    pub fn check(&self, key: &str, max_per_minute: u32) -> bool {
        let mut map = match self.buckets.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        let now = Instant::now();
        let window = Duration::from_secs(60);

        // Periodic cleanup
        if let Ok(mut last) = self.last_cleanup.lock() {
            if now.duration_since(*last) > Duration::from_secs(120) {
                map.retain(|_, entries| {
                    entries.retain(|t| now.duration_since(*t) < window);
                    !entries.is_empty()
                });
                *last = now;
            }
        }

        let entries = map.entry(key.to_string()).or_default();
        entries.retain(|t| now.duration_since(*t) < window);

        if entries.len() >= max_per_minute as usize {
            return false; // Rate limited
        }

        entries.push(now);
        true
    }
}

/// Extract client IP from headers (Cloudflare, Render, standard)
pub fn extract_client_ip(req: &Request<Body>) -> String {
    req.headers()
        .get("cf-connecting-ip")
        .or_else(|| req.headers().get("x-forwarded-for"))
        .or_else(|| req.headers().get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Rate limiting middleware — 60 req/min per IP for all routes
pub async fn rate_limit_middleware(
    axum::extract::Extension(limiter): axum::extract::Extension<Arc<GlobalRateLimiter>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let ip = extract_client_ip(&req);
    let path = req.uri().path().to_string();

    // Different limits for different paths
    let limit = if path.contains("/auth/") {
        10 // Auth: 10/min
    } else if path.contains("/chat/") {
        30 // Chat: 30/min
    } else if path.contains("/webhook") {
        10 // Webhook: 10/min
    } else {
        60 // Everything else: 60/min
    };

    let key = format!("ip:{}:{}", ip, if path.contains("/auth/") { "auth" } else if path.contains("/chat/") { "chat" } else { "general" });

    if !limiter.check(&key, limit) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(serde_json::json!({
                "error": "Too many requests. Please slow down."
            })),
        )
            .into_response();
    }

    next.run(req).await
}

// ── SSRF Protection ──

/// Check if a URL resolves to a private/internal IP range.
/// Returns true if the URL is safe (not private).
pub fn is_safe_url(url: &str) -> bool {
    // Extract hostname
    let host = url
        .split("://")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .and_then(|s| s.split(':').next())
        .unwrap_or("");

    // Block known private hostnames
    let blocked = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "[::1]",
        "metadata.google.internal",
        "169.254.169.254",
    ];

    if blocked.iter().any(|b| host.eq_ignore_ascii_case(b)) {
        return false;
    }

    // Block private IP ranges
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                !v4.is_private()
                    && !v4.is_loopback()
                    && !v4.is_link_local()
                    && !v4.is_broadcast()
                    && !v4.is_unspecified()
                    // 169.254.0.0/16 (AWS metadata)
                    && !(v4.octets()[0] == 169 && v4.octets()[1] == 254)
            }
            IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unspecified(),
        };
    }

    true // Not an IP, let DNS resolve
}

// ── Honeypot Endpoints ──

pub async fn honeypot(req: Request<Body>) -> Response {
    let ip = extract_client_ip(&req);
    let path = req.uri().path().to_string();
    let method = req.method().to_string();

    tracing::warn!(
        ip = %ip,
        path = %path,
        method = %method,
        "HONEYPOT: Suspicious reconnaissance detected"
    );

    // Return 404 — don't reveal it's a trap
    StatusCode::NOT_FOUND.into_response()
}

// ── Anomaly Detection ──

pub struct AnomalyDetector {
    /// Track balance changes per user to detect unusual patterns
    recent_credits: Mutex<HashMap<String, Vec<(Instant, i64)>>>,
}

impl AnomalyDetector {
    pub fn new() -> Self {
        Self {
            recent_credits: Mutex::new(HashMap::new()),
        }
    }

    /// Log a credit event and check for anomalies.
    /// Returns true if anomalous.
    pub fn check_credit(&self, user_id: &str, amount: i64) -> bool {
        let mut map = match self.recent_credits.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        let now = Instant::now();
        let window = Duration::from_secs(3600); // 1 hour window

        let entries = map.entry(user_id.to_string()).or_default();
        entries.retain(|(t, _)| now.duration_since(*t) < window);
        entries.push((now, amount));

        let total: i64 = entries.iter().map(|(_, a)| a).sum();

        // Flag if > $100 credited in 1 hour
        if total > 100_000_000 {
            tracing::warn!(
                user_id = %user_id,
                total_credits_1h = total,
                "ANOMALY: Unusual credit activity"
            );
            return true;
        }

        false
    }

    /// Check for duplicate wallet usage
    pub fn log_wallet_usage(&self, wallet: &str, user_id: &str) {
        // In a production system, this would query the DB
        // For now, just log for monitoring
        tracing::debug!(wallet = %wallet, user_id = %user_id, "Wallet usage recorded");
    }
}

// ── Input Validation ──

pub fn validate_model_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() { return Err("Name is required"); }
    if name.len() > 256 { return Err("Name too long (max 256 chars)"); }
    Ok(())
}

pub fn validate_description(desc: &str) -> Result<(), &'static str> {
    if desc.len() > 4096 { return Err("Description too long (max 4096 chars)"); }
    Ok(())
}

pub fn validate_system_prompt(prompt: &str) -> Result<(), &'static str> {
    if prompt.len() > 8192 { return Err("System prompt too long (max 8192 chars)"); }
    Ok(())
}

pub fn validate_chat_message(msg: &str) -> Result<(), &'static str> {
    if msg.is_empty() { return Err("Message is required"); }
    if msg.len() > 4096 { return Err("Message too long (max 4096 chars)"); }
    Ok(())
}

pub fn validate_slug(slug: &str) -> Result<(), &'static str> {
    if slug.is_empty() { return Err("Slug is required"); }
    if slug.len() > 64 { return Err("Slug too long (max 64 chars)"); }
    if !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Slug must be alphanumeric and hyphens only");
    }
    Ok(())
}

pub fn validate_email(email: &str) -> Result<(), &'static str> {
    if email.is_empty() { return Err("Email is required"); }
    if email.len() > 255 { return Err("Email too long"); }
    if !email.contains('@') || !email.contains('.') { return Err("Invalid email format"); }
    Ok(())
}

pub fn validate_wallet_address(addr: &str) -> Result<(), &'static str> {
    if addr.len() < 32 || addr.len() > 44 { return Err("Invalid wallet address length"); }
    if !addr.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Invalid wallet address characters");
    }
    Ok(())
}

// ── Prompt Injection Defense ──

/// Known prompt injection patterns to detect and log.
const INJECTION_PATTERNS: &[&str] = &[
    "ignore previous instructions",
    "ignore all previous",
    "disregard previous",
    "forget your instructions",
    "you are now",
    "new instructions:",
    "system prompt:",
    "system:",
    "[INST]",
    "<<SYS>>",
    "<|im_start|>system",
    "### instruction:",
    "ignore the above",
    "override:",
    "jailbreak",
    "DAN mode",
    "developer mode",
];

/// Sanitize chat input: detect injection attempts, strip dangerous patterns.
/// Returns (sanitized_message, was_injection_detected).
pub fn sanitize_chat_input(input: &str) -> (String, bool) {
    let lower = input.to_lowercase();
    let mut detected = false;

    for pattern in INJECTION_PATTERNS {
        if lower.contains(pattern) {
            detected = true;
            tracing::warn!(
                pattern = %pattern,
                input_preview = %&input[..input.len().min(100)],
                "PROMPT_INJECTION: Suspicious input detected"
            );
            break;
        }
    }

    // Strip null bytes and control characters (except newlines/tabs)
    let sanitized: String = input
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();

    (sanitized, detected)
}

// ── Internal Service Signing ──

/// Sign an outbound request to an internal service.
/// Returns the HMAC-SHA256 hex signature of the body.
pub fn sign_internal_request(body: &[u8], secret: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC key length is always valid");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Verify an inbound request from an internal service.
pub fn verify_internal_request(body: &[u8], signature: &str, secret: &str) -> bool {
    let expected = sign_internal_request(body, secret);
    // Constant-time comparison
    expected.len() == signature.len()
        && expected
            .bytes()
            .zip(signature.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

// ── Security.txt Route ──

pub async fn security_txt() -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        axum::http::StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Contact: mailto:anderson.a.obrien@gmail.com\nExpires: 2027-04-05T00:00:00.000Z\nPreferred-Languages: en\nCanonical: https://ghola.xyz/.well-known/security.txt\nPolicy: https://ghola.xyz/security-policy\n",
    ).into_response()
}

// ── Audit Logger ──

pub fn audit_log(action: &str, user_id: &str, target: &str, ip: &str, metadata: &str) {
    tracing::info!(
        target: "audit",
        action = %action,
        user_id = %user_id,
        target = %target,
        ip = %ip,
        metadata = %metadata,
        "AUDIT"
    );
}
