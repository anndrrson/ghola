//! Axum HTTP routes.
//!
//! Privacy-critical endpoint contracts:
//!   - `POST /relay`: validates proof shape only (NOT cryptographic
//!     correctness — the on-chain program is the source of truth). Returns
//!     a uuid and ETA estimate. Does NOT echo proof / recipient / amount.
//!   - `GET /status/:id`: returns ONE of the [`ClientStatus`] variants. It
//!     MUST NOT return the on-chain signature, the in-batch position, the
//!     submission time, or any data that could link the queue id to an
//!     observed on-chain transaction.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::batcher::Batcher;
use crate::config::Config;
use crate::dedup::{Dedup, DedupOutcome};
use crate::error::{Error, Result};
use crate::metrics::Metrics;
use crate::queue::{ProofBlob, QueuedAccountMeta, QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus};

/// Per-IP fixed-window rate limiter for `POST /relay`.
///
/// Bounds how fast a single source can submit (and thus grow the dedup index /
/// consume queue slots with unique proofs). Privacy: only a coarse
/// `IpAddr -> (window, count)` map is held in memory; nothing is persisted or
/// logged. Many clients share an egress IP behind a CDN, so this is a DoS
/// bound, not a per-user quota.
#[derive(Clone, Default)]
pub struct IpRateLimiter {
    windows: Arc<Mutex<HashMap<IpAddr, (i64, u32)>>>,
}

impl IpRateLimiter {
    /// Returns `true` if allowed, `false` if the per-minute limit is exceeded.
    /// `max_per_min == 0` disables limiting.
    pub async fn check(&self, ip: IpAddr, max_per_min: u32) -> bool {
        if max_per_min == 0 {
            return true;
        }
        let now_minute = Utc::now().timestamp() / 60;
        let mut windows = self.windows.lock().await;
        let entry = windows.entry(ip).or_insert((now_minute, 0));
        if entry.0 != now_minute {
            *entry = (now_minute, 1);
            return true;
        }
        entry.1 += 1;
        entry.1 <= max_per_min
    }

    /// Drop stale windows (older than the previous minute).
    pub async fn cleanup(&self) {
        let now_minute = Utc::now().timestamp() / 60;
        let mut windows = self.windows.lock().await;
        windows.retain(|_, (window, _)| *window >= now_minute - 1);
    }
}

#[derive(Clone)]
pub struct AppState {
    pub queue: WithdrawalQueue,
    pub config: Arc<Config>,
    pub metrics: Arc<Metrics>,
    pub wake_batcher: Arc<tokio::sync::Notify>,
    /// Content-addressed dedup index (Stream 3). Atomic CAS-guarded
    /// `H(proof_a || proof_b || proof_c) -> request_id` table. See
    /// [`crate::dedup`] for design notes.
    pub dedup: Arc<Dedup>,
    /// Per-IP rate limiter for `POST /relay` (DoS bound, M3).
    pub ip_rate_limiter: IpRateLimiter,
}

impl AppState {
    /// Construct with an ephemeral in-memory dedup index. Used by tests
    /// and by callers (e.g. `chaos-tests::harness`) that predate Stream 3.
    /// Production callers should prefer [`AppState::with_dedup`] so the
    /// dedup index persists across restarts (otherwise a relayer crash
    /// resets replay protection until the queue drains).
    pub fn new(
        queue: WithdrawalQueue,
        config: Arc<Config>,
        metrics: Arc<Metrics>,
        batcher: &Batcher,
    ) -> Self {
        let dedup = Arc::new(
            Dedup::open_temporary().expect("in-memory dedup must open"),
        );
        Self::with_dedup(queue, config, metrics, batcher, dedup)
    }

