use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config::CloudConfig;
use crate::error::CloudError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Provider enum & config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LlmProvider {
    Anthropic,
    OpenAI,
    Google,
    Groq,
    Together,
    Ollama,
    Mistral,
    Kimi,
    Qwen,
    Glm,
    DeepSeek,
    Cerebras,
    OpenRouter,
    Community,
}

impl LlmProvider {
    pub fn default_base_url(&self) -> &str {
        match self {
            LlmProvider::Anthropic => "https://api.anthropic.com",
            LlmProvider::OpenAI => "https://api.openai.com",
            LlmProvider::Google => "https://generativelanguage.googleapis.com",
            LlmProvider::Groq => "https://api.groq.com/openai",
            LlmProvider::Together => "https://api.together.xyz",
            LlmProvider::Ollama => "http://localhost:11434",
            LlmProvider::Mistral => "https://api.mistral.ai",
            LlmProvider::Kimi => "https://api.moonshot.cn",
            LlmProvider::Qwen => "https://dashscope.aliyuncs.com/compatible-mode",
            LlmProvider::Glm => "https://open.bigmodel.cn/api/paas",
            LlmProvider::DeepSeek => "https://api.deepseek.com",
            LlmProvider::Cerebras => "https://api.cerebras.ai",
            LlmProvider::OpenRouter => "https://openrouter.ai/api",
            LlmProvider::Community => "",
        }
    }

    pub fn default_model(&self) -> &str {
        match self {
            LlmProvider::Anthropic => "claude-sonnet-4-20250514",
            LlmProvider::OpenAI => "gpt-4o",
            LlmProvider::Google => "gemini-2.0-flash",
            LlmProvider::Groq => "llama-3.3-70b-versatile",
            LlmProvider::Together => "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            LlmProvider::Ollama => "llama3.2",
            LlmProvider::Mistral => "mistral-large-latest",
            LlmProvider::Kimi => "moonshot-v1-128k",
            LlmProvider::Qwen => "qwen-max",
            LlmProvider::Glm => "glm-4-plus",
            LlmProvider::DeepSeek => "deepseek-chat",
            LlmProvider::Cerebras => "llama-3.3-70b",
            LlmProvider::OpenRouter => "meta-llama/llama-3.3-70b-instruct:free",
            LlmProvider::Community => "community",
        }
    }

    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "anthropic" | "claude" => LlmProvider::Anthropic,
            "openai" | "gpt" => LlmProvider::OpenAI,
            "google" | "gemini" => LlmProvider::Google,
            "groq" => LlmProvider::Groq,
            "together" => LlmProvider::Together,
            "ollama" => LlmProvider::Ollama,
            "mistral" => LlmProvider::Mistral,
            "kimi" | "moonshot" => LlmProvider::Kimi,
            "qwen" | "alibaba" | "dashscope" => LlmProvider::Qwen,
            "glm" | "zhipu" | "chatglm" => LlmProvider::Glm,
            "deepseek" => LlmProvider::DeepSeek,
            "cerebras" => LlmProvider::Cerebras,
            "openrouter" => LlmProvider::OpenRouter,
            "community" => LlmProvider::Community,
            _ => LlmProvider::Anthropic,
        }
    }

    /// Whether this provider uses the OpenAI-compatible API format.
    pub fn is_openai_compat(&self) -> bool {
        matches!(
            self,
            LlmProvider::OpenAI
                | LlmProvider::Groq
                | LlmProvider::Together
                | LlmProvider::Ollama
                | LlmProvider::Mistral
                | LlmProvider::Kimi
                | LlmProvider::Qwen
                | LlmProvider::Glm
                | LlmProvider::DeepSeek
                | LlmProvider::Cerebras
                | LlmProvider::OpenRouter
        )
    }

    pub fn available_models(&self) -> Vec<&str> {
        match self {
            LlmProvider::Anthropic => vec![
                "claude-sonnet-4-20250514",
                "claude-opus-4-20250514",
                "claude-haiku-4-20250514",
            ],
            LlmProvider::OpenAI => vec![
                "gpt-4o",
                "gpt-4o-mini",
                "gpt-4.1",
                "gpt-4.1-mini",
                "o4-mini",
            ],
            LlmProvider::Google => vec!["gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
            LlmProvider::Groq => vec![
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "mixtral-8x7b-32768",
            ],
            LlmProvider::Together => vec![
                "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                "meta-llama/Llama-3.1-8B-Instruct-Turbo",
                "mistralai/Mixtral-8x7B-Instruct-v0.1",
            ],
            LlmProvider::Ollama => vec!["llama3.2", "llama3.1", "mistral", "gemma2"],
            LlmProvider::Mistral => vec![
                "mistral-large-latest",
                "mistral-medium-latest",
                "mistral-small-latest",
                "codestral-latest",
            ],
            LlmProvider::Kimi => vec!["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
            LlmProvider::Qwen => vec!["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"],
            LlmProvider::Glm => vec!["glm-4-plus", "glm-4", "glm-4-flash"],
            LlmProvider::DeepSeek => vec!["deepseek-chat", "deepseek-reasoner"],
            LlmProvider::Cerebras => vec!["llama-3.3-70b", "llama-3.1-8b"],
            LlmProvider::OpenRouter => vec![
                "meta-llama/llama-3.3-70b-instruct:free",
                "google/gemma-2-9b-it:free",
                "mistralai/mistral-7b-instruct:free",
            ],
            LlmProvider::Community => vec![],
        }
    }
}

pub struct UserLlmConfig {
    pub provider: LlmProvider,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: String,
    /// True when config was selected by the free cascade (enables 429 retry).
    pub is_cascade: bool,
}

/// Chat message for multi-turn streaming conversations.
#[derive(Clone)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Free inference cascade
// ---------------------------------------------------------------------------

/// Cascade order: Groq → Cerebras → Google Gemini → OpenRouter.
const CASCADE_ORDER: &[LlmProvider] = &[
    LlmProvider::Groq,
    LlmProvider::Cerebras,
    LlmProvider::Google,
    LlmProvider::OpenRouter,
];

struct FreeCascadeInner {
    /// Providers that have API keys configured (subset of CASCADE_ORDER).
    available: Vec<LlmProvider>,
    /// Daily request counts per provider.
    counts: HashMap<LlmProvider, u32>,
    /// Daily request limits per provider.
    limits: HashMap<LlmProvider, u32>,
    /// Date of last counter reset (UTC).
    last_reset: chrono::NaiveDate,
}

impl FreeCascadeInner {
    fn maybe_reset(&mut self) {
        let today = chrono::Utc::now().date_naive();
        if today > self.last_reset {
            self.counts.clear();
            self.last_reset = today;
        }
    }
}

/// In-memory tracker that rotates free-tier LLM requests across providers.
#[derive(Clone)]
pub struct FreeCascade {
    inner: Arc<Mutex<FreeCascadeInner>>,
}

impl FreeCascade {
    pub fn new(config: &CloudConfig) -> Self {
        let mut available = Vec::new();
        for &provider in CASCADE_ORDER {
            let has_key = match provider {
                LlmProvider::Groq => config.groq_api_key.is_some(),
                LlmProvider::Cerebras => config.cerebras_api_key.is_some(),
                LlmProvider::Google => config.google_gemini_api_key.is_some(),
                LlmProvider::OpenRouter => config.openrouter_api_key.is_some(),
                _ => false,
            };
            if has_key {
                available.push(provider);
            }
        }

        let mut limits = HashMap::new();
        limits.insert(LlmProvider::Groq, 900);
        limits.insert(LlmProvider::Cerebras, 950);
        limits.insert(LlmProvider::Google, 450);
        limits.insert(LlmProvider::OpenRouter, 180);

        Self {
            inner: Arc::new(Mutex::new(FreeCascadeInner {
                available,
                counts: HashMap::new(),
                limits,
                last_reset: chrono::Utc::now().date_naive(),
            })),
        }
    }

    /// Pick the next available free provider under its daily limit.
    pub async fn pick_provider(&self) -> Option<LlmProvider> {
        let mut inner = self.inner.lock().await;
        inner.maybe_reset();

        // Find first provider under its daily limit (immutable scan)
        let found = inner.available.iter().find_map(|&provider| {
            let count = inner.counts.get(&provider).copied().unwrap_or(0);
            let limit = inner.limits.get(&provider).copied().unwrap_or(0);
            if count < limit {
                Some(provider)
            } else {
                None
            }
        });

        // Increment count (mutable, after immutable borrow released)
        if let Some(provider) = found {
            *inner.counts.entry(provider).or_insert(0) += 1;
        }

        found
    }

    /// Mark a provider as exhausted (e.g. after a 429 response).
    pub async fn mark_exhausted(&self, provider: &LlmProvider) {
        let mut inner = self.inner.lock().await;
        if let Some(&limit) = inner.limits.get(provider) {
            inner.counts.insert(provider.clone(), limit);
        }
    }

    /// Return usage stats: provider_name → (used, limit).
    pub async fn stats(&self) -> HashMap<String, (u32, u32)> {
        let inner = self.inner.lock().await;
        let mut out = HashMap::new();
        for &provider in CASCADE_ORDER {
            let count = inner.counts.get(&provider).copied().unwrap_or(0);
            let limit = inner.limits.get(&provider).copied().unwrap_or(0);
            let name = match provider {
                LlmProvider::Groq => "groq",
                LlmProvider::Cerebras => "cerebras",
                LlmProvider::Google => "gemini",
                LlmProvider::OpenRouter => "openrouter",
                _ => continue,
            };
            out.insert(name.to_string(), (count, limit));
        }
        out
    }
}

/// Look up the server-side free-tier API key for a cascade provider.
fn cascade_provider_key(config: &CloudConfig, provider: &LlmProvider) -> Option<String> {
    match provider {
        LlmProvider::Groq => config.groq_api_key.clone(),
        LlmProvider::Cerebras => config.cerebras_api_key.clone(),
        LlmProvider::Google => config.google_gemini_api_key.clone(),
        LlmProvider::OpenRouter => config.openrouter_api_key.clone(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// BYOM base-URL SSRF guard
// ---------------------------------------------------------------------------
//
// `llm_base_url` is a user-controlled field interpolated into server-side
// `reqwest` calls (`{base_url}/v1/messages`, `{base_url}/v1/chat/completions`).
// Without validation an authenticated user can point it at internal services
// or the cloud metadata endpoint (169.254.169.254), turning the relay into an
// SSRF proxy. We enforce two checks:
//
//   1. Set-time (`validate_user_base_url`): require `https://`, parse the host,
//      and reject IP-literal hosts in private/loopback/link-local ranges.
//   2. Request-time (`assert_base_url_safe`): re-resolve the host via DNS and
//      reject if ANY resolved address is private/loopback/link-local. This is
//      the DNS-rebinding defense — a hostname that passed set-time validation
//      could later resolve to an internal IP.
//
// Note: the per-provider DEFAULT base URLs (e.g. Ollama's
// `http://localhost:11434`) are set server-side and never pass through this
// validator, so legitimate local providers are unaffected.

/// Extract `(scheme, host)` from a URL string without pulling in the `url`
/// crate. Returns `None` if the string is not a plausible `scheme://host…`.
fn parse_scheme_host(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    // Strip userinfo (`user:pass@host`), then path/query/fragment.
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    // Strip the port. Handle bracketed IPv6 literals `[::1]:443`.
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        // IPv6 literal: take up to the closing bracket.
        stripped.split(']').next().unwrap_or("").to_string()
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host))
}

/// True if `ip` is in a range that must never be reachable from a
/// user-controlled outbound request: loopback, RFC1918 private, link-local
/// (incl. 169.254/16 cloud metadata), unique-local IPv6 (fc00::/7), and
/// unspecified/reserved.
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()        // 127.0.0.0/8
                || v4.is_private()  // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local() // 169.254.0.0/16 (cloud metadata)
                || v4.is_unspecified() // 0.0.0.0
                || v4.is_broadcast()
                || v4.is_documentation()
                // Carrier-grade NAT 100.64.0.0/10 (often internal).
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
                // Reserved / Class-E 240.0.0.0/4 (incl. 255.255.255.255).
                || (v4.octets()[0] & 0xf0) == 0xf0
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() // ::1
                || v6.is_unspecified() // ::
                // Unique-local fc00::/7.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // Link-local fe80::/10.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // IPv4-mapped (::ffff:a.b.c.d) — unwrap and re-check.
                || v6.to_ipv4_mapped().map(is_blocked_ip_v4).unwrap_or(false)
                // Any IPv6 form that embeds an IPv4 address must be re-checked
                // against the v4 block-list, or an attacker can wrap an internal
                // v4 (e.g. 127.0.0.1) in a transition format that slips past the
                // v6 prefix checks above and routes to the embedded target on a
                // host with a NAT64/6to4 path. Covers 6to4 (2002::/16), NAT64
                // (64:ff9b::/96), and the deprecated IPv4-compatible (::a.b.c.d).
                || embedded_ipv4(v6).map(is_blocked_ip_v4).unwrap_or(false)
        }
    }
}

