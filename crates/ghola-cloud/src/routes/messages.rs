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
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
const MAX_REPORT_REASON_LEN: usize = 160;
const MAX_REPORT_METADATA_BYTES: usize = 4096;
const MESSAGE_RATE_LIMIT_PER_MINUTE: i64 = 60;
const MAX_UNACKED_QUEUE_PER_RECIPIENT: i64 = 500;
const SEV1_MAGIC: &[u8; 4] = b"SEv1";
const SEV1_VERSION: u8 = 0x01;
const SEV1_SIGNATURE_LEN: usize = 64;
const SEV1_EPHEM_PUB_LEN: usize = 32;
const SEV1_NONCE_LEN: usize = 12;
const DID_KEY_PREFIX: &str = "did:key:z";
const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];

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

#[derive(Debug, Deserialize)]
pub struct BlockSenderRequest {
    pub sender_did: String,
}

#[derive(Debug, Serialize)]
pub struct BlockSenderResponse {
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
pub struct ReportAbuseRequest {
    pub message_id: Option<Uuid>,
    pub sender_did: Option<String>,
    pub reason: Option<String>,
    pub ciphertext_metadata: Option<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct ReportAbuseResponse {
    pub ok: bool,
    pub report_id: Uuid,
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
    check_native_message_rate_limit(&state, claims.sub).await?;

    let recipient_owners: Vec<(Uuid,)> =
        sqlx::query_as("SELECT DISTINCT user_id FROM native_message_devices WHERE did = $1")
            .bind(&req.recipient_did)
            .fetch_all(&state.db)
            .await?;
    if recipient_owners.is_empty() {
        return Err(CloudError::NotFound(
            "recipient messaging keys not found".to_string(),
        ));
    }
    if recipient_owners.len() > 1 {
        return Err(CloudError::BadRequest(
            "recipient messaging DID is registered to multiple accounts".to_string(),
        ));
    }
    let recipient_user_id = recipient_owners[0].0;
    enforce_sender_not_blocked(&state, recipient_user_id, req.sender_did.trim()).await?;
    check_native_message_queue_limit(
        &state,
        req.recipient_did.trim(),
        req.recipient_device_id.as_deref().map(str::trim),
    )
    .await?;

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

/// POST /api/messages/block
pub async fn block_sender(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(value): Json<Value>,
) -> Result<Json<BlockSenderResponse>, CloudError> {
    reject_plaintext_value(&value)?;
    let req: BlockSenderRequest = serde_json::from_value(value)
        .map_err(|e| CloudError::BadRequest(format!("invalid block request: {e}")))?;
    validate_did(&req.sender_did)?;
    let sender_did_hash = hash_sensitive_text(req.sender_did.trim());

    sqlx::query(
        r#"
        INSERT INTO native_message_blocks (user_id, sender_did_hash)
        VALUES ($1, $2)
        ON CONFLICT (user_id, sender_did_hash) DO NOTHING
        "#,
    )
    .bind(claims.sub)
    .bind(&sender_did_hash)
    .execute(&state.db)
    .await?;

    write_audit_event(
        &state,
        Some(claims.sub),
        "sender_blocked",
        None,
        json!({ "sender_did_hash": sender_did_hash }),
    )
    .await;

    Ok(Json(BlockSenderResponse { ok: true }))
}

/// POST /api/messages/report
pub async fn report_abuse(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(value): Json<Value>,
) -> Result<Json<ReportAbuseResponse>, CloudError> {
    reject_plaintext_value(&value)?;
    let req: ReportAbuseRequest = serde_json::from_value(value)
        .map_err(|e| CloudError::BadRequest(format!("invalid report request: {e}")))?;
    reject_plaintext_keys(&req.extra)?;

    if let Some(message_id) = req.message_id {
        ensure_message_visible_to_user(&state, claims.sub, message_id).await?;
    }

    let sender_did_hash = req
        .sender_did
        .as_deref()
        .map(str::trim)
        .filter(|did| !did.is_empty())
        .map(|did| {
            validate_did(did)?;
            Ok::<String, CloudError>(hash_sensitive_text(did))
        })
        .transpose()?;
    let reason = normalize_report_reason(req.reason.as_deref())?;
    let metadata = normalize_report_metadata(req.ciphertext_metadata)?;

    let report_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO native_message_abuse_reports
            (user_id, message_id, sender_did_hash, reason, ciphertext_metadata)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(req.message_id)
    .bind(sender_did_hash.as_deref())
    .bind(reason.as_deref())
    .bind(&metadata)
    .fetch_one(&state.db)
    .await?;

    write_audit_event(
        &state,
        Some(claims.sub),
        "abuse_reported",
        req.message_id,
        json!({ "sender_did_hash": sender_did_hash }),
    )
    .await;

    Ok(Json(ReportAbuseResponse {
        ok: true,
        report_id,
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
    if req.expires_at <= req.created_at {
        return Err(CloudError::BadRequest(
            "device key bundle expires_at must be after created_at".to_string(),
        ));
    }
    if req.created_at > Utc::now() + chrono::Duration::minutes(5) {
        return Err(CloudError::BadRequest(
            "device key bundle created_at is too far in the future".to_string(),
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
    let envelope = parse_verified_sev1(&bytes)?;
    if envelope.recipient_kind == 0x02 {
        return Err(CloudError::BadRequest(
            "model-bridge envelopes are not native E2EE messages".to_string(),
        ));
    }
    if envelope.sender_did != req.sender_did.trim() {
        return Err(CloudError::BadRequest(
            "envelope sender_did does not match request sender_did".to_string(),
        ));
    }
    if envelope.recipient_id != req.recipient_did.trim() {
        return Err(CloudError::BadRequest(
            "envelope recipient_id does not match request recipient_did".to_string(),
        ));
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
    let compact: String = normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    if PLAINTEXT_KEYS.contains(&normalized.as_str())
        || compact.contains("plaintext")
        || compact.contains("cleartext")
        || compact == "rawmessage"
        || compact == "messagetext"
        || compact == "messagebody"
        || compact == "bodytext"
        || compact == "contenttext"
    {
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

struct Sev1PublicMetadata {
    recipient_kind: u8,
    sender_did: String,
    recipient_id: String,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], CloudError> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or_else(|| CloudError::BadRequest("SEv1 envelope is truncated".to_string()))?;
        if end > self.bytes.len() {
            return Err(CloudError::BadRequest(
                "SEv1 envelope is truncated".to_string(),
            ));
        }
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn take_u16(&mut self) -> Result<usize, CloudError> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]) as usize)
    }

    fn take_u32(&mut self) -> Result<usize, CloudError> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
    }
}

fn parse_verified_sev1(bytes: &[u8]) -> Result<Sev1PublicMetadata, CloudError> {
    if bytes.len() < SEV1_SIGNATURE_LEN + SEV1_MAGIC.len() + 2 {
        return Err(CloudError::BadRequest(
            "sealed_envelope_b64 is too short for SEv1".to_string(),
        ));
    }

    let body_end = bytes.len() - SEV1_SIGNATURE_LEN;
    let body = &bytes[..body_end];
    let sig_bytes = &bytes[body_end..];
    let mut cur = Cursor::new(body);

    if cur.take(SEV1_MAGIC.len())? != SEV1_MAGIC {
        return Err(CloudError::BadRequest(
            "sealed_envelope_b64 must contain an SEv1 envelope".to_string(),
        ));
    }
    let version = cur.take(1)?[0];
    if version != SEV1_VERSION {
        return Err(CloudError::BadRequest(format!(
            "unsupported SEv1 envelope version: {version}"
        )));
    }
    let recipient_kind = cur.take(1)?[0];
    if !matches!(recipient_kind, 0x00 | 0x01 | 0x02) {
        return Err(CloudError::BadRequest(
            "invalid SEv1 recipient kind".to_string(),
        ));
    }

    let sender_did_len = cur.take_u16()?;
    let sender_did = std::str::from_utf8(cur.take(sender_did_len)?)
        .map_err(|_| CloudError::BadRequest("SEv1 sender_did is not UTF-8".to_string()))?
        .to_string();

    let recipient_id_len = cur.take_u16()?;
    let recipient_id = std::str::from_utf8(cur.take(recipient_id_len)?)
        .map_err(|_| CloudError::BadRequest("SEv1 recipient_id is not UTF-8".to_string()))?
        .to_string();

    cur.take(SEV1_EPHEM_PUB_LEN)?;
    cur.take(SEV1_NONCE_LEN)?;
    let ad_len = cur.take_u16()?;
    cur.take(ad_len)?;
    let ct_len = cur.take_u32()?;
    cur.take(ct_len)?;
    if cur.pos != body.len() {
        return Err(CloudError::BadRequest(
            "SEv1 envelope has trailing unsigned bytes".to_string(),
        ));
    }

    let sender_vk = verifying_from_did_key(&sender_did)?;
    let signature = Signature::from_slice(sig_bytes)
        .map_err(|_| CloudError::BadRequest("SEv1 envelope signature is malformed".to_string()))?;
    sender_vk
        .verify(&Sha256::digest(body), &signature)
        .map_err(|_| CloudError::BadRequest("SEv1 envelope signature failed".to_string()))?;

    Ok(Sev1PublicMetadata {
        recipient_kind,
        sender_did,
        recipient_id,
    })
}

fn verifying_from_did_key(did: &str) -> Result<VerifyingKey, CloudError> {
    let encoded = did.strip_prefix(DID_KEY_PREFIX).ok_or_else(|| {
        CloudError::BadRequest("SEv1 sender_did must be an Ed25519 did:key".to_string())
    })?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| CloudError::BadRequest("SEv1 sender_did is not base58".to_string()))?;
    if bytes.len() != 34 || bytes[..2] != ED25519_MULTICODEC {
        return Err(CloudError::BadRequest(
            "SEv1 sender_did must encode an Ed25519 key".to_string(),
        ));
    }
    let key_bytes: [u8; 32] = bytes[2..].try_into().expect("length checked");
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| CloudError::BadRequest("SEv1 sender_did key is invalid".to_string()))
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

async fn check_native_message_rate_limit(
    state: &AppState,
    user_id: Uuid,
) -> Result<(), CloudError> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM native_message_envelopes
        WHERE sender_user_id = $1
          AND created_at > now() - interval '1 minute'
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if count >= MESSAGE_RATE_LIMIT_PER_MINUTE {
        return Err(CloudError::RateLimit);
    }
    Ok(())
}

async fn check_native_message_queue_limit(
    state: &AppState,
    recipient_did: &str,
    recipient_device_id: Option<&str>,
) -> Result<(), CloudError> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM native_message_envelopes
        WHERE recipient_did = $1
          AND ($2::text IS NULL OR recipient_device_id IS NULL OR recipient_device_id = $2)
          AND acked_at IS NULL
        "#,
    )
    .bind(recipient_did)
    .bind(recipient_device_id)
    .fetch_one(&state.db)
    .await?;

    if count >= MAX_UNACKED_QUEUE_PER_RECIPIENT {
        return Err(CloudError::BadRequest(
            "recipient native message queue is full".to_string(),
        ));
    }
    Ok(())
}

async fn enforce_sender_not_blocked(
    state: &AppState,
    recipient_user_id: Uuid,
    sender_did: &str,
) -> Result<(), CloudError> {
    let sender_did_hash = hash_sensitive_text(sender_did);
    let blocked: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM native_message_blocks
            WHERE user_id = $1 AND sender_did_hash = $2
        )
        "#,
    )
    .bind(recipient_user_id)
    .bind(sender_did_hash)
    .fetch_one(&state.db)
    .await?;

