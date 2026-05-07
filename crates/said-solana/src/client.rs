use base64::{engine::general_purpose::STANDARD, Engine};
use borsh::BorshDeserialize;
use ed25519_dalek::SigningKey;
use serde::Serialize;

use crate::error::{Result, SolanaError};
use crate::instructions;
use crate::pda::find_identity_pda;
use crate::tx;

/// On-chain identity record, matching the Anchor IdentityRecord layout.
/// Anchor accounts are prefixed with an 8-byte discriminator, then Borsh-encoded.
#[derive(Debug, Clone, BorshDeserialize, Serialize)]
pub struct IdentityRecord {
    pub authority: [u8; 32],
    pub master_pubkey: [u8; 32],
    pub did_key: String,
    pub profile_uri: String,
    pub registered_at: i64,
    pub updated_at: i64,
    pub active: bool,
    pub bump: u8,
}

impl IdentityRecord {
    /// Format the authority as a base58 string.
    pub fn authority_bs58(&self) -> String {
        bs58::encode(&self.authority).into_string()
    }

    /// Format the master_pubkey as a base58 string.
    pub fn master_pubkey_bs58(&self) -> String {
        bs58::encode(&self.master_pubkey).into_string()
    }
}

/// Client for interacting with the SAID on-chain registry.
pub struct SolanaClient {
    rpc_url: String,
    payer: SigningKey,
    http: reqwest::Client,
}

impl SolanaClient {
    /// Create a new client from raw keypair bytes [secret(32) | pubkey(32)].
    pub fn new(rpc_url: &str, keypair_bytes: &[u8; 64]) -> Result<Self> {
        let secret: [u8; 32] = keypair_bytes[..32]
            .try_into()
            .map_err(|_| SolanaError::Client("invalid keypair bytes".into()))?;
        let payer = SigningKey::from_bytes(&secret);
        Ok(Self {
            rpc_url: rpc_url.to_string(),
            payer,
            http: reqwest::Client::new(),
        })
    }

    /// Create a new client from a SigningKey directly.
    pub fn new_with_signing_key(rpc_url: &str, signing_key: SigningKey) -> Self {
        Self {
            rpc_url: rpc_url.to_string(),
            payer: signing_key,
            http: reqwest::Client::new(),
        }
    }

    /// Get the payer's public key as bytes.
    pub fn payer_pubkey(&self) -> [u8; 32] {
        self.payer.verifying_key().to_bytes()
    }

    /// Get the payer's public key as a base58 string.
    pub fn payer_pubkey_bs58(&self) -> String {
        bs58::encode(self.payer_pubkey()).into_string()
    }

