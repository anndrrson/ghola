//! Inbound Helius webhook receiver.
//!
//! Helius posts a JSON array of enhanced transactions to this endpoint
//! whenever any watched agent wallet is touched on-chain. We:
//!   1. Verify the `Authorization` header matches `HELIUS_WEBHOOK_AUTH`.
//!   2. Pull every active `agent_wallets.solana_address` once for the
//!      batch (used to filter transfers that aren't ours).
//!   3. For each transaction, derive every relevant transfer (USDC first,
//!      SOL fallback) and insert a `payment_transactions` row,
//!      idempotently on `signature` (UNIQUE constraint).
//!
//! Failure modes:
//!   • 401 if auth header is missing / wrong — Helius will not retry an
//!     auth failure, so this only fires when config drifts.
//!   • 503 when Helius isn't configured locally — same code that 401s,
//!     so a misconfigured prod env doesn't silently swallow events.
//!   • Per-row DB errors are logged + skipped; we still 200 the batch
//!     so Helius doesn't keep retrying the entire payload over one bad
//!     row. The UNIQUE(signature) constraint handles duplicate deliveries.

use crate::error::AppError;
use crate::helius::{derive_transfers, EnhancedTx};
use crate::state::AppState;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

pub async fn ingest_helius(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(batch): Json<Vec<EnhancedTx>>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    // ── Auth: shared-secret in `Authorization` header ────────────────
    let expected = state
        .config
        .helius_webhook_auth
        .as_deref()
        .ok_or_else(|| AppError::Internal("helius webhook auth not configured".into()))?;
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if presented != expected {
        return Err(AppError::Unauthorized("invalid helius auth header".into()));
    }

    // ── Snapshot the active watchlist so we can map address → row ───
    // Wallets that have been archived since Helius queued the delivery
    // are silently dropped — we don't want to record activity for a
    // wallet that no longer belongs to any agent.
    #[derive(sqlx::FromRow)]
    struct WalletRow {
        id: Uuid,
        user_id: Uuid,
        label: String,
        solana_address: String,
    }
    let wallets: Vec<WalletRow> = sqlx::query_as(
        "SELECT id, user_id, label, solana_address FROM agent_wallets WHERE active = true",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Internal(format!("wallets fetch: {e}")))?;
    let addresses: Vec<String> = wallets.iter().map(|w| w.solana_address.clone()).collect();

    let mut inserted = 0u32;
    let mut skipped = 0u32;

    for tx in &batch {
        for d in derive_transfers(tx, &addresses) {
            let Some(wallet) = wallets
                .iter()
                .find(|w| w.solana_address == d.agent_wallet_address)
            else {
                skipped += 1;
                continue;
            };
            // Idempotent on signature. We rely on the UNIQUE(signature)
            // index to no-op on duplicates rather than checking first —
            // saves a round-trip on the happy path. NULL columns from
            // /pay/sync are upgraded on the next Helius delivery via
            // COALESCE in the update branch.
            let res = sqlx::query(
                r#"
                INSERT INTO payment_transactions
                    (user_id, agent_wallet_id, agent_label, direction, currency, amount,
                     recipient, sender, signature, status,
                     helius_type, helius_source, description, slot, block_time)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', $10, $11, $12, $13, $14)
                ON CONFLICT (signature) DO UPDATE SET
                    helius_type   = COALESCE(payment_transactions.helius_type,   EXCLUDED.helius_type),
                    helius_source = COALESCE(payment_transactions.helius_source, EXCLUDED.helius_source),
                    description   = COALESCE(payment_transactions.description,   EXCLUDED.description),
                    slot          = COALESCE(payment_transactions.slot,          EXCLUDED.slot),
                    block_time    = COALESCE(payment_transactions.block_time,    EXCLUDED.block_time),
                    status        = 'confirmed'
                "#,
            )
            .bind(wallet.user_id)
            .bind(wallet.id)
            .bind(&wallet.label)
            .bind(d.direction)
            .bind(d.currency)
            .bind(d.amount_micro)
            .bind(if d.direction == "receive" { &d.agent_wallet_address } else { &d.counterparty })
            .bind(if d.direction == "receive" { &d.counterparty } else { &d.agent_wallet_address })
            .bind(&d.signature)
            .bind(&d.helius_type)
            .bind(&d.helius_source)
            .bind(&d.description)
            .bind(d.slot)
            .bind(d.block_time)
            .execute(&state.db)
            .await;
            match res {
                Ok(_) => inserted += 1,
                Err(e) => {
                    tracing::warn!(
                        signature = %d.signature,
                        wallet = %wallet.solana_address,
                        "helius insert failed: {e}"
                    );
                    skipped += 1;
                }
            }
        }
    }

    tracing::info!(
        batch_size = batch.len(),
        inserted,
        skipped,
        "helius batch processed"
    );

    Ok((
        StatusCode::OK,
        Json(json!({ "inserted": inserted, "skipped": skipped })),
    ))
}