    if blocked {
        return Err(CloudError::BadRequest(
            "recipient has blocked this sender".to_string(),
        ));
    }
    Ok(())
}

async fn ensure_message_visible_to_user(
    state: &AppState,
    user_id: Uuid,
    message_id: Uuid,
) -> Result<(), CloudError> {
    let visible: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM native_message_envelopes e
            INNER JOIN native_message_devices d
                ON d.did = e.recipient_did
               AND (e.recipient_device_id IS NULL OR d.device_id = e.recipient_device_id)
            WHERE e.id = $1 AND d.user_id = $2
        )
        "#,
    )
    .bind(message_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if !visible {
        return Err(CloudError::NotFound("native message not found".to_string()));
    }
    Ok(())
}

fn normalize_report_reason(raw: Option<&str>) -> Result<Option<String>, CloudError> {
    let Some(reason) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    validate_limited("reason", reason, 1, MAX_REPORT_REASON_LEN)?;
    Ok(Some(reason.to_string()))
}

fn normalize_report_metadata(raw: Option<Value>) -> Result<Value, CloudError> {
    let metadata = raw.unwrap_or_else(|| json!({}));
    reject_plaintext_value(&metadata)?;
    if !metadata.is_object() {
        return Err(CloudError::BadRequest(
            "ciphertext_metadata must be a JSON object".to_string(),
        ));
    }
    let size = serde_json::to_vec(&metadata)
        .map_err(|e| CloudError::BadRequest(format!("invalid ciphertext metadata: {e}")))?
        .len();
    if size > MAX_REPORT_METADATA_BYTES {
        return Err(CloudError::BadRequest(
            "ciphertext_metadata is too large".to_string(),
        ));
    }
    Ok(metadata)
}

