use std::path::PathBuf;

use bip39::Mnemonic;
use ed25519_bip32::{DerivationScheme, XPrv};
use zeroize::Zeroize;

use said_types::{KeyType, Provider, WalletMetadata, SAID_PURPOSE};

use crate::encrypt::{
    decrypt_seed_with_password, derive_key, encrypt_seed_with_password, is_seed_encrypted,
};
use crate::error::{Result, SaidError};
use crate::storage::Storage;

const HARDENED: u32 = 0x80000000;

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// SAID wallet: manages HD keys, encrypted storage, and wallet lifecycle.
pub struct Wallet {
    seed: [u8; 64],
    data_key: [u8; 32],
    master_xprv: XPrv,
    wallet_dir: PathBuf,
    storage: Storage,
    /// Whether the seed file is encrypted with a password.
    seed_encrypted: bool,
}

impl Wallet {
    /// Initialize a new wallet, generating a fresh mnemonic.
    /// If `password` is provided, the seed file is encrypted with Argon2id + AES-256-GCM.
    /// Returns the wallet and the mnemonic phrase (for backup).
    pub fn init(wallet_dir: &PathBuf, password: Option<&str>) -> Result<(Self, String)> {
        if wallet_dir.join("wallet.json").exists() {
            return Err(SaidError::WalletExists(wallet_dir.display().to_string()));
        }

        let mnemonic = Mnemonic::generate(24)
            .map_err(|e| SaidError::KeyDerivation(format!("{}", e)))?;
        let phrase = mnemonic.to_string();
        let seed = mnemonic.to_seed("");

        let encrypted = password.is_some();
        let mut wallet = Self::from_seed(seed, wallet_dir.clone())?;
        wallet.seed_encrypted = encrypted;
        wallet.persist_wallet_files(password)?;

        Ok((wallet, phrase))
    }

    /// Load an existing wallet from disk.
    /// If the seed is encrypted and no password is provided, returns `PasswordRequired`.
    pub fn load(wallet_dir: &PathBuf, password: Option<&str>) -> Result<Self> {
        if !wallet_dir.join("seed").exists() {
            return Err(SaidError::WalletNotFound(wallet_dir.display().to_string()));
        }

        let seed_bytes = std::fs::read(wallet_dir.join("seed"))?;

        if is_seed_encrypted(&seed_bytes) {
            let pw = password.ok_or(SaidError::PasswordRequired)?;
            let mut decrypted = decrypt_seed_with_password(&seed_bytes, pw)?;
            let seed: [u8; 64] = decrypted
                .as_slice()
                .try_into()
                .map_err(|_| SaidError::Storage("invalid decrypted seed (expected 64 bytes)".into()))?;
            decrypted.zeroize();
            let mut wallet = Self::from_seed(seed, wallet_dir.clone())?;
            wallet.seed_encrypted = true;
            Ok(wallet)
        } else {
            let seed: [u8; 64] = seed_bytes
                .try_into()
                .map_err(|_| SaidError::Storage("invalid seed file (expected 64 bytes)".into()))?;
            Self::from_seed(seed, wallet_dir.clone())
        }
    }

    /// Recover a wallet from a mnemonic phrase.
    /// If `password` is provided, the seed file is encrypted.
    pub fn recover(phrase: &str, wallet_dir: &PathBuf, password: Option<&str>) -> Result<Self> {
        if wallet_dir.join("wallet.json").exists() {
            return Err(SaidError::WalletExists(wallet_dir.display().to_string()));
        }

        let mnemonic: Mnemonic = phrase
            .parse()
            .map_err(|e: bip39::Error| SaidError::InvalidMnemonic(e.to_string()))?;
        let seed = mnemonic.to_seed("");

        let encrypted = password.is_some();
        let mut wallet = Self::from_seed(seed, wallet_dir.clone())?;
        wallet.seed_encrypted = encrypted;
        wallet.persist_wallet_files(password)?;

        Ok(wallet)
    }

