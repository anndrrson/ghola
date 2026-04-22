//! `TurnkeyVault` — Turnkey-backed [`Vault`] implementation.
//!
//! This backend keeps ciphertext in Ghola's DB, while deriving request-time DEKs
//! through Turnkey `sign_raw_payload`. A DB dump alone is not sufficient to
//! decrypt credentials.
//!
//! Key points:
//! - `mint_suborg` creates a sub-organization with a Solana wallet account.
//! - `encrypt` derives a per-credential DEK via Turnkey signing + local KDF,
//!   AES-seals plaintext with that DEK, and stores derivation metadata in
//!   `key_ref`.
//! - `decrypt` re-derives the same DEK from `key_ref` and opens the envelope.
//!
//! Env required:
//! - `TURNKEY_API_PRIVATE_KEY` (or legacy `TURNKEY_API_KEY`)
//! - `TURNKEY_API_PUBLIC_KEY`
//! - `TURNKEY_ORG_ID`
//! - `TURNKEY_SIGN_WITH` (private key id or address used for `sign_raw_payload`)
//!
//! Optional:
//! - `TURNKEY_API_BASE_URL` (default `https://api.turnkey.com`)
//! - `TURNKEY_TIMEOUT_SECS` (default `12`)
//! - `TURNKEY_KEY_VERSION` (default `1`)

use async_trait::async_trait;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use turnkey_client::generated::immutable::{activity::v1 as tk_activity, common::v1 as tk_common};
use turnkey_client::{TurnkeyClient, TurnkeyP256ApiKey};
use zeroize::Zeroize;

use crate::{AuthMode, StoredCredential, SuborgHandle, Vault, VaultError};

const TURNKEY_DEFAULT_BASE_URL: &str = "https://api.turnkey.com";
const TURNKEY_DEFAULT_TIMEOUT_SECS: u64 = 12;
const KDF_KEY_REF_PREFIX: &str = "turnkey-kdf-v1";
const KDF_CONTEXT: &[u8] = b"ghola-vault-turnkey-kdf-v1";
const SOLANA_BIP32_PATH: &str = "m/44'/501'/0'/0'";

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn normalize_label(input: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(max_len);
    let mut prev_dash = false;

    for ch in input.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= max_len {
            break;
        }
    }

    while out.starts_with('-') {
        out.remove(0);
    }
    while out.ends_with('-') {
        out.pop();
    }

    if out.is_empty() {
        "merchant".to_string()
    } else {
        out
    }
}

fn parse_timeout_secs() -> Result<u64, VaultError> {
    match std::env::var("TURNKEY_TIMEOUT_SECS") {
        Ok(raw) => raw
            .parse::<u64>()
            .map_err(|e| VaultError::InvalidKey(format!("invalid TURNKEY_TIMEOUT_SECS: {e}"))),
        Err(_) => Ok(TURNKEY_DEFAULT_TIMEOUT_SECS),
    }
}

fn parse_key_version() -> Result<i32, VaultError> {
    match std::env::var("TURNKEY_KEY_VERSION") {
        Ok(raw) => {
            let v = raw
                .parse::<i32>()
                .map_err(|e| VaultError::InvalidKey(format!("invalid TURNKEY_KEY_VERSION: {e}")))?;
            if v < 1 {
                return Err(VaultError::InvalidKey(
                    "TURNKEY_KEY_VERSION must be >= 1".into(),
                ));
            }
            Ok(v)
        }
        Err(_) => Ok(1),
    }
}

fn build_key_ref(sign_with: &str, salt: &[u8; 16]) -> String {
    format!("{KDF_KEY_REF_PREFIX}:{sign_with}:{}", hex::encode(salt))
}

fn parse_key_ref(raw: &str, default_sign_with: &str) -> Result<(String, [u8; 16]), VaultError> {
    // Backward-compatible fallback for an older key_ref shape where only hex
    // salt was stored.
    if !raw.starts_with(&format!("{KDF_KEY_REF_PREFIX}:")) {
        let decoded = hex::decode(raw).map_err(|e| {
            VaultError::InvalidKey(format!("invalid turnkey key_ref hex salt: {e}"))
        })?;
        if decoded.len() != 16 {
            return Err(VaultError::InvalidKey(format!(
                "invalid turnkey key_ref salt length: expected 16 bytes, got {}",
                decoded.len()
            )));
        }
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&decoded);
        return Ok((default_sign_with.to_string(), salt));
    }

    let rest = &raw[(KDF_KEY_REF_PREFIX.len() + 1)..];
    let split_at = rest.rfind(':').ok_or_else(|| {
        VaultError::InvalidKey("invalid turnkey key_ref format (missing ':' separator)".into())
    })?;

    let sign_with = rest[..split_at].to_string();
    if sign_with.trim().is_empty() {
        return Err(VaultError::InvalidKey(
            "invalid turnkey key_ref format (empty sign_with)".into(),
        ));
    }

    let salt_hex = &rest[(split_at + 1)..];
    let decoded = hex::decode(salt_hex)
        .map_err(|e| VaultError::InvalidKey(format!("invalid turnkey key_ref salt: {e}")))?;
    if decoded.len() != 16 {
        return Err(VaultError::InvalidKey(format!(
            "invalid turnkey key_ref salt length: expected 16 bytes, got {}",
            decoded.len()
        )));
    }

    let mut salt = [0u8; 16];
    salt.copy_from_slice(&decoded);
    Ok((sign_with, salt))
}

