use std::path::PathBuf;

use bip39::Mnemonic;
use ed25519_bip32::{DerivationScheme, XPrv};
use zeroize::Zeroize;

use bs58;
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
    // ── Agent Payment Wallet Methods ──

    /// Derive an agent's Solana keypair bytes [secret(32) | pubkey(32)].
    /// Path: m / 0x534149' / 6' / 0' / {agent_index}
    pub fn agent_solana_keypair(&self, agent_index: u32) -> [u8; 64] {
        let xprv = self.derive_provider_key(Provider::Agent, KeyType::Signing, agent_index);
        let signing_key = crate::ucan::xprv_to_signing_key(&xprv);
        let verifying_key = signing_key.verifying_key();
        let mut result = [0u8; 64];
        result[..32].copy_from_slice(signing_key.as_bytes());
        result[32..].copy_from_slice(verifying_key.as_bytes());
        result
    }

    /// Get an agent's Solana address as a base58 string.
    pub fn agent_solana_address(&self, agent_index: u32) -> String {
        let kp = self.agent_solana_keypair(agent_index);
        bs58::encode(&kp[32..]).into_string()
    }

    /// Create a new agent wallet with the given label and spending policy.
    /// Assigns the next available HD derivation index and persists to encrypted storage.
    pub fn create_agent_wallet(
        &self,
        label: &str,
        policy: said_types::SpendingPolicy,
    ) -> Result<said_types::AgentWallet> {
        let mut wallets: Vec<said_types::AgentWallet> =
            self.storage.load("agent_wallets").unwrap_or_default();

        // Check for duplicate label
        if wallets.iter().any(|w| w.label == label) {
            return Err(SaidError::Storage(format!(
                "agent wallet with label '{}' already exists",
                label
            )));
        }

        // Next index = max existing index + 1, or 0
        let next_index = wallets.iter().map(|w| w.index).max().map_or(0, |m| m + 1);
        let address = self.agent_solana_address(next_index);

        let wallet = said_types::AgentWallet {
            id: uuid::Uuid::new_v4(),
            label: label.to_string(),
            index: next_index,
            solana_address: address,
            spending_policy: policy,
            created_at: chrono::Utc::now(),
            active: true,
        };

        wallets.push(wallet.clone());
        self.storage.save("agent_wallets", &wallets)?;

        Ok(wallet)
    }

    /// List all agent wallets from encrypted storage.
    pub fn list_agent_wallets(&self) -> Result<Vec<said_types::AgentWallet>> {
        self.storage.load("agent_wallets")
    }

    /// Find an agent wallet by label.
    pub fn find_agent_wallet(&self, label: &str) -> Result<said_types::AgentWallet> {
        let wallets = self.list_agent_wallets()?;
        wallets
            .into_iter()
            .find(|w| w.label == label)
            .ok_or_else(|| SaidError::AgentNotFound(label.to_string()))
    }

    /// Update the spending policy for an agent wallet.
    pub fn update_agent_policy(
        &self,
        agent_id: uuid::Uuid,
        policy: said_types::SpendingPolicy,
    ) -> Result<()> {
        let mut wallets: Vec<said_types::AgentWallet> =
            self.storage.load("agent_wallets").unwrap_or_default();

        let agent = wallets
            .iter_mut()
            .find(|w| w.id == agent_id)
            .ok_or_else(|| SaidError::AgentNotFound(agent_id.to_string()))?;

        agent.spending_policy = policy;
        self.storage.save("agent_wallets", &wallets)?;
        Ok(())
    }

    /// Deactivate an agent wallet.
    pub fn deactivate_agent(&self, agent_id: uuid::Uuid) -> Result<()> {
        let mut wallets: Vec<said_types::AgentWallet> =
            self.storage.load("agent_wallets").unwrap_or_default();

        let agent = wallets
            .iter_mut()
            .find(|w| w.id == agent_id)
            .ok_or_else(|| SaidError::AgentNotFound(agent_id.to_string()))?;

        agent.active = false;
        self.storage.save("agent_wallets", &wallets)?;
        Ok(())
    }

    /// Log a payment transaction to encrypted storage.
    pub fn log_transaction(&self, tx: said_types::PaymentTransaction) -> Result<()> {
        let value = serde_json::to_value(&tx)
            .map_err(|e| SaidError::Serialization(e.to_string()))?;
        self.storage.append_value("pay_transactions", value)?;
        Ok(())
    }

    /// Get payment transaction history, optionally filtered by agent.
    pub fn transaction_history(
        &self,
        agent_id: Option<uuid::Uuid>,
        limit: usize,
    ) -> Result<Vec<said_types::PaymentTransaction>> {
        let txs: Vec<said_types::PaymentTransaction> =
            self.storage.load("pay_transactions").unwrap_or_default();

        let filtered: Vec<said_types::PaymentTransaction> = txs
            .into_iter()
            .rev()
            .filter(|tx| agent_id.map_or(true, |id| tx.agent_id == id))
            .take(limit)
            .collect();

        Ok(filtered)
    }

    /// Check if a transfer would exceed the agent's spending limits.
    /// Sums all sends in the last 24 hours and compares against the policy.
    pub fn check_spending_limit(
        &self,
        agent_id: uuid::Uuid,
        currency: &said_types::PayCurrency,
        amount: u64,
    ) -> Result<()> {
        let wallets: Vec<said_types::AgentWallet> =
            self.storage.load("agent_wallets").unwrap_or_default();

        let agent = wallets
            .iter()
            .find(|w| w.id == agent_id)
            .ok_or_else(|| SaidError::AgentNotFound(agent_id.to_string()))?;

        if !agent.active {
            return Err(SaidError::AgentInactive(agent.label.clone()));
        }

        let policy = &agent.spending_policy;

        // Check per-transaction limit
        match currency {
            said_types::PayCurrency::Sol => {
                if let Some(limit) = policy.per_tx_limit_lamports {
                    if amount > limit {
                        return Err(SaidError::SpendingLimitExceeded(format!(
                            "per-tx SOL limit: {} lamports, requested: {}",
                            limit, amount
                        )));
                    }
                }
            }
            said_types::PayCurrency::Usdc => {
                if let Some(limit) = policy.per_tx_limit_usdc_micro {
                    if amount > limit {
                        return Err(SaidError::SpendingLimitExceeded(format!(
                            "per-tx USDC limit: {} micro, requested: {}",
                            limit, amount
                        )));
                    }
                }
            }
        }

        // Check daily limit
        let daily_limit = match currency {
            said_types::PayCurrency::Sol => policy.daily_limit_lamports,
            said_types::PayCurrency::Usdc => policy.daily_limit_usdc_micro,
        };

        if let Some(limit) = daily_limit {
            let txs: Vec<said_types::PaymentTransaction> =
                self.storage.load("pay_transactions").unwrap_or_default();

            let twenty_four_hours_ago = chrono::Utc::now() - chrono::Duration::hours(24);

            let daily_spent: u64 = txs
                .iter()
                .filter(|tx| {
                    tx.agent_id == agent_id
                        && tx.direction == said_types::TxDirection::Send
                        && tx.currency == *currency
                        && tx.created_at > twenty_four_hours_ago
                })
                .map(|tx| tx.amount)
                .sum();

            if daily_spent + amount > limit {
                return Err(SaidError::SpendingLimitExceeded(format!(
                    "daily {:?} limit: {}, already spent: {}, requested: {}",
                    currency, limit, daily_spent, amount
                )));
            }
        }

        Ok(())
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

    #[test]
    fn agent_wallet_lifecycle() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _) = Wallet::init(&wallet_dir, None).unwrap();

        // Create agent wallet
        let policy = said_types::SpendingPolicy {
            daily_limit_usdc_micro: Some(50_000_000), // $50
            per_tx_limit_usdc_micro: Some(10_000_000), // $10
            ..Default::default()
        };
        let agent = wallet.create_agent_wallet("test-bot", policy).unwrap();
        assert_eq!(agent.label, "test-bot");
        assert!(agent.active);
        assert!(!agent.solana_address.is_empty());

        // List
        let agents = wallet.list_agent_wallets().unwrap();
        assert_eq!(agents.len(), 1);

        // Find
        let found = wallet.find_agent_wallet("test-bot").unwrap();
        assert_eq!(found.id, agent.id);

        // Deactivate
        wallet.deactivate_agent(agent.id).unwrap();
        let agents = wallet.list_agent_wallets().unwrap();
        assert!(!agents[0].active);
    }

    #[test]
    fn agent_spending_limits() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _) = Wallet::init(&wallet_dir, None).unwrap();

        let policy = said_types::SpendingPolicy {
            per_tx_limit_lamports: Some(1_000_000),
            daily_limit_lamports: Some(5_000_000),
            ..Default::default()
        };
        let agent = wallet.create_agent_wallet("spender", policy).unwrap();

        // Under per-tx limit: OK
        wallet
            .check_spending_limit(agent.id, &said_types::PayCurrency::Sol, 500_000)
            .unwrap();

        // Over per-tx limit: fail
        let result =
            wallet.check_spending_limit(agent.id, &said_types::PayCurrency::Sol, 2_000_000);
        assert!(result.is_err());
    }

    #[test]
    fn agent_deterministic_derivation() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, phrase) = Wallet::init(&wallet_dir, None).unwrap();

        let addr1 = wallet.agent_solana_address(0);
        let addr2 = wallet.agent_solana_address(1);
        assert_ne!(addr1, addr2); // Different indices → different addresses

        // Recover produces same addresses
        let dir2 = TempDir::new().unwrap();
        let wallet_dir2 = dir2.path().join(".said");
        let recovered = Wallet::recover(&phrase, &wallet_dir2, None).unwrap();
        assert_eq!(addr1, recovered.agent_solana_address(0));
    }
}