/// Extract an embedded IPv4 address from an IPv6 transition format, if the
/// address uses one. Returns `None` for ordinary IPv6 (incl. IPv4-mapped,
/// which is handled separately by [`std::net::Ipv6Addr::to_ipv4_mapped`]).
fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let seg = v6.segments();
    // 6to4: 2002:AABB:CCDD::/16 — the embedded v4 is the next two segments.
    if seg[0] == 0x2002 {
        return Some(std::net::Ipv4Addr::new(
            (seg[1] >> 8) as u8,
            (seg[1] & 0xff) as u8,
            (seg[2] >> 8) as u8,
            (seg[2] & 0xff) as u8,
        ));
    }
    // NAT64 well-known prefix 64:ff9b::/96 — embedded v4 is the low 32 bits.
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        let o = v6.octets();
        return Some(std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    // IPv4-compatible ::a.b.c.d (deprecated): high 96 bits zero, low 32 the v4.
    // Exclude :: and ::1 (already covered by is_unspecified/is_loopback) so we
    // don't surface 0.0.0.x as a bogus "documentation" hit.
    if seg[0..6] == [0, 0, 0, 0, 0, 0] {
        let o = v6.octets();
        let candidate = std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15]);
        if !candidate.is_unspecified() && candidate != std::net::Ipv4Addr::new(0, 0, 0, 1) {
            return Some(candidate);
        }
    }
    None
}

fn is_blocked_ip_v4(v4: std::net::Ipv4Addr) -> bool {
    is_blocked_ip(std::net::IpAddr::V4(v4))
}

/// Set-time validation of a user-supplied BYOM base URL. Requires `https://`
/// and rejects IP-literal hosts in blocked ranges. Hostnames are accepted here
/// (resolution can change) but are re-checked at request time via
/// [`assert_base_url_safe`].
pub fn validate_user_base_url(raw: &str) -> Result<(), CloudError> {
    let (scheme, host) = parse_scheme_host(raw).ok_or_else(|| {
        CloudError::BadRequest("base_url must be a valid https:// URL".to_string())
    })?;
    if scheme != "https" {
        return Err(CloudError::BadRequest(
            "base_url must use https://".to_string(),
        ));
    }
    // If the host is an IP literal, block private/loopback/link-local ranges now.
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(CloudError::BadRequest(
                "base_url host is not allowed (private/loopback/link-local address)".to_string(),
            ));
        }
    }
    Ok(())
}

/// Request-time DNS-rebinding defense: resolve the base URL's host and reject
/// if any resolved address is in a blocked range. Call this immediately before
/// issuing an outbound request to a user-controlled `base_url`.
pub async fn assert_base_url_safe(raw: &str) -> Result<(), CloudError> {
    let (scheme, host) = parse_scheme_host(raw).ok_or_else(|| {
        CloudError::BadRequest("base_url must be a valid https:// URL".to_string())
    })?;
    if scheme != "https" {
        return Err(CloudError::BadRequest(
            "base_url must use https://".to_string(),
        ));
    }
    // IP literal: check directly, no DNS.
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(CloudError::BadRequest(
                "base_url resolves to a disallowed address".to_string(),
            ));
        }
        return Ok(());
    }
    // Hostname: resolve and check every returned address. Use port 443 since we
    // require https. `lookup_host` needs a `host:port` form.
    let addrs = tokio::net::lookup_host((host.as_str(), 443u16))
        .await
        .map_err(|e| CloudError::BadRequest(format!("base_url host did not resolve: {e}")))?;
    let mut saw_any = false;
    for addr in addrs {
        saw_any = true;
        if is_blocked_ip(addr.ip()) {
            return Err(CloudError::BadRequest(
                "base_url resolves to a disallowed address".to_string(),
            ));
        }
    }
    if !saw_any {
        return Err(CloudError::BadRequest(
            "base_url host did not resolve to any address".to_string(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Connect-time SSRF enforcement
// ---------------------------------------------------------------------------
//
// The set-time (`validate_user_base_url`) and pre-flight (`assert_base_url_safe`)
// checks are necessary UX/fast-fail layers, but they are NOT the security
// boundary: a default reqwest client follows 3xx redirects and re-resolves DNS
// independently at connect time, so a host that passes a pre-flight lookup can
//   (a) 302-redirect the request to an internal target, or
//   (b) DNS-rebind between the pre-flight lookup and the socket connect.
//
// The real defense lives HERE:
//   1. `safe_outbound_client()` builds every client that may carry a
//      user-influenced `base_url` with `redirect(Policy::none())`, so a
//      user-controlled host can never bounce us to `169.254.169.254` et al.
//   2. `SsrfGuardResolver` is installed as the client's DNS resolver. reqwest
//      connects to one of the `SocketAddr`s the resolver returns, so filtering
//      blocked IPs inside the resolver means the IP we actually connect to is
//      the one we checked — closing the rebinding TOCTOU. If every resolved
//      address is blocked, the resolver errors and the connection never opens.

/// DNS resolver that performs a normal system lookup and then strips any
/// address in a blocked range ([`is_blocked_ip`]). Used by
/// [`safe_outbound_client`]. Because reqwest connects to exactly the addresses
/// this resolver yields, the connect-time IP is guaranteed to be one we passed
/// through [`is_blocked_ip`] — there is no second, unchecked resolution.
#[derive(Debug, Clone, Default)]
struct SsrfGuardResolver;

impl reqwest::dns::Resolve for SsrfGuardResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            // Port is irrelevant for the block decision; reqwest overrides it
            // from the URL. Use 0 and let the connector set the real port.
            let resolved = tokio::net::lookup_host((host.as_str(), 0u16)).await;
            match resolved {
                Ok(addrs) => {
                    let safe: Vec<std::net::SocketAddr> =
                        addrs.filter(|a| !is_blocked_ip(a.ip())).collect();
                    if safe.is_empty() {
                        // Either the host didn't resolve to anything, or every
                        // address was in a blocked range. Fail the connection.
                        let err: Box<dyn std::error::Error + Send + Sync> = Box::from(
                            "ssrf guard: host resolved to no allowed (public) address",
                        );
                        return Err(err);
                    }
                    let iter: reqwest::dns::Addrs = Box::new(safe.into_iter());
                    Ok(iter)
                }
                Err(e) => {
                    let err: Box<dyn std::error::Error + Send + Sync> = Box::new(e);
                    Err(err)
                }
            }
        })
    }
}