    fn from_seed(seed: [u8; 64], wallet_dir: PathBuf) -> Result<Self> {
        let data_key = derive_key(&seed, b"said-local-data-key");

        let mut hd_secret = derive_key(&seed, b"said-hd-secret");
        let hd_chain = derive_key(&seed, b"said-hd-chain");
        let master_xprv = XPrv::from_nonextended_force(&hd_secret, &hd_chain);
        hd_secret.zeroize();

        let storage = Storage::new(wallet_dir.join("data"), data_key);

        Ok(Self {
            seed,
            data_key,
            master_xprv,
            wallet_dir,
            storage,
            seed_encrypted: false,
        })
    }

    fn persist_wallet_files(&self, password: Option<&str>) -> Result<()> {
        std::fs::create_dir_all(&self.wallet_dir)?;

        // Save seed (optionally encrypted, chmod 600)
        let seed_path = self.wallet_dir.join("seed");
        let seed_data = if let Some(pw) = password {
            encrypt_seed_with_password(&self.seed, pw)?
        } else {
            self.seed.to_vec()
        };
        std::fs::write(&seed_path, &seed_data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&seed_path, std::fs::Permissions::from_mode(0o600))?;
        }

        // Save metadata
        let xpub = self.master_xprv.public();
        let pub_key_bytes: &[u8] = xpub.as_ref();
        let metadata = WalletMetadata {
            version: 1,
            created_at: chrono::Utc::now(),
            master_public_key: to_hex(&pub_key_bytes[..32]),
            seed_encrypted: self.seed_encrypted,
        };
        let metadata_json = serde_json::to_string_pretty(&metadata)?;
        std::fs::write(self.wallet_dir.join("wallet.json"), metadata_json)?;

        Ok(())
    }

    /// Derive a provider-specific key.
    /// Path: m / SAI' / provider' / key_type' / instance
    pub fn derive_provider_key(
        &self,
        provider: Provider,
        key_type: KeyType,
        instance: u32,
    ) -> XPrv {
        self.master_xprv
            .derive(DerivationScheme::V2, (HARDENED | SAID_PURPOSE).into())
            .derive(DerivationScheme::V2, (HARDENED | provider as u32).into())
            .derive(DerivationScheme::V2, (HARDENED | key_type as u32).into())
            .derive(DerivationScheme::V2, instance.into())
    }

    /// Get a reference to the encrypted storage.
    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    /// Derive Solana keypair bytes [secret(32) | pubkey(32)] from SAID seed.
    /// Path: m / 0x534149' / 5' / 0' / 0
    pub fn solana_keypair_bytes(&self) -> [u8; 64] {
        let xprv = self.derive_provider_key(Provider::Solana, KeyType::Signing, 0);
        let signing_key = crate::ucan::xprv_to_signing_key(&xprv);
        let verifying_key = signing_key.verifying_key();
        let mut result = [0u8; 64];
        result[..32].copy_from_slice(signing_key.as_bytes());
        result[32..].copy_from_slice(verifying_key.as_bytes());
        result
    }

    /// Get the derived Solana public key (32 bytes).
    pub fn solana_pubkey_bytes(&self) -> [u8; 32] {
        let xprv = self.derive_provider_key(Provider::Solana, KeyType::Signing, 0);
        let signing_key = crate::ucan::xprv_to_signing_key(&xprv);
        *signing_key.verifying_key().as_bytes()
    }

    /// Get the wallet directory path.
    pub fn wallet_dir(&self) -> &PathBuf {
        &self.wallet_dir
    }

    /// Load wallet metadata from disk.
    pub fn load_metadata(wallet_dir: &PathBuf) -> Result<WalletMetadata> {
        let path = wallet_dir.join("wallet.json");
        if !path.exists() {
            return Err(SaidError::WalletNotFound(wallet_dir.display().to_string()));
        }
        let json = std::fs::read_to_string(path)?;
        let metadata: WalletMetadata = serde_json::from_str(&json)?;
        Ok(metadata)
    }

    /// Get the default wallet directory (~/.said/).
    pub fn default_wallet_dir() -> Result<PathBuf> {
        dirs::home_dir()
            .map(|h| h.join(".said"))
            .ok_or_else(|| SaidError::Storage("could not determine home directory".into()))
    }
}

impl Drop for Wallet {
    fn drop(&mut self) {
        self.seed.zeroize();
        self.data_key.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn init_creates_wallet() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, phrase) = Wallet::init(&wallet_dir, None).unwrap();

