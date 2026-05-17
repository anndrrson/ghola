//! Ghola-native E2EE messaging relay.
//!
//! The relay is intentionally server-blind: clients register signed public key
//! bundles, then upload sealed-envelope ciphertext for recipients. This module
//! rejects plaintext-looking fields at the API boundary and never stores or
//! returns message body, subject, preview, prompt, or approval nonce fields.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::log_id;
use crate::state::AppState;

const MAX_DID_LEN: usize = 256;
const MAX_DEVICE_ID_LEN: usize = 128;
const MAX_DEVICE_LABEL_LEN: usize = 80;
const MAX_KEY_LEN: usize = 512;
const MAX_SIGNATURE_LEN: usize = 1024;
const MAX_RELAY_URLS: usize = 6;
const MAX_RELAY_URL_LEN: usize = 512;
const MAX_ENVELOPE_BYTES: usize = 128 * 1024;
const MAX_APPROVAL_RECEIPT_HASH_LEN: usize = 128;

const PLAINTEXT_KEYS: &[&str] = &[
    "body",
    "content",
    "decrypted_preview",
    "message",
    "plaintext",
    "preview",
    "prompt",
    "raw_body",
    "subject",
    "text",
];

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DeviceKeyBundleV1 {
    pub user_did: String,
    pub device_id: String,
    pub device_label: String,
    pub signing_pubkey: String,
    pub x25519_prekey_pub: String,
    #[serde(default)]
    pub relay_urls: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterDeviceResponse {
    pub ok: bool,
    pub user_did: String,
    pub device_id: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct PrekeysResponse {
    pub user_did: String,
    pub devices: Vec<DeviceKeyBundleV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeMessageKind {
    Human,
    AgentApproved,
    AgentGenerated,
}

impl NativeMessageKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::AgentApproved => "agent_approved",
            Self::AgentGenerated => "agent_generated",
        }
    }

    fn requires_approval_receipt(&self) -> bool {
        matches!(self, Self::AgentApproved | Self::AgentGenerated)
    }
}

