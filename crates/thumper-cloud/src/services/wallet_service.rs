//! Native Solana wallet service for Ghola.
//! HD derivation (BIP39 + BIP32-Ed25519), encrypted storage, balance checks,
//! SOL/USDC transfers — all via JSON-RPC, no solana-sdk dependency.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_bip32::{DerivationScheme, XPrv};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::{NetworkScope, PrivacyApproval};
use crate::services::llm_router::{decrypt_api_key, encrypt_api_key};
use crate::state::AppState;

const HARDENED: u32 = 0x80000000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// SPL Token Program ID: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];

/// Associated Token Account Program ID: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
const ATA_PROGRAM_ID: [u8; 32] = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
    0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
];

/// System Program ID: 11111111111111111111111111111111
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// USDC Mint (Mainnet): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
const USDC_MINT_MAINNET: [u8; 32] = [
    0xc6, 0xfa, 0x7a, 0xf3, 0xbe, 0xdb, 0xad, 0x39, 0x22, 0x22, 0x76, 0x5e, 0x44, 0x70, 0x04, 0x64,
    0xe3, 0xdf, 0x71, 0x23, 0xc0, 0x81, 0x5f, 0x84, 0xf4, 0x6f, 0xb3, 0x50, 0x8e, 0x97, 0xf8, 0xa7,
];

/// USDC Mint (Devnet): 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
const USDC_MINT_DEVNET: [u8; 32] = [
    0x3b, 0x44, 0x2c, 0xc7, 0x14, 0xf8, 0x4f, 0x7a, 0x4c, 0x3c, 0x09, 0x65, 0xf5, 0xc8, 0xac, 0x51,
    0xdb, 0x35, 0xd5, 0x73, 0x45, 0x6e, 0x6e, 0x52, 0xb7, 0x05, 0x2b, 0xe7, 0x57, 0x3b, 0x15, 0x7f,
];

const USDC_DECIMALS: u8 = 6;

// ---------------------------------------------------------------------------
// HD key derivation
// ---------------------------------------------------------------------------

/// Derive a Solana keypair from BIP39 seed via BIP44 path m/44'/501'/0'/0'.
/// Uses ed25519-bip32 (same pattern as SAID wallet).
fn derive_solana_keypair(seed: &[u8; 64]) -> SigningKey {
    // Derive root XPrv from seed using HMAC-SHA512 (like SAID's from_seed)
    let hd_secret = hmac_sha512(b"ed25519 seed", seed);
    let (secret, chain_code): ([u8; 32], [u8; 32]) = {
        let mut s = [0u8; 32];
        let mut c = [0u8; 32];
        s.copy_from_slice(&hd_secret[..32]);
        c.copy_from_slice(&hd_secret[32..]);
        (s, c)
    };

    let root = XPrv::from_nonextended_force(&secret, &chain_code);

    // Derive: m / 44' / 501' / 0' / 0'
    let derived = root
        .derive(DerivationScheme::V2, HARDENED | 44)
        .derive(DerivationScheme::V2, HARDENED | 501)
        .derive(DerivationScheme::V2, HARDENED | 0)
        .derive(DerivationScheme::V2, HARDENED | 0);

    xprv_to_signing_key(&derived)
}

/// Convert an ed25519_bip32 XPrv to an ed25519_dalek SigningKey.
fn xprv_to_signing_key(xprv: &XPrv) -> SigningKey {
    let bytes: &[u8] = xprv.as_ref();
    let secret: [u8; 32] = bytes[..32].try_into().expect("XPrv has at least 32 bytes");
    SigningKey::from_bytes(&secret)
}