fn decode_hexish(raw: &str, field_name: &str) -> Result<Vec<u8>, VaultError> {
    let trimmed = raw.trim();
    let normalized = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    hex::decode(normalized).map_err(|e| {
        VaultError::Backend(format!(
            "invalid Turnkey signature component {field_name}: {e}"
        ))
    })
}

#[derive(Clone)]
pub struct TurnkeyVault {
    org_id: String,
    sign_with: String,
    key_version: i32,
    client: Arc<TurnkeyClient<TurnkeyP256ApiKey>>,
}

impl TurnkeyVault {
    pub fn from_env() -> Result<Self, VaultError> {
        let api_private_key = std::env::var("TURNKEY_API_PRIVATE_KEY")
            .or_else(|_| std::env::var("TURNKEY_API_KEY"))
            .map_err(|_| {
                VaultError::NotConfigured("TURNKEY_API_PRIVATE_KEY (or TURNKEY_API_KEY)".into())
            })?;
        let api_public_key = std::env::var("TURNKEY_API_PUBLIC_KEY")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_API_PUBLIC_KEY".into()))?;
        let org_id = std::env::var("TURNKEY_ORG_ID")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_ORG_ID".into()))?;
        let sign_with = std::env::var("TURNKEY_SIGN_WITH")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_SIGN_WITH".into()))?;
        let timeout_secs = parse_timeout_secs()?;
        let key_version = parse_key_version()?;
        let base_url = std::env::var("TURNKEY_API_BASE_URL")
            .unwrap_or_else(|_| TURNKEY_DEFAULT_BASE_URL.into());

        let api_key =
            TurnkeyP256ApiKey::from_strings(api_private_key.trim(), Some(api_public_key.trim()))
                .map_err(|e| {
                    VaultError::InvalidKey(format!("invalid Turnkey API key pair: {e}"))
                })?;

        let client = TurnkeyClient::builder()
            .api_key(api_key)
            .base_url(base_url)
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| VaultError::Backend(format!("failed to build Turnkey client: {e}")))?;

        Ok(Self {
            org_id,
            sign_with,
            key_version,
            client: Arc::new(client),
        })
    }

    async fn derive_dek(&self, sign_with: &str, salt: &[u8; 16]) -> Result<[u8; 32], VaultError> {
        // The payload includes the salt so each credential gets a distinct key.
        let payload = format!(
            "{}:{}",
            String::from_utf8_lossy(KDF_CONTEXT),
            hex::encode(salt)
        );
        let sign_req = tk_activity::SignRawPayloadIntentV2 {
            sign_with: sign_with.to_string(),
            payload,
            encoding: tk_common::PayloadEncoding::TextUtf8,
            hash_function: tk_common::HashFunction::Sha256,
        };

        let signed = self
            .client
            .sign_raw_payload(self.org_id.clone(), now_ms(), sign_req)
            .await
            .map_err(|e| {
                VaultError::Backend(format!(
                    "turnkey sign_raw_payload failed for sign_with '{sign_with}': {e}"
                ))
            })?;

        let mut r = decode_hexish(&signed.result.r, "r")?;
        let mut s = decode_hexish(&signed.result.s, "s")?;
        let mut v = decode_hexish(&signed.result.v, "v")?;

        let mut hasher = Sha256::new();
        hasher.update(KDF_CONTEXT);
        hasher.update(sign_with.as_bytes());
        hasher.update(salt);
        hasher.update(&r);
        hasher.update(&s);
        hasher.update(&v);
        let digest = hasher.finalize();

        let mut dek = [0u8; 32];
        dek.copy_from_slice(&digest[..32]);

        r.zeroize();
        s.zeroize();
        v.zeroize();
        Ok(dek)
    }
}