    /// Construct with an explicit (typically persistent) dedup index.
    /// Used by `main.rs` so replay protection survives restarts.
    pub fn with_dedup(
        queue: WithdrawalQueue,
        config: Arc<Config>,
        metrics: Arc<Metrics>,
        batcher: &Batcher,
        dedup: Arc<Dedup>,
    ) -> Self {
        Self {
            queue,
            config,
            metrics,
            wake_batcher: batcher.wake.clone(),
            dedup,
            ip_rate_limiter: IpRateLimiter::default(),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/relay", post(relay))
        .route("/status/{id}", get(status))
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    /// Opaque JSON proof bundle; we never structurally decode it inside
    /// the relayer (see `queue::ProofBlob`).
    pub proof_bundle: ProofBlob,
    pub recipient: String, // base58 pubkey, validated below
    pub fee: u64,
    pub relayer_fee: u64,
    /// Hex-encoded instruction data (Anchor discriminator + Borsh
    /// args). Optional for back-compat with older clients; if absent,
    /// the withdrawal sits in the queue forever (no chain submission)
    /// — the new client always supplies this.
    #[serde(default)]
    pub instruction_data_hex: Option<String>,
    /// On-chain account list for the said-shielded-pool program's
    /// `withdraw` ix, in program-expected order. Excludes the relayer
    /// fee payer (the submitter splices that in).
    #[serde(default)]
    pub accounts: Vec<QueuedAccountMeta>,
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub id: Uuid,
    pub eta_seconds: u64,
}

/// Retry-After header value (seconds) returned alongside HTTP 429 when the
/// pending-queue cap is hit. Picked to be longer than [`Config::min_delay`]
/// default (30s) so a polite client doesn't immediately re-hammer the
/// relayer; short enough not to be useless if the operator drained the
/// queue by hand.
const QUEUE_FULL_RETRY_AFTER_SECS: u64 = 30;

/// Retry-After (seconds) returned with HTTP 429 when the per-IP rate limit is
/// hit. Aligned with the per-minute window.
const RATE_LIMIT_RETRY_AFTER_SECS: u64 = 60;

/// Best-effort client IP for rate limiting.
///
/// `X-Forwarded-For` is honored ONLY when the immediate connecting peer
/// (`conn`) is in the operator-configured trusted-proxy set
/// ([`crate::config::Config::trusted_proxies`]). In that case we take the
/// rightmost VALID XFF entry — a trusted proxy appends the real client on the
/// right; the leftmost is client-controlled and trivially spoofable.
///
/// For ANY untrusted peer — a direct client connection, or a deployment with
/// no proxy (the default, since `trusted_proxies` is empty) — we IGNORE XFF
/// entirely and key on the real peer `SocketAddr`. Without this, a direct
/// client could forge `X-Forwarded-For` to rotate its rate-limit identity on
/// every request, trivially defeating the per-IP limiter.
///
/// The peer `SocketAddr` is provided via `ConnectInfo` in the request
/// extensions when the server is built with
/// `into_make_service_with_connect_info` (see `main.rs`). When it is absent
/// (e.g. tests using a bare `axum::serve`), there is no peer to trust, so XFF
/// is still ignored and the result is `None` (rate limiting is skipped).
fn client_ip(
    headers: &HeaderMap,
    conn: Option<IpAddr>,
    trusted_proxies: &std::collections::HashSet<IpAddr>,
) -> Option<IpAddr> {
    let peer = conn?;
    if trusted_proxies.contains(&peer) {
        // Trusted proxy: prefer the rightmost valid XFF entry it appended;
        // fall back to the peer (the proxy itself) if XFF is missing/garbage.
        if let Some(xff_ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').rev().find_map(|part| part.trim().parse().ok()))
        {
            return Some(xff_ip);
        }
    }
    // Untrusted peer (or no/invalid XFF from a trusted proxy): use the real
    // socket peer address. Never trust a client-supplied XFF here.
    Some(peer)
}

async fn relay(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: axum::extract::Request,
) -> std::result::Result<Response, Error> {
    // Pull the peer IP from ConnectInfo (present in prod via
    // `into_make_service_with_connect_info`; absent in tests that use a bare
    // `axum::serve`), then buffer + parse the JSON body ourselves so this
    // handler stays a single body-consuming extractor.
    let conn_ip = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0.ip());

    // ----- Stage 0: per-IP rate limit (M3 DoS bound) -----
    // Runs first so a flood is cheap to reject — before JSON validation, the
    // dedup index, or queue accounting. We log at DEBUG only (an INFO rejection
    // rate would be a weak timing side-channel, same rationale as below).
    let ip = client_ip(&headers, conn_ip, &state.config.trusted_proxies);
    if let Some(ip) = ip {
        if !state
            .ip_rate_limiter
            .check(ip, state.config.relay_rate_limit_per_min)
            .await
        {
            tracing::debug!("relay rejected: per-IP rate limit");
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                [("Retry-After", RATE_LIMIT_RETRY_AFTER_SECS.to_string())],
                Json(json!({"error": "rate_limited"})),
            )
                .into_response());
        }
    }