/// Build a reqwest client for outbound calls that may target a
/// user-influenced `base_url`. Disables redirect-following and installs the
/// connect-time SSRF guard resolver. ALL LLM-provider HTTP in this module
/// routes through here — provider-default hosts are public and unaffected by
/// the blocklist, and inference endpoints do not legitimately 3xx, so there is
/// no downside to hardening every client uniformly (and it guarantees no call
/// site is accidentally left on a default, redirect-following client).
fn safe_outbound_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // Disable proxy auto-detection. reqwest otherwise honors
        // HTTP_PROXY / HTTPS_PROXY / ALL_PROXY from the environment, in which
        // case it dials the PROXY and never consults our custom resolver — the
        // proxy resolves the target host, bypassing the SSRF guard entirely.
        // The whole point of the guard is that WE choose the egress IP, so we
        // must connect directly. (If a legitimate egress proxy is ever needed,
        // route it explicitly and re-validate the target there.)
        .no_proxy()
        .dns_resolver(std::sync::Arc::new(SsrfGuardResolver))
        .build()
        // Builder only fails on a TLS/config error that is environment-wide and
        // not request-specific; fall back to a default client so a transient
        // builder failure degrades to (still no worse than) prior behavior.
        .unwrap_or_else(|_| reqwest::Client::new())
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/// Resolve the LLM config for a given user (BYOM → free cascade → Claude fallback).
pub async fn get_user_llm_config(
    state: &AppState,
    user_id: Uuid,
) -> Result<UserLlmConfig, CloudError> {
    let row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<Vec<u8>>, Option<String>)>(
        "SELECT llm_provider, llm_model, llm_api_key_encrypted, llm_base_url FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((provider_str, model, encrypted_key, base_url)) = row {
        let provider = provider_str
            .map(|p| LlmProvider::from_str_loose(&p))
            .unwrap_or(LlmProvider::Anthropic);

        // SSRF guard (DNS-rebinding defense): a user-supplied base_url passed
        // set-time validation but could now resolve to an internal address.
        // Re-resolve and reject before it is used in any outbound request. A
        // user-stored base_url that no longer validates is dropped, falling
        // back to the provider default rather than failing the whole request.
        let base_url = match base_url {
            Some(u) if !u.is_empty() => match assert_base_url_safe(&u).await {
                Ok(()) => Some(u),
                Err(e) => {
                    tracing::warn!(
                        user = %user_id,
                        "stored llm_base_url rejected by SSRF guard ({e}); using provider default"
                    );
                    None
                }
            },
            _ => None,
        };

        // Try to decrypt BYOM key
        let byom_key = encrypted_key.and_then(|enc| {
            match decrypt_api_key(&enc, &state.config.encryption_key) {
                Ok(key) => Some(key),
                Err(e) => {
                    tracing::warn!(
                        "failed to decrypt BYOM key for user {user_id}: {e} — falling back"
                    );
                    None
                }
            }
        });

        // BYOM user — has their own key, use it as-is
        if byom_key.is_some() {
            return Ok(UserLlmConfig {
                model: model.unwrap_or_else(|| provider.default_model().to_string()),
                base_url: base_url.unwrap_or_else(|| provider.default_base_url().to_string()),
                provider,
                api_key: byom_key,
                is_cascade: false,
            });
        }

        // No BYOM key — only cascade for the default Anthropic fallback path
        match provider {
            LlmProvider::Anthropic => resolve_cascade_or_claude(state, model, base_url).await,
            _ => {
                // Non-Anthropic with no key — BYOM user who hasn't entered key yet
                Ok(UserLlmConfig {
                    model: model.unwrap_or_else(|| provider.default_model().to_string()),
                    base_url: base_url.unwrap_or_else(|| provider.default_base_url().to_string()),
                    provider,
                    api_key: None,
                    is_cascade: false,
                })
            }
        }
    } else {
        // No user row — new user
        resolve_cascade_or_claude(state, None, None).await
    }
}

/// Try free cascade providers, then fall back to CLAUDE_API_KEY.
async fn resolve_cascade_or_claude(
    state: &AppState,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<UserLlmConfig, CloudError> {
    // Try free cascade
    if let Some(cascade_provider) = state.free_cascade.pick_provider().await {
        if let Some(key) = cascade_provider_key(&state.config, &cascade_provider) {
            tracing::debug!(provider = ?cascade_provider, "using free cascade provider");
            return Ok(UserLlmConfig {
                model: cascade_provider.default_model().to_string(),
                base_url: cascade_provider.default_base_url().to_string(),
                provider: cascade_provider,
                api_key: Some(key),
                is_cascade: true,
            });
        }
    }

    // Try community GPU providers
    {
        let cache = state.compute_cache.lock().await;
        if !cache.is_empty() {
            // There are online community providers — use Community provider
            // The actual provider selection happens in generate_community/stream_community
            return Ok(UserLlmConfig {
                provider: LlmProvider::Community,
                model: "community".to_string(),
                api_key: None,
                base_url: String::new(),
                is_cascade: false,
            });
        }
    }

    // Cascade exhausted or unavailable — fall back to CLAUDE_API_KEY
    if let Some(ref claude_key) = state.config.claude_api_key {
        return Ok(UserLlmConfig {
            provider: LlmProvider::Anthropic,
            model: model.unwrap_or_else(|| "claude-sonnet-4-20250514".to_string()),
            api_key: Some(claude_key.clone()),
            base_url: base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            is_cascade: false,
        });
    }

    Err(CloudError::ServiceUnavailable(
        "No AI model configured".into(),
    ))
}

// ---------------------------------------------------------------------------
// Non-streaming generation
// ---------------------------------------------------------------------------

fn is_rate_limit_error(e: &CloudError) -> bool {
    let msg = e.to_string();
    msg.contains("429") || msg.contains("529") || msg.contains("rate limit")
}

fn dispatch_generate<'a>(
    config: &'a UserLlmConfig,
    prompt: &'a str,
    response_format: Option<&'a str>,
) -> Pin<Box<dyn std::future::Future<Output = Result<String, CloudError>> + Send + 'a>> {
    match config.provider {
        LlmProvider::Anthropic => Box::pin(generate_anthropic(config, prompt, response_format)),
        LlmProvider::Google => Box::pin(generate_google(config, prompt, response_format)),
        _ => Box::pin(generate_openai_compat(config, prompt, response_format)),
    }
}

/// Generate text using the user's configured LLM provider.
/// Automatically retries once with the next cascade provider on 429/529.
pub async fn generate(
    state: &AppState,
    user_id: Uuid,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    // Community provider — special path
    if config.provider == LlmProvider::Community {
        let messages = vec![ChatMsg {
            role: "user".to_string(),
            content: prompt.to_string(),
        }];
        let (text, _model) = generate_community(state, user_id, &messages, None).await?;
        return Ok(text);
    }

    let result = dispatch_generate(&config, prompt, response_format).await;

    // 429 retry for cascade requests
    if config.is_cascade {
        if let Err(ref e) = result {
            if is_rate_limit_error(e) {
                tracing::warn!(provider = ?config.provider, "cascade 429 — marking exhausted and retrying");
                state.free_cascade.mark_exhausted(&config.provider).await;
                if let Some(next) = state.free_cascade.pick_provider().await {
                    if let Some(key) = cascade_provider_key(&state.config, &next) {
                        let retry = UserLlmConfig {
                            model: next.default_model().to_string(),
                            base_url: next.default_base_url().to_string(),
                            provider: next,
                            api_key: Some(key),
                            is_cascade: true,
                        };
                        return dispatch_generate(&retry, prompt, response_format).await;
                    }
                }
            }
        }
    }

    result
}

async fn generate_anthropic(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Anthropic API key not configured".into(),
        ))?;

    let system = if response_format == Some("json") {
        "You are a helpful assistant. Always respond with valid JSON only, no markdown or extra text."
    } else {
        "You are a helpful assistant. Be concise and direct."
    };

    let body = serde_json::json!({
        "model": &config.model,
        "max_tokens": 4096,
        "system": system,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = safe_outbound_client();
    let resp = client
        .post(format!("{}/v1/messages", config.base_url))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Anthropic API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "Anthropic API returned status {status}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Anthropic response parse failed: {e}")))?;

    extract_anthropic_text(&resp_body)
}

fn extract_anthropic_text(body: &serde_json::Value) -> Result<String, CloudError> {
    let content = body["content"].as_array().ok_or(CloudError::Internal(
        "no content in Anthropic response".into(),
    ))?;

    let text: String = content
        .iter()
        .filter_map(|block| {
            if block["type"].as_str() == Some("text") {
                block["text"].as_str().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("");

    Ok(text)
}

async fn generate_openai_compat(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config.api_key.as_deref().unwrap_or("");

    let system_msg = if response_format == Some("json") {
        "You are a helpful assistant. Always respond with valid JSON only, no markdown or extra text."
    } else {
        "You are a helpful assistant. Be concise and direct."
    };

    let mut body = serde_json::json!({
        "model": &config.model,
        "messages": [
            { "role": "system", "content": system_msg },
            { "role": "user", "content": prompt },
        ],
        "max_tokens": 4096,
    });

    if response_format == Some("json") {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }

    // Ollama doesn't need auth header
    let needs_auth = config.provider != LlmProvider::Ollama;

    let url = if config.provider == LlmProvider::Ollama {
        format!("{}/v1/chat/completions", config.base_url)
    } else {
        format!("{}/v1/chat/completions", config.base_url)
    };

    let client = safe_outbound_client();
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if needs_auth {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    // OpenRouter requires referrer headers
    if config.provider == LlmProvider::OpenRouter {
        req = req
            .header("HTTP-Referer", "https://ghola.xyz")
            .header("X-Title", "Ghola");
    }

    let resp = req
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("LLM API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "LLM API returned status {status}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("LLM response parse failed: {e}")))?;

    resp_body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or(CloudError::Internal("no content in LLM response".into()))
}

async fn generate_google(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Google API key not configured".into(),
        ))?;

    let system_instruction = if response_format == Some("json") {
        Some("Always respond with valid JSON only, no markdown or extra text.")
    } else {
        None
    };

    let mut body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 4096 },
    });

    if let Some(sys) = system_instruction {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": sys }]
        });
    }

    if response_format == Some("json") {
        body["generationConfig"]["responseMimeType"] = serde_json::json!("application/json");
    }

    let url = format!(
        "{}/v1/models/{}:generateContent?key={}",
        config.base_url, config.model, api_key
    );

    let client = safe_outbound_client();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Gemini API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "Gemini API returned status {status}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Gemini response parse failed: {e}")))?;

    resp_body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or(CloudError::Internal("no text in Gemini response".into()))
}

// ---------------------------------------------------------------------------
// Streaming generation (for SSE chat)
// ---------------------------------------------------------------------------

pub type TextStream =
    Pin<Box<dyn futures::stream::Stream<Item = Result<String, CloudError>> + Send>>;