    /// JSON-RPC call to the Solana cluster.
    async fn rpc_call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| SolanaError::Client(e.to_string()))?
            .json()
            .await
            .map_err(|e| SolanaError::Client(e.to_string()))?;

        if let Some(error) = resp.get("error") {
            return Err(SolanaError::Client(error.to_string()));
        }
        resp.get("result")
            .cloned()
            .ok_or(SolanaError::Client("missing result".into()))
    }

    /// Fetch the latest blockhash from the cluster.
    async fn get_latest_blockhash(&self) -> Result<[u8; 32]> {
        let result = self
            .rpc_call(
                "getLatestBlockhash",
                serde_json::json!([{"commitment": "confirmed"}]),
            )
            .await?;
        let hash_str = result["value"]["blockhash"]
            .as_str()
            .ok_or(SolanaError::Client("missing blockhash".into()))?;
        let bytes = bs58::decode(hash_str)
            .into_vec()
            .map_err(|e| SolanaError::Client(e.to_string()))?;
        bytes
            .try_into()
            .map_err(|_| SolanaError::Client("invalid blockhash length".into()))
    }

    /// Send a signed transaction to the cluster.
    async fn send_transaction(&self, tx_bytes: &[u8]) -> Result<String> {
        let b64 = STANDARD.encode(tx_bytes);
        let result = self
            .rpc_call(
                "sendTransaction",
                serde_json::json!([b64, {"encoding": "base64", "preflightCommitment": "confirmed"}]),
            )
            .await?;
        result
            .as_str()
            .map(|s| s.to_string())
            .ok_or(SolanaError::Transaction("missing signature".into()))
    }

    /// Build, sign, and send a single instruction.
    async fn send_single_ix(&self, ix: instructions::RawInstruction) -> Result<String> {
        let blockhash = self.get_latest_blockhash().await?;
        let msg = tx::build_message(&[ix], &self.payer_pubkey(), &blockhash);
        let tx_bytes = tx::sign_and_serialize(&msg, &self.payer);
        self.send_transaction(&tx_bytes).await
    }

    /// Register an identity on-chain.
    pub async fn register(
        &self,
        master_pubkey: &[u8; 32],
        did_key: &str,
        signature: &[u8; 64],
    ) -> Result<String> {
        let ixs =
            instructions::build_register_ix(&self.payer_pubkey(), master_pubkey, did_key, signature);
        let blockhash = self.get_latest_blockhash().await?;
        let msg = tx::build_message(&ixs, &self.payer_pubkey(), &blockhash);
        let tx_bytes = tx::sign_and_serialize(&msg, &self.payer);
        self.send_transaction(&tx_bytes).await
    }

    /// Deactivate an identity.
    pub async fn deactivate(&self, master_pubkey: &[u8; 32]) -> Result<String> {
        let ix = instructions::build_deactivate_ix(&self.payer_pubkey(), master_pubkey);
        self.send_single_ix(ix).await
    }

    /// Reactivate an identity.
    pub async fn reactivate(&self, master_pubkey: &[u8; 32]) -> Result<String> {
        let ix = instructions::build_reactivate_ix(&self.payer_pubkey(), master_pubkey);
        self.send_single_ix(ix).await
    }

    /// Update the authority for an identity.
    pub async fn update_authority(
        &self,
        master_pubkey: &[u8; 32],
        new_authority: &[u8; 32],
    ) -> Result<String> {
        let ix =
            instructions::build_update_authority_ix(&self.payer_pubkey(), master_pubkey, new_authority);
        self.send_single_ix(ix).await
    }

    /// Update the profile URI for an identity.
    pub async fn update_profile_uri(
        &self,
        master_pubkey: &[u8; 32],
        profile_uri: &str,
    ) -> Result<String> {
        let ix = instructions::build_update_profile_uri_ix(
            &self.payer_pubkey(),
            master_pubkey,
            profile_uri,
        );
        self.send_single_ix(ix).await
    }

    /// Look up an identity record by master public key.
    pub async fn lookup_by_pubkey(&self, master_pubkey: &[u8; 32]) -> Result<IdentityRecord> {
        let (pda, _bump) = find_identity_pda(master_pubkey);
        let pda_b58 = bs58::encode(&pda).into_string();

        let result = self
            .rpc_call(
                "getAccountInfo",
                serde_json::json!([pda_b58, {"encoding": "base64", "commitment": "confirmed"}]),
            )
            .await?;

        let value = result.get("value").ok_or(SolanaError::IdentityNotFound)?;
        if value.is_null() {
            return Err(SolanaError::IdentityNotFound);
        }

        let data_arr = value["data"]
            .as_array()
            .ok_or(SolanaError::Deserialization("bad format".into()))?;
        let b64 = data_arr[0]
            .as_str()
            .ok_or(SolanaError::Deserialization("missing data".into()))?;

        let raw = STANDARD
            .decode(b64)
            .map_err(|e| SolanaError::Deserialization(e.to_string()))?;

        // Skip 8-byte Anchor discriminator
        if raw.len() < 8 {
            return Err(SolanaError::Deserialization("too short".into()));
        }
        IdentityRecord::try_from_slice(&raw[8..])
            .map_err(|e| SolanaError::Deserialization(e.to_string()))
    }

    /// Get the SOL balance of the payer account.
    pub async fn get_balance(&self) -> Result<u64> {
        let pubkey_b58 = self.payer_pubkey_bs58();
        let result = self
            .rpc_call(
                "getBalance",
                serde_json::json!([pubkey_b58, {"commitment": "confirmed"}]),
            )
            .await?;
        result["value"]
            .as_u64()
            .ok_or(SolanaError::Client("missing balance".into()))
    }

    /// Request an airdrop (devnet/localnet only).
    pub async fn request_airdrop(&self, lamports: u64) -> Result<String> {
        let pubkey_b58 = self.payer_pubkey_bs58();
        let result = self
            .rpc_call("requestAirdrop", serde_json::json!([pubkey_b58, lamports]))
            .await?;
        result
            .as_str()
            .map(|s| s.to_string())
            .ok_or(SolanaError::Client("missing signature".into()))
    }

    /// Get the SOL balance of any address (not just the payer).
    pub async fn get_balance_of(&self, address: &str) -> Result<u64> {
        let result = self
            .rpc_call(
                "getBalance",
                serde_json::json!([address, {"commitment": "confirmed"}]),
            )
            .await?;
        result["value"]
            .as_u64()
            .ok_or(SolanaError::Client("missing balance".into()))
    }

    /// Get the SPL token balance for a wallet + mint pair.
    /// Returns the balance in the token's smallest unit (e.g., micro-USDC).
    pub async fn get_token_balance(
        &self,
        wallet: &[u8; 32],
        mint: &[u8; 32],
    ) -> Result<u64> {
        let ata = crate::spl::find_ata(wallet, mint);
        let ata_b58 = bs58::encode(&ata).into_string();

        let result = self
            .rpc_call(
                "getTokenAccountBalance",
                serde_json::json!([ata_b58, {"commitment": "confirmed"}]),
            )
            .await;

        match result {
            Ok(val) => {
                let amount_str = val["value"]["amount"]
                    .as_str()
                    .ok_or(SolanaError::Client("missing token amount".into()))?;
                amount_str
                    .parse::<u64>()
                    .map_err(|e| SolanaError::Client(format!("invalid amount: {}", e)))
            }
            Err(_) => Ok(0), // ATA doesn't exist = 0 balance
        }
    }

    /// Transfer SOL from the payer to a recipient.
    /// Returns the transaction signature.
    pub async fn transfer_sol(&self, to: &[u8; 32], lamports: u64) -> Result<String> {
        let ix = crate::spl::build_sol_transfer_ix(&self.payer_pubkey(), to, lamports);
        self.send_single_ix(ix).await
    }

    /// Transfer USDC from the payer to a recipient.
    /// Creates the recipient's ATA if it doesn't exist.
    /// `amount` is in micro-USDC (6 decimals).
    /// `devnet` controls which USDC mint to use.
    pub async fn transfer_usdc(
        &self,
        to: &[u8; 32],
        amount: u64,
        devnet: bool,
    ) -> Result<String> {
        let mint = if devnet {
            crate::spl::USDC_MINT_DEVNET
        } else {
            crate::spl::USDC_MINT_MAINNET
        };

        let payer = self.payer_pubkey();
        let source_ata = crate::spl::find_ata(&payer, &mint);
        let dest_ata = crate::spl::find_ata(to, &mint);

        // Create dest ATA (idempotent) + TransferChecked
        let create_ata_ix = crate::spl::build_create_ata_ix(&payer, to, &mint);
        let transfer_ix = crate::spl::build_transfer_checked_ix(
            &source_ata,
            &mint,
            &dest_ata,
            &payer,
            amount,
            crate::spl::USDC_DECIMALS,
        );

        let blockhash = self.get_latest_blockhash().await?;
        let msg = crate::tx::build_message(&[create_ata_ix, transfer_ix], &payer, &blockhash);
        let tx_bytes = crate::tx::sign_and_serialize(&msg, &self.payer);
        self.send_transaction(&tx_bytes).await
    }

    /// Build, sign, and send a transaction with multiple instructions using a custom signer.
    /// Returns the transaction signature.
    pub async fn send_signed_tx(
        &self,
        instructions: &[crate::instructions::RawInstruction],
        signer: &SigningKey,
    ) -> Result<String> {
        let payer = signer.verifying_key().to_bytes();
        let blockhash = self.get_latest_blockhash().await?;
        let msg = crate::tx::build_message(instructions, &payer, &blockhash);
        let tx_bytes = crate::tx::sign_and_serialize(&msg, signer);
        self.send_transaction(&tx_bytes).await
    }
}