/// HMAC-SHA512 for BIP32 root key derivation.
fn hmac_sha512(key: &[u8], data: &[u8]) -> [u8; 64] {
    use sha2::Sha512;
    // Simple HMAC implementation (avoids adding hmac crate)
    let block_size = 128;
    let mut k = vec![0u8; block_size];
    if key.len() > block_size {
        let hash = Sha512::digest(key);
        k[..64].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = vec![0x36u8; block_size];
    let mut opad = vec![0x5cu8; block_size];
    for i in 0..block_size {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner_hasher = Sha512::new();
    inner_hasher.update(&ipad);
    inner_hasher.update(data);
    let inner_hash = inner_hasher.finalize();

    let mut outer_hasher = Sha512::new();
    outer_hasher.update(&opad);
    outer_hasher.update(&inner_hash);
    let result = outer_hasher.finalize();

    let mut out = [0u8; 64];
    out.copy_from_slice(&result);
    out
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct WalletInfo {
    pub address: String,
    pub network: String,
}

#[derive(Serialize)]
pub struct Balances {
    pub sol: f64,
    pub usdc: f64,
    pub address: String,
    pub network: String,
}

#[derive(Deserialize)]
pub struct TransferRequest {
    pub to: String,
    pub amount: u64,
    pub currency: String,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Serialize, Clone)]
pub struct TxResult {
    pub signature: String,
    pub explorer_url: String,
}

/// Send USDC from the platform treasury wallet to a recipient address.
/// Used for provider payout withdrawals.
pub async fn send_treasury_usdc(
    mnemonic_str: &str,
    to_address: &str,
    amount: u64,
    rpc_url: &str,
) -> Result<TxResult, CloudError> {
    let mnemonic = bip39::Mnemonic::parse(mnemonic_str)
        .map_err(|e| CloudError::Internal(format!("invalid treasury mnemonic: {e}")))?;
    let seed = mnemonic.to_seed("");
    let signing_key = derive_solana_keypair(&seed);
    let payer = signing_key.verifying_key().to_bytes();

    let to_bytes = bs58::decode(to_address)
        .into_vec()
        .map_err(|e| CloudError::BadRequest(format!("invalid recipient address: {e}")))?;
    let to: [u8; 32] = to_bytes
        .try_into()
        .map_err(|_| CloudError::BadRequest("invalid recipient address length".into()))?;

    let is_devnet = rpc_url.contains("devnet");
    let client = reqwest::Client::new();

    let signature = send_usdc_transfer(
        &client,
        rpc_url,
        &signing_key,
        &payer,
        &to,
        amount,
        is_devnet,
    )
    .await?;

    let cluster = if is_devnet { "?cluster=devnet" } else { "" };
    let explorer_url = format!("https://explorer.solana.com/tx/{signature}{cluster}");

    Ok(TxResult {
        signature,
        explorer_url,
    })
}

#[derive(Serialize)]
pub struct TxHistoryEntry {
    pub id: Uuid,
    pub tx_type: String,
    pub currency: String,
    pub amount: i64,
    pub to_address_preview: Option<String>,
    pub signature: Option<String>,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn recipient_preview(address: Option<&str>) -> Option<String> {
    address.map(crate::privacy::log_addr)
}

// ---------------------------------------------------------------------------
// Wallet tool definitions (for Claude tool-use in chat)
// ---------------------------------------------------------------------------

pub fn wallet_tool_definitions() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "name": "check_wallet_balance",
            "description": "Check the user's Solana wallet balance (SOL and USDC). Call this when the user asks about their balance, funds, or wallet.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        serde_json::json!({
            "name": "send_crypto",
            "description": "Send SOL or USDC to a Solana address. Call this when the user wants to send, transfer, or pay someone in crypto.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "Recipient's Solana address (base58)"
                    },
                    "amount": {
                        "type": "number",
                        "description": "Amount to send in lamports (SOL) or micro-units (USDC)"
                    },
                    "currency": {
                        "type": "string",
                        "enum": ["SOL", "USDC"],
                        "description": "Currency to send"
                    }
                },
                "required": ["to", "amount", "currency"]
            }
        }),
        serde_json::json!({
            "name": "get_wallet_address",
            "description": "Get the user's Solana wallet address. Call this when the user asks for their address or wants to receive crypto.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
    ]
}

// ---------------------------------------------------------------------------
// Wallet operations
// ---------------------------------------------------------------------------

/// Provision a new Solana wallet for a user via BIP39 + BIP32-Ed25519.
pub async fn generate_wallet(state: &AppState, user_id: Uuid) -> Result<WalletInfo, CloudError> {
    // Check if wallet already exists
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT solana_address, network FROM user_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    if let Some((address, network)) = existing {
        return Ok(WalletInfo { address, network });
    }

    // Generate 24-word BIP39 mnemonic
    let mnemonic = bip39::Mnemonic::generate(24)
        .map_err(|e| CloudError::Internal(format!("mnemonic generation failed: {e}")))?;

    let seed = mnemonic.to_seed("");

    // HD derivation: m / 44' / 501' / 0' / 0' (standard Solana BIP44 path)
    let signing_key = derive_solana_keypair(&seed);
    let pubkey = signing_key.verifying_key().to_bytes();
    let address = bs58::encode(&pubkey).into_string();

    // Encrypt mnemonic
    let mnemonic_str = mnemonic.to_string();
    let encrypted = encrypt_api_key(&mnemonic_str, &state.config.encryption_key)?;

    // Determine network from RPC URL
    let network = if state.config.solana_rpc_url.contains("devnet") {
        "devnet"
    } else {
        "mainnet-beta"
    };

    // Set spending limit based on user tier
    let tier: Option<String> = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .flatten();
    let daily_limit = spending_limit_daily(&tier.unwrap_or_else(|| "free".to_string()));

    sqlx::query(
        r#"
        INSERT INTO user_wallets (user_id, solana_address, mnemonic_encrypted, network, spending_limit_daily_usdc)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(user_id)
    .bind(&address)
    .bind(&encrypted)
    .bind(network)
    .bind(daily_limit)
    .execute(&state.db)
    .await?;

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        address = %crate::privacy::log_addr(&address),
        %network,
        "wallet provisioned"
    );

    Ok(WalletInfo {
        address,
        network: network.to_string(),
    })
}