async fn dispatch_stream(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    match config.provider {
        LlmProvider::Anthropic => stream_anthropic(config, messages, system).await,
        LlmProvider::Google => stream_google(config, messages, system).await,
        _ => stream_openai_compat(config, messages, system).await,
    }
}

/// Stream text deltas from the user's configured LLM provider.
/// Automatically retries once with the next cascade provider on 429/529.
pub async fn generate_stream(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    // Community provider — special path
    if config.provider == LlmProvider::Community {
        let (stream, _model) = stream_community(state, user_id, messages, system).await?;
        return Ok(stream);
    }

    let result = dispatch_stream(&config, messages, system).await;

    // 429 retry for cascade requests
    if config.is_cascade {
        if let Err(ref e) = result {
            if is_rate_limit_error(e) {
                tracing::warn!(provider = ?config.provider, "cascade stream 429 — marking exhausted and retrying");
                state.free_cascade.mark_exhausted(&config.provider).await;
                if let Some(next) = state.free_cascade.pick_provider().await {
                    if let Some(key) = cascade_provider_key(&state.config, &next) {
                        let retry = UserLlmConfig {
                            model: next.default_model().to_string(),
                            base_url: next.default_base_url().to_string(),
                            provider: next,
                            api_key: Some(key),
                            is_cascade: true,
                        };
                        return dispatch_stream(&retry, messages, system).await;
                    }
                }
            }
        }
    }

    result
}

async fn stream_anthropic(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Anthropic API key not configured".into(),
        ))?
        .to_string();

    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": &m.role, "content": &m.content }))
        .collect();

    let mut body = serde_json::json!({
        "model": &config.model,
        "max_tokens": 4096,
        "stream": true,
        "messages": msgs,
    });

    if let Some(sys) = system {
        body["system"] = serde_json::Value::String(sys.to_string());
    }

    let base_url = config.base_url.clone();

    let client = safe_outbound_client();
    let resp = client
        .post(format!("{base_url}/v1/messages"))
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Anthropic stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "Anthropic API returned status {status}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find("\n\n") {
                        let event_block = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        for line in event_block.lines() {
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    if json["type"] == "content_block_delta" {
                                        if let Some(text) = json["delta"]["text"].as_str() {
                                            yield Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}

async fn stream_openai_compat(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config.api_key.clone().unwrap_or_default();
    let needs_auth = config.provider != LlmProvider::Ollama;

    let mut msgs: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        msgs.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        msgs.push(serde_json::json!({ "role": &m.role, "content": &m.content }));
    }

    let body = serde_json::json!({
        "model": &config.model,
        "messages": msgs,
        "max_tokens": 4096,
        "stream": true,
    });

    let url = format!("{}/v1/chat/completions", config.base_url);

    let client = safe_outbound_client();
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if needs_auth {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    // OpenRouter requires referrer headers
    if config.provider == LlmProvider::OpenRouter {
        req = req
            .header("HTTP-Referer", "https://ghola.xyz")
            .header("X-Title", "Ghola");
    }

    let resp = req
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("LLM stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "LLM API returned status {status}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find("\n") {
                        let line = buffer[..pos].trim().to_string();
                        buffer = buffer[pos + 1..].to_string();

                        if line == "data: [DONE]" {
                            break;
                        }

                        if let Some(data) = line.strip_prefix("data: ") {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(text) = json["choices"][0]["delta"]["content"].as_str() {
                                    if !text.is_empty() {
                                        yield Ok(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}

async fn stream_google(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Google API key not configured".into(),
        ))?
        .to_string();

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" {
                "model"
            } else {
                "user"
            };
            serde_json::json!({ "role": role, "parts": [{ "text": &m.content }] })
        })
        .collect();

    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": 4096 },
    });

    if let Some(sys) = system {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": sys }]
        });
    }

    let url = format!(
        "{}/v1/models/{}:streamGenerateContent?alt=sse&key={}",
        config.base_url, config.model, api_key
    );

    let client = safe_outbound_client();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Gemini stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "Gemini API returned status {status}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find("\n\n") {
                        let event_block = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        for line in event_block.lines() {
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(text) = json["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                                        if !text.is_empty() {
                                            yield Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

pub struct IntentClassification {
    pub category: String,
    pub confidence: f64,
    pub template_id: Option<String>,
    pub extracted_params: serde_json::Value,
}

/// Classify user input to determine the task type.
pub async fn classify_intent(
    state: &AppState,
    user_id: Uuid,
    user_input: &str,
) -> Result<IntentClassification, CloudError> {
    let prompt = format!(
        r#"Classify this user request into one of these categories:

Request: "{user_input}"

Categories:
- "call" — user wants to make a phone call (book restaurant, schedule appointment, call customer service)
- "email" — user wants to send or draft an email (request refund, follow up, complain, cancel)
- "calendar" — user wants to manage calendar events
- "search" — user wants to search the web
- "device" — user wants to control their phone (open app, tap, type, navigate)
- "crypto" — user wants to check wallet balance, send crypto (SOL/USDC), or get their wallet address
- "chat" — general conversation, question, or request that doesn't fit other categories

Return a JSON object with:
- "category": one of the above
- "confidence": 0.0-1.0
- "template_id": matching template ID if applicable (book_restaurant, schedule_appointment, customer_service, cancel_service, request_refund, follow_up, complaint, cancel_subscription), or null
- "extracted_params": any parameters extracted from the request

Only return JSON, no other text."#
    );

    let result = generate(state, user_id, &prompt, Some("json")).await?;

    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap_or_else(|_| {
        serde_json::json!({
            "category": "chat",
            "confidence": 0.5,
            "template_id": null,
            "extracted_params": {}
        })
    });

    Ok(IntentClassification {
        category: parsed["category"].as_str().unwrap_or("chat").to_string(),
        confidence: parsed["confidence"].as_f64().unwrap_or(0.5),
        template_id: parsed["template_id"].as_str().map(|s| s.to_string()),
        extracted_params: parsed["extracted_params"].clone(),
    })
}

// ---------------------------------------------------------------------------
// Tool-use generation (for chat with wallet tools)
// ---------------------------------------------------------------------------

/// Result of a non-streaming tool-use generation round.
pub struct ToolUseResult {
    /// Final assistant text to display.
    pub text: String,
    /// Tool calls that were made during the conversation (for SSE events).
    pub tool_calls: Vec<ToolCallEvent>,
}

pub struct ToolCallEvent {
    pub tool_name: String,
    /// "executing" | "success" | "error" | "client_action"
    pub status: String,
    /// For server-executed tools, the result. For `client_action`, the tool INPUT
    /// that the client should render as an `ActionCard`.
    pub result: Option<serde_json::Value>,
}

/// How a tool should be handled when the LLM emits it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolHandling {
    /// Execute server-side (wallet_*). The result is fed back to the LLM and
    /// the conversation continues.
    Server,
    /// Surface to the client as an `ActionCard`. The LLM does NOT see a
    /// `tool_result` — the user reviews and triggers the action via the card.
    Client,
}

fn classify_tool(name: &str) -> ToolHandling {
    match name {
        "send_email" | "send_sms" | "initiate_call" | "create_calendar_event" => {
            ToolHandling::Client
        }
        _ => ToolHandling::Server,
    }
}

/// Walk Anthropic response content blocks and emit a `client_action` event for
/// each Client-classified tool_use. Pure function — testable against fixture
/// payloads without touching the network or AppState.
fn extract_client_actions_anthropic(content_blocks: &[serde_json::Value]) -> Vec<ToolCallEvent> {
    let mut events = Vec::new();
    for block in content_blocks {
        if block["type"].as_str() != Some("tool_use") {
            continue;
        }
        let tool_name = block["name"].as_str().unwrap_or("");
        if classify_tool(tool_name) != ToolHandling::Client {
            continue;
        }
        events.push(ToolCallEvent {
            tool_name: tool_name.to_string(),
            status: "client_action".to_string(),
            result: Some(block["input"].clone()),
        });
    }
    events
}

/// Walk an OpenAI-style `tool_calls` array and emit a `client_action` event
/// for each Client-classified call.
fn extract_client_actions_openai(tool_calls: &[serde_json::Value]) -> Vec<ToolCallEvent> {
    let mut events = Vec::new();
    for tc in tool_calls {
        let func = &tc["function"];
        let tool_name = func["name"].as_str().unwrap_or("");
        if classify_tool(tool_name) != ToolHandling::Client {
            continue;
        }
        let arguments_str = func["arguments"].as_str().unwrap_or("{}");
        let tool_input: serde_json::Value =
            serde_json::from_str(arguments_str).unwrap_or(serde_json::json!({}));
        events.push(ToolCallEvent {
            tool_name: tool_name.to_string(),
            status: "client_action".to_string(),
            result: Some(tool_input),
        });
    }
    events
}

/// Walk a Gemini response `parts` array and emit a `client_action` event for
/// each `functionCall` block whose tool is Client-classified.
fn extract_client_actions_google(parts: &[serde_json::Value]) -> Vec<ToolCallEvent> {
    let mut events = Vec::new();
    for part in parts {
        let fc = match part.get("functionCall") {
            Some(v) => v,
            None => continue,
        };
        let tool_name = fc["name"].as_str().unwrap_or("");
        if classify_tool(tool_name) != ToolHandling::Client {
            continue;
        }
        events.push(ToolCallEvent {
            tool_name: tool_name.to_string(),
            status: "client_action".to_string(),
            result: Some(fc["args"].clone()),
        });
    }
    events
}

/// Whether the given provider can use the structured tool-use path. Fail-closed
/// on unknown variants — if a new provider is added without explicit support,
/// the client falls back to the regex action detector.
pub fn supports_tool_use(provider: &LlmProvider) -> bool {
    match provider {
        LlmProvider::Anthropic => true,
        LlmProvider::OpenAI => true,
        LlmProvider::Google => true,
        // OpenAI-compatible providers that advertise function-calling. Each has
        // been verified to accept the OpenAI tool schema by the existing
        // `generate_with_tools_openai` path.
        LlmProvider::Mistral => true,
        LlmProvider::Groq => true,
        LlmProvider::Together => true,
        LlmProvider::DeepSeek => true,
        LlmProvider::OpenRouter => true,
        LlmProvider::Kimi => true,
        LlmProvider::Qwen => true,
        LlmProvider::Glm => true,
        LlmProvider::Cerebras => true,
        // No tool-use support — these get the regex fallback client-side.
        LlmProvider::Ollama => false,
        LlmProvider::Community => false,
    }
}

/// Generate a response with tool-use support. Works across all providers:
/// - Anthropic: native tool-use format
/// - OpenAI-compatible (OpenAI, Mistral, Kimi, Qwen, GLM, DeepSeek, Groq, Together, Ollama): OpenAI function calling format
/// - Google: falls back to non-tool text generation with tool descriptions in system prompt
pub async fn generate_with_tools(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    match config.provider {
        LlmProvider::Anthropic => {
            generate_with_tools_anthropic(state, user_id, &config, messages, system, tools).await
        }
        LlmProvider::Google => {
            generate_with_tools_google(state, user_id, &config, messages, system, tools).await
        }
        LlmProvider::Community => {
            // Community providers don't support tool-use; fall back to plain generation
            let (text, _model) = generate_community(state, user_id, messages, system).await?;
            Ok(ToolUseResult {
                text,
                tool_calls: vec![],
            })
        }
        _ => generate_with_tools_openai(state, user_id, &config, messages, system, tools).await,
    }
}

/// Anthropic tool-use loop.
async fn generate_with_tools_anthropic(
    state: &AppState,
    user_id: Uuid,
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "API key not configured".into(),
        ))?;

    let mut conversation: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": &m.role, "content": &m.content }))
        .collect();

    let mut tool_calls = Vec::new();

    for _ in 0..5 {
        let mut body = serde_json::json!({
            "model": &config.model,
            "max_tokens": 4096,
            "messages": conversation,
            "tools": tools,
        });
        if let Some(sys) = system {
            body["system"] = serde_json::Value::String(sys.to_string());
        }

        let resp = safe_outbound_client()
            .post(format!("{}/v1/messages", config.base_url))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("Anthropic request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let _ = resp.text().await;
            return Err(CloudError::Internal(format!(
                "Anthropic returned status {status}"
            )));
        }

        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("parse failed: {e}")))?;

        let stop_reason = resp_body["stop_reason"].as_str().unwrap_or("");
        let content = resp_body["content"].as_array().cloned().unwrap_or_default();

        // Pre-compute the text content from this turn — it's used both when
        // we exit on a client_action and when there are no tool_uses at all.
        let turn_text: String = content
            .iter()
            .filter_map(|b| {
                if b["type"].as_str() == Some("text") {
                    b["text"].as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");

        if stop_reason == "tool_use" {
            conversation.push(serde_json::json!({ "role": "assistant", "content": content }));

            let mut tool_results = Vec::new();

            // Pass 1: server-execute every Server-classified tool, append a
            // tool_result for each.
            for block in &content {
                if block["type"].as_str() != Some("tool_use") {
                    continue;
                }
                let tool_name = block["name"].as_str().unwrap_or("");
                if classify_tool(tool_name) != ToolHandling::Server {
                    continue;
                }
                let tool_id = block["id"].as_str().unwrap_or("");
                let tool_input = &block["input"];

                tool_calls.push(ToolCallEvent {
                    tool_name: tool_name.to_string(),
                    status: "executing".to_string(),
                    result: None,
                });

                let result = crate::services::wallet_service::execute_tool(
                    state, user_id, tool_name, tool_input,
                )
                .await;

                match result {
                    Ok(value) => {
                        tool_calls.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "success".to_string(),
                            result: Some(value.clone()),
                        });
                        tool_results.push(serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": serde_json::to_string(&value).unwrap_or_default(),
                        }));
                    }
                    Err(e) => {
                        tool_calls.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "error".to_string(),
                            result: Some(serde_json::json!({ "error": e.to_string() })),
                        });
                        tool_results.push(serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "is_error": true,
                            "content": e.to_string(),
                        }));
                    }
                }
            }

            // Pass 2: emit client_action events for every Client-classified
            // tool via the pure extractor. Do NOT execute and do NOT append a
            // tool_result — the user drives the action via the ActionCard.
            let client_events = extract_client_actions_anthropic(&content);
            let saw_client_action = !client_events.is_empty();
            tool_calls.extend(client_events);

            if saw_client_action {
                // Mixed-turn semantics: server tools have already run and the
                // user will get an ActionCard for each client tool. The LLM
                // doesn't get a chance to see the client results — that
                // happens out of band on the next user turn.
                return Ok(ToolUseResult {
                    text: turn_text,
                    tool_calls,
                });
            }

            conversation.push(serde_json::json!({ "role": "user", "content": tool_results }));
        } else {
            return Ok(ToolUseResult {
                text: turn_text,
                tool_calls,
            });
        }
    }

    Err(CloudError::Internal(
        "tool-use loop exceeded max rounds".into(),
    ))
}

