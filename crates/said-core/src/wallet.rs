use std::path::PathBuf;

use bip39::Mnemonic;
use ed25519_bip32::{DerivationScheme, XPrv};
use zeroize::Zeroize;

use said_types::{KeyType, Provider, WalletMetadata, SAID_PURPOSE};

use crate::encrypt::derive_key;
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
}

impl Wallet {
    /// Initialize a new wallet, generating a fresh mnemonic.
    /// Returns the wallet and the mnemonic phrase (for backup).
    pub fn init(wallet_dir: &PathBuf) -> Result<(Self, String)> {
        if wallet_dir.join("wallet.json").exists() {
            return Err(SaidError::WalletExists(wallet_dir.display().to_string()));
        }

        let mnemonic = Mnemonic::generate(24)
            .map_err(|e| SaidError::KeyDerivation(format!("{}", e)))?;
        let phrase = mnemonic.to_string();
        let seed = mnemonic.to_seed("");

        let wallet = Self::from_seed(seed, wallet_dir.clone())?;
        wallet.persist_wallet_files()?;

        Ok((wallet, phrase))
    }

    /// Load an existing wallet from disk.
    pub fn load(wallet_dir: &PathBuf) -> Result<Self> {
        if !wallet_dir.join("seed").exists() {
            return Err(SaidError::WalletNotFound(wallet_dir.display().to_string()));
        }

        let seed_bytes = std::fs::read(wallet_dir.join("seed"))?;
        let seed: [u8; 64] = seed_bytes
            .try_into()
            .map_err(|_| SaidError::Storage("invalid seed file (expected 64 bytes)".into()))?;

        Self::from_seed(seed, wallet_dir.clone())
    }

    /// Recover a wallet from a mnemonic phrase.
    pub fn recover(phrase: &str, wallet_dir: &PathBuf) -> Result<Self> {
        if wallet_dir.join("wallet.json").exists() {
            return Err(SaidError::WalletExists(wallet_dir.display().to_string()));
        }

        let mnemonic: Mnemonic = phrase
            .parse()
            .map_err(|e: bip39::Error| SaidError::InvalidMnemonic(e.to_string()))?;
        let seed = mnemonic.to_seed("");

        let wallet = Self::from_seed(seed, wallet_dir.clone())?;
        wallet.persist_wallet_files()?;

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
        })
    }

    fn persist_wallet_files(&self) -> Result<()> {
        std::fs::create_dir_all(&self.wallet_dir)?;

        // Save seed (chmod 600)
        let seed_path = self.wallet_dir.join("seed");
        std::fs::write(&seed_path, &self.seed)?;
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
        let (wallet, phrase) = Wallet::init(&wallet_dir).unwrap();

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
        let (_wallet, _phrase) = Wallet::init(&wallet_dir).unwrap();
        let loaded = Wallet::load(&wallet_dir);
        assert!(loaded.is_ok());
    }

    #[test]
    fn recover_from_phrase() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (_wallet, phrase) = Wallet::init(&wallet_dir).unwrap();

        // Recover to a different directory
        let dir2 = TempDir::new().unwrap();
        let wallet_dir2 = dir2.path().join(".said");
        let recovered = Wallet::recover(&phrase, &wallet_dir2).unwrap();

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
        Wallet::init(&wallet_dir).unwrap();
        let result = Wallet::init(&wallet_dir);
        assert!(result.is_err());
    }

    #[test]
    fn derive_provider_keys_are_distinct() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _) = Wallet::init(&wallet_dir).unwrap();

        let openai_key = wallet.derive_provider_key(Provider::OpenAI, KeyType::Signing, 0);
        let anthropic_key =
            wallet.derive_provider_key(Provider::Anthropic, KeyType::Signing, 0);

        let openai_pub = openai_key.public();
        let anthropic_pub = anthropic_key.public();
        assert_ne!(openai_pub.as_ref(), anthropic_pub.as_ref());
    }

    #[test]
    fn derive_keys_deterministic() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (_wallet, phrase) = Wallet::init(&wallet_dir).unwrap();

        let dir2 = TempDir::new().unwrap();
        let wallet_dir2 = dir2.path().join(".said");
        let recovered = Wallet::recover(&phrase, &wallet_dir2).unwrap();

        let key1 = _wallet
            .derive_provider_key(Provider::OpenAI, KeyType::Encryption, 0)
            .public();
        let key2 = recovered
            .derive_provider_key(Provider::OpenAI, KeyType::Encryption, 0)
            .public();
        assert_eq!(key1.as_ref(), key2.as_ref());
    }
}