/// Get the wallet address for a user (without decrypting the mnemonic).
pub async fn get_address(state: &AppState, user_id: Uuid) -> Result<WalletInfo, CloudError> {
    let row: (String, String) =
        sqlx::query_as("SELECT solana_address, network FROM user_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(CloudError::NotFound("wallet not provisioned".to_string()))?;

    Ok(WalletInfo {
        address: row.0,
        network: row.1,
    })
}

/// Fetch SOL and USDC balances for a user's wallet.
pub async fn get_balances(state: &AppState, user_id: Uuid) -> Result<Balances, CloudError> {
    let (address, network): (String, String) =
        sqlx::query_as("SELECT solana_address, network FROM user_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(CloudError::NotFound("wallet not provisioned".to_string()))?;

    let pubkey_bytes = bs58::decode(&address)
        .into_vec()
        .map_err(|e| CloudError::Internal(format!("invalid address: {e}")))?;
    let pubkey: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| CloudError::Internal("invalid pubkey length".into()))?;

    let client = reqwest::Client::new();
    let rpc_url = &state.config.solana_rpc_url;

    // Fetch SOL balance
    let sol_lamports = rpc_get_balance(&client, rpc_url, &address).await?;
    let sol = sol_lamports as f64 / 1_000_000_000.0;

    // Fetch USDC balance
    let is_devnet = network == "devnet";
    let mint = if is_devnet {
        USDC_MINT_DEVNET
    } else {
        USDC_MINT_MAINNET
    };
    let ata = find_ata(&pubkey, &mint);
    let ata_b58 = bs58::encode(&ata).into_string();
    let usdc_micro = rpc_get_token_balance(&client, rpc_url, &ata_b58)
        .await
        .unwrap_or(0);
    let usdc = usdc_micro as f64 / 1_000_000.0;

    Ok(Balances {
        sol,
        usdc,
        address,
        network,
    })
}

/// Rate limit: max 1 transfer per 10 seconds per user.
async fn check_transfer_cooldown(state: &AppState, user_id: Uuid) -> Result<(), CloudError> {
    let recent: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        r#"
        SELECT created_at FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some(last_tx_time) = recent {
        let elapsed = chrono::Utc::now() - last_tx_time;
        if elapsed.num_seconds() < 10 {
            return Err(CloudError::RateLimit);
        }
    }
    Ok(())
}

/// Prevent duplicate transfers: same to/amount/currency within 30 seconds.
async fn check_duplicate_transfer(
    state: &AppState,
    user_id: Uuid,
    req: &TransferRequest,
) -> Result<(), CloudError> {
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM wallet_transactions
            WHERE user_id = $1
              AND to_address = $2
              AND amount = $3
              AND currency = $4
              AND created_at > now() - interval '30 seconds'
        )
        "#,
    )
    .bind(user_id)
    .bind(&req.to)
    .bind(req.amount as i64)
    .bind(&req.currency)
    .fetch_one(&state.db)
    .await?;

    if exists {
        return Err(CloudError::BadRequest(
            "duplicate transfer detected — wait 30 seconds before retrying the same transfer"
                .to_string(),
        ));
    }
    Ok(())
}

/// Check for pending transactions before allowing new ones.
async fn check_pending_transfers(state: &AppState, user_id: Uuid) -> Result<(), CloudError> {
    let pending_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1 AND status = 'pending'",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if pending_count > 0 {
        return Err(CloudError::BadRequest(
            "you have a pending transaction — wait for it to complete".to_string(),
        ));
    }
    Ok(())
}

