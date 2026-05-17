//! Provider session management: grant, revoke, list, and verify sessions.

use std::time::Duration;

use base64::Engine;
use ed25519_dalek::VerifyingKey;
use uuid::Uuid;

use said_types::{Capability, KeyType, Provider, ProviderSession};

use crate::error::{Result, SaidError};
use crate::ucan::{
    capabilities_from_payload, create_ucan, delegate_ucan, verify_ucan_chain,
    xprv_to_signing_key, xprv_to_verifying_key,
};
use crate::ucan::UcanPayload;
use crate::wallet::Wallet;

/// Walk the proof chain to find the root token string.
/// If the payload has no proofs, the token itself is the root.
/// Returns an owned String since intermediate tokens are embedded inside JWT payloads.
fn find_root_token(token: &str, payload: &UcanPayload) -> String {
    if payload.prf.is_empty() {
        return token.to_string();
    }
    // Walk down prf[0] recursively
    let parent = &payload.prf[0];
    let parts: Vec<&str> = parent.splitn(3, '.').collect();
    if parts.len() != 3 {
        return parent.clone();
    }
    let payload_bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]) {
        Ok(b) => b,
        Err(_) => return parent.clone(),
    };
    let parent_payload: UcanPayload = match serde_json::from_slice(&payload_bytes) {
        Ok(p) => p,
        Err(_) => return parent.clone(),
    };
    find_root_token(parent, &parent_payload)
}

impl Wallet {
    /// Grant a provider access by creating a UCAN token and persisting the session.
    pub fn grant_provider(
        &self,
        provider: Provider,
        label: &str,
        capabilities: Vec<Capability>,
        expires_in: Duration,
    ) -> Result<ProviderSession> {
        // Derive the master signing key (issuer)
        let master_xprv = self.derive_provider_key(Provider::Master, KeyType::Signing, 0);
        let master_signing = xprv_to_signing_key(&master_xprv);

        // Derive the provider's public key (audience)
        let provider_xprv = self.derive_provider_key(provider, KeyType::Signing, 0);
        let provider_pub = xprv_to_verifying_key(&provider_xprv);

        // Create the UCAN token
        let token = create_ucan(&master_signing, &provider_pub, &capabilities, expires_in)?;

        let now = chrono::Utc::now();
        let session = ProviderSession {
            id: Uuid::new_v4(),
            provider,
            label: label.to_string(),
            capabilities,
            token,
            issued_at: now,
            expires_at: now + chrono::Duration::from_std(expires_in).unwrap_or(chrono::Duration::days(30)),
            revoked: false,
        };

        // Persist to encrypted storage
        let mut sessions: Vec<ProviderSession> = self
            .storage()
            .load("sessions")
            .unwrap_or_default();
        sessions.push(session.clone());
        self.storage().save("sessions", &sessions)?;

        Ok(session)
    }

    /// Revoke a provider session by ID.
    pub fn revoke_session(&self, session_id: Uuid) -> Result<()> {
        let mut sessions: Vec<ProviderSession> = self
            .storage()
            .load("sessions")
            .unwrap_or_default();

        let session = sessions
            .iter_mut()
            .find(|s| s.id == session_id)
            .ok_or_else(|| SaidError::NotFound(format!("session {}", session_id)))?;

        session.revoked = true;
        self.storage().save("sessions", &sessions)?;
        Ok(())
    }

    /// List all provider sessions.
    pub fn list_sessions(&self) -> Result<Vec<ProviderSession>> {
        self.storage().load("sessions")
    }

    /// Verify an incoming request token and check that it grants the required capability.
    ///
    /// Supports both root tokens (issued directly by the master key) and
    /// delegated tokens (with `prf` chain). For delegated tokens, the full
    /// chain is verified back to the root issuer, and the root token is
    /// matched against a known session.
    ///
    /// Returns the matching session if valid.
    pub fn verify_request(
        &self,
        token: &str,
        required_cap: &Capability,
    ) -> Result<ProviderSession> {
        // Get master public key for verification
        let master_xprv = self.derive_provider_key(Provider::Master, KeyType::Signing, 0);
        let master_pub = xprv_to_verifying_key(&master_xprv);

        // Verify the UCAN chain (handles both root and delegated tokens)
        let payload = verify_ucan_chain(token, &master_pub)?;

        // Look up the session — for delegated tokens, find the root session
        // by walking the proof chain to the root token
        let sessions: Vec<ProviderSession> = self
            .storage()
            .load("sessions")
            .unwrap_or_default();

        let root_token = find_root_token(token, &payload);
        let session = sessions
            .into_iter()
            .find(|s| s.token == token || s.token == root_token.as_str())
            .ok_or_else(|| SaidError::Auth("unknown session token".into()))?;

        // Check revocation
        if session.revoked {
            return Err(SaidError::SessionRevoked);
        }

        // Check capability from the verified (leaf) payload
        let token_caps = capabilities_from_payload(&payload);
        let has_cap = token_caps.iter().any(|c| c.grants(required_cap));
        if !has_cap {
            return Err(SaidError::InsufficientCapability(
                format!("{:?}", required_cap),
            ));
        }

        Ok(session)
    }