fn hash_text(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(raw.as_bytes());
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_sensitive_text(raw: &str) -> String {
    let hash = Sha256::digest(raw.trim().as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect()
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

    const PEER_SENDER_DID: &str = "did:key:z6MkgxFiZiRE1XJHX7dqZXGgcNWWrPirT2izosrtduZnAw4s";
    const PEER_RECIPIENT_DID: &str = "did:key:z6MkuvajM3HoGhuQYPkyFDLeLADv6mfnLnbgFYnRH79jkKPJ";
    const PEER_WIRE_HEX: &str = "53457631010100386469643a6b65793a7a364d6b677846695a69524531584a48583764715a584767634e5757725069725432697a6f73727464755a6e4177347300386469643a6b65793a7a364d6b7576616a4d33486f4768755159506b7946444c654c414476366d666e4c6e626746596e524837396a6b4b504a74dc56937dd7779ead2761e3fa04a6365e3f0898a16fb2a1ff41b957c084d53f9a019a9fad7c56bd2db2bf1f001973657373696f6e3d6162633b74733d3137303030303030303000000024349520e0660a3fed71a652f30d1fff9c2b8eee5214a95006051a9e7a81622800572cf02c40edeceaecf5bf589dc54e0167f05a0ec09b613140d10a30920a62c452f905c8e665d2d21fd6d8daae1de6b42b29e2059e8186def386dcdb2a90cd3512569602";
    const MODEL_BRIDGE_WIRE_HEX: &str = "53457631010200386469643a6b65793a7a364d6b75335478346279746263437655574e7a65473141653752416351553462335a6466394e53536352706e734d61001b616e7468726f7069632f636c617564652d736f6e6e65742d342d36e07be2e3248463029f76fbbdfeb6392d8a2c78a6843356bc7f22a271ad1c094af8ba5071145e161a73aa98810016726f6c653d757365723b6d6f64656c2d6272696467650000002b15b0444283f0b45963c36d4652dc77f7b87c4f1233a7572bfec5a7e1ed89d41b1a23f984be72b993dd34f5e315106a98373faeb9533c38e121a47ca22cc7c93ad8bf7e0ffbafde98c520b4163ab30848f49b0a5ef1877765ac14552bb56812749b5569a24c99e97418ae08";

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0);
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
            .collect()
    }

    fn peer_wire_b64() -> String {
        STANDARD.encode(hex_to_bytes(PEER_WIRE_HEX))
    }

    fn base_request() -> PostEnvelopeRequest {
        PostEnvelopeRequest {
            message_id: Some(Uuid::new_v4()),
            thread_id: Some(Uuid::new_v4()),
            sender_did: PEER_SENDER_DID.to_string(),
            sender_device_id: "device-a".to_string(),
            recipient_did: PEER_RECIPIENT_DID.to_string(),
            recipient_device_id: Some("device-b".to_string()),
            kind: NativeMessageKind::Human,
            sealed_envelope_b64: peer_wire_b64(),
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
            "body_text",
            "clear_text",
            "content",
            "content_text",
            "message_text",
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
    fn abuse_report_metadata_rejects_plaintext_fields() {
        let metadata = serde_json::json!({
            "sealed_envelope_hash": "abc123",
            "body": "plaintext leak"
        });
        assert!(normalize_report_metadata(Some(metadata)).is_err());
    }

    #[test]
    fn block_hash_uses_full_digest_not_raw_did() {
        let hashed = hash_sensitive_text(PEER_SENDER_DID);
        assert_eq!(hashed.len(), 64);
        assert_ne!(hashed, PEER_SENDER_DID);
    }

    #[test]
    fn envelope_validation_binds_sender_and_recipient_to_sev1_header() {
        let mut req = base_request();
        req.sender_did = PEER_RECIPIENT_DID.to_string();
        assert!(validate_envelope_request(&req).is_err());

        let mut req = base_request();
        req.recipient_did = PEER_SENDER_DID.to_string();
        assert!(validate_envelope_request(&req).is_err());
    }

    #[test]
    fn envelope_validation_rejects_tampered_sev1_signature() {
        let mut wire = hex_to_bytes(PEER_WIRE_HEX);
        let last = wire.len() - 1;
        wire[last] ^= 0x01;

        let mut req = base_request();
        req.sealed_envelope_b64 = STANDARD.encode(wire);
        assert!(validate_envelope_request(&req).is_err());
    }

    #[test]
    fn envelope_validation_rejects_model_bridge_for_native_messages() {
        let mut req = base_request();
        req.sender_did = "did:key:z6Mku3Tx4bytbcCvUWNzeG1Ae7RAcQU4b3Zdf9NSScRpnsMa".to_string();
        req.recipient_did = "anthropic/claude-sonnet-4-6".to_string();
        req.sealed_envelope_b64 = STANDARD.encode(hex_to_bytes(MODEL_BRIDGE_WIRE_HEX));
        assert!(validate_envelope_request(&req).is_err());
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

    fn base_device_bundle() -> DeviceKeyBundleV1 {
        DeviceKeyBundleV1 {
            user_did: PEER_SENDER_DID.to_string(),
            device_id: "device-a".to_string(),
            device_label: "Alice iPhone".to_string(),
            signing_pubkey: "a".repeat(64),
            x25519_prekey_pub: "b".repeat(64),
            relay_urls: vec!["https://relay.example.com".to_string()],
            created_at: Utc::now(),
            expires_at: Utc::now() + chrono::Duration::days(1),
            signature: "c".repeat(128),
        }
    }

    #[test]
    fn device_bundle_validation_rejects_stale_or_inverted_dates() {
        let mut expired = base_device_bundle();
        expired.expires_at = Utc::now() - chrono::Duration::seconds(1);
        assert!(validate_device_bundle(&expired).is_err());

        let mut inverted = base_device_bundle();
        inverted.created_at = Utc::now() + chrono::Duration::days(2);
        inverted.expires_at = Utc::now() + chrono::Duration::days(1);
        assert!(validate_device_bundle(&inverted).is_err());
    }

    #[test]
    fn device_bundle_deserialization_rejects_non_rfc3339_dates() {
        let value = serde_json::json!({
            "user_did": PEER_SENDER_DID,
            "device_id": "device-a",
            "device_label": "Alice iPhone",
            "signing_pubkey": "a".repeat(64),
            "x25519_prekey_pub": "b".repeat(64),
            "relay_urls": [],
            "created_at": "2026/05/17 13:00:00",
            "expires_at": "2026-06-17T13:00:00Z",
            "signature": "c".repeat(128)
        });
        assert!(serde_json::from_value::<DeviceKeyBundleV1>(value).is_err());
    }
}