/// Transfer SOL or USDC from the user's wallet.
pub async fn transfer(
    state: &AppState,
    user_id: Uuid,
    req: &TransferRequest,
) -> Result<TxResult, CloudError> {
    req.approval.require_for(NetworkScope::WalletTransfer)?;

    // Validate currency
    if req.currency != "SOL" && req.currency != "USDC" {
        return Err(CloudError::BadRequest(
            "currency must be SOL or USDC".to_string(),
        ));
    }

    // Rate limit: max 1 transfer per 10 seconds per user
    check_transfer_cooldown(state, user_id).await?;

    // Duplicate prevention: same to/amount/currency within 30 seconds
    check_duplicate_transfer(state, user_id, req).await?;

    // Block if there's already a pending transaction
    check_pending_transfers(state, user_id).await?;

    // Load wallet
    let (wallet_id, encrypted_mnemonic, network, daily_limit): (Uuid, Vec<u8>, String, i64) =
        sqlx::query_as(
            "SELECT id, mnemonic_encrypted, network, spending_limit_daily_usdc FROM user_wallets WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(CloudError::NotFound("wallet not provisioned".to_string()))?;

    // Check spending limits (for USDC transfers)
    if req.currency == "USDC" {
        check_spending_limit(state, user_id, req.amount as i64, daily_limit).await?;
    }

    // Validate recipient address
    let to_bytes = bs58::decode(&req.to)
        .into_vec()
        .map_err(|_| CloudError::BadRequest("invalid recipient address".to_string()))?;
    let to: [u8; 32] = to_bytes
        .try_into()
        .map_err(|_| CloudError::BadRequest("invalid recipient address length".to_string()))?;

    // Decrypt mnemonic → derive keypair
    let mnemonic_str = decrypt_api_key(&encrypted_mnemonic, &state.config.encryption_key)?;
    let mnemonic = bip39::Mnemonic::parse(&mnemonic_str)
        .map_err(|e| CloudError::Internal(format!("invalid mnemonic: {e}")))?;
    let seed = mnemonic.to_seed("");
    let signing_key = derive_solana_keypair(&seed);
    let payer = signing_key.verifying_key().to_bytes();

    let client = reqwest::Client::new();
    let rpc_url = &state.config.solana_rpc_url;
    let is_devnet = network == "devnet";

    // Record pending transaction
    let tx_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wallet_transactions (user_id, wallet_id, tx_type, currency, amount, to_address, status, privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary)
        VALUES ($1, $2, 'transfer', $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(wallet_id)
    .bind(&req.currency)
    .bind(req.amount as i64)
    .bind(&req.to)
    .bind(req.approval.privacy_mode.as_deref())
    .bind(req.approval.network_scope.as_deref())
    .bind(req.approval.user_approved_at)
    .bind(req.approval.approval_nonce.as_deref())
    .bind(req.approval.approval_summary.as_deref())
    .fetch_one(&state.db)
    .await?;

    // Build and send transaction
    let result = match req.currency.as_str() {
        "SOL" => send_sol_transfer(&client, rpc_url, &signing_key, &payer, &to, req.amount).await,
        "USDC" => {
            send_usdc_transfer(
                &client,
                rpc_url,
                &signing_key,
                &payer,
                &to,
                req.amount,
                is_devnet,
            )
            .await
        }
        _ => unreachable!(),
    };

    match result {
        Ok(signature) => {
            // Mark confirmed
            sqlx::query(
                "UPDATE wallet_transactions SET signature = $1, status = 'confirmed' WHERE id = $2",
            )
            .bind(&signature)
            .bind(tx_id)
            .execute(&state.db)
            .await?;

            let cluster = if is_devnet { "?cluster=devnet" } else { "" };
            let explorer_url = format!("https://explorer.solana.com/tx/{signature}{cluster}");

            tracing::info!(
                user = %crate::privacy::log_id(&user_id),
                currency = %req.currency,
                "transfer confirmed"
            );

            Ok(TxResult {
                signature,
                explorer_url,
            })
        }
        Err(e) => {
            // Mark failed
            sqlx::query("UPDATE wallet_transactions SET status = 'failed' WHERE id = $1")
                .bind(tx_id)
                .execute(&state.db)
                .await?;
            Err(e)
        }
    }
}

/// Fetch transaction history for a user.
pub async fn get_history(
    state: &AppState,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<TxHistoryEntry>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
            String,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"
        SELECT id, tx_type, currency, amount, to_address, signature, status, created_at
        FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, tx_type, currency, amount, to_address, signature, status, created_at)| {
                TxHistoryEntry {
                    id,
                    tx_type,
                    currency,
                    amount,
                    to_address_preview: recipient_preview(to_address.as_deref()),
                    signature,
                    status,
                    created_at,
                }
            },
        )
        .collect())
}

