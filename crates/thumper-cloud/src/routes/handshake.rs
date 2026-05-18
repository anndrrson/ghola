//! Pair-Device handshake mailbox.
//!
//! Lets a user transfer session DEKs (and other vault state) from one
//! browser to another **without the cloud being able to read them**.
//!
//! ## Protocol
//!
//! 1. **New device B** generates an ephemeral X25519 keypair, picks a
//!    random `id` (≥16 bytes, base64url-encoded), and shows
//!    `(id, ephem_pub)` in a QR code.
//! 2. **Existing device A** scans the QR. A unlocks its session vault
//!    (Turnkey signature), enumerates its session DEKs, and packages
//!    them into a sealed envelope addressed to `ephem_pub` (kind =
//!    PeerDid). A POSTs the envelope bytes here.
//! 3. **Device B** polls `GET /api/devices/handshake/:id`. On the first
//!    successful read the row is deleted server-side, so the mailbox
//!    can deliver to exactly one receiver. B opens the envelope with
//!    its ephemeral X25519 secret, verifies the signature against A's
//!    DID (which is in the envelope header), and imports the DEKs into
//!    its own vault.
//!
//! ## Security notes
//!
//! - The cloud sees opaque ciphertext; the envelope is verified by the
//!   recipient (B), not the cloud. Replacing `ephem_pub` between the
//!   QR scan and the POST requires physical compromise of one of the
//!   two devices — that's outside our threat model.
//! - `id` is required to be high-entropy (≥16 bytes after base64url
//!   decode). Guessing it gives no advantage; brute-force is rate-
//!   limited.
//! - Rows expire after [`HANDSHAKE_TTL`] (currently 2 minutes) and are
//!   deleted on the first successful GET. A cron-style sweep is not
//!   needed — every read prunes the row that was just consumed AND any
//!   expired siblings, so storage stays bounded by recent traffic.
//! - This endpoint is intentionally **unauthenticated**: the receiving
//!   device is fresh and has no auth state yet. The cryptographic
//!   wrapping is the only confidentiality control.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::error::CloudError;
use crate::state::AppState;

/// How long a posted envelope sticks around before being purged.
/// Two minutes is enough for the user to walk between devices but short
/// enough that an unread mailbox can't sit there indefinitely.
const HANDSHAKE_TTL: Duration = Duration::from_secs(120);

/// Maximum allowed size of a posted envelope. Sealed envelopes for
/// session DEKs are tiny (~hundreds of bytes); 16 KiB is a generous
/// ceiling that still rejects abuse.
const MAX_ENVELOPE_BYTES: usize = 16 * 1024;

/// Minimum decoded length of the `id` field. Forces clients to use
/// genuine random nonces, not predictable counters or short strings.
const MIN_ID_DECODED_BYTES: usize = 16;

#[derive(Deserialize)]
pub struct PostHandshakeRequest {
    /// High-entropy mailbox id (base64url-no-pad, decoded to ≥16 bytes).
    pub id: String,
    /// Sealed envelope from `crates/said-envelope`, base64url-no-pad.
    pub envelope_b64: String,
}

#[derive(Serialize)]
pub struct PostHandshakeResponse {
    pub ok: bool,
    /// Unix milliseconds at which the row will be deleted if unread.
    pub expires_at_ms: i64,
}

#[derive(Serialize)]
pub struct GetHandshakeResponse {
    pub envelope_b64: String,
}

fn validate_id(id: &str) -> Result<(), CloudError> {
    if id.len() > 256 {
        return Err(CloudError::BadRequest("handshake id too long".into()));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| CloudError::BadRequest("handshake id is not base64url-no-pad".into()))?;
    if decoded.len() < MIN_ID_DECODED_BYTES {
        return Err(CloudError::BadRequest(format!(
            "handshake id must encode at least {MIN_ID_DECODED_BYTES} random bytes"
        )));
    }
    Ok(())
}

/// `POST /api/devices/handshake` — device A drops a sealed envelope for
/// device B. Returns `409` (BadRequest) if the id is already in use.
pub async fn post_handshake(
    State(state): State<AppState>,
    Json(req): Json<PostHandshakeRequest>,
) -> Result<Json<PostHandshakeResponse>, CloudError> {
    validate_id(&req.id)?;

    let envelope_bytes = URL_SAFE_NO_PAD
        .decode(&req.envelope_b64)
        .map_err(|_| CloudError::BadRequest("envelope_b64 is not base64url-no-pad".into()))?;

    if envelope_bytes.is_empty() {
        return Err(CloudError::BadRequest("envelope is empty".into()));
    }
    if envelope_bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(CloudError::BadRequest(format!(
            "envelope too large (max {MAX_ENVELOPE_BYTES} bytes)"
        )));
    }

    // Opportunistic prune: a single DELETE that costs nothing when there
    // is nothing to prune. Keeps the table from growing unboundedly even
    // without a separate sweeper.
    let _ = sqlx::query("DELETE FROM device_handshakes WHERE expires_at <= now()")
        .execute(&state.db)
        .await;

    let expires_at =
        chrono::Utc::now() + chrono::Duration::from_std(HANDSHAKE_TTL).expect("ttl fits");

    // Write-once: ON CONFLICT DO NOTHING + RETURNING means we can detect
    // a duplicate id without a separate SELECT round-trip.
    let inserted: Option<(chrono::DateTime<chrono::Utc>,)> = sqlx::query_as(
        r#"
        INSERT INTO device_handshakes (id, envelope_blob, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
        RETURNING expires_at
        "#,
    )
    .bind(&req.id)
    .bind(&envelope_bytes)
    .bind(expires_at)
    .fetch_optional(&state.db)
    .await?;

    let Some((row_expires_at,)) = inserted else {
        return Err(CloudError::BadRequest(
            "handshake id already used — pick a fresh id".into(),
        ));
    };

    Ok(Json(PostHandshakeResponse {
        ok: true,
        expires_at_ms: row_expires_at.timestamp_millis(),
    }))
}

/// `GET /api/devices/handshake/:id` — device B reads its envelope.
/// First successful read deletes the row, so the mailbox can deliver
/// to exactly one receiver.
pub async fn get_handshake(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<GetHandshakeResponse>), CloudError> {
    validate_id(&id)?;

    // Atomic delete-and-return — race-free, single round-trip. If the
    // row exists and isn't expired we get the envelope; otherwise we
    // return 404 without leaking which case it was.
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        r#"
        DELETE FROM device_handshakes
         WHERE id = $1
           AND expires_at > now()
         RETURNING envelope_blob
        "#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let Some((envelope,)) = row else {
        return Err(CloudError::NotFound(
            "handshake not found or expired".into(),
        ));
    };

    Ok((
        StatusCode::OK,
        Json(GetHandshakeResponse {
            envelope_b64: URL_SAFE_NO_PAD.encode(envelope),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_accepts_random_16_bytes() {
        let id = URL_SAFE_NO_PAD.encode([0xab; 16]);
        validate_id(&id).expect("16 random bytes is valid");
    }

    #[test]
    fn validate_id_rejects_short_id() {
        let id = URL_SAFE_NO_PAD.encode([0xab; 8]);
        assert!(validate_id(&id).is_err());
    }

    #[test]
    fn validate_id_rejects_non_base64url() {
        assert!(validate_id("not!valid!base64").is_err());
    }

    #[test]
    fn validate_id_rejects_excessively_long() {
        let id = "A".repeat(300);
        assert!(validate_id(&id).is_err());
    }
}
