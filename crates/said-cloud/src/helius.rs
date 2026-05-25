//! Helius integration — uses the enhanced-webhook product end to end.
//!
//! What we get from "max Helius capabilities":
//!   • Enhanced (parsed) transaction payloads — Helius classifies each tx
//!     (TRANSFER / SWAP / NFT_SALE / etc.) and breaks down
//!     `nativeTransfers` + `tokenTransfers`, so we don't run our own
//!     Solana parser.
//!   • A single org-wide webhook that watches every agent_wallets row.
//!     Helius supports ~100k addresses per webhook, plenty of headroom.
//!     We PATCH the address list on agent create / archive instead of
//!     creating per-user webhooks (which would burn webhook IDs and
//!     require more state to track).
//!   • Authentication via `authHeader` — Helius sends an arbitrary
//!     `Authorization` header on every delivery. Routes compare it
//!     against `HELIUS_WEBHOOK_AUTH` and 401 on mismatch.
//!   • Account-level filtering — only agent wallets, so we never see
//!     unrelated chain noise.
//!
//! The receiver hits `/v1/webhooks/helius`; see routes/webhooks.rs for
//! that side. This module is the *outbound* side: list/add/remove
//! addresses on the configured webhook, plus parsers shared with the
//! receiver.

use crate::config::Config;
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const HELIUS_BASE: &str = "https://api.helius.xyz/v0";

/// USDC mint (mainnet). devnet uses a different mint; we accept both
/// downstream so the same code runs in either environment.
pub const USDC_MINT_MAINNET: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const USDC_MINT_DEVNET: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

pub fn is_usdc_mint(mint: &str) -> bool {
    mint == USDC_MINT_MAINNET || mint == USDC_MINT_DEVNET
}

// ─── Outbound: Helius webhook management ────────────────────────────────

/// Snapshot of a webhook as Helius returns it from `GET /v0/webhooks/:id`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HeliusWebhook {
    #[serde(rename = "webhookID")]
    pub webhook_id: String,
    pub wallet: Option<String>,
    #[serde(rename = "webhookURL")]
    pub webhook_url: String,
    #[serde(rename = "accountAddresses", default)]
    pub account_addresses: Vec<String>,
    #[serde(rename = "transactionTypes", default)]
    pub transaction_types: Vec<String>,
    #[serde(rename = "webhookType", default)]
    pub webhook_type: String,
    #[serde(rename = "authHeader", default)]
    pub auth_header: Option<String>,
}

/// Body for `PUT /v0/webhooks/:id`. We only ever touch the address list +
/// transaction types; everything else stays whatever the admin configured
/// when they created the webhook in the Helius dashboard.
#[derive(Debug, Clone, Serialize)]
struct UpdateWebhookBody<'a> {
    #[serde(rename = "webhookURL")]
    webhook_url: &'a str,
    #[serde(rename = "transactionTypes")]
    transaction_types: &'a [&'a str],
    #[serde(rename = "accountAddresses")]
    account_addresses: &'a [String],
    #[serde(rename = "webhookType")]
    webhook_type: &'a str,
    #[serde(rename = "authHeader", skip_serializing_if = "Option::is_none")]
    auth_header: Option<&'a str>,
}

/// Helius client scoped to one webhook ID. Construct via `Helius::new`,
/// returns `None` when Helius isn't configured (so callers can branch
/// without sprinkling env checks everywhere).
pub struct Helius<'a> {
    client: &'a reqwest::Client,
    api_key: &'a str,
    webhook_id: &'a str,
    auth_header: &'a str,
}

impl<'a> Helius<'a> {
    pub fn new(client: &'a reqwest::Client, config: &'a Config) -> Option<Self> {
        Some(Self {
            client,
            api_key: config.helius_api_key.as_deref()?,
            webhook_id: config.helius_webhook_id.as_deref()?,
            auth_header: config.helius_webhook_auth.as_deref()?,
        })
    }