#[derive(Debug, Deserialize)]
pub struct PostEnvelopeRequest {
    pub message_id: Option<Uuid>,
    pub thread_id: Option<Uuid>,
    pub sender_did: String,
    pub sender_device_id: String,
    pub recipient_did: String,
    pub recipient_device_id: Option<String>,
    #[serde(default = "default_message_kind")]
    pub kind: NativeMessageKind,
    pub sealed_envelope_b64: String,
    pub approval_receipt_hash: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn default_message_kind() -> NativeMessageKind {
    NativeMessageKind::Human
}

#[derive(Debug, Serialize)]
pub struct PostEnvelopeResponse {
    pub message_id: Uuid,
    pub queued_at: DateTime<Utc>,
    pub status: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct SyncQuery {
    pub limit: Option<i64>,
    pub include_acked: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct SyncEnvelopeResponse {
    pub message_id: Uuid,
    pub thread_id: Option<Uuid>,
    pub sender_did: Option<String>,
    pub sender_device_id: Option<String>,
    pub recipient_did: String,
    pub recipient_device_id: Option<String>,
    pub kind: String,
    pub sealed_envelope_b64: String,
    pub approval_receipt_hash: Option<String>,
    pub created_at: DateTime<Utc>,
    pub acked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct AckResponse {
    pub ok: bool,
    pub message_id: Uuid,
    pub acked_at: DateTime<Utc>,
}

/// POST /api/messages/devices
pub async fn register_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(value): Json<Value>,
) -> Result<Json<RegisterDeviceResponse>, CloudError> {
    reject_plaintext_value(&value)?;
    let req: DeviceKeyBundleV1 = serde_json::from_value(value)
        .map_err(|e| CloudError::BadRequest(format!("invalid device key bundle: {e}")))?;
    validate_device_bundle(&req)?;

    let key_bundle = serde_json::to_value(&req)
        .map_err(|e| CloudError::Internal(format!("serialize key bundle failed: {e}")))?;

    let row: Option<(String, String, DateTime<Utc>)> = sqlx::query_as(
        r#"
        INSERT INTO native_message_devices
            (did, user_id, device_id, key_bundle, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (did, device_id) DO UPDATE
            SET device_id = EXCLUDED.device_id,
                key_bundle = EXCLUDED.key_bundle,
                updated_at = now()
            WHERE native_message_devices.user_id = EXCLUDED.user_id
        RETURNING did, device_id, updated_at
        "#,
    )
    .bind(&req.user_did)
    .bind(claims.sub)
    .bind(&req.device_id)
    .bind(&key_bundle)
    .fetch_optional(&state.db)
    .await?;

    let Some((user_did, device_id, updated_at)) = row else {
        return Err(CloudError::BadRequest(
            "messaging DID is already registered to another account".to_string(),
        ));
    };

    write_audit_event(
        &state,
        Some(claims.sub),
        "device_registered",
        None,
        json!({ "device_id_hash": hash_text(&device_id) }),
    )
    .await;

    Ok(Json(RegisterDeviceResponse {
        ok: true,
        user_did,
        device_id,
        updated_at,
    }))
}

/// GET /api/messages/prekeys/:did
pub async fn get_prekeys(
    State(state): State<AppState>,
    AuthUser(_claims): AuthUser,
    Path(did): Path<String>,
) -> Result<Json<PrekeysResponse>, CloudError> {
    validate_did(&did)?;

    let rows: Vec<(Value,)> = sqlx::query_as(
        r#"
        SELECT key_bundle
        FROM native_message_devices
        WHERE did = $1
        ORDER BY updated_at DESC
        "#,
    )
    .bind(&did)
    .fetch_all(&state.db)
    .await?;

    if rows.is_empty() {
        return Err(CloudError::NotFound("messaging keys not found".to_string()));
    }

    let mut devices = Vec::with_capacity(rows.len());
    for (value,) in rows {
        let bundle = serde_json::from_value::<DeviceKeyBundleV1>(value)
            .map_err(|e| CloudError::Internal(format!("invalid stored key bundle: {e}")))?;
        devices.push(bundle);
    }

    Ok(Json(PrekeysResponse {
        user_did: did,
        devices,
    }))
}

/// POST /api/messages/envelopes
pub async fn post_envelope(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(value): Json<Value>,
) -> Result<Json<PostEnvelopeResponse>, CloudError> {
    reject_plaintext_value(&value)?;
    let req: PostEnvelopeRequest = serde_json::from_value(value)
        .map_err(|e| CloudError::BadRequest(format!("invalid native message envelope: {e}")))?;
    validate_envelope_request(&req)?;

    let sender_exists: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT did FROM native_message_devices
        WHERE did = $1 AND device_id = $2 AND user_id = $3
        "#,
    )
    .bind(&req.sender_did)
    .bind(&req.sender_device_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;
    if sender_exists.is_none() {
        return Err(CloudError::BadRequest(
            "sender messaging key is not registered for this account".to_string(),
        ));
    }

    let exists: Option<(String,)> =
        sqlx::query_as("SELECT did FROM native_message_devices WHERE did = $1")
            .bind(&req.recipient_did)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(CloudError::NotFound(
            "recipient messaging keys not found".to_string(),
        ));
    }

    let message_id = req.message_id.unwrap_or_else(Uuid::new_v4);
    let row: Option<(Uuid, DateTime<Utc>)> = sqlx::query_as(
        r#"
        INSERT INTO native_message_envelopes
            (id, thread_id, sender_user_id, sender_did, sender_device_id,
             recipient_did, recipient_device_id, kind, sealed_envelope_b64,
             approval_receipt_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
        RETURNING id, created_at
        "#,
    )
    .bind(message_id)
    .bind(req.thread_id)
    .bind(claims.sub)
    .bind(req.sender_did.trim())
    .bind(req.sender_device_id.trim())
    .bind(req.recipient_did.trim())
    .bind(req.recipient_device_id.as_deref().map(str::trim))
    .bind(req.kind.as_str())
    .bind(req.sealed_envelope_b64.trim())
    .bind(req.approval_receipt_hash.as_deref().map(str::trim))
    .fetch_optional(&state.db)
    .await?;

    let Some((id, queued_at)) = row else {
        return Err(CloudError::BadRequest(
            "duplicate native message id".to_string(),
        ));
    };

    write_audit_event(
        &state,
        Some(claims.sub),
        "envelope_queued",
        Some(id),
        json!({
            "recipient_did_hash": hash_text(req.recipient_did.trim()),
            "kind": req.kind.as_str(),
        }),
    )
    .await;

    tracing::info!(
        message = %log_id(&id),
        user = %log_id(&claims.sub),
        kind = req.kind.as_str(),
        "native message envelope queued"
    );

    Ok(Json(PostEnvelopeResponse {
        message_id: id,
        queued_at,
        status: "queued",
    }))
}

/// GET /api/messages/sync
pub async fn sync(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(query): Query<SyncQuery>,
) -> Result<Json<Vec<SyncEnvelopeResponse>>, CloudError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let include_acked = query.include_acked.unwrap_or(false);

    let rows: Vec<(
        Uuid,
        Option<Uuid>,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
    )> = sqlx::query_as(
        r#"
        SELECT e.id, e.thread_id, e.sender_did, e.sender_device_id,
               e.recipient_did, e.recipient_device_id, e.kind,
               e.sealed_envelope_b64, e.approval_receipt_hash,
               e.created_at, e.acked_at
        FROM native_message_envelopes e
        INNER JOIN native_message_devices d
            ON d.did = e.recipient_did
           AND (e.recipient_device_id IS NULL OR d.device_id = e.recipient_device_id)
        WHERE d.user_id = $1
          AND ($2::bool OR e.acked_at IS NULL)
        ORDER BY e.created_at ASC
        LIMIT $3
        "#,
    )
    .bind(claims.sub)
    .bind(include_acked)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let envelopes = rows
        .into_iter()
        .map(
            |(
                message_id,
                thread_id,
                sender_did,
                sender_device_id,
                recipient_did,
                recipient_device_id,
                kind,
                sealed_envelope_b64,
                approval_receipt_hash,
                created_at,
                acked_at,
            )| SyncEnvelopeResponse {
                message_id,
                thread_id,
                sender_did,
                sender_device_id,
                recipient_did,
                recipient_device_id,
                kind,
                sealed_envelope_b64,
                approval_receipt_hash,
                created_at,
                acked_at,
            },
        )
        .collect();

    Ok(Json(envelopes))
}

/// POST /api/messages/:id/ack
pub async fn ack(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(message_id): Path<Uuid>,
) -> Result<Json<AckResponse>, CloudError> {
    let row: Option<(Uuid, DateTime<Utc>)> = sqlx::query_as(
        r#"
        UPDATE native_message_envelopes e
        SET acked_at = COALESCE(e.acked_at, now())
        FROM native_message_devices d
        WHERE e.id = $1
          AND d.did = e.recipient_did
          AND (e.recipient_device_id IS NULL OR d.device_id = e.recipient_device_id)
          AND d.user_id = $2
        RETURNING e.id, e.acked_at
        "#,
    )
    .bind(message_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;

    let Some((id, acked_at)) = row else {
        return Err(CloudError::NotFound("native message not found".to_string()));
    };

    let _ = sqlx::query(
        r#"
        INSERT INTO native_message_delivery_receipts
            (message_id, user_id, acked_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (message_id, user_id) DO UPDATE
            SET acked_at = EXCLUDED.acked_at
        "#,
    )
    .bind(id)
    .bind(claims.sub)
    .bind(acked_at)
    .execute(&state.db)
    .await;

    write_audit_event(
        &state,
        Some(claims.sub),
        "envelope_acked",
        Some(id),
        json!({}),
    )
    .await;

    Ok(Json(AckResponse {
        ok: true,
        message_id: id,
        acked_at,
    }))
}

fn validate_device_bundle(req: &DeviceKeyBundleV1) -> Result<(), CloudError> {
    validate_did(&req.user_did)?;
    validate_limited("device_id", &req.device_id, 1, MAX_DEVICE_ID_LEN)?;
    validate_limited("device_label", &req.device_label, 1, MAX_DEVICE_LABEL_LEN)?;
    validate_limited("signing_pubkey", &req.signing_pubkey, 32, MAX_KEY_LEN)?;
    validate_limited("x25519_prekey_pub", &req.x25519_prekey_pub, 32, MAX_KEY_LEN)?;
    validate_limited("signature", &req.signature, 64, MAX_SIGNATURE_LEN)?;
    if req.relay_urls.len() > MAX_RELAY_URLS {
        return Err(CloudError::BadRequest("too many relay_urls".to_string()));
    }
    for url in &req.relay_urls {
        validate_limited("relay_url", url, 1, MAX_RELAY_URL_LEN)?;
        if !(url.starts_with("https://") || url.starts_with("http://localhost")) {
            return Err(CloudError::BadRequest(
                "relay_urls must use https:// or local development URLs".to_string(),
            ));
        }
    }
    if req.expires_at <= Utc::now() {
        return Err(CloudError::BadRequest(
            "device key bundle is expired".to_string(),
        ));
    }
    Ok(())
}

fn validate_envelope_request(req: &PostEnvelopeRequest) -> Result<(), CloudError> {
    reject_plaintext_keys(&req.extra)?;
    validate_did(&req.sender_did)?;
    validate_did(&req.recipient_did)?;
    validate_limited(
        "sender_device_id",
        &req.sender_device_id,
        1,
        MAX_DEVICE_ID_LEN,
    )?;
    if let Some(device_id) = &req.recipient_device_id {
        validate_limited("recipient_device_id", device_id, 1, MAX_DEVICE_ID_LEN)?;
    }

    let trimmed = req.sealed_envelope_b64.trim();
    if trimmed.is_empty() {
        return Err(CloudError::BadRequest(
            "sealed_envelope_b64 is required".to_string(),
        ));
    }
    let bytes = STANDARD
        .decode(trimmed)
        .map_err(|_| CloudError::BadRequest("sealed_envelope_b64 must be base64".to_string()))?;
    if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(CloudError::BadRequest(format!(
            "sealed_envelope_b64 must decode to 1..={MAX_ENVELOPE_BYTES} bytes"
        )));
    }

    if req.kind.requires_approval_receipt() {
        let hash = req.approval_receipt_hash.as_deref().unwrap_or("").trim();
        validate_limited(
            "approval_receipt_hash",
            hash,
            16,
            MAX_APPROVAL_RECEIPT_HASH_LEN,
        )?;
    }

    if let Some(hash) = &req.approval_receipt_hash {
        validate_limited(
            "approval_receipt_hash",
            hash,
            16,
            MAX_APPROVAL_RECEIPT_HASH_LEN,
        )?;
    }

    Ok(())
}

fn reject_plaintext_keys(extra: &BTreeMap<String, Value>) -> Result<(), CloudError> {
    for key in extra.keys() {
        reject_plaintext_key(key)?;
    }
    Ok(())
}

fn reject_plaintext_value(value: &Value) -> Result<(), CloudError> {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                reject_plaintext_key(key)?;
                reject_plaintext_value(nested)?;
            }
        }
        Value::Array(values) => {
            for nested in values {
                reject_plaintext_value(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn reject_plaintext_key(key: &str) -> Result<(), CloudError> {
    let normalized = key.to_ascii_lowercase();
    if PLAINTEXT_KEYS.contains(&normalized.as_str()) || normalized.contains("plaintext") {
        return Err(CloudError::BadRequest(format!(
            "plaintext field '{key}' is not allowed on native messaging relay"
        )));
    }
    if normalized == "approval_nonce" {
        return Err(CloudError::BadRequest(
            "approval_nonce is not stored by native messaging relay".to_string(),
        ));
    }
    Ok(())
}

fn validate_did(did: &str) -> Result<(), CloudError> {
    let did = did.trim();
    validate_limited("did", did, 8, MAX_DID_LEN)?;
    if !did.starts_with("did:") {
        return Err(CloudError::BadRequest(
            "messaging DID must start with did:".to_string(),
        ));
    }
    Ok(())
}

fn validate_limited(field: &str, raw: &str, min: usize, max: usize) -> Result<(), CloudError> {
    let len = raw.trim().len();
    if len < min || len > max {
        return Err(CloudError::BadRequest(format!(
            "{field} must be {min}..={max} characters"
        )));
    }
    Ok(())
}

fn hash_text(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(raw.as_bytes());
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

async fn write_audit_event(
    state: &AppState,
    user_id: Option<Uuid>,
    event_type: &'static str,
    message_id: Option<Uuid>,
    metadata: Value,
) {
    let result = sqlx::query(
        r#"
        INSERT INTO native_message_relay_audit_events
            (user_id, event_type, message_id, metadata)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(user_id)
    .bind(event_type)
    .bind(message_id)
    .bind(metadata)
    .execute(&state.db)
    .await;

    if let Err(e) = result {
        tracing::warn!("native messaging audit insert failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request() -> PostEnvelopeRequest {
        PostEnvelopeRequest {
            message_id: Some(Uuid::new_v4()),
            thread_id: Some(Uuid::new_v4()),
            sender_did: "did:key:zSenderDevice".to_string(),
            sender_device_id: "device-a".to_string(),
            recipient_did: "did:key:zRecipientDevice".to_string(),
            recipient_device_id: Some("device-b".to_string()),
            kind: NativeMessageKind::Human,
            sealed_envelope_b64: STANDARD.encode([1_u8, 2, 3, 4]),
            approval_receipt_hash: None,
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn envelope_validation_accepts_ciphertext_only_payload() {
        validate_envelope_request(&base_request()).expect("ciphertext payload is valid");
    }

    #[test]
    fn envelope_validation_rejects_plaintext_fields() {
        for key in [
            "body",
            "content",
            "subject",
            "text",
            "plaintext",
            "approval_nonce",
        ] {
            let mut req = base_request();
            req.extra
                .insert(key.to_string(), Value::String("leak".into()));
            assert!(
                validate_envelope_request(&req).is_err(),
                "{key} should be rejected"
            );
        }
    }

    #[test]
    fn raw_payload_guard_rejects_nested_plaintext_fields() {
        let value = serde_json::json!({
            "message_id": Uuid::new_v4(),
            "sender_did": "did:key:zSenderDevice",
            "sender_device_id": "device-a",
            "recipient_did": "did:key:zRecipientDevice",
            "sealed_envelope_b64": STANDARD.encode([1_u8, 2, 3, 4]),
            "metadata": {
                "body": "leak"
            }
        });
        assert!(reject_plaintext_value(&value).is_err());
    }

    #[test]
    fn envelope_validation_requires_agent_approval_receipt_hash() {
        let mut req = base_request();
        req.kind = NativeMessageKind::AgentGenerated;
        assert!(validate_envelope_request(&req).is_err());
        req.approval_receipt_hash = Some("receipt-hash-1234567890".to_string());
        assert!(validate_envelope_request(&req).is_ok());
    }

    #[test]
    fn envelope_validation_rejects_invalid_base64() {
        let mut req = base_request();
        req.sealed_envelope_b64 = "not base64%%%%".to_string();
        assert!(validate_envelope_request(&req).is_err());
    }
}
