use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use ed25519_dalek::{Signature, Verifier, VerifyingKey, PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH};
use serde::Deserialize;

use thumper_types::AuthPayload;

use crate::error::RelayError;

// Re-export the shared replay-protection cache so existing callers
// (`thumper_relay::auth::NonceCache`) keep working unchanged.
pub use said_noncecache::NonceCache;

/// Verify an authentication payload. Returns the authenticated pubkey on success.
///
/// In dev mode, signature verification is skipped — only timestamp is checked.
pub fn verify_auth(
    payload: &AuthPayload,
    auth_timeout_secs: u64,
    dev_mode: bool,
    nonce_cache: Option<&NonceCache>,
) -> Result<String, RelayError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RelayError::Internal("system clock error".into()))?
        .as_secs();

    let elapsed = now.saturating_sub(payload.message.timestamp);
    if elapsed > auth_timeout_secs {
        return Err(RelayError::Auth("auth message expired".into()));
    }

    if payload.message.timestamp > now.saturating_add(30) {
        return Err(RelayError::Auth(
            "auth message timestamp in the future".into(),
        ));
    }

    // Check nonce for replay prevention
    if let Some(cache) = nonce_cache {
        if cache.check_and_insert(&payload.message.nonce) {
            return Err(RelayError::Auth("nonce already used (replay detected)".into()));
        }
    }

    // In dev mode, trust the pubkey without verifying the signature
    if dev_mode {
        tracing::warn!(
            pubkey = %payload.message.pubkey,
            "dev mode: skipping signature verification"
        );
        return Ok(payload.message.pubkey.clone());
    }

    // Decode pubkey from base58
    let pubkey_bytes = bs58_decode(&payload.message.pubkey)
        .map_err(|_| RelayError::Auth("invalid pubkey encoding".into()))?;

    if pubkey_bytes.len() != PUBLIC_KEY_LENGTH {
        return Err(RelayError::Auth("invalid pubkey length".into()));
    }

    let mut key_array = [0u8; PUBLIC_KEY_LENGTH];
    key_array.copy_from_slice(&pubkey_bytes);
    let verifying_key = VerifyingKey::from_bytes(&key_array)
        .map_err(|_| RelayError::Auth("invalid public key".into()))?;

    // Decode signature from base64
    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &payload.signature,
    )
    .map_err(|_| RelayError::Auth("invalid signature encoding".into()))?;

    if sig_bytes.len() != SIGNATURE_LENGTH {
        return Err(RelayError::Auth("invalid signature length".into()));
    }

    let signature = Signature::from_bytes(
        sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| RelayError::Auth("invalid signature length".into()))?,
    );

    let message_bytes = payload.message.canonical_bytes();

    verifying_key
        .verify(&message_bytes, &signature)
        .map_err(|_| RelayError::Auth("signature verification failed".into()))?;

    Ok(payload.message.pubkey.clone())
}

/// Minimal base58 decoding (Bitcoin/Solana alphabet). Exported for testing.
pub(crate) fn bs58_decode(input: &str) -> Result<Vec<u8>, ()> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    let mut result: Vec<u8> = Vec::new();

    for &c in input.as_bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c).ok_or(())? as u32;
        for byte in result.iter_mut() {
            let val = (*byte as u32) * 58 + carry;
            *byte = (val & 0xFF) as u8;
            carry = val >> 8;
        }
        while carry > 0 {
            result.push((carry & 0xFF) as u8);
            carry >>= 8;
        }
    }

    for &c in input.as_bytes() {
        if c == b'1' {
            result.push(0);
        } else {
            break;
        }
    }

    result.reverse();
    Ok(result)
}

// ---------------------------------------------------------------------------
// Sealed-inference auth middleware (Phase 3 of v3.5 privacy rollout)
// ---------------------------------------------------------------------------
//
// Replaces the `Authorization: Bearer <jwt>` header for `POST
// /inference/sealed`. Authentication is now derived from the said-envelope
// nested inside the request body:
//
//   1. Parse the JSON body, base64-decode `sealed_request_b64`, and call
//      `said_envelope::open_header_unchecked` to extract `sender_did`
//      and the per-envelope `nonce` *without* decrypting (the relay
//      does not have the enclave's X25519 secret, so it cannot open the
//      envelope; it only needs the header + the trailing signature).
//   2. Verify the trailing Ed25519 signature against `sender_did` —
//      this proves the request was authored by the holder of that DID's
//      private key. We don't reuse `said_envelope::open()` because that
//      requires the recipient's X25519 secret; instead we re-run the
//      signature step against the sender's DID-derived verifying key.
//   3. Reject if `sender_did ∉ did_set` (401 unknown DID).
//   4. Reject if the envelope's nonce has been seen recently (429 replay).
//
// The middleware then reconstructs the original `Request` (body
// preserved) and forwards it to the handler.