/// OpenAI-compatible tool-use loop.
/// Works with: OpenAI, Mistral, Kimi/Moonshot, Qwen, GLM/Zhipu, DeepSeek, Groq, Together, Ollama.
async fn generate_with_tools_openai(
    state: &AppState,
    user_id: Uuid,
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let api_key = config.api_key.clone().unwrap_or_default();
    let needs_auth = config.provider != LlmProvider::Ollama;

    // Convert Anthropic tool format → OpenAI function calling format
    let openai_tools: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                }
            })
        })
        .collect();

    let mut conversation: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        conversation.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        conversation.push(serde_json::json!({ "role": &m.role, "content": &m.content }));
    }

    let mut tool_calls_out = Vec::new();

    for _ in 0..5 {
        let body = serde_json::json!({
            "model": &config.model,
            "messages": conversation,
            "tools": openai_tools,
            "max_tokens": 4096,
        });

        let url = format!("{}/v1/chat/completions", config.base_url);
        let mut req = safe_outbound_client()
            .post(&url)
            .header("content-type", "application/json")
            .json(&body);

        if needs_auth {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }

        // OpenRouter requires referrer headers
        if config.provider == LlmProvider::OpenRouter {
            req = req
                .header("HTTP-Referer", "https://ghola.xyz")
                .header("X-Title", "Ghola");
        }

        let resp = req
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("LLM request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let _ = resp.text().await;
            return Err(CloudError::Internal(format!(
                "LLM returned status {status}"
            )));
        }

        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("parse failed: {e}")))?;

        let choice = &resp_body["choices"][0];
        let message = &choice["message"];
        let finish_reason = choice["finish_reason"].as_str().unwrap_or("");

        // Check for tool calls
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(|tc| tc.as_array())
            .map_or(false, |tc| !tc.is_empty());

        let message_text = message["content"].as_str().unwrap_or("").to_string();

        if has_tool_calls || finish_reason == "tool_calls" {
            // Add assistant message with tool_calls to conversation
            conversation.push(message.clone());

            let tc_array = message["tool_calls"]
                .as_array()
                .cloned()
                .unwrap_or_default();

            // Pass 1: server-execute every Server-classified tool.
            for tc in &tc_array {
                let func = &tc["function"];
                let tool_name = func["name"].as_str().unwrap_or("");
                if classify_tool(tool_name) != ToolHandling::Server {
                    continue;
                }
                let call_id = tc["id"].as_str().unwrap_or("");
                let arguments_str = func["arguments"].as_str().unwrap_or("{}");
                let tool_input: serde_json::Value =
                    serde_json::from_str(arguments_str).unwrap_or(serde_json::json!({}));

                tool_calls_out.push(ToolCallEvent {
                    tool_name: tool_name.to_string(),
                    status: "executing".to_string(),
                    result: None,
                });

                let result = crate::services::wallet_service::execute_tool(
                    state,
                    user_id,
                    tool_name,
                    &tool_input,
                )
                .await;

                match result {
                    Ok(value) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "success".to_string(),
                            result: Some(value.clone()),
                        });
                        conversation.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": serde_json::to_string(&value).unwrap_or_default(),
                        }));
                    }
                    Err(e) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "error".to_string(),
                            result: Some(serde_json::json!({ "error": e.to_string() })),
                        });
                        conversation.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": format!("Error: {e}"),
                        }));
                    }
                }
            }

            // Pass 2: emit client_action events for Client-classified tools.
            let client_events = extract_client_actions_openai(&tc_array);
            let saw_client_action = !client_events.is_empty();
            tool_calls_out.extend(client_events);

            if saw_client_action {
                return Ok(ToolUseResult {
                    text: message_text,
                    tool_calls: tool_calls_out,
                });
            }
        } else {
            // Final text response
            return Ok(ToolUseResult {
                text: message_text,
                tool_calls: tool_calls_out,
            });
        }
    }

    Err(CloudError::Internal(
        "tool-use loop exceeded max rounds".into(),
    ))
}