    // Buffer + deserialize the body only AFTER the cheap rate-limit gate, so a
    // flood can't force per-request JSON parsing. Bound the body to a generous
    // ceiling to avoid unbounded memory use.
    const MAX_RELAY_BODY_BYTES: usize = 256 * 1024;
    let body_bytes = axum::body::to_bytes(req.into_body(), MAX_RELAY_BODY_BYTES)
        .await
        .map_err(|_| Error::BadRequest("request body too large or unreadable".into()))?;
    let req: RelayRequest = serde_json::from_slice(&body_bytes)
        .map_err(|_| Error::BadRequest("invalid relay request JSON".into()))?;

    // ----- Stage 1: shape validation -----
    // Cheap, syntactic. Run first so adversarial garbage is rejected
    // before we hit the dedup index or count the queue depth.
    validate_proof_shape(&req.proof_bundle)?;
    let recipient = decode_recipient(&req.recipient)?;

    if req.relayer_fee > req.fee {
        return Err(Error::BadRequest("relayer_fee > fee".into()));
    }

    let instruction_data = match &req.instruction_data_hex {
        Some(h) => hex::decode(h)
            .map_err(|_| Error::BadRequest("instruction_data_hex must be valid hex".into()))?,
        None => Vec::new(),
    };
    // Sanity-check supplied account list. Cap matches Solana's
    // realistic per-tx account limit; mainly here to reject malformed
    // payloads early so they don't sit forever in the queue.
    if req.accounts.len() > 64 {
        return Err(Error::BadRequest("too many accounts".into()));
    }

    // ----- Stage 2: replay / dedup check (Stream 3) -----
    // Content-address the proof and refuse to re-queue a duplicate.
    // Runs BEFORE the queue-depth cap because a duplicate POST is
    // idempotent — the client should get its existing request_id back,
    // not a 429. Otherwise an attacker who fills the queue with
    // genuine submissions could DoS legitimate retries; with this
    // ordering, retries of already-accepted proofs always succeed
    // (returning the original id) regardless of queue pressure.
    //
    // Privacy: the dedup key is content-derived from the proof and
    // must NEVER be logged. The outcome event is DEBUG-only; INFO
    // would let an operator with read-only log access reconstruct
    // a "duplicate-detection rate" timing channel.
    let request_id = Uuid::new_v4();
    match state.dedup.check_and_record(&req.proof_bundle.0, request_id)? {
        DedupOutcome::Fresh => {
            // Fall through to queue-depth + enqueue.
        }
        DedupOutcome::Duplicate(existing) => {
            tracing::debug!("relay duplicate detected (debug-only)");
            return Ok((
                StatusCode::OK,
                Json(json!({
                    "id": existing.to_string(),
                    "status": "duplicate",
                    "message": "this proof was already accepted"
                })),
            )
                .into_response());
        }
    }

    // ----- Stage 3: backpressure (Stream 6) -----
    // Bound the on-disk queue so a sustained burst (or an adversarial
    // flood of *unique* proofs) cannot exhaust the relayer's disk and
    // memory. Runs AFTER dedup so legitimate retries are never 429'd.
    // We log at DEBUG — INFO would leak the rate at which we're
    // rejecting traffic, which is a (weak) timing side-channel.
    //
    // Subtle: if we reject here we've already recorded the proof in
    // the dedup tree (via the Fresh branch above). That's intentional —
    // a future retry of the same proof, once the queue has drained,
    // will hit Duplicate and return this fresh id, and `/status/:id`
    // will report Unknown until the client re-submits. This is the
    // less-bad failure mode; the alternative (rolling back the dedup
    // insert on 429) would race with concurrent submissions.
    let depth = state.queue.depth().unwrap_or_default();
    if depth >= state.config.max_queue_depth {
        tracing::debug!("relay rejected: queue_full");
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            [("Retry-After", QUEUE_FULL_RETRY_AFTER_SECS.to_string())],
            Json(json!({"error": "queue_full"})),
        )
            .into_response());
    }

    let w = QueuedWithdrawal {
        id: request_id,
        proof_bundle: req.proof_bundle,
        recipient,
        fee: req.fee,
        relayer_fee: req.relayer_fee,
        instruction_data,
        accounts: req.accounts,
        accepted_at: Utc::now(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    };
    state.queue.insert(&w)?;

    // Privacy: log only that an item arrived. NEVER include the proof,
    // recipient, amount, or id at INFO. The id is debug-only because while
    // it's not on-chain-correlated, it IS what the client gets back, and
    // anyone with both an INFO log and the client response can link them.
    tracing::info!(queue_depth = ?state.queue.depth().unwrap_or_default(), "withdrawal accepted");
    tracing::debug!(id = %request_id, "accepted withdrawal (debug-only id)");

    state.wake_batcher.notify_one();

    let eta_seconds = estimate_eta(&state).unwrap_or(state.config.min_delay.as_secs());
    Ok(Json(RelayResponse { id: request_id, eta_seconds }).into_response())
}

