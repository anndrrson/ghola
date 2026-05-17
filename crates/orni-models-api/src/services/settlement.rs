use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use uuid::Uuid;

use crate::state::AppState;

/// Phase 4.5: time-batched + denomination-normalized settlement.
///
/// Default cadence is 6h with ±5min jitter — the cadence is what hides the
/// link between an individual user payment and the on-chain transfer to the
/// creator (an observer can no longer say "this batch is the user paying X
/// at 3:42:17"). Per-payout amounts are rounded down to the nearest $0.10
/// at settlement time and the rounding remainder rolls back into the
/// creator's balance for the next batch.
pub async fn settlement_loop(state: Arc<AppState>) {
    let interval_secs: u64 = std::env::var("SETTLEMENT_INTERVAL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(21_600); // 6h
    let jitter_max_secs: u64 = std::env::var("SETTLEMENT_JITTER_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300); // ±5min

    loop {
        let jitter = rand::thread_rng().gen_range(0..=jitter_max_secs);
        tokio::time::sleep(Duration::from_secs(interval_secs.saturating_sub(jitter_max_secs / 2) + jitter)).await;

        if state.escrow_keypair.is_none() {
            continue;
        }
        if let Err(e) = process_settlements(&state).await {
            tracing::error!("Settlement error: {e}");
        }
    }
}

/// Round a per-creator-per-currency total down to the nearest $0.10
/// (= 100_000 micro-units for 6-decimal stables). Returns (round_amount, remainder).
fn round_to_dime(total: i64) -> (i64, i64) {
    const DIME_MICRO: i64 = 100_000;
    let rounded = (total / DIME_MICRO) * DIME_MICRO;
    let remainder = total - rounded;
    (rounded, remainder)
}

#[cfg(test)]
mod tests {
    use super::round_to_dime;

    #[test]
    fn rounds_down_to_nearest_dime() {
        assert_eq!(round_to_dime(423_700), (400_000, 23_700));
        assert_eq!(round_to_dime(5_000_000), (5_000_000, 0));
        assert_eq!(round_to_dime(50_000), (0, 50_000));
        assert_eq!(round_to_dime(0), (0, 0));
    }

    #[test]
    fn rounding_remainder_invariant() {
        for total in [1_i64, 99_999, 100_000, 100_001, 12_345_678, 987_654_321] {
            let (rounded, remainder) = round_to_dime(total);
            assert_eq!(rounded + remainder, total);
            assert!(remainder >= 0 && remainder < 100_000);
            assert_eq!(rounded % 100_000, 0);
        }
    }
}

async fn process_settlements(state: &AppState) -> anyhow::Result<()> {
    // Batch pending payouts by (creator_wallet, currency). Each batch becomes
    // a single on-chain transfer in the matching SPL token.
    //
    // Phase 3.5: rows in `approval_status = 'pending'` are large-withdrawal
    // requests waiting for a second admin to approve them. We skip those here;
    // the admin approval flow flips approval_status to 'approved'.
    let pending: Vec<(String, String, i64)> = sqlx::query_as(
        r#"SELECT creator_wallet, currency, SUM(amount_micro_usdc)::BIGINT as total
           FROM settlement_queue
           WHERE status = 'pending'
             AND creator_wallet IS NOT NULL AND creator_wallet != ''
             AND approval_status IN ('auto', 'approved')
           GROUP BY creator_wallet, currency"#,
    )
    .fetch_all(&state.db)
    .await?;

    if pending.is_empty() {
        return Ok(());
    }

    tracing::info!("Processing {} settlement batches", pending.len());

    let keypair_bytes = state.escrow_keypair.as_ref().unwrap();
    let client = said_solana::SolanaClient::new(&state.config.solana_rpc_url, keypair_bytes)
        .map_err(|e| anyhow::anyhow!("Failed to create Solana client: {e}"))?;

    for (wallet, currency, total) in &pending {
        if *total <= 0 {
            continue;
        }

        // Skip currencies that have been paused (e.g., during a depeg event).
        // Paused-currency rows stay in 'pending' and resume on next tick once
        // the pause is lifted.
        let token = match state.config.find_token(currency) {
            Some(t) => t.clone(),
            None => {
                tracing::warn!(
                    currency = %currency,
                    "Settlement skipped: currency not accepted or paused"
                );
                continue;
            }
        };

        // Phase 4.5: round down to nearest $0.10. The rounding remainder
        // does not get sent on-chain — it credits back to the creator's
        // currency_balances so it accumulates into the next batch. Result:
        // every on-chain payout is a "round" amount (e.g. $4.20, $11.30),
        // breaking the fingerprint between specific user payments and the
        // exact creator transfer.
        let (rounded_total, remainder) = round_to_dime(*total);
        if rounded_total == 0 {
            // Whole batch is below the rounding floor — skip until it grows.
            continue;
        }

        let wallet_bytes: [u8; 32] = match bs58::decode(wallet).into_vec() {
            Ok(v) if v.len() == 32 => v.try_into().unwrap(),
            _ => {
                tracing::warn!("Invalid wallet address: {wallet}, skipping");
                sqlx::query(
                    "UPDATE settlement_queue SET status = 'failed' WHERE creator_wallet = $1 AND currency = $2 AND status = 'pending'",
                )
                .bind(wallet)
                .bind(currency)
                .execute(&state.db)
                .await?;
                continue;
            }
        };

        let mint_bytes: [u8; 32] = match bs58::decode(&token.mint_b58).into_vec() {
            Ok(v) if v.len() == 32 => v.try_into().unwrap(),
            _ => {
                tracing::error!(
                    currency = %currency,
                    mint = %token.mint_b58,
                    "Settlement aborted: configured mint is not a valid base58 pubkey"
                );
                continue;
            }
        };

        // Mark this (wallet, currency) batch as processing so concurrent
        // settlement-loop iterations can't double-spend it.
        sqlx::query(
            "UPDATE settlement_queue SET status = 'processing' WHERE creator_wallet = $1 AND currency = $2 AND status = 'pending'",
        )
        .bind(wallet)
        .bind(currency)
        .execute(&state.db)
        .await?;

        match client
            .transfer_token(&wallet_bytes, &mint_bytes, rounded_total as u64, token.decimals)
            .await
        {
            Ok(tx_sig) => {
                tracing::info!(
                    wallet = %wallet,
                    currency = %currency,
                    amount = rounded_total,
                    remainder = remainder,
                    tx = %tx_sig,
                    "Settlement sent (denom-rounded; remainder rolled to next batch)"
                );
                sqlx::query(
                    "UPDATE settlement_queue SET status = 'settled', tx_signature = $1, settled_at = NOW() WHERE creator_wallet = $2 AND currency = $3 AND status = 'processing'",
                )
                .bind(&tx_sig)
                .bind(wallet)
                .bind(currency)
                .execute(&state.db)
                .await?;

                // Re-credit the rounding remainder back into the creator's
                // currency_balances so it can join the next batch. Use the
                // creator's user_id (looked up from the wallet).
                if remainder > 0 {
                    let creator_id: Option<Uuid> = sqlx::query_scalar(
                        "SELECT id FROM users WHERE wallet_address = $1",
                    )
                    .bind(wallet)
                    .fetch_optional(&state.db)
                    .await?;
                    if let Some(uid) = creator_id {
                        crate::services::balances::credit(&state.db, uid, currency, remainder)
                            .await
                            .ok();
                    }
                }
            }
            Err(e) => {
                tracing::error!(wallet = %wallet, currency = %currency, error = %e, "Settlement transfer failed");
                sqlx::query(
                    "UPDATE settlement_queue SET status = 'pending' WHERE creator_wallet = $1 AND currency = $2 AND status = 'processing'",
                )
                .bind(wallet)
                .bind(currency)
                .execute(&state.db)
                .await?;
            }
        }
    }

    Ok(())
}
