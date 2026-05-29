//! Privacy helpers for enforcement and log sanitization.
//! Prevents PII (UUIDs, wallet addresses) from appearing in INFO-level logs
//! and rejects network-backed work unless the client supplies a fresh,
//! explicit user approval for the expected boundary.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::CloudError;

pub const STRICT_LOCAL: &str = "strictLocal";
const MAX_APPROVAL_AGE: Duration = Duration::minutes(10);
const MAX_APPROVAL_FUTURE_SKEW: Duration = Duration::seconds(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkScope {
    Auth,
    CloudChat,
    LocalServerChat,
    CallExecution,
    EmailDraft,
    EmailSend,
    CalendarExecution,
    WalletProvision,
    WalletTransfer,
    SmsSend,
    NativeMessagingRelay,
    AgentPlan,
    RemoteAgentCompute,
    SwarmExecution,
    Billing,
    CommerceExecution,
    ProviderConfig,
}

impl NetworkScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::CloudChat => "cloudChat",
            Self::LocalServerChat => "localServerChat",
            Self::CallExecution => "callExecution",
            Self::EmailDraft => "emailDraft",
            Self::EmailSend => "emailSend",
            Self::CalendarExecution => "calendarExecution",
            Self::WalletProvision => "walletProvision",
            Self::WalletTransfer => "walletTransfer",
            Self::SmsSend => "smsSend",
            Self::NativeMessagingRelay => "nativeMessagingRelay",
            Self::AgentPlan => "agentPlan",
            Self::RemoteAgentCompute => "remoteAgentCompute",
            Self::SwarmExecution => "swarmExecution",
            Self::Billing => "billing",
            Self::CommerceExecution => "commerceExecution",
            Self::ProviderConfig => "providerConfig",
        }
    }

    pub fn boundary_label(self) -> &'static str {
        match self {
            Self::LocalServerChat => "Local network",
            Self::CloudChat
            | Self::Auth
            | Self::NativeMessagingRelay
            | Self::AgentPlan
            | Self::RemoteAgentCompute
            | Self::SwarmExecution
            | Self::Billing
            | Self::ProviderConfig => "Ghola Cloud",
            Self::CallExecution
            | Self::CommerceExecution
            | Self::EmailDraft
            | Self::EmailSend
            | Self::SmsSend
            | Self::CalendarExecution
            | Self::WalletProvision
            | Self::WalletTransfer => "External provider",
        }
    }

    pub fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "auth" => Some(Self::Auth),
            "cloudChat" => Some(Self::CloudChat),
            "localServerChat" => Some(Self::LocalServerChat),
            "callExecution" => Some(Self::CallExecution),
            "emailDraft" => Some(Self::EmailDraft),
            "emailSend" => Some(Self::EmailSend),
            "calendarExecution" => Some(Self::CalendarExecution),
            "walletProvision" => Some(Self::WalletProvision),
            "walletTransfer" => Some(Self::WalletTransfer),
            "smsSend" => Some(Self::SmsSend),
            "nativeMessagingRelay" => Some(Self::NativeMessagingRelay),
            "agentPlan" => Some(Self::AgentPlan),
            "remoteAgentCompute" => Some(Self::RemoteAgentCompute),
            "swarmExecution" => Some(Self::SwarmExecution),
            "billing" => Some(Self::Billing),
            "commerceExecution" => Some(Self::CommerceExecution),
            "providerConfig" => Some(Self::ProviderConfig),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PrivacyApproval {
    pub privacy_mode: Option<String>,
    pub network_scope: Option<String>,
    pub user_approved_at: Option<DateTime<Utc>>,
    pub approval_nonce: Option<String>,
    pub approval_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPrivacyApproval {
    pub privacy_mode: String,
    pub network_scope: String,
    pub user_approved_at: DateTime<Utc>,
    pub approval_nonce_hash: String,
    pub approval_summary: String,
}

impl PrivacyApproval {
    pub fn require_for(&self, expected: NetworkScope) -> Result<(), CloudError> {
        let scope = expected.as_str();
        let bad = || {
            CloudError::BadRequest(format!(
                "explicit user approval required for {scope} network execution"
            ))
        };

        if self.privacy_mode.as_deref() != Some(STRICT_LOCAL) {
            return Err(bad());
        }
        if self.network_scope.as_deref() != Some(scope) {
            return Err(bad());
        }

        let approved_at = self.user_approved_at.ok_or_else(bad)?;
        let now = Utc::now();
        if approved_at < now - MAX_APPROVAL_AGE || approved_at > now + MAX_APPROVAL_FUTURE_SKEW {
            return Err(bad());
        }

        let nonce = self.approval_nonce.as_deref().unwrap_or_default().trim();
        if nonce.len() < 16 || nonce.len() > 128 {
            return Err(bad());
        }

        let summary = self.approval_summary.as_deref().unwrap_or_default().trim();
        if summary.is_empty() || summary.len() > 600 {
            return Err(bad());
        }

        Ok(())
    }

    pub fn require_and_store_for(
        &self,
        expected: NetworkScope,
    ) -> Result<StoredPrivacyApproval, CloudError> {
        self.require_for(expected)?;
        let nonce = self.approval_nonce.as_deref().unwrap_or_default().trim();
        let summary = self.approval_summary.as_deref().unwrap_or_default().trim();
        Ok(StoredPrivacyApproval {
            privacy_mode: STRICT_LOCAL.to_string(),
            network_scope: expected.as_str().to_string(),
            user_approved_at: self.user_approved_at.expect("validated approval timestamp"),
            approval_nonce_hash: approval_nonce_hash(nonce),
            approval_summary: summary.to_string(),
        })
    }
}

pub fn approval_nonce_hash(raw: &str) -> String {
    let hash = Sha256::digest(raw.trim().as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sensitive_text_hash(raw: &str) -> String {
    let hash = Sha256::digest(raw.trim().as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn value_preview(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "redacted".to_string();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 4 {
        return "****".to_string();
    }
    let suffix: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("...{suffix}")
}

pub fn phone_preview(raw: &str) -> String {
    let digits: String = raw.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        format!("...{}", &digits[digits.len() - 4..])
    } else {
        value_preview(raw)
    }
}

pub fn redact_sensitive_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, nested) in map {
                if is_sensitive_json_key(key) {
                    out.insert(key.clone(), serde_json::json!("[redacted]"));
                } else {
                    out.insert(key.clone(), redact_sensitive_json(nested));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(redact_sensitive_json).collect())
        }
        _ => value.clone(),
    }
}

pub fn safe_task_result(
    task_type: &str,
    status: &str,
    result: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let Some(result) = result else {
        return None;
    };

    let boundary = task_network_scope(task_type, &serde_json::json!({}))
        .map(NetworkScope::boundary_label)
        .unwrap_or("Ghola Cloud");

    let safe = match task_type {
        "email" | "follow_up" => serde_json::json!({
            "email_action_id": result.get("email_action_id").cloned().unwrap_or(serde_json::Value::Null),
            "status": result.get("status").and_then(serde_json::Value::as_str).unwrap_or(status),
            "privacy_boundary": boundary,
            "redacted": true,
        }),
        "call"
        | "customer_service"
        | "cancel_service"
        | "request_refund"
        | "complaint"
        | "cancel_subscription" => serde_json::json!({
            "status": result.get("status").and_then(serde_json::Value::as_str).unwrap_or(status),
            "outcome": result.get("outcome").and_then(serde_json::Value::as_str),
            "success": result.get("success").and_then(serde_json::Value::as_bool),
            "privacy_boundary": boundary,
            "redacted": true,
        }),
        "calendar" => serde_json::json!({
            "action": result.get("action").and_then(serde_json::Value::as_str),
            "status": result.get("status").and_then(serde_json::Value::as_str).unwrap_or(status),
            "privacy_boundary": boundary,
            "redacted": true,
        }),
        "crypto" | "crypto_transfer" | "send_crypto" => {
            let mut safe = redact_sensitive_json(&result);
            if let Some(obj) = safe.as_object_mut() {
                obj.insert("redacted".to_string(), serde_json::json!(true));
            }
            safe
        }
        _ => serde_json::json!({
            "status": status,
            "privacy_boundary": boundary,
            "redacted": true,
        }),
    };

    Some(safe)
}

pub async fn record_privacy_audit_event(
    db: &PgPool,
    user_id: Uuid,
    scope: NetworkScope,
    approval: &StoredPrivacyApproval,
    request_kind: &str,
) {
    let _ = sqlx::query(
        r#"
        INSERT INTO privacy_audit_events
            (user_id, request_kind, privacy_mode, network_scope,
             approval_nonce_hash, approval_summary)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(request_kind)
    .bind(&approval.privacy_mode)
    .bind(scope.as_str())
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .execute(db)
    .await;
}

fn is_sensitive_json_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    let compact: String = normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    matches!(
        compact.as_str(),
        "address"
            | "body"
            | "content"
            | "description"
            | "details"
            | "email"
            | "firstsentence"
            | "intent"
            | "location"
            | "message"
            | "objective"
            | "phone"
            | "phonenumber"
            | "prompt"
            | "providerpayload"
            | "rawpayload"
            | "recipient"
            | "recordingurl"
            | "script"
            | "subject"
            | "summary"
            | "task"
            | "text"
            | "title"
            | "to"
            | "toaddress"
            | "transcript"
            | "walletaddress"
    ) || compact.contains("payload")
        || compact.contains("transcript")
        || compact.contains("recording")
        || compact.contains("address")
}

pub fn stored_approval_nonce_hash(raw_or_hash: &str) -> String {
    let trimmed = raw_or_hash.trim();
    if trimmed.len() == 64 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        trimmed.to_ascii_lowercase()
    } else {
        approval_nonce_hash(trimmed)
    }
}