/// Google Gemini tool-use loop.
async fn generate_with_tools_google(
    state: &AppState,
    user_id: Uuid,
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Google API key not configured".into(),
        ))?;

    // Convert Anthropic tool format → Gemini function declarations
    let function_declarations: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            })
        })
        .collect();

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" {
                "model"
            } else {
                "user"
            };
            serde_json::json!({ "role": role, "parts": [{ "text": &m.content }] })
        })
        .collect();

    let mut conversation = contents;
    let mut tool_calls_out = Vec::new();

    for _ in 0..5 {
        let mut body = serde_json::json!({
            "contents": conversation,
            "tools": [{ "functionDeclarations": function_declarations }],
            "generationConfig": { "maxOutputTokens": 4096 },
        });

        if let Some(sys) = system {
            body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
        }

        let url = format!(
            "{}/v1/models/{}:generateContent?key={}",
            config.base_url, config.model, api_key
        );

        let resp = safe_outbound_client()
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("Gemini request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let _ = resp.text().await;
            return Err(CloudError::Internal(format!(
                "Gemini returned status {status}"
            )));
        }

        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("parse failed: {e}")))?;

        let parts = resp_body["candidates"][0]["content"]["parts"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        // Check for function calls
        let function_calls: Vec<&serde_json::Value> = parts
            .iter()
            .filter(|p| p.get("functionCall").is_some())
            .collect();

        // Text from this turn — used both on exit (client_action or no
        // function_calls) and for fallback messaging.
        let turn_text: String = parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("");

        if !function_calls.is_empty() {
            // Add model response to conversation
            conversation.push(serde_json::json!({
                "role": "model",
                "parts": parts.clone(),
            }));

            let mut response_parts = Vec::new();

            // Pass 1: server-execute every Server-classified function call.
            for fc in &function_calls {
                let fc_obj = &fc["functionCall"];
                let tool_name = fc_obj["name"].as_str().unwrap_or("");
                if classify_tool(tool_name) != ToolHandling::Server {
                    continue;
                }
                let tool_args = &fc_obj["args"];

                tool_calls_out.push(ToolCallEvent {
                    tool_name: tool_name.to_string(),
                    status: "executing".to_string(),
                    result: None,
                });

                let result = crate::services::wallet_service::execute_tool(
                    state, user_id, tool_name, tool_args,
                )
                .await;

                match result {
                    Ok(value) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "success".to_string(),
                            result: Some(value.clone()),
                        });
                        response_parts.push(serde_json::json!({
                            "functionResponse": {
                                "name": tool_name,
                                "response": value,
                            }
                        }));
                    }
                    Err(e) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "error".to_string(),
                            result: Some(serde_json::json!({ "error": e.to_string() })),
                        });
                        response_parts.push(serde_json::json!({
                            "functionResponse": {
                                "name": tool_name,
                                "response": { "error": e.to_string() },
                            }
                        }));
                    }
                }
            }

            // Pass 2: emit client_action events for Client-classified calls.
            let client_events = extract_client_actions_google(&parts);
            let saw_client_action = !client_events.is_empty();
            tool_calls_out.extend(client_events);

            if saw_client_action {
                return Ok(ToolUseResult {
                    text: turn_text,
                    tool_calls: tool_calls_out,
                });
            }

            conversation.push(serde_json::json!({
                "role": "user",
                "parts": response_parts,
            }));
        } else {
            return Ok(ToolUseResult {
                text: turn_text,
                tool_calls: tool_calls_out,
            });
        }
    }

    Err(CloudError::Internal(
        "tool-use loop exceeded max rounds".into(),
    ))
}

// ---------------------------------------------------------------------------
// Community GPU provider generation
// ---------------------------------------------------------------------------

/// Generate text using a community GPU provider (non-streaming).
pub async fn generate_community(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<(String, String), CloudError> {
    // Returns (text, model_id) so chat.rs can emit provider info
    use crate::services::compute_service;

    // Select best provider
    let provider = compute_service::select_provider(state, "community", None).await?;

    // Create escrow
    let estimated_cost = 100; // 100 micro-USDC estimate
    let escrow_id = compute_service::create_escrow(
        &state.db,
        user_id,
        Some(provider.provider_id),
        estimated_cost,
    )
    .await?;

    // Create job
    let job_id = compute_service::create_job(
        &state.db,
        user_id,
        provider.provider_id,
        escrow_id,
        &provider.model_id,
    )
    .await?;

    // Build inference messages as JSON
    let inference_msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();
    let messages_json = serde_json::Value::Array(inference_msgs);

    // Dispatch to relay
    let result = compute_service::dispatch_inference(
        state,
        &provider.relay_pubkey,
        &messages_json,
        system,
        &provider.model_id,
        2048,
        &job_id.to_string(),
    )
    .await;

    match result {
        Ok(inference_result) => {
            // Validate response
            let quality = compute_service::validate_response(&inference_result.text, 10);

            // Complete job
            let _ = compute_service::complete_job(
                &state.db,
                job_id,
                inference_result.input_tokens as i64,
                inference_result.output_tokens as i64,
                inference_result.latency_ms as i64,
                quality.score,
            )
            .await;

            // Settle escrow
            let settle_result = compute_service::settle_escrow(
                &state.db,
                escrow_id,
                inference_result.input_tokens as i64,
                inference_result.output_tokens as i64,
                provider.price_per_1k_input,
                provider.price_per_1k_output,
            )
            .await;

            // Update daily stats
            if let Ok(ref settlement) = settle_result {
                let _ = compute_service::update_daily_stats(
                    &state.db,
                    provider.provider_id,
                    true,
                    inference_result.input_tokens as i64 + inference_result.output_tokens as i64,
                    settlement.provider_amount,
                    inference_result.latency_ms as f64,
                )
                .await;
            }

            // Update reputation
            let _ = compute_service::update_reputation(
                &state.db,
                provider.provider_id,
                true,
                Some(inference_result.latency_ms as i64),
            )
            .await;

            Ok((inference_result.text, provider.model_id))
        }
        Err(e) => {
            // Refund escrow on failure
            let _ = compute_service::refund_escrow(&state.db, escrow_id).await;
            let _ = compute_service::fail_job(&state.db, job_id, &e.to_string()).await;
            let _ =
                compute_service::update_reputation(&state.db, provider.provider_id, false, None)
                    .await;
            let _ = compute_service::update_daily_stats(
                &state.db,
                provider.provider_id,
                false,
                0,
                0,
                0.0,
            )
            .await;
            Err(e)
        }
    }
}

/// Stream text using a community GPU provider.
pub async fn stream_community(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<(TextStream, String), CloudError> {
    // Returns (stream, model_id)
    use crate::services::compute_service;

    let provider = compute_service::select_provider(state, "community", None).await?;
    let estimated_cost = 100;
    let escrow_id = compute_service::create_escrow(
        &state.db,
        user_id,
        Some(provider.provider_id),
        estimated_cost,
    )
    .await?;
    let job_id = compute_service::create_job(
        &state.db,
        user_id,
        provider.provider_id,
        escrow_id,
        &provider.model_id,
    )
    .await?;

    let inference_msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();
    let messages_json = serde_json::Value::Array(inference_msgs);

    let text_stream = compute_service::dispatch_inference_stream(
        state,
        &provider.relay_pubkey,
        &messages_json,
        system,
        &provider.model_id,
        2048,
        &job_id.to_string(),
    )
    .await?;

    // Wrap the stream to handle escrow settlement on completion
    let model_id = provider.model_id.clone();
    let db = state.db.clone();
    let provider_id = provider.provider_id;
    let price_input = provider.price_per_1k_input;
    let price_output = provider.price_per_1k_output;

    // For streaming, we settle after the stream ends. We can't know exact token counts
    // from the stream, so we estimate. The relay's InferenceStreamEnd would have them
    // but that's not easily accessible from here. Use a rough estimate.
    let wrapped = async_stream::stream! {
        let mut char_count = 0u64;
        let mut had_error = false;
        let mut pinned = std::pin::Pin::from(text_stream);
        while let Some(chunk) = futures::StreamExt::next(&mut pinned).await {
            match &chunk {
                Ok(text) => char_count += text.len() as u64,
                Err(_) => had_error = true,
            }
            yield chunk;
        }

        if had_error {
            let _ = compute_service::fail_job(&db, job_id, "stream error").await;
            let _ = compute_service::refund_escrow(&db, escrow_id).await;
            let _ = compute_service::update_reputation(&db, provider_id, false, None).await;
            let _ = compute_service::update_daily_stats(
                &db, provider_id, false, 0, 0, 0.0,
            ).await;
        } else {
            // Estimate tokens from chars (rough: 4 chars per token)
            let est_output_tokens = (char_count / 4).max(1) as i64;
            let est_input_tokens = 500i64; // rough estimate

            let _ = compute_service::complete_job(
                &db, job_id, est_input_tokens, est_output_tokens, 0i64, 0.8,
            ).await;
            let settle_result = compute_service::settle_escrow(
                &db, escrow_id, est_input_tokens, est_output_tokens, price_input, price_output,
            ).await;
            if let Ok(ref settlement) = settle_result {
                let _ = compute_service::update_daily_stats(
                    &db, provider_id, true,
                    est_input_tokens + est_output_tokens,
                    settlement.provider_amount,
                    0.0,
                ).await;
            } else {
                let _ = compute_service::update_daily_stats(
                    &db, provider_id, false, 0, 0, 0.0,
                ).await;
            }
            let _ = compute_service::update_reputation(&db, provider_id, true, None).await;
        }
    };

    Ok((Box::pin(wrapped), model_id))
}

// ---------------------------------------------------------------------------
// Encryption helpers (for user API keys)
// ---------------------------------------------------------------------------

pub fn encrypt_api_key(plaintext: &str, key: &[u8; 32]) -> Result<Vec<u8>, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    use rand::RngCore;

    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| CloudError::Internal(format!("encryption failed: {e}")))?;

    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);
    Ok(result)
}

