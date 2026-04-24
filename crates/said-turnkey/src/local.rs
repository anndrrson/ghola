//! `LocalVault` — the default [`Vault`] implementation.
//!
//! Holds a single 32-byte KEK in process memory (loaded from `GHOLA_VAULT_KEY`)
//! and uses it directly to AES-256-GCM-encrypt every merchant credential. No
//! wrapped-DEK layer — that's only worth the complexity when the KEK lives in
//! a separate trust boundary like Turnkey's HSM.
//!
//! Sub-orgs are minted as fresh ed25519 keypairs, with the public key encoded
//! as a base58 Solana address. The private key is **discarded immediately** —
//! Ghola never needs to sign outbound Solana transactions on the merchant's
//! behalf. The address is purely a destination for incoming USDC settlements.
//! This is important: it means a Ghola breach cannot drain merchant funds.
//!
//! When the user plugs in a real Turnkey account, [`crate::TurnkeyVault`]
//! will instead create a sub-org that actually holds a signer, enabling
//! merchant-initiated payouts and HMAC-signed upstream auth.

use async_trait::async_trait;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;

use crate::{envelope, AuthMode, StoredCredential, SuborgHandle, Vault, VaultError};

#[derive(Clone)]
pub struct LocalVault {
    kek: [u8; 32],
    key_version: i32,
}

impl LocalVault {
    /// Build a [`LocalVault`] from a 32-byte KEK.
    pub fn new(kek: [u8; 32]) -> Self {
        Self {
            kek,
            key_version: 1,
        }
    }

    /// Load from `GHOLA_VAULT_KEY` env var (hex-encoded 32 bytes). If the
    /// variable is absent, generates an ephemeral key and logs a loud warning.
    /// Ephemeral keys are fine for `cargo run` but UNREADABLE after a restart,
    /// so all merchant credentials encrypted under them are lost.
    pub fn from_env() -> Result<Self, VaultError> {
        match std::env::var("GHOLA_VAULT_KEY") {
            Ok(hex_str) => {
                let kek = envelope::parse_hex_key(&hex_str)?;
                tracing::info!("LocalVault loaded GHOLA_VAULT_KEY from env");
                Ok(Self::new(kek))
            }
            Err(_) => {
                let mut kek = [0u8; 32];
                use rand::RngCore;
                rand::thread_rng().fill_bytes(&mut kek);
                tracing::warn!(
                    "GHOLA_VAULT_KEY not set — LocalVault generated an EPHEMERAL key. \
                     All merchant credentials encrypted under this key will be \
                     unreadable after a restart. Set GHOLA_VAULT_KEY=<hex-32-bytes> \
                     for stable operation."
                );
                Ok(Self::new(kek))
            }
        }
    }
}

#[async_trait]
impl Vault for LocalVault {
    fn backend_name(&self) -> &'static str {
        "local"
    }

    async fn mint_suborg(&self, merchant_slug: &str) -> Result<SuborgHandle, VaultError> {
        // Fresh ed25519 keypair. We keep only the public half — Ghola never
        // signs as this merchant, because v1 settlement is a transfer *to*
        // this address, not *from* it. If the merchant ever wants to move
        // funds they do so from their own Turnkey export or custom signer.
        let sk = SigningKey::generate(&mut OsRng);
        let pk: VerifyingKey = (&sk).into();
        // Drop the private key as early as possible.
        drop(sk);

        let solana_address = bs58::encode(pk.to_bytes()).into_string();

        // suborg_id is just a stable handle the gateway can use to look up
        // this vault's state later. For LocalVault it's "local:<base58-pk>".
        // TurnkeyVault would return "turnkey:<suborg_uuid>".
        let suborg_id = format!("local:{}", solana_address);

        tracing::info!(
            merchant = merchant_slug,
            address = %solana_address,
            "LocalVault minted suborg"
        );

        Ok(SuborgHandle {
            suborg_id,
            solana_address,
            backend: "local",
        })
    }

    async fn encrypt(
        &self,
        mode: AuthMode,
        plaintext: &str,
    ) -> Result<StoredCredential, VaultError> {
        let ct = envelope::seal(&self.kek, plaintext.as_bytes())?;
        Ok(StoredCredential {
            backend: "local",
            key_version: self.key_version,
            key_ref: None, // LocalVault uses the single process-wide KEK
            ciphertext: ct,
            auth_mode: mode,
        })
    }

    async fn decrypt(&self, stored: &StoredCredential) -> Result<String, VaultError> {
        if stored.backend != "local" {
            return Err(VaultError::Backend(format!(
                "LocalVault cannot decrypt blob from backend '{}'",
                stored.backend
            )));
        }
        if stored.key_version != self.key_version {
            return Err(VaultError::InvalidKey(format!(
                "key_version mismatch: stored={} current={}",
                stored.key_version, self.key_version
            )));
        }
        let pt = envelope::open(&self.kek, &stored.ciphertext)?;
        String::from_utf8(pt).map_err(|e| VaultError::Decrypt(format!("non-utf8 plaintext: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn full_roundtrip() {
        let vault = LocalVault::new([42u8; 32]);
        let stored = vault
            .encrypt(AuthMode::Bearer, "sk-super-secret")
            .await
            .unwrap();
        assert_eq!(stored.backend, "local");
        assert_eq!(stored.auth_mode, AuthMode::Bearer);
        let pt = vault.decrypt(&stored).await.unwrap();
        assert_eq!(pt, "sk-super-secret");
    }

    #[tokio::test]
    async fn mint_suborg_produces_valid_address() {
        let vault = LocalVault::new([0u8; 32]);
        let handle = vault.mint_suborg("alpha").await.unwrap();
        assert!(handle.suborg_id.starts_with("local:"));
        // Base58-decoded address should be exactly 32 bytes (ed25519 public key).
        let decoded = bs58::decode(&handle.solana_address).into_vec().unwrap();
        assert_eq!(decoded.len(), 32);
        assert_eq!(handle.backend, "local");
    }

    #[tokio::test]
    async fn two_suborgs_get_different_addresses() {
        let vault = LocalVault::new([0u8; 32]);
        let a = vault.mint_suborg("a").await.unwrap();
        let b = vault.mint_suborg("b").await.unwrap();
        assert_ne!(a.solana_address, b.solana_address);
    }

    #[tokio::test]
    async fn decrypt_rejects_wrong_backend() {
        let vault = LocalVault::new([0u8; 32]);
        let bogus = StoredCredential {
            backend: "turnkey",
            key_version: 1,
            key_ref: None,
            ciphertext: vec![0u8; 40],
            auth_mode: AuthMode::Bearer,
        };
        assert!(vault.decrypt(&bogus).await.is_err());
    }
}