pub fn task_network_scope(task_type: &str, params: &serde_json::Value) -> Option<NetworkScope> {
    match task_type {
        "call"
        | "customer_service"
        | "cancel_service"
        | "request_refund"
        | "complaint"
        | "cancel_subscription" => Some(NetworkScope::CallExecution),
        "email" | "follow_up" => Some(NetworkScope::EmailDraft),
        "calendar" => Some(NetworkScope::CalendarExecution),
        "crypto_transfer" | "send_crypto" => Some(NetworkScope::WalletTransfer),
        "crypto" => match params
            .get("action")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
        {
            "transfer" => Some(NetworkScope::WalletTransfer),
            _ => None,
        },
        _ => None,
    }
}

/// Return first 8 hex chars of SHA-256(uuid) for privacy-safe logging.
pub fn log_id(id: &Uuid) -> String {
    let hash = Sha256::digest(id.as_bytes());
    hash[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// Truncate a wallet address for logging: first 4 + last 4 chars.
pub fn log_addr(addr: &str) -> String {
    if addr.len() > 10 {
        format!("{}...{}", &addr[..4], &addr[addr.len() - 4..])
    } else {
        "****".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(scope: NetworkScope) -> PrivacyApproval {
        PrivacyApproval {
            privacy_mode: Some(STRICT_LOCAL.to_string()),
            network_scope: Some(scope.as_str().to_string()),
            user_approved_at: Some(Utc::now()),
            approval_nonce: Some("nonce-1234567890".to_string()),
            approval_summary: Some("User approved network execution.".to_string()),
        }
    }

    #[test]
    fn requires_matching_fresh_approval() {
        assert!(approval(NetworkScope::CallExecution)
            .require_for(NetworkScope::CallExecution)
            .is_ok());
        assert!(approval(NetworkScope::EmailDraft)
            .require_for(NetworkScope::EmailSend)
            .is_err());
    }

    #[test]
    fn rejects_stale_or_missing_approval() {
        let mut stale = approval(NetworkScope::CloudChat);
        stale.user_approved_at = Some(Utc::now() - Duration::minutes(11));
        assert!(stale.require_for(NetworkScope::CloudChat).is_err());
        assert!(PrivacyApproval::default()
            .require_for(NetworkScope::WalletTransfer)
            .is_err());
    }

    #[test]
    fn classifies_external_task_scopes() {
        assert_eq!(
            task_network_scope("call", &serde_json::json!({})),
            Some(NetworkScope::CallExecution)
        );
        assert_eq!(
            task_network_scope("crypto", &serde_json::json!({ "action": "transfer" })),
            Some(NetworkScope::WalletTransfer)
        );
        assert_eq!(
            task_network_scope("crypto", &serde_json::json!({ "action": "balance" })),
            None
        );
    }

    #[test]
    fn stores_hashed_approval_nonce() {
        let raw_nonce = "wallet-transfer-nonce-abcdef";
        let mut approval = approval(NetworkScope::WalletTransfer);
        approval.approval_nonce = Some(raw_nonce.to_string());

        let stored = approval
            .require_and_store_for(NetworkScope::WalletTransfer)
            .expect("approval should normalize");

        assert_eq!(stored.privacy_mode, STRICT_LOCAL);
        assert_eq!(stored.network_scope, NetworkScope::WalletTransfer.as_str());
        assert_ne!(stored.approval_nonce_hash, raw_nonce);
        assert_eq!(stored.approval_nonce_hash.len(), 64);
        assert_eq!(stored.approval_nonce_hash, approval_nonce_hash(raw_nonce));
    }

    #[test]
    fn preserves_existing_stored_nonce_hash_when_propagating_legacy_rows() {
        let raw = "nonce-123456789012345";
        let hashed = approval_nonce_hash(raw);
        assert_eq!(stored_approval_nonce_hash(&hashed), hashed);
        assert_eq!(stored_approval_nonce_hash(raw), approval_nonce_hash(raw));
    }

    #[test]
    fn sms_send_is_explicit_external_scope() {
        let stored = approval(NetworkScope::SmsSend)
            .require_and_store_for(NetworkScope::SmsSend)
            .expect("sms approval should validate");
        assert_eq!(stored.network_scope, "smsSend");
        assert_eq!(
            NetworkScope::from_str("smsSend"),
            Some(NetworkScope::SmsSend)
        );
        assert_eq!(NetworkScope::SmsSend.boundary_label(), "External provider");
    }

    #[test]
    fn remote_compute_scopes_are_explicit_cloud_scopes() {
        for (raw, scope) in [
            ("agentPlan", NetworkScope::AgentPlan),
            ("remoteAgentCompute", NetworkScope::RemoteAgentCompute),
            ("swarmExecution", NetworkScope::SwarmExecution),
        ] {
            assert_eq!(NetworkScope::from_str(raw), Some(scope));
            assert_eq!(scope.boundary_label(), "Ghola Cloud");
            assert!(approval(scope).require_for(scope).is_ok());
        }
    }

    #[test]
    fn redacts_task_results_and_nested_sensitive_fields() {
        let email = safe_task_result(
            "email",
            "awaiting_approval",
            Some(serde_json::json!({
                "email_action_id": "11111111-1111-1111-1111-111111111111",
                "to_address": "person@example.com",
                "subject": "Secret",
                "body": "plaintext"
            })),
        )
        .expect("safe result");
        assert_eq!(
            email["email_action_id"],
            "11111111-1111-1111-1111-111111111111"
        );
        assert!(email.get("to_address").is_none());
        assert!(email.get("body").is_none());

        let nested = redact_sensitive_json(&serde_json::json!({
            "safe": true,
            "provider_payload": {"phone_number": "+14015551212"},
            "signature": "tx"
        }));
        assert_eq!(nested["safe"], true);
        assert_eq!(nested["provider_payload"], "[redacted]");
        assert_eq!(nested["signature"], "tx");
    }
}