pub fn decrypt_api_key(data: &[u8], key: &[u8; 32]) -> Result<String, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    if data.len() < 12 {
        return Err(CloudError::Internal("encrypted data too short".into()));
    }

    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CloudError::Internal(format!("decryption failed: {e}")))?;

    String::from_utf8(plaintext)
        .map_err(|e| CloudError::Internal(format!("invalid UTF-8 after decrypt: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_validator_requires_https() {
        assert!(validate_user_base_url("https://api.example.com").is_ok());
        // http:// rejected
        assert!(validate_user_base_url("http://api.example.com").is_err());
        // garbage rejected
        assert!(validate_user_base_url("not a url").is_err());
        assert!(validate_user_base_url("ftp://example.com").is_err());
    }

    #[test]
    fn base_url_validator_blocks_private_and_metadata_ip_literals() {
        // Cloud metadata + private/loopback/link-local IP literals are blocked,
        // even with the https scheme.
        assert!(validate_user_base_url("https://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_user_base_url("https://127.0.0.1").is_err());
        assert!(validate_user_base_url("https://10.0.0.5:8443").is_err());
        assert!(validate_user_base_url("https://192.168.1.1").is_err());
        assert!(validate_user_base_url("https://172.16.0.1").is_err());
        assert!(validate_user_base_url("https://[::1]").is_err());
        // A public IP literal is allowed.
        assert!(validate_user_base_url("https://1.1.1.1").is_ok());
    }

    #[test]
    fn parse_scheme_host_strips_userinfo_port_and_path() {
        assert_eq!(
            parse_scheme_host("https://user:pass@host.example.com:8443/v1/x?q=1"),
            Some(("https".to_string(), "host.example.com".to_string()))
        );
        assert_eq!(
            parse_scheme_host("https://[2001:db8::1]:443/path"),
            Some(("https".to_string(), "2001:db8::1".to_string()))
        );
        assert_eq!(parse_scheme_host("https://"), None);
        assert_eq!(parse_scheme_host("noscheme"), None);
    }

    #[test]
    fn is_blocked_ip_covers_metadata_and_private_ranges() {
        use std::net::IpAddr;
        assert!(is_blocked_ip("169.254.169.254".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("10.1.2.3".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("172.31.255.255".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("192.168.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("100.64.0.1".parse::<IpAddr>().unwrap())); // CGNAT
        assert!(is_blocked_ip("::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("fc00::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("fe80::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("::ffff:127.0.0.1".parse::<IpAddr>().unwrap())); // mapped loopback
        // Reserved / Class-E 240.0.0.0/4 and broadcast.
        assert!(is_blocked_ip("240.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("255.255.255.255".parse::<IpAddr>().unwrap()));
        // Public addresses pass.
        assert!(!is_blocked_ip("8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("2606:4700::1111".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn is_blocked_ip_unwraps_ipv6_transition_embeddings() {
        use std::net::IpAddr;
        // 6to4 (2002::/16) wrapping internal v4 must be blocked.
        // 2002:7f00:0001:: embeds 127.0.0.1.
        assert!(is_blocked_ip("2002:7f00:0001::".parse::<IpAddr>().unwrap()));
        // 2002:a00:0001:: embeds 10.0.0.1 (private).
        assert!(is_blocked_ip("2002:a00:1::".parse::<IpAddr>().unwrap()));
        // 2002:a9fe:a9fe:: embeds 169.254.169.254 (cloud metadata).
        assert!(is_blocked_ip("2002:a9fe:a9fe::".parse::<IpAddr>().unwrap()));
        // 6to4 wrapping a PUBLIC v4 (8.8.8.8 = 0808:0808) is allowed.
        assert!(!is_blocked_ip("2002:808:808::".parse::<IpAddr>().unwrap()));

        // NAT64 64:ff9b::/96 wrapping internal v4 must be blocked.
        // 64:ff9b::7f00:1 embeds 127.0.0.1.
        assert!(is_blocked_ip("64:ff9b::7f00:1".parse::<IpAddr>().unwrap()));
        // 64:ff9b::a9fe:a9fe embeds 169.254.169.254.
        assert!(is_blocked_ip("64:ff9b::a9fe:a9fe".parse::<IpAddr>().unwrap()));
        // NAT64 wrapping a public v4 (8.8.8.8) is allowed.
        assert!(!is_blocked_ip("64:ff9b::808:808".parse::<IpAddr>().unwrap()));

        // IPv4-compatible ::a.b.c.d (deprecated) wrapping internal v4.
        // ::7f00:1 embeds 127.0.0.1.
        assert!(is_blocked_ip("::7f00:1".parse::<IpAddr>().unwrap()));
        // ::a9fe:a9fe embeds 169.254.169.254.
        assert!(is_blocked_ip("::a9fe:a9fe".parse::<IpAddr>().unwrap()));
        // :: and ::1 still handled by unspecified/loopback (and not misflagged).
        assert!(is_blocked_ip("::".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("::1".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn classify_tool_routes_action_tools_to_client() {
        assert_eq!(classify_tool("send_email"), ToolHandling::Client);
        assert_eq!(classify_tool("send_sms"), ToolHandling::Client);
        assert_eq!(classify_tool("initiate_call"), ToolHandling::Client);
        assert_eq!(classify_tool("create_calendar_event"), ToolHandling::Client);
    }

    #[test]
    fn classify_tool_defaults_unknown_to_server() {
        // Server is the safe default for the wallet path that consumes
        // execute_tool — unknown names get an explicit error there.
        assert_eq!(classify_tool("check_wallet_balance"), ToolHandling::Server);
        assert_eq!(classify_tool("send_crypto"), ToolHandling::Server);
        assert_eq!(classify_tool("totally_unknown_tool"), ToolHandling::Server);
    }

    #[test]
    fn supports_tool_use_true_for_anthropic_openai_google() {
        assert!(supports_tool_use(&LlmProvider::Anthropic));
        assert!(supports_tool_use(&LlmProvider::OpenAI));
        assert!(supports_tool_use(&LlmProvider::Google));
    }

    #[test]
    fn supports_tool_use_true_for_openai_compatible_providers() {
        assert!(supports_tool_use(&LlmProvider::Mistral));
        assert!(supports_tool_use(&LlmProvider::Groq));
        assert!(supports_tool_use(&LlmProvider::Together));
        assert!(supports_tool_use(&LlmProvider::DeepSeek));
        assert!(supports_tool_use(&LlmProvider::OpenRouter));
        assert!(supports_tool_use(&LlmProvider::Kimi));
        assert!(supports_tool_use(&LlmProvider::Qwen));
        assert!(supports_tool_use(&LlmProvider::Glm));
        assert!(supports_tool_use(&LlmProvider::Cerebras));
    }

    #[test]
    fn supports_tool_use_false_for_community_and_ollama() {
        assert!(!supports_tool_use(&LlmProvider::Community));
        assert!(!supports_tool_use(&LlmProvider::Ollama));
    }

    // ---- Wiremock-backed HTTP integration tests ------------------------------
    //
    // These exercise the full HTTP-and-parse loop for Anthropic and OpenAI
    // against a stubbed LLM endpoint, proving that:
    //   1. The reqwest call is wired correctly to `config.base_url`.
    //   2. A response containing a Client-classified tool_use yields a
    //      `client_action` ToolCallEvent in the returned ToolUseResult.
    //   3. The loop exits after a client_action — no follow-up LLM request.

    use std::net::SocketAddr;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn minimal_cloud_config() -> CloudConfig {
        CloudConfig {
            bind_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
            database_url: "postgres://invalid".into(),
            jwt_secret: "test-secret".into(),
            bland_api_key: None,
            bland_webhook_url: None,
            claude_api_key: None,
            google_client_id: None,
            google_client_secret: None,
            apple_client_id: None,
            gmail_client_id: None,
            gmail_client_secret: None,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_price_pro: None,
            stripe_price_private_agent: None,
            stripe_price_unlimited: None,
            base_url: "http://localhost".into(),
            encryption_key: [0u8; 32],
            telegram_bot_token: None,
            solana_rpc_url: "http://localhost".into(),
            groq_api_key: None,
            cerebras_api_key: None,
            google_gemini_api_key: None,
            openrouter_api_key: None,
            relay_url: "http://localhost".into(),
            platform_wallet_address: None,
            treasury_mnemonic: None,
            min_provider_reputation: 0.0,
            max_escrow_age_secs: 0,
            provider_payout_interval_secs: 0,
        }
    }

    /// Construct an AppState whose PgPool is lazy and never queried. The
    /// client-action path in `generate_with_tools_*` doesn't touch the DB —
    /// it short-circuits before reaching `wallet_service::execute_tool`.
    fn test_app_state() -> AppState {
        let config = minimal_cloud_config();
        // connect_lazy doesn't open a connection until used — fine for tests
        // that never query the DB.
        let db = sqlx::PgPool::connect_lazy(&config.database_url)
            .expect("connect_lazy never fails on parseable URL");
        AppState::new(config, db)
    }

    #[tokio::test]
    async fn anthropic_loop_emits_client_action_and_exits() {
        let server = MockServer::start().await;

        // Anthropic returns a tool_use for send_email; loop must exit
        // immediately without a second /v1/messages call.
        let resp_body = serde_json::json!({
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Drafting that email." },
                {
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "send_email",
                    "input": {
                        "to": "alice@example.com",
                        "subject": "demo",
                        "body": "Hi Alice"
                    }
                }
            ],
            "stop_reason": "tool_use"
        });

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(resp_body))
            .expect(1) // Asserts the loop did NOT make a second call.
            .mount(&server)
            .await;

        let state = test_app_state();
        let config = UserLlmConfig {
            provider: LlmProvider::Anthropic,
            model: "claude-test".into(),
            api_key: Some("test-key".into()),
            base_url: server.uri(),
            is_cascade: false,
        };
        let messages = vec![ChatMsg {
            role: "user".into(),
            content: "email alice@example.com".into(),
        }];

        let result =
            generate_with_tools_anthropic(&state, Uuid::nil(), &config, &messages, None, &[])
                .await
                .expect("anthropic loop should return a result");

        let client_events: Vec<_> = result
            .tool_calls
            .iter()
            .filter(|e| e.status == "client_action")
            .collect();
        assert_eq!(client_events.len(), 1, "exactly one client_action expected");
        assert_eq!(client_events[0].tool_name, "send_email");
        let input = client_events[0].result.as_ref().unwrap();
        assert_eq!(input["to"], "alice@example.com");
        assert_eq!(input["subject"], "demo");
        assert_eq!(input["body"], "Hi Alice");
        assert_eq!(result.text, "Drafting that email.");
    }

    #[tokio::test]
    async fn openai_loop_emits_client_action_and_exits() {
        let server = MockServer::start().await;

        let resp_body = serde_json::json!({
            "id": "chatcmpl_01",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "On it.",
                    "tool_calls": [{
                        "id": "call_abc",
                        "type": "function",
                        "function": {
                            "name": "send_sms",
                            "arguments": "{\"to\":\"+15551234567\",\"body\":\"On my way\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(resp_body))
            .expect(1)
            .mount(&server)
            .await;

        let state = test_app_state();
        let config = UserLlmConfig {
            provider: LlmProvider::OpenAI,
            model: "gpt-test".into(),
            api_key: Some("test-key".into()),
            base_url: server.uri(),
            is_cascade: false,
        };
        let messages = vec![ChatMsg {
            role: "user".into(),
            content: "text +15551234567".into(),
        }];

        let result = generate_with_tools_openai(&state, Uuid::nil(), &config, &messages, None, &[])
            .await
            .expect("openai loop should return a result");

        let client_events: Vec<_> = result
            .tool_calls
            .iter()
            .filter(|e| e.status == "client_action")
            .collect();
        assert_eq!(client_events.len(), 1);
        assert_eq!(client_events[0].tool_name, "send_sms");
        let input = client_events[0].result.as_ref().unwrap();
        assert_eq!(input["to"], "+15551234567");
        assert_eq!(input["body"], "On my way");
        assert_eq!(result.text, "On it.");
    }

    // ---- Anthropic extractor -------------------------------------------------

    #[test]
    fn anthropic_extracts_send_email_tool_use() {
        let content = serde_json::json!([
            { "type": "text", "text": "Drafting an email for you." },
            {
                "type": "tool_use",
                "id": "toolu_01",
                "name": "send_email",
                "input": { "to": "alice@example.com", "subject": "demo", "body": "Hi Alice" }
            }
        ]);
        let events = extract_client_actions_anthropic(content.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name, "send_email");
        assert_eq!(events[0].status, "client_action");
        let input = events[0].result.as_ref().unwrap();
        assert_eq!(input["to"], "alice@example.com");
        assert_eq!(input["subject"], "demo");
        assert_eq!(input["body"], "Hi Alice");
    }

    #[test]
    fn anthropic_extracts_multiple_client_tools_in_one_turn() {
        let content = serde_json::json!([
            {
                "type": "tool_use",
                "id": "toolu_01",
                "name": "send_email",
                "input": { "to": "alice@example.com", "subject": "demo", "body": "Hi" }
            },
            {
                "type": "tool_use",
                "id": "toolu_02",
                "name": "send_sms",
                "input": { "to": "+15551234567", "body": "On my way" }
            }
        ]);
        let events = extract_client_actions_anthropic(content.as_array().unwrap());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].tool_name, "send_email");
        assert_eq!(events[1].tool_name, "send_sms");
    }

    #[test]
    fn anthropic_skips_server_classified_tools() {
        let content = serde_json::json!([
            {
                "type": "tool_use",
                "id": "toolu_01",
                "name": "check_wallet_balance",
                "input": {}
            },
            {
                "type": "tool_use",
                "id": "toolu_02",
                "name": "send_email",
                "input": { "to": "a@b.c", "subject": "x", "body": "y" }
            }
        ]);
        let events = extract_client_actions_anthropic(content.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name, "send_email");
    }

    #[test]
    fn anthropic_returns_empty_on_text_only_turn() {
        let content = serde_json::json!([
            { "type": "text", "text": "I don't need a tool here." }
        ]);
        let events = extract_client_actions_anthropic(content.as_array().unwrap());
        assert!(events.is_empty());
    }

    // ---- OpenAI extractor ----------------------------------------------------

    #[test]
    fn openai_extracts_send_sms_tool_call() {
        let tool_calls = serde_json::json!([
            {
                "id": "call_abc",
                "type": "function",
                "function": {
                    "name": "send_sms",
                    "arguments": "{\"to\":\"+15551234567\",\"body\":\"On my way\"}"
                }
            }
        ]);
        let events = extract_client_actions_openai(tool_calls.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name, "send_sms");
        assert_eq!(events[0].status, "client_action");
        let input = events[0].result.as_ref().unwrap();
        assert_eq!(input["to"], "+15551234567");
        assert_eq!(input["body"], "On my way");
    }

    #[test]
    fn openai_extracts_initiate_call_and_create_calendar_event() {
        let tool_calls = serde_json::json!([
            {
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "initiate_call",
                    "arguments": "{\"phone_number\":\"+15550001111\",\"objective\":\"book haircut\"}"
                }
            },
            {
                "id": "call_2",
                "type": "function",
                "function": {
                    "name": "create_calendar_event",
                    "arguments": "{\"title\":\"kickoff\",\"start\":\"2026-05-20T15:00:00Z\",\"end\":\"2026-05-20T16:00:00Z\"}"
                }
            }
        ]);
        let events = extract_client_actions_openai(tool_calls.as_array().unwrap());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].tool_name, "initiate_call");
        assert_eq!(
            events[0].result.as_ref().unwrap()["phone_number"],
            "+15550001111"
        );
        assert_eq!(events[1].tool_name, "create_calendar_event");
        assert_eq!(events[1].result.as_ref().unwrap()["title"], "kickoff");
    }

    #[test]
    fn openai_skips_server_classified_tools() {
        let tool_calls = serde_json::json!([
            {
                "id": "call_1",
                "type": "function",
                "function": { "name": "send_crypto", "arguments": "{}" }
            },
            {
                "id": "call_2",
                "type": "function",
                "function": {
                    "name": "send_email",
                    "arguments": "{\"to\":\"a@b.c\",\"subject\":\"x\",\"body\":\"y\"}"
                }
            }
        ]);
        let events = extract_client_actions_openai(tool_calls.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name, "send_email");
    }

    #[test]
    fn openai_handles_malformed_arguments_as_empty_object() {
        let tool_calls = serde_json::json!([
            {
                "id": "call_1",
                "type": "function",
                "function": { "name": "send_email", "arguments": "not valid json" }
            }
        ]);
        let events = extract_client_actions_openai(tool_calls.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].result.as_ref().unwrap(), &serde_json::json!({}));
    }

    // ---- Google extractor ----------------------------------------------------

    #[test]
    fn google_extracts_create_calendar_event_function_call() {
        let parts = serde_json::json!([
            { "text": "Booking that kickoff for you." },
            {
                "functionCall": {
                    "name": "create_calendar_event",
                    "args": {
                        "title": "kickoff",
                        "start": "2026-05-20T15:00:00Z",
                        "end": "2026-05-20T16:00:00Z"
                    }
                }
            }
        ]);
        let events = extract_client_actions_google(parts.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name, "create_calendar_event");
        assert_eq!(events[0].status, "client_action");
        let input = events[0].result.as_ref().unwrap();
        assert_eq!(input["title"], "kickoff");
        assert_eq!(input["start"], "2026-05-20T15:00:00Z");
    }

    #[test]
    fn google_skips_server_classified_calls() {
        let parts = serde_json::json!([
            { "functionCall": { "name": "check_wallet_balance", "args": {} } },
            { "functionCall": {
                "name": "send_sms",
                "args": { "to": "+15551234567", "body": "ping" }
            }}
        ]);
        let events = extract_client_actions_google(parts.as_array().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_name, "send_sms");
    }

    #[test]
    fn google_returns_empty_when_parts_are_text_only() {
        let parts = serde_json::json!([
            { "text": "Here's what I'd suggest..." }
        ]);
        let events = extract_client_actions_google(parts.as_array().unwrap());
        assert!(events.is_empty());
    }

    // -----------------------------------------------------------------------
    // Connect-time SSRF enforcement (H5). These prove the *security boundary*,
    // not just the fast-fail pre-flight: the resolver and redirect policy on
    // `safe_outbound_client()` are what actually stop a redirect-to-private or
    // a DNS-rebind-to-private from connecting.
    // -----------------------------------------------------------------------

    /// The guard resolver must refuse a hostname that resolves into a blocked
    /// range. `localhost` resolves to loopback (127.0.0.1 / ::1), which
    /// `is_blocked_ip` rejects, so the resolver yields an error and reqwest
    /// never opens the socket.
    #[tokio::test]
    async fn ssrf_resolver_rejects_loopback_hostname() {
        use reqwest::dns::Resolve;
        let resolver = SsrfGuardResolver;
        let name: reqwest::dns::Name = "localhost".parse().expect("valid dns name");
        let result = resolver.resolve(name).await;
        assert!(
            result.is_err(),
            "resolver must reject localhost (resolves to loopback, a blocked range)"
        );
    }

    /// End-to-end: a `safe_outbound_client()` request to a real loopback
    /// listener must FAIL at connect time, because the resolver strips the
    /// 127.0.0.1 address. This is the rebinding/SSRF backstop — even if a
    /// hostname slipped past set-time validation, the connect is blocked.
    #[tokio::test]
    async fn safe_client_refuses_to_connect_to_loopback_server() {
        // Bind a real loopback server so the test is hermetic (no external DNS).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        // Accept (and immediately drop) one connection if we ever get one — we
        // assert we do NOT, but the task keeps the listener alive for the test.
        let server = tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        // `localhost` forces the request through the DNS resolver (an IP
        // literal would bypass DNS), which is where the block happens.
        let url = format!("http://localhost:{port}/v1/messages");
        let resp = safe_outbound_client().get(&url).send().await;
        assert!(
            resp.is_err(),
            "safe client must fail to connect to a loopback target (got {resp:?})"
        );

        server.abort();
    }

    /// `safe_outbound_client()` must NOT follow redirects. A public-looking
    /// request that 3xx-redirects toward an internal target must surface the
    /// 3xx itself rather than chasing the Location header. We assert against a
    /// loopback server that returns a redirect — but since the client also
    /// refuses to connect to loopback, the stronger guarantee (no connection
    /// at all) already holds; here we assert the redirect policy directly on a
    /// constructed client by inspecting that a 3xx is returned, not followed,
    /// for a same-origin public case is environment-dependent, so we validate
    /// the policy is wired by confirming the builder produced a client whose
    /// redirect behavior is `none` via a loopback redirect that, if followed,
    /// would still be blocked by the resolver. The connect-refusal test above
    /// is the load-bearing assertion; this documents intent.
    #[tokio::test]
    async fn safe_client_does_not_follow_redirect_to_loopback() {
        // Serve a 302 -> http://127.0.0.1:<port>/internal on a loopback socket.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let body = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/internal\r\nContent-Length: 0\r\n\r\n"
                );
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });

        // Connect by IP literal so the resolver is bypassed and we exercise the
        // REDIRECT policy in isolation: the first hop succeeds (127.0.0.1
        // literal is not DNS-resolved), and we assert we get the 302 back
        // rather than the client chasing the Location into a second request.
        let url = format!("http://127.0.0.1:{port}/start");
        match safe_outbound_client().get(&url).send().await {
            Ok(resp) => assert_eq!(
                resp.status().as_u16(),
                302,
                "redirect must be surfaced, not followed"
            ),
            Err(e) => panic!("first hop to IP literal should connect: {e}"),
        }

        server.abort();
    }
}