/// Shape of the JSON body for `POST /inference/sealed`. Mirrors
/// `crate::handlers::SealedInferenceDispatchRequest` but only includes
/// the fields the middleware needs to look at.
#[derive(Debug, Deserialize)]
struct SealedAuthBodyPeek {
    sealed_request_b64: String,
}

/// Max body size we'll buffer to inspect. The body is then re-injected
/// into the request and forwarded to the handler. 2 MiB is generous —
/// sealed inference payloads are tens of KiB at most.
const MAX_SEALED_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Authentication middleware for `POST /inference/sealed`.
///
/// Privacy goal: the relay must be able to assert "this request was
/// produced by *some* registered Ghola DID" without learning *which*
/// user account it belongs to. The sender DID is per-DID-linkable
/// (same DID = same pseudonym across requests) but per-DID-unidentifiable
/// (we never join it to email/google_id/etc. at the relay). Full
/// per-request unlinkability is v4 (Privacy Pass).
pub async fn require_sealed_envelope_auth(
    State(state): State<crate::state::AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    use axum::body::{to_bytes, Body};

    let (parts, body) = request.into_parts();
    let body_bytes = match to_bytes(body, MAX_SEALED_BODY_BYTES).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("sealed-inference auth: failed to buffer body: {e}");
            return Err(axum::http::StatusCode::BAD_REQUEST);
        }
    };

    // -- parse JSON; extract sealed_request_b64 ---------------------------
    let peek: SealedAuthBodyPeek = match serde_json::from_slice(&body_bytes) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("sealed-inference auth: invalid JSON: {e}");
            return Err(axum::http::StatusCode::BAD_REQUEST);
        }
    };

    let envelope_bytes = match base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &peek.sealed_request_b64,
    ) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("sealed-inference auth: bad base64: {e}");
            return Err(axum::http::StatusCode::BAD_REQUEST);
        }
    };

    // Run the shared validator. Same logic the OHTTP gateway uses, so
    // both transports get identical auth semantics — bootstrap +
    // freshness + signature + DID membership + nonce + per-DID rate
    // limit.
    validate_sealed_envelope_bytes(&state, &envelope_bytes)?;

    // -- Reconstruct request with the original body and forward -----------
    let req = axum::http::Request::from_parts(parts, Body::from(body_bytes));
    Ok(next.run(req).await)
}