    /// Delegate a provider session's token to an agent.
    ///
    /// Finds the parent session by ID, verifies it is active, derives the
    /// provider signing key used for that session, and creates a delegated
    /// UCAN for the agent's public key with the given capabilities.
    pub fn delegate_to_agent(
        &self,
        parent_session_id: Uuid,
        agent_pub: &VerifyingKey,
        capabilities: Vec<Capability>,
        expires_in: Duration,
    ) -> Result<String> {
        let sessions: Vec<ProviderSession> = self
            .storage()
            .load("sessions")
            .unwrap_or_default();

        let parent_session = sessions
            .iter()
            .find(|s| s.id == parent_session_id)
            .ok_or_else(|| SaidError::NotFound(format!("session {}", parent_session_id)))?;

        if parent_session.revoked {
            return Err(SaidError::SessionRevoked);
        }

        let now = chrono::Utc::now();
        if parent_session.expires_at <= now {
            return Err(SaidError::SessionExpired);
        }

        // Derive the provider signing key (the audience of the parent token)
        let provider_xprv = self.derive_provider_key(parent_session.provider, KeyType::Signing, 0);
        let provider_signing = xprv_to_signing_key(&provider_xprv);

        delegate_ucan(
            &parent_session.token,
            &provider_signing,
            agent_pub,
            &capabilities,
            expires_in,
        )
    }

    /// Get the master public key as a `did:key` string.
    pub fn master_did_key(&self) -> String {
        let master_xprv = self.derive_provider_key(Provider::Master, KeyType::Signing, 0);
        let master_pub = xprv_to_verifying_key(&master_xprv);
        crate::ucan::did_key_from_pub(&master_pub)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Wallet;
    use tempfile::TempDir;

    fn test_wallet() -> (Wallet, TempDir) {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _) = Wallet::init(&wallet_dir, None).unwrap();
        (wallet, dir)
    }

    #[test]
    fn grant_creates_session() {
        let (wallet, _dir) = test_wallet();

        let session = wallet
            .grant_provider(
                Provider::Anthropic,
                "Anthropic",
                vec![Capability::ReadPrompts, Capability::ReadMemories],
                Duration::from_secs(3600),
            )
            .unwrap();

        assert_eq!(session.label, "Anthropic");
        assert_eq!(session.provider, Provider::Anthropic);
        assert!(!session.token.is_empty());
        assert!(!session.revoked);

        let sessions = wallet.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session.id);
    }

    #[test]
    fn revoke_marks_inactive() {
        let (wallet, _dir) = test_wallet();

        let session = wallet
            .grant_provider(
                Provider::OpenAI,
                "OpenAI",
                vec![Capability::All],
                Duration::from_secs(3600),
            )
            .unwrap();

        wallet.revoke_session(session.id).unwrap();

        // verify_request should fail with SessionRevoked
        let result = wallet.verify_request(&session.token, &Capability::ReadPrompts);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), SaidError::SessionRevoked));
    }

    #[test]
    fn verify_checks_capability() {
        let (wallet, _dir) = test_wallet();

        // Grant read-only
        let session = wallet
            .grant_provider(
                Provider::Anthropic,
                "Anthropic",
                vec![Capability::ReadPrompts],
                Duration::from_secs(3600),
            )
            .unwrap();

        // ReadPrompts should succeed
        let verified = wallet
            .verify_request(&session.token, &Capability::ReadPrompts)
            .unwrap();
        assert_eq!(verified.id, session.id);

        // WriteMemories should fail
        let result = wallet.verify_request(&session.token, &Capability::WriteMemories);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            SaidError::InsufficientCapability(_)
        ));
    }

    #[test]
    fn expired_session_rejected() {
        let (wallet, _dir) = test_wallet();

        // Grant with 0 seconds — already expired
        let session = wallet
            .grant_provider(
                Provider::Google,
                "Google",
                vec![Capability::ReadPrompts],
                Duration::from_secs(0),
            )
            .unwrap();

        let result = wallet.verify_request(&session.token, &Capability::ReadPrompts);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), SaidError::SessionExpired));
    }

    #[test]
    fn all_capability_grants_everything() {
        let (wallet, _dir) = test_wallet();

        let session = wallet
            .grant_provider(
                Provider::Anthropic,
                "Anthropic (all)",
                vec![Capability::All],
                Duration::from_secs(3600),
            )
            .unwrap();

        // Should succeed for any capability
        wallet
            .verify_request(&session.token, &Capability::ReadPrompts)
            .unwrap();
        wallet
            .verify_request(&session.token, &Capability::WriteMemories)
            .unwrap();
        wallet
            .verify_request(&session.token, &Capability::ReadMcpConfigs)
            .unwrap();
    }

    #[test]
    fn master_did_key_is_stable() {
        let (wallet, _dir) = test_wallet();
        let did1 = wallet.master_did_key();
        let did2 = wallet.master_did_key();
        assert_eq!(did1, did2);
        assert!(did1.starts_with("did:key:z"));
    }
}
