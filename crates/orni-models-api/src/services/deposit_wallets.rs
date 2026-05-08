//! Phase 4.1: per-user deposit subaddresses.
//!
//! Each user gets a fresh Solana keypair on first deposit. The keypair signs
//! nothing user-facing — its job is purely to be a unique on-chain destination
//! address per user, so on-chain observers can no longer query "all Ghola
//! deposits" by hitting one shared escrow ATA.
//!
//! The hot/cold sweep from Phase 3.3 pulls funds from these per-user wallets
//! into the platform hot wallet on a schedule.
//!
//! Private keys are encrypted at rest with `WALLET_ENCRYPTION_KEY` (32 bytes,
//! base64-encoded in env). A breach of the DB without that key reveals only
//! pubkeys.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use ed25519_dalek::SigningKey;
use rand::RngCore;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Returned by `provision_or_get` — the Solana wallet address (base58) the
/// user should send deposits to. The platform sweeps this wallet to the hot
/// treasury on a schedule.
#[derive(Debug, Clone)]
pub struct DepositWallet {
    pub wallet_pubkey: String,
}

/// Provision a per-user deposit wallet on first call, return the existing one
/// on subsequent calls. The wallet is shared across currencies — a user's
/// deposit address for USDT and USDC is the *same* Solana wallet, with two
/// different ATAs underneath.
pub async fn provision_or_get(db: &PgPool, user_id: Uuid) -> AppResult<DepositWallet> {
    if let Some(pubkey) = sqlx::query_scalar::<_, String>(
        "SELECT wallet_pubkey FROM user_deposit_wallets WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    {
        return Ok(DepositWallet {
            wallet_pubkey: pubkey,
        });
    }

    let master_key = load_master_key()?;

    // Generate a fresh ed25519 keypair.
    let mut secret_seed = [0u8; 32];
    OsRng.fill_bytes(&mut secret_seed);
    let signing_key = SigningKey::from_bytes(&secret_seed);
    let pubkey_bytes = signing_key.verifying_key().to_bytes();
    let pubkey_b58 = bs58::encode(pubkey_bytes).into_string();

    // Encrypt the secret seed under the master key. Layout: nonce(12) || ct.
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&master_key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, secret_seed.as_ref())
        .map_err(|e| AppError::Internal(format!("wallet key encryption failed: {e}")))?;
    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);

    sqlx::query(
        r#"INSERT INTO user_deposit_wallets (user_id, wallet_pubkey, encrypted_secret_key, provider)
           VALUES ($1, $2, $3, 'local')
           ON CONFLICT (user_id) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(&pubkey_b58)
    .bind(&blob)
    .execute(db)
    .await?;

    // Re-read in case ON CONFLICT skipped (race with another inflight request).
    let final_pubkey: String =
        sqlx::query_scalar("SELECT wallet_pubkey FROM user_deposit_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?;

    Ok(DepositWallet {
        wallet_pubkey: final_pubkey,
    })
}

/// Compute the user's ATA for a given mint. Used to display per-currency
/// deposit instructions. Returns base58.
pub async fn deposit_ata_for(
    db: &PgPool,
    user_id: Uuid,
    mint_b58: &str,
) -> AppResult<String> {
    let wallet = provision_or_get(db, user_id).await?;
    let wallet_bytes: [u8; 32] = bs58::decode(&wallet.wallet_pubkey)
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| AppError::Internal("stored wallet pubkey malformed".into()))?;
    let mint_bytes: [u8; 32] = bs58::decode(mint_b58)
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("invalid mint".into()))?;
    let ata = said_solana::spl::find_ata(&wallet_bytes, &mint_bytes);
    Ok(bs58::encode(ata).into_string())
}

fn load_master_key() -> AppResult<[u8; 32]> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let raw = std::env::var("WALLET_ENCRYPTION_KEY").map_err(|_| {
        AppError::Internal(
            "WALLET_ENCRYPTION_KEY env not set — required for per-user deposit wallets (Phase 4.1)".into(),
        )
    })?;
    let bytes = STANDARD
        .decode(raw.trim())
        .map_err(|_| AppError::Internal("WALLET_ENCRYPTION_KEY must be base64".into()))?;
    if bytes.len() != 32 {
        return Err(AppError::Internal(
            "WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)".into(),
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}