/// Run the full sealed-envelope authentication and rate-limiting check
/// against the raw (base64-decoded) envelope bytes. Used by both the
/// `POST /inference/sealed` middleware (`require_sealed_envelope_auth`)
/// and the OHTTP gateway (`handle_sealed_inference_ohttp`).
///
/// Steps, all fail-closed:
///   1. did_set must be bootstrapped (rejects until first cloud fetch).
///   2. did_set must be fresh per `did_set_max_staleness_secs`.
///   3. Envelope header must parse.
///   4. Trailing Ed25519 signature must verify against the sender DID.
///   5. Sender DID must be in the cached set.
///   6. Envelope nonce must not have been seen recently.
///   7. Sender DID must be within its rate-limit bucket.
///
/// Returns the parsed `EnvelopeHeader` on success so callers can use the
/// `sender_did` for downstream accounting/metrics if needed.
pub(crate) fn validate_sealed_envelope_bytes(
    state: &crate::state::AppState,
    envelope_bytes: &[u8],
) -> Result<EnvelopeHeader, axum::http::StatusCode> {
    // -- fail-closed if the holder hasn't bootstrapped yet ----------------
    if !state.did_set().is_bootstrapped() {
        tracing::warn!(
            "sealed-inference auth rejecting: did_set not yet bootstrapped"
        );
        return Err(axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    // -- fail-closed if the cached DID set is too stale -------------------
    {
        let now_unix = chrono::Utc::now().timestamp();
        let max = state.config().did_set_max_staleness_secs;
        if !state.did_set().is_fresh(now_unix, max) {
            let (count, last_refresh) = state.did_set().stats();
            tracing::warn!(
                count,
                last_refresh,
                now_unix,
                max_staleness_secs = max,
                "sealed-inference auth rejecting: did_set cache stale beyond \
                 THUMPER_DID_SET_MAX_STALENESS_SECS"
            );
            return Err(axum::http::StatusCode::SERVICE_UNAVAILABLE);
        }
    }

    let header = match parse_envelope_header(envelope_bytes) {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!("sealed-inference auth: envelope parse failed: {e}");
            return Err(axum::http::StatusCode::UNAUTHORIZED);
        }
    };

    if !verify_envelope_signature(envelope_bytes, &header.sender_did) {
        tracing::warn!(
            "sealed-inference auth: envelope signature verification failed \
             (DID redacted from public-facing logs)"
        );
        return Err(axum::http::StatusCode::UNAUTHORIZED);
    }

    if !state.did_set().contains(&header.sender_did) {
        tracing::warn!("sealed-inference auth: sender DID not in did_set");
        return Err(axum::http::StatusCode::UNAUTHORIZED);
    }

    if state.nonce_cache().check_and_insert(&header.nonce_hex) {
        tracing::warn!("sealed-inference auth: nonce replay detected");
        return Err(axum::http::StatusCode::TOO_MANY_REQUESTS);
    }

    // -- per-DID rate limit -----------------------------------------------
    //
    // Sealed inference is expensive on the relay (HPKE decap, envelope
    // verify, did-set check, then a WS forward to the provider). A
    // per-WS-connection limiter does nothing for an OHTTP-fronted POST
    // that bypasses the WebSocket plumbing, and a per-IP limit collapses
    // the whole user base into Cloudflare's egress range. Per-DID is the
    // right granularity for this surface.
    let rate = state.config().sealed_rate_limit_per_did;
    if !state.check_sealed_did_rate_limit(&header.sender_did, rate) {
        tracing::warn!("sealed-inference auth: per-DID rate limit exceeded");
        return Err(axum::http::StatusCode::TOO_MANY_REQUESTS);
    }

    Ok(header)
}


/// Header fields the middleware needs from the wire envelope.
///
/// We mirror just enough of `said-envelope`'s wire format to extract
/// `sender_did` and the AES-GCM `nonce` (used for replay protection)
/// without re-implementing AEAD or the X25519 handshake.
#[derive(Debug)]
pub(crate) struct EnvelopeHeader {
    pub(crate) sender_did: String,
    /// Hex-encoded 12-byte AES-GCM nonce — used as the replay key.
    pub(crate) nonce_hex: String,
}

const SE_MAGIC: &[u8; 4] = b"SEv1";
const SE_VERSION: u8 = 0x01;
const SE_NONCE_LEN: usize = 12;
const SE_EPHEM_PUB_LEN: usize = 32;
const SE_SIGNATURE_LEN: usize = 64;

fn parse_envelope_header(wire: &[u8]) -> Result<EnvelopeHeader, String> {
    let mut pos = 0usize;
    if wire.len() < SE_SIGNATURE_LEN + 4 + 2 {
        return Err("envelope truncated".into());
    }
    if &wire[..4] != SE_MAGIC {
        return Err("bad magic".into());
    }
    pos += 4;
    if wire[pos] != SE_VERSION {
        return Err(format!("bad version: {:#x}", wire[pos]));
    }
    pos += 1;
    // recipient_kind
    pos += 1;

    // sender_did_len (u16 BE) + sender_did
    if wire.len() < pos + 2 {
        return Err("truncated at sender_did_len".into());
    }
    let did_len = u16::from_be_bytes([wire[pos], wire[pos + 1]]) as usize;
    pos += 2;
    if wire.len() < pos + did_len {
        return Err("truncated at sender_did".into());
    }
    let sender_did = std::str::from_utf8(&wire[pos..pos + did_len])
        .map_err(|_| "sender_did not utf8")?
        .to_string();
    pos += did_len;

    // recipient_id_len (u16 BE) + recipient_id
    if wire.len() < pos + 2 {
        return Err("truncated at recipient_id_len".into());
    }
    let rid_len = u16::from_be_bytes([wire[pos], wire[pos + 1]]) as usize;
    pos += 2 + rid_len;

    // ephem_pub
    pos += SE_EPHEM_PUB_LEN;

    // nonce
    if wire.len() < pos + SE_NONCE_LEN {
        return Err("truncated at nonce".into());
    }
    let nonce_hex = hex::encode(&wire[pos..pos + SE_NONCE_LEN]);

    Ok(EnvelopeHeader {
        sender_did,
        nonce_hex,
    })
}

/// Re-derive the body / sig split and verify the trailing Ed25519
/// signature against the `did:key:z…` sender. Returns true on success.
fn verify_envelope_signature(wire: &[u8], sender_did: &str) -> bool {
    if wire.len() < SE_SIGNATURE_LEN {
        return false;
    }
    let body_end = wire.len() - SE_SIGNATURE_LEN;
    let body = &wire[..body_end];
    let sig_bytes = &wire[body_end..];

    let vk = match said_envelope::verifying_from_did_key(sender_did) {
        Ok(vk) => vk,
        Err(_) => return false,
    };
    let sig = match Signature::from_slice(sig_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(body);
    vk.verify(&digest, &sig).is_ok()
}

// Suppress the unused-import warning for items used only by the
// middleware function signature in this module-attached helper layer.
#[allow(unused_imports)]
use axum as _axum_for_doc;