#[async_trait]
impl Vault for TurnkeyVault {
    fn backend_name(&self) -> &'static str {
        "turnkey"
    }

    async fn mint_suborg(&self, merchant_slug: &str) -> Result<SuborgHandle, VaultError> {
        let normalized = normalize_label(merchant_slug, 24);
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let short_suffix = &suffix[..8];
        let suborg_name = format!("ghola-{normalized}-{short_suffix}");
        let root_user_name = format!("merchant-{normalized}-{short_suffix}");
        let root_user_email = format!("{normalized}+{short_suffix}@ghola.xyz");

        let req = tk_activity::CreateSubOrganizationIntentV8 {
            sub_organization_name: suborg_name,
            root_users: vec![tk_activity::RootUserParamsV5 {
                user_name: root_user_name,
                user_email: Some(root_user_email),
                user_phone_number: None,
                api_keys: vec![],
                authenticators: vec![],
                oauth_providers: vec![],
            }],
            root_quorum_threshold: 1,
            wallet: Some(tk_activity::WalletParams {
                wallet_name: "Ghola Merchant Wallet".to_string(),
                accounts: vec![tk_activity::WalletAccountParams {
                    curve: tk_common::Curve::Ed25519,
                    path_format: tk_common::PathFormat::Bip32,
                    path: SOLANA_BIP32_PATH.to_string(),
                    address_format: tk_common::AddressFormat::Solana,
                }],
                mnemonic_length: None,
            }),
            disable_email_recovery: None,
            disable_email_auth: None,
            disable_sms_auth: None,
            disable_otp_email_auth: None,
            verification_token: None,
            client_signature: None,
        };

        let response = self
            .client
            .create_sub_organization(self.org_id.clone(), now_ms(), req)
            .await
            .map_err(|e| {
                VaultError::Backend(format!(
                    "turnkey create_sub_organization failed for merchant '{merchant_slug}': {e}"
                ))
            })?;

        let suborg_id = response.result.sub_organization_id;
        let wallet = response
            .result
            .wallet
            .ok_or_else(|| VaultError::Backend("turnkey response missing wallet".into()))?;
        let solana_address =
            wallet.addresses.into_iter().next().ok_or_else(|| {
                VaultError::Backend("turnkey response missing wallet address".into())
            })?;

        Ok(SuborgHandle {
            suborg_id,
            solana_address,
            backend: "turnkey",
        })
    }

    async fn encrypt(
        &self,
        mode: AuthMode,
        plaintext: &str,
    ) -> Result<StoredCredential, VaultError> {
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);

        let mut dek = self.derive_dek(&self.sign_with, &salt).await?;
        let ciphertext = crate::envelope::seal(&dek, plaintext.as_bytes())?;
        dek.zeroize();

        let key_ref = build_key_ref(&self.sign_with, &salt);
        salt.zeroize();

        Ok(StoredCredential {
            backend: "turnkey",
            key_version: self.key_version,
            key_ref: Some(key_ref),
            ciphertext,
            auth_mode: mode,
        })
    }

    async fn decrypt(&self, stored: &StoredCredential) -> Result<String, VaultError> {
        if stored.backend != "turnkey" {
            return Err(VaultError::Backend(format!(
                "TurnkeyVault cannot decrypt blob from backend '{}'",
                stored.backend
            )));
        }

        let key_ref = stored
            .key_ref
            .as_deref()
            .ok_or_else(|| VaultError::InvalidKey("turnkey credential missing key_ref".into()))?;
        let (sign_with, mut salt) = parse_key_ref(key_ref, &self.sign_with)?;

        let mut dek = self.derive_dek(&sign_with, &salt).await?;
        let plaintext_bytes = crate::envelope::open(&dek, &stored.ciphertext)?;
        dek.zeroize();
        salt.zeroize();

        String::from_utf8(plaintext_bytes)
            .map_err(|e| VaultError::Decrypt(format!("non-utf8 plaintext: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_ref_roundtrip() {
        let salt = [7u8; 16];
        let key_ref = build_key_ref("abc:def", &salt);
        let (sign_with, parsed) = parse_key_ref(&key_ref, "ignored").unwrap();
        assert_eq!(sign_with, "abc:def");
        assert_eq!(parsed, salt);
    }

    #[test]
    fn key_ref_legacy_hex_salt_roundtrip() {
        let salt = [1u8; 16];
        let raw = hex::encode(salt);
        let (sign_with, parsed) = parse_key_ref(&raw, "fallback-sign-with").unwrap();
        assert_eq!(sign_with, "fallback-sign-with");
        assert_eq!(parsed, salt);
    }

    #[test]
    fn normalize_label_sanitizes_input() {
        let out = normalize_label(" ACME__Merchant !!! $$$", 24);
        assert_eq!(out, "acme-merchant");
    }
}