    fn url(&self, suffix: &str) -> String {
        format!("{HELIUS_BASE}{suffix}?api-key={key}", key = self.api_key)
    }

    /// `GET /v0/webhooks/:id` — fetch current state. Cheap; cache on call site.
    pub async fn get(&self) -> AppResult<HeliusWebhook> {
        let url = self.url(&format!("/webhooks/{}", self.webhook_id));
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("helius get: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!("helius get {status}: {body}")));
        }
        resp.json::<HeliusWebhook>()
            .await
            .map_err(|e| AppError::Internal(format!("helius decode: {e}")))
    }

    /// `PUT /v0/webhooks/:id` — replace the address list wholesale. Used by
    /// the startup reconcile to set the canonical list from the DB.
    pub async fn set_addresses(&self, addresses: &[String]) -> AppResult<()> {
        let current = self.get().await?;
        let webhook_url = current.webhook_url;
        // Default to the broad transaction-type set if the admin didn't pick
        // any in the dashboard. "ANY" tells Helius to deliver every tx
        // category — we use the webhookType="enhanced" to still get parsed
        // payloads.
        let tx_types: Vec<&str> = if current.transaction_types.is_empty() {
            vec!["ANY"]
        } else {
            current
                .transaction_types
                .iter()
                .map(String::as_str)
                .collect()
        };
        let webhook_type = if current.webhook_type.is_empty() {
            "enhanced"
        } else {
            current.webhook_type.as_str()
        };
        let body = UpdateWebhookBody {
            webhook_url: &webhook_url,
            transaction_types: &tx_types,
            account_addresses: addresses,
            webhook_type,
            auth_header: Some(self.auth_header),
        };
        let url = self.url(&format!("/webhooks/{}", self.webhook_id));
        let resp = self
            .client
            .put(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("helius put: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!("helius put {status}: {body}")));
        }
        Ok(())
    }

    /// Idempotent add — fetches the current address list, adds `address`
    /// if absent, then PUTs the union back. Safe to call on every agent
    /// create even if the address is already watched (no-op then).
    pub async fn add_address(&self, address: &str) -> AppResult<()> {
        let mut current = self.get().await?;
        if current.account_addresses.iter().any(|a| a == address) {
            return Ok(());
        }
        current.account_addresses.push(address.to_string());
        self.set_addresses(&current.account_addresses).await
    }

    /// Idempotent remove. No-op when the address isn't in the list.
    pub async fn remove_address(&self, address: &str) -> AppResult<()> {
        let mut current = self.get().await?;
        let before = current.account_addresses.len();
        current.account_addresses.retain(|a| a != address);
        if current.account_addresses.len() == before {
            return Ok(());
        }
        self.set_addresses(&current.account_addresses).await
    }
}

// ─── Inbound: enhanced transaction payload ──────────────────────────────
//
// Helius posts an array of these to our `/v1/webhooks/helius` endpoint.
// We only deserialize the fields we actually consume — Helius adds new
// fields regularly and `#[serde(default)]` keeps us forward-compatible.

#[derive(Debug, Clone, Deserialize)]
pub struct EnhancedTx {
    /// Solana tx signature. Acts as the idempotency key for inserts.
    pub signature: String,
    /// Block slot.
    #[serde(default)]
    pub slot: Option<u64>,
    /// Block time as a unix timestamp (seconds).
    #[serde(default)]
    pub timestamp: Option<i64>,
    /// Helius classification — TRANSFER, SWAP, NFT_SALE, etc.
    #[serde(rename = "type", default)]
    pub tx_type: String,
    /// Originating program (Jupiter, Magic Eden, SYSTEM_PROGRAM, ...).
    #[serde(default)]
    pub source: String,
    /// Human-readable summary Helius synthesizes (e.g.
    /// "9xQz...7nFp transferred 0.42 USDC to BvJk...zxc"). Lets us show
    /// rich feed copy without re-deriving.
    #[serde(default)]
    pub description: String,
    #[serde(rename = "feePayer", default)]
    pub fee_payer: String,
    #[serde(rename = "nativeTransfers", default)]
    pub native_transfers: Vec<NativeTransfer>,
    #[serde(rename = "tokenTransfers", default)]
    pub token_transfers: Vec<TokenTransfer>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativeTransfer {
    #[serde(rename = "fromUserAccount")]
    pub from_user_account: String,
    #[serde(rename = "toUserAccount")]
    pub to_user_account: String,
    /// Lamports.
    pub amount: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenTransfer {
    #[serde(rename = "fromUserAccount", default)]
    pub from_user_account: String,
    #[serde(rename = "toUserAccount", default)]
    pub to_user_account: String,
    #[serde(rename = "tokenAmount", default)]
    pub token_amount: f64,
    /// USDC's raw atomic amount = tokenAmount * 10^decimals. We round to
    /// micro-USDC (6 decimals) for storage so this matches `/pay/sync`'s
    /// units exactly.
    #[serde(rename = "rawTokenAmount", default)]
    pub raw_token_amount: Option<RawTokenAmount>,
    #[serde(default)]
    pub mint: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawTokenAmount {
    #[serde(rename = "tokenAmount", default)]
    pub token_amount: String,
    #[serde(default)]
    pub decimals: u8,
}

/// A row we plan to insert into `payment_transactions`. The receiver
/// builds one per relevant transfer per agent wallet. `signature +
/// agent_wallet_id` could clash for batched transfers; the DB constraint
/// is only on signature, so for now a single Helius tx maps to at most
/// one row per agent wallet (we pick the largest USDC delta).
#[derive(Debug)]
pub struct DerivedTransfer {
    pub agent_wallet_address: String,
    pub direction: &'static str, // "send" | "receive"
    pub currency: &'static str,  // "usdc" | "sol"
    pub amount_micro: i64,
    pub counterparty: String,
    pub signature: String,
    pub helius_type: String,
    pub helius_source: String,
    pub description: String,
    pub slot: Option<i64>,
    pub block_time: Option<DateTime<Utc>>,
}

/// Walk one Helius tx and yield every transfer that touches one of the
/// watched agent addresses. We prefer USDC over SOL: if the same tx has
/// both a USDC and a SOL leg touching the same wallet, the USDC leg wins
/// (this is the SWAP case — user spends SOL, gets USDC; we record the
/// USDC receipt as the meaningful event for the feed).
pub fn derive_transfers(tx: &EnhancedTx, watched: &[String]) -> Vec<DerivedTransfer> {
    let mut out: Vec<DerivedTransfer> = Vec::new();
    let block_time = tx
        .timestamp
        .and_then(|ts| DateTime::<Utc>::from_timestamp(ts, 0));

    // Token transfers first so they win the "one row per agent" rule when
    // we dedupe below.
    for tt in &tx.token_transfers {
        if !is_usdc_mint(&tt.mint) {
            continue;
        }
        let amount_micro =
            micro_from_raw(tt).unwrap_or_else(|| (tt.token_amount * 1_000_000.0) as i64);
        if amount_micro == 0 {
            continue;
        }
        if watched.iter().any(|a| a == &tt.to_user_account) {
            out.push(DerivedTransfer {
                agent_wallet_address: tt.to_user_account.clone(),
                direction: "receive",
                currency: "usdc",
                amount_micro,
                counterparty: tt.from_user_account.clone(),
                signature: tx.signature.clone(),
                helius_type: tx.tx_type.clone(),
                helius_source: tx.source.clone(),
                description: tx.description.clone(),
                slot: tx.slot.map(|s| s as i64),
                block_time,
            });
        }
        if watched.iter().any(|a| a == &tt.from_user_account) {
            out.push(DerivedTransfer {
                agent_wallet_address: tt.from_user_account.clone(),
                direction: "send",
                currency: "usdc",
                amount_micro,
                counterparty: tt.to_user_account.clone(),
                signature: tx.signature.clone(),
                helius_type: tx.tx_type.clone(),
                helius_source: tx.source.clone(),
                description: tx.description.clone(),
                slot: tx.slot.map(|s| s as i64),
                block_time,
            });
        }
    }

    // Native SOL transfers — only record if no USDC leg already touches
    // the same wallet in this tx (SWAP case described above).
    for nt in &tx.native_transfers {
        if nt.amount == 0 {
            continue;
        }
        let lamports = nt.amount.abs();
        if watched.iter().any(|a| a == &nt.to_user_account)
            && !out
                .iter()
                .any(|d| d.agent_wallet_address == nt.to_user_account)
        {
            out.push(DerivedTransfer {
                agent_wallet_address: nt.to_user_account.clone(),
                direction: "receive",
                currency: "sol",
                amount_micro: lamports,
                counterparty: nt.from_user_account.clone(),
                signature: tx.signature.clone(),
                helius_type: tx.tx_type.clone(),
                helius_source: tx.source.clone(),
                description: tx.description.clone(),
                slot: tx.slot.map(|s| s as i64),
                block_time,
            });
        }
        if watched.iter().any(|a| a == &nt.from_user_account)
            && !out
                .iter()
                .any(|d| d.agent_wallet_address == nt.from_user_account)
        {
            out.push(DerivedTransfer {
                agent_wallet_address: nt.from_user_account.clone(),
                direction: "send",
                currency: "sol",
                amount_micro: lamports,
                counterparty: nt.to_user_account.clone(),
                signature: tx.signature.clone(),
                helius_type: tx.tx_type.clone(),
                helius_source: tx.source.clone(),
                description: tx.description.clone(),
                slot: tx.slot.map(|s| s as i64),
                block_time,
            });
        }
    }
    out
}

fn micro_from_raw(tt: &TokenTransfer) -> Option<i64> {
    let raw = tt.raw_token_amount.as_ref()?;
    let amount: u128 = raw.token_amount.parse().ok()?;
    // Convert atomic amount → micro-USDC (always 6 decimals for storage).
    // For USDC this is already 1:1; for any other 6-decimal SPL it's
    // also 1:1; for tokens with different decimals we scale here.
    let target_decimals = 6u32;
    let micro = if raw.decimals as u32 == target_decimals {
        amount
    } else if (raw.decimals as u32) > target_decimals {
        amount / 10u128.pow(raw.decimals as u32 - target_decimals)
    } else {
        amount * 10u128.pow(target_decimals - raw.decimals as u32)
    };
    // Saturating cast — payment_transactions.amount is i64.
    Some(micro.min(i64::MAX as u128) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(
        token_transfers: Vec<TokenTransfer>,
        native_transfers: Vec<NativeTransfer>,
    ) -> EnhancedTx {
        EnhancedTx {
            signature: "sig1".into(),
            slot: None,
            timestamp: None,
            tx_type: "TRANSFER".into(),
            source: "SYSTEM_PROGRAM".into(),
            description: "desc".into(),
            fee_payer: "fp".into(),
            native_transfers,
            token_transfers,
        }
    }

    fn tt(from: &str, to: &str, mint: &str, raw: &str, decimals: u8) -> TokenTransfer {
        TokenTransfer {
            from_user_account: from.into(),
            to_user_account: to.into(),
            token_amount: 0.0,
            raw_token_amount: Some(RawTokenAmount {
                token_amount: raw.into(),
                decimals,
            }),
            mint: mint.into(),
        }
    }

    fn nt(from: &str, to: &str, amount: i64) -> NativeTransfer {
        NativeTransfer {
            from_user_account: from.into(),
            to_user_account: to.into(),
            amount,
        }
    }

    #[test]
    fn usdc_receive_only() {
        let t = tx(vec![tt("X", "A", USDC_MINT_MAINNET, "500000", 6)], vec![]);
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].direction, "receive");
        assert_eq!(out[0].currency, "usdc");
        assert_eq!(out[0].amount_micro, 500_000);
        assert_eq!(out[0].agent_wallet_address, "A");
    }

    #[test]
    fn usdc_send_only() {
        let t = tx(vec![tt("A", "X", USDC_MINT_MAINNET, "1000000", 6)], vec![]);
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].direction, "send");
        assert_eq!(out[0].currency, "usdc");
        assert_eq!(out[0].amount_micro, 1_000_000);
    }