/// Client-visible status. Note the deliberate collapse: `Batched` and
/// `Submitted` both surface as `Submitted` so the client cannot infer
/// whether their tx is still inside the jitter window vs. already on
/// the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientStatus {
    Pending,
    Submitted,
    Confirmed,
    Failed,
    Unknown,
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub status: ClientStatus,
}

pub fn status_response(s: WithdrawalStatus) -> ClientStatus {
    match s {
        WithdrawalStatus::Pending => ClientStatus::Pending,
        WithdrawalStatus::Batched | WithdrawalStatus::Submitted => ClientStatus::Submitted,
        WithdrawalStatus::Confirmed => ClientStatus::Confirmed,
        WithdrawalStatus::Failed => ClientStatus::Failed,
    }
}

async fn status(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<StatusResponse>> {
    match state.queue.get(id)? {
        None => {
            // Either truly unknown OR already garbage-collected post-confirm.
            // We return `unknown` rather than 404 so the response shape is
            // uniform — a client probing nonexistent ids gets exactly the
            // same response shape as a client probing GC'd ids.
            Ok(Json(StatusResponse {
                status: ClientStatus::Unknown,
            }))
        }
        Some(w) => Ok(Json(StatusResponse {
            status: status_response(w.status),
        })),
    }
}

async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.metrics.render();
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        body,
    )
}

/// Shape-only proof validation. We do NOT verify cryptographically — the
/// on-chain program is the trust anchor and re-validation here would just
/// duplicate work and risk subtle divergence.
///
/// We treat the proof bundle as an opaque JSON blob and only sanity-check
/// the surface shape:
///   - It is a JSON object.
///   - It contains either the canonical nested shape
///     `{ proof: { a, b, c }, public_inputs: { ... } }` or the flattened
///     Android/cloud bridge shape `{ a, b, c, input_nullifiers, ... }`.
///   - `input_nullifiers` and `output_commitments` exist as non-empty arrays
///     of reasonable size.
fn validate_proof_shape(pb: &ProofBlob) -> Result<()> {
    let obj = pb
        .0
        .as_object()
        .ok_or_else(|| Error::BadRequest("proof_bundle must be an object".into()))?;

    if let Some(proof) = obj.get("proof").and_then(|v| v.as_object()) {
        for key in ["a", "b", "c"] {
            if !proof.contains_key(key) {
                return Err(Error::BadRequest(format!("missing proof.{key}")));
            }
        }
    } else {
        for key in ["a", "b", "c"] {
            if !obj.contains_key(key) {
                return Err(Error::BadRequest(format!("missing {key}")));
            }
        }
    }
    let nested_pi = obj
        .get("public_inputs")
        .and_then(|v| v.as_object());

    let check_array = |key: &str| -> Result<()> {
        let arr = nested_pi
            .and_then(|pi| pi.get(key))
            .or_else(|| obj.get(key))
            .and_then(|v| v.as_array())
            .ok_or_else(|| Error::BadRequest(format!("{key} must be an array")))?;
        if arr.is_empty() {
            return Err(Error::BadRequest(format!("{key} empty")));
        }
        if arr.len() > 16 {
            return Err(Error::BadRequest(format!("too many {key}")));
        }
        Ok(())
    };
    check_array("input_nullifiers")?;
    check_array("output_commitments")?;
    Ok(())
}

