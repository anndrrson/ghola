//! Provider session management: grant, revoke, list, and verify sessions.

use std::time::Duration;

use uuid::Uuid;

use said_types::{Capability, KeyType, Provider, ProviderSession};

use crate::error::{Result, SaidError};
use crate::ucan::{
    capabilities_from_payload, create_ucan, verify_ucan, xprv_to_signing_key,
    xprv_to_verifying_key,
};
use crate::wallet::Wallet;

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
    /// Returns the matching session if valid.
    pub fn verify_request(
        &self,
        token: &str,
        required_cap: &Capability,
    ) -> Result<ProviderSession> {
        // Get master public key for verification
        let master_xprv = self.derive_provider_key(Provider::Master, KeyType::Signing, 0);
        let master_pub = xprv_to_verifying_key(&master_xprv);

        // Verify the UCAN (checks signature + expiry)
        let payload = verify_ucan(token, &master_pub)?;

        // Look up the session by token
        let sessions: Vec<ProviderSession> = self
            .storage()
            .load("sessions")
            .unwrap_or_default();

        let session = sessions
            .into_iter()
            .find(|s| s.token == token)
            .ok_or_else(|| SaidError::Auth("unknown session token".into()))?;

        // Check revocation
        if session.revoked {
            return Err(SaidError::SessionRevoked);
        }

        // Check capability
        let token_caps = capabilities_from_payload(&payload);
        let has_cap = token_caps.iter().any(|c| c.grants(required_cap));
        if !has_cap {
            return Err(SaidError::InsufficientCapability(
                format!("{:?}", required_cap),
            ));
        }

        Ok(session)
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
        let (wallet, _) = Wallet::init(&wallet_dir).unwrap();
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
