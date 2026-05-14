//! # DID set snapshot — `GET /v1/did-set`
//!
//! Phase 3 of the v3.5 privacy rollout: the relay needs to verify "this
//! sealed-inference request is from *some* registered Ghola DID" without
//! ever learning which user account it maps to. To do that, the relay
//! polls this endpoint for an opaque membership artifact and caches it
//! in-memory.
//!
//! ## Encoding choice — sorted JSON list of `did:key:z…` strings
//!
//! For v3.5 (sub-10k users in production) we ship the simplest viable
//! encoding: a JSON object containing
//!   - `version`: schema tag (`"v1"`)
//!   - `count`: number of DIDs in the set
//!   - `dids`: a **sorted** array of `did:key:z…` strings
//!   - `snapshot_at_unix`: timestamp of materialisation
//!   - `digest_hex`: sha256 of the sorted concatenation, so the relay can
//!     log a fingerprint without dumping the set itself
//!
//! Why sorted: the list is the artifact; if anyone seizes a copy it leaks
//! the *cardinality* and the *set of DIDs*, but does not by itself link
//! a DID back to a user account (the email/google_id/etc. live elsewhere).
//! Anyone who already has a candidate `did:key:z…` can binary-search the
//! list; anyone who doesn't has nothing useful. That is acceptable for
//! v3.5. v4 will move to a Bloom filter or sparse Merkle root + ZK
//! membership proofs (Privacy Pass tier).
//!
//! Future-compat: bump `version` and switch encodings without changing
//! the endpoint URL. The relay's set-holder code in
//! `crates/thumper-relay/src/did_set.rs` only needs `contains(did)`, so
//! the on-the-wire structure can evolve.
//!
//! ## Auth
//!
//! A single static API key in the `Authorization: Bearer <key>` header,
//! checked against the `THUMPER_CLOUD_RELAY_API_KEY` env var. Only the
//! relay is supposed to poll this endpoint. If the env var is unset, the
//! endpoint refuses all requests (failing closed).

use axum::{
    extract::State,
    http::HeaderMap,
    Json,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::CloudError;
use crate::state::AppState;

/// JSON shape returned by `GET /v1/did-set`.
#[derive(Debug, Serialize)]
pub struct DidSetSnapshot {
    pub version: &'static str,
    pub count: usize,
    pub dids: Vec<String>,
    pub snapshot_at_unix: i64,
    pub digest_hex: String,
}

/// Map a base58 Solana wallet pubkey to a `did:key:z…` (Ed25519 multicodec).
///
/// Mirrors `apps/web/src/app/chat/page.tsx::solanaAddressToDid` and the
/// canonical Rust helper at `said_envelope::did_key_from_verifying`.
fn siws_pubkey_to_did_key(pubkey_b58: &str) -> Option<String> {
    let raw = bs58::decode(pubkey_b58).into_vec().ok()?;
    if raw.len() != 32 {
        return None;
    }
    // Ed25519 multicodec prefix = 0xed 0x01.
    let mut prefixed = Vec::with_capacity(34);
    prefixed.push(0xed);
    prefixed.push(0x01);
    prefixed.extend_from_slice(&raw);
    Some(format!("did:key:z{}", bs58::encode(&prefixed).into_string()))
}

/// GET /v1/did-set — relay-only.
///
/// Returns a sorted list of registered Ghola DIDs derived from the
/// `users.siws_pubkey` column. Auth: `Authorization: Bearer <key>`
/// against `THUMPER_CLOUD_RELAY_API_KEY`.
pub async fn get_did_set(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DidSetSnapshot>, CloudError> {
    // -- API-key auth --------------------------------------------------
    let expected = std::env::var("THUMPER_CLOUD_RELAY_API_KEY").map_err(|_| {
        tracing::error!("THUMPER_CLOUD_RELAY_API_KEY unset; refusing /v1/did-set");
        CloudError::Unauthorized
    })?;
    if expected.is_empty() {
        return Err(CloudError::Unauthorized);
    }

    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").map(str::to_owned))
        .ok_or(CloudError::Unauthorized)?;

    // Constant-time compare to avoid timing leaks.
    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(CloudError::Unauthorized);
    }

    // -- Materialise the set -------------------------------------------
    let rows: Vec<(Option<String>,)> =
        sqlx::query_as("SELECT siws_pubkey FROM users WHERE siws_pubkey IS NOT NULL")
            .fetch_all(&state.db)
            .await?;

    let mut dids: Vec<String> = rows
        .into_iter()
        .filter_map(|(s,)| s.and_then(|pk| siws_pubkey_to_did_key(&pk)))
        .collect();
    dids.sort();
    dids.dedup();

    let mut hasher = Sha256::new();
    for d in &dids {
        hasher.update(d.as_bytes());
        hasher.update(b"\n");
    }
    let digest_hex = hex::encode(hasher.finalize());

    let snapshot = DidSetSnapshot {
        version: "v1",
        count: dids.len(),
        dids,
        snapshot_at_unix: chrono::Utc::now().timestamp(),
        digest_hex,
    };

    tracing::info!(
        count = snapshot.count,
        digest = %snapshot.digest_hex,
        "served /v1/did-set snapshot"
    );

    Ok(Json(snapshot))
}

/// Plain constant-time byte compare. Returns true iff the slices are
/// equal length and equal content. Used for the relay API-key check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