        assert!(wallet_dir.join("seed").exists());
        assert!(wallet_dir.join("wallet.json").exists());
        assert_eq!(phrase.split_whitespace().count(), 24);

        // Verify seed file permissions on unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::metadata(wallet_dir.join("seed")).unwrap().permissions();
            assert_eq!(perms.mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (_wallet, _phrase) = Wallet::init(&wallet_dir, None).unwrap();
        let loaded = Wallet::load(&wallet_dir, None);
        assert!(loaded.is_ok());
    }

    #[test]
    fn recover_from_phrase() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (_wallet, phrase) = Wallet::init(&wallet_dir, None).unwrap();

        // Recover to a different directory
        let dir2 = TempDir::new().unwrap();
        let wallet_dir2 = dir2.path().join(".said");
        let recovered = Wallet::recover(&phrase, &wallet_dir2, None).unwrap();

        assert!(wallet_dir2.join("seed").exists());
        assert!(wallet_dir2.join("wallet.json").exists());

        // Same seed should produce same master public key
        let meta1 = Wallet::load_metadata(&wallet_dir).unwrap();
        let meta2 = Wallet::load_metadata(&wallet_dir2).unwrap();
        assert_eq!(meta1.master_public_key, meta2.master_public_key);
    }

    #[test]
    fn init_existing_fails() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        Wallet::init(&wallet_dir, None).unwrap();
        let result = Wallet::init(&wallet_dir, None);
        assert!(result.is_err());
    }

    #[test]
    fn init_with_password() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (_wallet, _phrase) = Wallet::init(&wallet_dir, Some("testpass")).unwrap();

        // Seed file should start with SAID magic
        let seed_bytes = std::fs::read(wallet_dir.join("seed")).unwrap();
        assert_eq!(&seed_bytes[..4], b"SAID");

        // Load without password should fail with PasswordRequired
        let result = Wallet::load(&wallet_dir, None);
        assert!(matches!(result, Err(SaidError::PasswordRequired)));

        // Load with correct password should succeed
        let loaded = Wallet::load(&wallet_dir, Some("testpass"));
        assert!(loaded.is_ok());

        // Load with wrong password should fail
        let result = Wallet::load(&wallet_dir, Some("wrongpass"));
        assert!(result.is_err());

        // Metadata should indicate encryption
        let meta = Wallet::load_metadata(&wallet_dir).unwrap();
        assert!(meta.seed_encrypted);
    }

    #[test]
    fn derive_provider_keys_are_distinct() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _) = Wallet::init(&wallet_dir, None).unwrap();

        let openai_key = wallet.derive_provider_key(Provider::OpenAI, KeyType::Signing, 0);
        let anthropic_key =
            wallet.derive_provider_key(Provider::Anthropic, KeyType::Signing, 0);

        let openai_pub = openai_key.public();
        let anthropic_pub = anthropic_key.public();
        assert_ne!(openai_pub.as_ref(), anthropic_pub.as_ref());
    }

    #[test]
    fn solana_keypair_derivation() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, phrase) = Wallet::init(&wallet_dir, None).unwrap();

        let kp1 = wallet.solana_keypair_bytes();
        assert_eq!(kp1.len(), 64);
        // Pubkey matches last 32 bytes of keypair
        assert_eq!(&kp1[32..], &wallet.solana_pubkey_bytes());

        // Deterministic: same phrase produces same keys
        let dir2 = TempDir::new().unwrap();
        let wallet_dir2 = dir2.path().join(".said");
        let recovered = Wallet::recover(&phrase, &wallet_dir2, None).unwrap();
        assert_eq!(kp1, recovered.solana_keypair_bytes());
    }

    #[test]
    fn derive_keys_deterministic() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (_wallet, phrase) = Wallet::init(&wallet_dir, None).unwrap();

        let dir2 = TempDir::new().unwrap();
        let wallet_dir2 = dir2.path().join(".said");
        let recovered = Wallet::recover(&phrase, &wallet_dir2, None).unwrap();

        let key1 = _wallet
            .derive_provider_key(Provider::OpenAI, KeyType::Encryption, 0)
            .public();
        let key2 = recovered
            .derive_provider_key(Provider::OpenAI, KeyType::Encryption, 0)
            .public();
        assert_eq!(key1.as_ref(), key2.as_ref());
    }
}
