//! Privacy helpers for enforcement and log sanitization.
//! Prevents PII (UUIDs, wallet addresses) from appearing in INFO-level logs
//! and rejects network-backed work unless the client supplies a fresh,
//! explicit user approval for the expected boundary.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    Billing,
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
            Self::Billing => "billing",
            Self::ProviderConfig => "providerConfig",
        }
    }

    pub fn boundary_label(self) -> &'static str {
        match self {
            Self::LocalServerChat => "Local network",
            Self::CloudChat | Self::Auth | Self::Billing | Self::ProviderConfig => "Ghola Cloud",
            Self::CallExecution
            | Self::EmailDraft
            | Self::EmailSend
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
            "billing" => Some(Self::Billing),
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
}