/// Execute a wallet tool call from Claude (for chat integration).
pub async fn execute_tool(
    state: &AppState,
    user_id: Uuid,
    tool_name: &str,
    _tool_input: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    match tool_name {
        "check_wallet_balance" => {
            let balances = get_balances(state, user_id).await?;
            Ok(serde_json::json!({
                "sol": balances.sol,
                "usdc": balances.usdc,
                "address": balances.address,
                "network": balances.network,
            }))
        }
        "get_wallet_address" => {
            let info = get_address(state, user_id).await?;
            Ok(serde_json::json!({
                "address": info.address,
                "network": info.network,
            }))
        }
        "send_crypto" => Err(CloudError::BadRequest(
            "wallet transfers require explicit in-app approval via the dedicated transfer flow"
                .into(),
        )),
        _ => Err(CloudError::BadRequest(format!(
            "unknown wallet tool: {tool_name}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// HD-derived intermediate wallets (privacy: break treasury → provider link)
// ---------------------------------------------------------------------------

/// Derive a unique intermediate keypair for a provider payout.
/// Path: m / 44' / 501' / {provider_index}' / 0'
/// Each provider gets a distinct on-chain address so payouts cannot be linked
/// back to the single treasury wallet.
fn derive_intermediate_keypair(seed: &[u8; 64], provider_index: u32) -> SigningKey {
    let hd_secret = hmac_sha512(b"ed25519 seed", seed);
    let (secret, chain_code): ([u8; 32], [u8; 32]) = {
        let mut s = [0u8; 32];
        let mut c = [0u8; 32];
        s.copy_from_slice(&hd_secret[..32]);
        c.copy_from_slice(&hd_secret[32..]);
        (s, c)
    };

    let root = XPrv::from_nonextended_force(&secret, &chain_code);

    let derived = root
        .derive(DerivationScheme::V2, HARDENED | 44)
        .derive(DerivationScheme::V2, HARDENED | 501)
        .derive(DerivationScheme::V2, HARDENED | provider_index)
        .derive(DerivationScheme::V2, HARDENED | 0);

    xprv_to_signing_key(&derived)
}

/// Send USDC to a provider via an HD-derived intermediate wallet.
/// Three-step fund-on-demand flow:
///   1. Fund intermediate with SOL (for tx fees) if balance < 0.01 SOL
///   2. Transfer USDC from treasury → intermediate
///   3. Transfer USDC from intermediate → provider
/// Returns the TxResult from step 3 (the provider-visible tx).
pub async fn send_via_intermediate(
    mnemonic_str: &str,
    provider_index: u32,
    to_address: &str,
    amount: u64,
    rpc_url: &str,
) -> Result<TxResult, CloudError> {
    let mnemonic = bip39::Mnemonic::parse(mnemonic_str)
        .map_err(|e| CloudError::Internal(format!("invalid treasury mnemonic: {e}")))?;
    let seed = mnemonic.to_seed("");

    let treasury_key = derive_solana_keypair(&seed);
    let treasury_pubkey = treasury_key.verifying_key().to_bytes();

    let intermediate_key = derive_intermediate_keypair(&seed, provider_index);
    let intermediate_pubkey = intermediate_key.verifying_key().to_bytes();
    let intermediate_addr = bs58::encode(&intermediate_pubkey).into_string();

    let to_bytes = bs58::decode(to_address)
        .into_vec()
        .map_err(|e| CloudError::BadRequest(format!("invalid recipient address: {e}")))?;
    let to: [u8; 32] = to_bytes
        .try_into()
        .map_err(|_| CloudError::BadRequest("invalid recipient address length".into()))?;

    let is_devnet = rpc_url.contains("devnet");
    let client = reqwest::Client::new();

    // Step 1: Ensure intermediate has enough SOL for tx fees
    let intermediate_sol = rpc_get_balance(&client, rpc_url, &intermediate_addr).await?;
    if intermediate_sol < 10_000_000 {
        // < 0.01 SOL → fund with 0.02 SOL from treasury
        send_sol_transfer(
            &client,
            rpc_url,
            &treasury_key,
            &treasury_pubkey,
            &intermediate_pubkey,
            20_000_000, // 0.02 SOL
        )
        .await?;
    }

    // Step 2: Transfer USDC from treasury → intermediate
    send_usdc_transfer(
        &client,
        rpc_url,
        &treasury_key,
        &treasury_pubkey,
        &intermediate_pubkey,
        amount,
        is_devnet,
    )
    .await?;

    // Step 3: Transfer USDC from intermediate → provider
    let signature = send_usdc_transfer(
        &client,
        rpc_url,
        &intermediate_key,
        &intermediate_pubkey,
        &to,
        amount,
        is_devnet,
    )
    .await?;

    let cluster = if is_devnet { "?cluster=devnet" } else { "" };
    let explorer_url = format!("https://explorer.solana.com/tx/{signature}{cluster}");

    Ok(TxResult {
        signature,
        explorer_url,
    })
}

// ---------------------------------------------------------------------------
// Spending limits
// ---------------------------------------------------------------------------

fn spending_limit_daily(tier: &str) -> i64 {
    match tier {
        "trial_pack" => 10_000_000,             // $10 in micro-USDC
        "starter" => 50_000_000,                // $50 in micro-USDC
        "pro" | "private_agent" => 100_000_000, // $100 in micro-USDC
        "unlimited" => 1_000_000_000,           // $1,000 in micro-USDC
        "enterprise" => i64::MAX,
        _ => 500_000, // $0.50 free tier
    }
}

fn spending_limit_per_tx(tier: &str) -> i64 {
    match tier {
        "trial_pack" => 10_000_000,            // $10
        "starter" => 25_000_000,               // $25
        "pro" | "private_agent" => 50_000_000, // $50
        "unlimited" => 500_000_000,            // $500
        "enterprise" => i64::MAX,
        _ => 250_000, // $0.25 free tier
    }
}

async fn check_spending_limit(
    state: &AppState,
    user_id: Uuid,
    amount: i64,
    daily_limit: i64,
) -> Result<(), CloudError> {
    // Check per-tx limit
    let tier: Option<String> = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .flatten();
    let tier = tier.unwrap_or_else(|| "free".to_string());
    let per_tx = spending_limit_per_tx(&tier);

    if amount > per_tx {
        return Err(CloudError::BadRequest(format!(
            "amount exceeds per-transaction limit of {} micro-USDC for {} tier",
            per_tx, tier
        )));
    }

    // Check daily limit
    let spent_today: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(amount), 0)
        FROM wallet_transactions
        WHERE user_id = $1
            AND currency = 'USDC'
            AND status = 'confirmed'
            AND created_at >= CURRENT_DATE
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let spent = spent_today.unwrap_or(0);
    if spent + amount > daily_limit {
        return Err(CloudError::BadRequest(format!(
            "transfer would exceed daily USDC limit ({} of {} used)",
            spent, daily_limit
        )));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Solana JSON-RPC helpers
// ---------------------------------------------------------------------------

async fn rpc_call(
    client: &reqwest::Client,
    rpc_url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let resp: serde_json::Value = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|_| CloudError::Internal("Solana RPC request failed".to_string()))?
        .json()
        .await
        .map_err(|_| CloudError::Internal("Solana RPC response parse failed".to_string()))?;

    if resp.get("error").is_some() {
        tracing::warn!(method = %method, "Solana RPC returned an error");
        return Err(CloudError::Internal("Solana RPC error".to_string()));
    }
    resp.get("result")
        .cloned()
        .ok_or(CloudError::Internal("missing RPC result".into()))
}

async fn rpc_get_balance(
    client: &reqwest::Client,
    rpc_url: &str,
    address: &str,
) -> Result<u64, CloudError> {
    let result = rpc_call(
        client,
        rpc_url,
        "getBalance",
        serde_json::json!([address, {"commitment": "confirmed"}]),
    )
    .await?;
    result["value"]
        .as_u64()
        .ok_or(CloudError::Internal("missing balance value".into()))
}

async fn rpc_get_token_balance(
    client: &reqwest::Client,
    rpc_url: &str,
    ata_address: &str,
) -> Result<u64, CloudError> {
    let result = rpc_call(
        client,
        rpc_url,
        "getTokenAccountBalance",
        serde_json::json!([ata_address, {"commitment": "confirmed"}]),
    )
    .await?;
    let amount_str = result["value"]["amount"]
        .as_str()
        .ok_or(CloudError::Internal("missing token amount".into()))?;
    amount_str
        .parse::<u64>()
        .map_err(|e| CloudError::Internal(format!("invalid token amount: {e}")))
}

async fn rpc_get_latest_blockhash(
    client: &reqwest::Client,
    rpc_url: &str,
) -> Result<[u8; 32], CloudError> {
    let result = rpc_call(
        client,
        rpc_url,
        "getLatestBlockhash",
        serde_json::json!([{"commitment": "confirmed"}]),
    )
    .await?;
    let hash_str = result["value"]["blockhash"]
        .as_str()
        .ok_or(CloudError::Internal("missing blockhash".into()))?;
    let bytes = bs58::decode(hash_str)
        .into_vec()
        .map_err(|e| CloudError::Internal(format!("invalid blockhash: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| CloudError::Internal("invalid blockhash length".into()))
}

async fn rpc_send_transaction(
    client: &reqwest::Client,
    rpc_url: &str,
    tx_bytes: &[u8],
) -> Result<String, CloudError> {
    let b64 = STANDARD.encode(tx_bytes);
    let result = rpc_call(
        client,
        rpc_url,
        "sendTransaction",
        serde_json::json!([b64, {"encoding": "base64", "preflightCommitment": "confirmed"}]),
    )
    .await?;
    result
        .as_str()
        .map(|s| s.to_string())
        .ok_or(CloudError::Internal("missing tx signature".into()))
}

// ---------------------------------------------------------------------------
// Transaction building (from said-solana patterns)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct AccountMeta {
    pubkey: [u8; 32],
    is_signer: bool,
    is_writable: bool,
}

impl AccountMeta {
    fn new(pubkey: [u8; 32], is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: true,
        }
    }

    fn new_readonly(pubkey: [u8; 32], is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: false,
        }
    }
}

#[derive(Debug, Clone)]
struct RawInstruction {
    program_id: [u8; 32],
    accounts: Vec<AccountMeta>,
    data: Vec<u8>,
}

fn encode_compact_u16(val: u16) -> Vec<u8> {
    let mut out = Vec::new();
    let mut v = val;
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
    out
}

fn build_message(
    instructions: &[RawInstruction],
    payer: &[u8; 32],
    recent_blockhash: &[u8; 32],
) -> Vec<u8> {
    use std::collections::BTreeMap;

    let mut account_map: BTreeMap<[u8; 32], (bool, bool)> = BTreeMap::new();
    account_map.insert(*payer, (true, true));

    for ix in instructions {
        account_map.entry(ix.program_id).or_insert((false, false));
        for meta in &ix.accounts {
            let entry = account_map.entry(meta.pubkey).or_insert((false, false));
            entry.0 |= meta.is_signer;
            entry.1 |= meta.is_writable;
        }
    }

    let mut writable_signers: Vec<[u8; 32]> = Vec::new();
    let mut readonly_signers: Vec<[u8; 32]> = Vec::new();
    let mut writable_nonsigners: Vec<[u8; 32]> = Vec::new();
    let mut readonly_nonsigners: Vec<[u8; 32]> = Vec::new();

    for (&pubkey, &(is_signer, is_writable)) in &account_map {
        if pubkey == *payer {
            continue;
        }
        match (is_signer, is_writable) {
            (true, true) => writable_signers.push(pubkey),
            (true, false) => readonly_signers.push(pubkey),
            (false, true) => writable_nonsigners.push(pubkey),
            (false, false) => readonly_nonsigners.push(pubkey),
        }
    }

    let mut accounts: Vec<[u8; 32]> = Vec::new();
    accounts.push(*payer);
    accounts.extend_from_slice(&writable_signers);
    accounts.extend_from_slice(&readonly_signers);
    accounts.extend_from_slice(&writable_nonsigners);
    accounts.extend_from_slice(&readonly_nonsigners);

    let account_index: BTreeMap<[u8; 32], u8> = accounts
        .iter()
        .enumerate()
        .map(|(i, &pk)| (pk, i as u8))
        .collect();

    let num_required_signatures = (1 + writable_signers.len() + readonly_signers.len()) as u8;
    let num_readonly_signed = readonly_signers.len() as u8;
    let num_readonly_unsigned = readonly_nonsigners.len() as u8;

    let mut msg = Vec::new();
    msg.push(num_required_signatures);
    msg.push(num_readonly_signed);
    msg.push(num_readonly_unsigned);
    msg.extend_from_slice(&encode_compact_u16(accounts.len() as u16));
    for account in &accounts {
        msg.extend_from_slice(account);
    }
    msg.extend_from_slice(recent_blockhash);
    msg.extend_from_slice(&encode_compact_u16(instructions.len() as u16));

    for ix in instructions {
        let prog_idx = account_index[&ix.program_id];
        msg.push(prog_idx);
        msg.extend_from_slice(&encode_compact_u16(ix.accounts.len() as u16));
        for meta in &ix.accounts {
            let idx = account_index[&meta.pubkey];
            msg.push(idx);
        }
        msg.extend_from_slice(&encode_compact_u16(ix.data.len() as u16));
        msg.extend_from_slice(&ix.data);
    }

    msg
}

fn sign_and_serialize(message: &[u8], signer: &SigningKey) -> Vec<u8> {
    let signature = signer.sign(message);
    let mut tx = Vec::new();
    tx.extend_from_slice(&encode_compact_u16(1));
    tx.extend_from_slice(&signature.to_bytes());
    tx.extend_from_slice(message);
    tx
}

// ---------------------------------------------------------------------------
// SPL helpers
// ---------------------------------------------------------------------------

fn find_ata(wallet: &[u8; 32], mint: &[u8; 32]) -> [u8; 32] {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(wallet);
        hasher.update(&TOKEN_PROGRAM_ID);
        hasher.update(mint);
        hasher.update([bump]);
        hasher.update(&ATA_PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();
        if !is_on_curve(&candidate) {
            return candidate;
        }
    }
    panic!("could not find valid ATA bump");
}

fn is_on_curve(bytes: &[u8; 32]) -> bool {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*bytes);
    compressed.decompress().is_some()
}

fn build_create_ata_ix(payer: &[u8; 32], wallet: &[u8; 32], mint: &[u8; 32]) -> RawInstruction {
    let ata = find_ata(wallet, mint);
    RawInstruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1], // CreateIdempotent
    }
}

fn build_transfer_checked_ix(
    source_ata: &[u8; 32],
    mint: &[u8; 32],
    dest_ata: &[u8; 32],
    authority: &[u8; 32],
    amount: u64,
    decimals: u8,
) -> RawInstruction {
    let mut data = vec![12u8]; // TransferChecked instruction
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    RawInstruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source_ata, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*dest_ata, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn build_sol_transfer_ix(from: &[u8; 32], to: &[u8; 32], lamports: u64) -> RawInstruction {
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());

    RawInstruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

// ---------------------------------------------------------------------------
// High-level transfer functions
// ---------------------------------------------------------------------------

async fn send_sol_transfer(
    client: &reqwest::Client,
    rpc_url: &str,
    signing_key: &SigningKey,
    payer: &[u8; 32],
    to: &[u8; 32],
    lamports: u64,
) -> Result<String, CloudError> {
    let ix = build_sol_transfer_ix(payer, to, lamports);
    let blockhash = rpc_get_latest_blockhash(client, rpc_url).await?;
    let msg = build_message(&[ix], payer, &blockhash);
    let tx_bytes = sign_and_serialize(&msg, signing_key);
    rpc_send_transaction(client, rpc_url, &tx_bytes).await
}

async fn send_usdc_transfer(
    client: &reqwest::Client,
    rpc_url: &str,
    signing_key: &SigningKey,
    payer: &[u8; 32],
    to: &[u8; 32],
    amount: u64,
    devnet: bool,
) -> Result<String, CloudError> {
    let mint = if devnet {
        USDC_MINT_DEVNET
    } else {
        USDC_MINT_MAINNET
    };

    let source_ata = find_ata(payer, &mint);
    let dest_ata = find_ata(to, &mint);

    let create_ata_ix = build_create_ata_ix(payer, to, &mint);
    let transfer_ix =
        build_transfer_checked_ix(&source_ata, &mint, &dest_ata, payer, amount, USDC_DECIMALS);

    let blockhash = rpc_get_latest_blockhash(client, rpc_url).await?;
    let msg = build_message(&[create_ata_ix, transfer_ix], payer, &blockhash);
    let tx_bytes = sign_and_serialize(&msg, signing_key);
    rpc_send_transaction(client, rpc_url, &tx_bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privacy::STRICT_LOCAL;
    use chrono::Utc;

    #[test]
    fn recipient_preview_masks_raw_wallet_address() {
        assert_eq!(
            recipient_preview(Some("11111111111111111111111111111111")).as_deref(),
            Some("1111...1111")
        );
        assert_eq!(recipient_preview(None), None);
    }

    #[test]
    fn history_entry_serializes_masked_recipient_only() {
        let entry = TxHistoryEntry {
            id: Uuid::nil(),
            tx_type: "transfer".to_string(),
            currency: "USDC".to_string(),
            amount: 1_250_000,
            to_address_preview: recipient_preview(Some("11111111111111111111111111111111")),
            signature: None,
            status: "confirmed".to_string(),
            created_at: Utc::now(),
        };

        let value = serde_json::to_value(entry).expect("history entry serializes");
        assert!(value.get("to_address").is_none());
        assert!(value.get("approval_nonce").is_none());
        assert_eq!(value["to_address_preview"], "1111...1111");
    }

    #[test]
    fn wallet_transfer_requires_matching_approval_metadata() {
        assert!(PrivacyApproval::default()
            .require_for(NetworkScope::WalletTransfer)
            .is_err());

        let approval = PrivacyApproval {
            privacy_mode: Some(STRICT_LOCAL.to_string()),
            network_scope: Some(NetworkScope::WalletTransfer.as_str().to_string()),
            user_approved_at: Some(Utc::now()),
            approval_nonce: Some("wallet-transfer-nonce-123".to_string()),
            approval_summary: Some("User approved a public Solana USDC transfer.".to_string()),
        };

        assert!(approval.require_for(NetworkScope::WalletTransfer).is_ok());
        assert!(approval.require_for(NetworkScope::WalletProvision).is_err());
    }
}