    #[test]
    fn swap_sol_to_usdc_usdc_wins() {
        let t = tx(
            vec![tt("Pool", "A", USDC_MINT_MAINNET, "2000000", 6)],
            vec![nt("A", "Pool", 100_000_000)],
        );
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].currency, "usdc");
        assert_eq!(out[0].direction, "receive");
        assert_eq!(out[0].amount_micro, 2_000_000);
    }

    #[test]
    fn sol_only_receive() {
        let t = tx(vec![], vec![nt("X", "A", 12_345_678)]);
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].currency, "sol");
        assert_eq!(out[0].direction, "receive");
        assert_eq!(out[0].amount_micro, 12_345_678);
    }

    #[test]
    fn non_usdc_token_dropped() {
        let t = tx(
            vec![tt(
                "X",
                "A",
                "SomeRandomMint1111111111111111111111111111",
                "1000000",
                6,
            )],
            vec![],
        );
        let out = derive_transfers(&t, &["A".to_string()]);
        assert!(out.is_empty());
    }

    #[test]
    fn two_watched_addresses_one_transfer() {
        let t = tx(vec![tt("A", "B", USDC_MINT_MAINNET, "750000", 6)], vec![]);
        let mut out = derive_transfers(&t, &["A".to_string(), "B".to_string()]);
        assert_eq!(out.len(), 2);
        out.sort_by_key(|d| d.direction);
        // "receive" < "send" lexicographically
        assert_eq!(out[0].direction, "receive");
        assert_eq!(out[0].agent_wallet_address, "B");
        assert_eq!(out[1].direction, "send");
        assert_eq!(out[1].agent_wallet_address, "A");
    }

    #[test]
    fn raw_amount_decimals_6() {
        let t = tx(vec![tt("X", "A", USDC_MINT_MAINNET, "1000000", 6)], vec![]);
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out[0].amount_micro, 1_000_000);
    }

    #[test]
    fn raw_amount_decimals_9_scaled_down() {
        let t = tx(
            vec![tt("X", "A", USDC_MINT_MAINNET, "1000000000", 9)],
            vec![],
        );
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out[0].amount_micro, 1_000_000);
    }

    #[test]
    fn raw_amount_decimals_4_scaled_up() {
        let t = tx(vec![tt("X", "A", USDC_MINT_MAINNET, "10000", 4)], vec![]);
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out[0].amount_micro, 1_000_000);
    }

    #[test]
    fn devnet_usdc_mint_recognized() {
        let t = tx(vec![tt("X", "A", USDC_MINT_DEVNET, "500000", 6)], vec![]);
        let out = derive_transfers(&t, &["A".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].currency, "usdc");
    }

    #[test]
    fn zero_amount_dropped() {
        let t = tx(
            vec![tt("X", "A", USDC_MINT_MAINNET, "0", 6)],
            vec![nt("Y", "A", 0)],
        );
        let out = derive_transfers(&t, &["A".to_string()]);
        assert!(out.is_empty());
    }

    #[test]
    fn is_usdc_mint_direct() {
        assert!(is_usdc_mint(USDC_MINT_MAINNET));
        assert!(is_usdc_mint(USDC_MINT_DEVNET));
        assert!(!is_usdc_mint("So11111111111111111111111111111111111111112"));
    }
}