fn decode_recipient(s: &str) -> Result<[u8; 32]> {
    // Lightweight base58 decode (avoid pulling solana-sdk).
    // We accept any 32-byte payload; the on-chain program will validate it
    // against the commitment in `ext_data_hash`.
    let bytes = bs58_decode(s)?;
    if bytes.len() != 32 {
        return Err(Error::BadRequest("recipient must be 32 bytes".into()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn bs58_decode(s: &str) -> Result<Vec<u8>> {
    // Minimal pure-Rust bs58 implementation to avoid adding bs58 to deps.
    // Adequate for input validation. The on-chain check is the real arbiter.
    const ALPHABET: &[u8] =
        b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut map = [255u8; 128];
    for (i, c) in ALPHABET.iter().enumerate() {
        map[*c as usize] = i as u8;
    }
    let s = s.as_bytes();
    let mut zeros = 0;
    while zeros < s.len() && s[zeros] == b'1' {
        zeros += 1;
    }
    let mut b256 = vec![0u8; s.len() * 733 / 1000 + 1];
    let mut length = 0;
    for &c in &s[zeros..] {
        if c >= 128 || map[c as usize] == 255 {
            return Err(Error::BadRequest("invalid base58 in recipient".into()));
        }
        let mut carry = map[c as usize] as u32;
        let mut i = 0;
        for byte in b256.iter_mut().rev() {
            if i >= length && carry == 0 {
                break;
            }
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
            i += 1;
        }
        length = i;
    }
    let mut out = vec![0u8; zeros];
    out.extend_from_slice(&b256[b256.len() - length..]);
    Ok(out)
}

fn estimate_eta(state: &AppState) -> Result<u64> {
    let depth = state.queue.depth()?;
    let cfg = &state.config;
    // Very rough heuristic for the client UX. Not a privacy leak: every
    // client gets the same formula based on queue depth, which is also
    // exposed via /metrics.
    if depth + 1 >= cfg.anonymity_threshold {
        Ok(cfg.min_delay.as_secs())
    } else {
        Ok(cfg.max_delay.as_secs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::net::IpAddr;

    fn hdrs(xff: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(v) = xff {
            h.insert("x-forwarded-for", v.parse().unwrap());
        }
        h
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    /// M3: with no trusted proxies (the default), a client-supplied XFF MUST be
    /// ignored — the rate-limit key is the real peer, so XFF spoofing cannot
    /// rotate identity.
    #[test]
    fn xff_ignored_when_no_trusted_proxies() {
        let trusted = HashSet::new();
        let got = client_ip(
            &hdrs(Some("1.2.3.4, 5.6.7.8")),
            Some(ip("203.0.113.9")),
            &trusted,
        );
        assert_eq!(got, Some(ip("203.0.113.9")), "must key on peer, not XFF");
    }

    /// A spoofed XFF from an untrusted peer is ignored even if it rotates every
    /// request: two different forged XFFs from the same peer map to the same
    /// rate-limit key (the peer).
    #[test]
    fn spoofed_xff_cannot_rotate_identity() {
        let trusted = HashSet::new();
        let peer = ip("203.0.113.9");
        let a = client_ip(&hdrs(Some("9.9.9.9")), Some(peer), &trusted);
        let b = client_ip(&hdrs(Some("8.8.8.8")), Some(peer), &trusted);
        assert_eq!(a, b);
        assert_eq!(a, Some(peer));
    }

    /// When the immediate peer IS a trusted proxy, honor the rightmost valid
    /// XFF entry (the real client the proxy appended).
    #[test]
    fn xff_honored_from_trusted_proxy_rightmost() {
        let mut trusted = HashSet::new();
        trusted.insert(ip("10.0.0.1")); // the proxy's peer address
        let got = client_ip(
            &hdrs(Some("1.2.3.4, 203.0.113.50")),
            Some(ip("10.0.0.1")),
            &trusted,
        );
        // Rightmost valid entry = the address the trusted proxy appended.
        assert_eq!(got, Some(ip("203.0.113.50")));
    }

    /// A trusted proxy with a missing/garbage XFF falls back to the proxy peer.
    #[test]
    fn trusted_proxy_without_xff_falls_back_to_peer() {
        let mut trusted = HashSet::new();
        trusted.insert(ip("10.0.0.1"));
        let got = client_ip(&hdrs(None), Some(ip("10.0.0.1")), &trusted);
        assert_eq!(got, Some(ip("10.0.0.1")));
    }

    /// No peer (e.g. bare `axum::serve` in tests) => no rate-limit key, XFF is
    /// never trusted on its own.
    #[test]
    fn no_peer_yields_none_even_with_xff() {
        let trusted = HashSet::new();
        let got = client_ip(&hdrs(Some("1.2.3.4")), None, &trusted);
        assert_eq!(got, None);
    }
}
