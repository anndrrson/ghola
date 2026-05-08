//! Phase 3.3: hot/cold treasury sweep.
//!
//! Background task that periodically moves excess balance from the platform's
//! hot wallet (which signs outbound user-facing transfers) to a cold wallet
//! (which only ever signs to other internal wallets). This bounds the freeze
//! authority's blast radius — if Tether ever freezes the hot wallet, only
//! ~2 weeks of withdrawal volume is exposed; the bulk of platform reserves
//! sit somewhere a freeze can't reach in one hop.
//!
//! Cold wallet is configured via `COLD_WALLET_ADDRESS` env. Reserve target is
//! `HOT_WALLET_RESERVE_DAYS × rolling-7d-mean-daily-volume` per currency.
//! When that value can't be computed (e.g., new deploy with no settled
//! withdrawals yet) we fall back to a static `HOT_WALLET_RESERVE_FLOOR_USD`.

use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;

/// Run the treasury sweep loop. Called once at startup; runs forever.
pub async fn treasury_loop(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(3_600)); // hourly

    loop {
        interval.tick().await;

        if state.escrow_keypair.is_none() {
            continue;
        }
        if std::env::var("COLD_WALLET_ADDRESS")
            .ok()
            .filter(|s| !s.is_empty())
            .is_none()
        {
            // No cold wallet configured — sweep is a no-op.
            continue;
        }

        if let Err(e) = sweep_once(&state).await {
            tracing::error!("Treasury sweep error: {e}");
        }
    }
}

async fn sweep_once(state: &AppState) -> anyhow::Result<()> {
    let cold_wallet = match std::env::var("COLD_WALLET_ADDRESS") {
        Ok(s) if !s.is_empty() => s,
        _ => return Ok(()),
    };

    let reserve_days: i64 = std::env::var("HOT_WALLET_RESERVE_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(14);
    let reserve_floor_micro: i64 = std::env::var("HOT_WALLET_RESERVE_FLOOR_USD")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(5_000)
        * 1_000_000;

    let cold_bytes: [u8; 32] = match bs58::decode(&cold_wallet).into_vec() {
        Ok(v) if v.len() == 32 => v.try_into().unwrap(),
        _ => {
            tracing::error!(
                cold_wallet = %cold_wallet,
                "Treasury sweep aborted: COLD_WALLET_ADDRESS is not a valid base58 pubkey"
            );
            return Ok(());
        }
    };

    let keypair_bytes = state.escrow_keypair.as_ref().unwrap();
    let client = said_solana::SolanaClient::new(&state.config.solana_rpc_url, keypair_bytes)
        .map_err(|e| anyhow::anyhow!("Failed to create Solana client: {e}"))?;
    let hot_wallet = client.payer_pubkey();

    for token in &state.config.accepted_tokens {
        if token.paused {
            continue;
        }

        // Compute reserve target: 7-day mean × reserve_days. Floor at the
        // configured static minimum so we don't sweep ourselves dry.
        let mean_daily_micro: i64 = sqlx::query_scalar(
            r#"SELECT COALESCE(SUM(amount_micro_usdc), 0)::BIGINT / 7
               FROM settlement_queue
               WHERE currency = $1
                 AND status = 'settled'
                 AND settled_at > NOW() - INTERVAL '7 days'"#,
        )
        .bind(&token.symbol)
        .fetch_one(&state.db)
        .await?;
        let target_micro = (mean_daily_micro * reserve_days).max(reserve_floor_micro);

        // Read on-chain hot-wallet ATA balance.
        let mint_bytes: [u8; 32] = match bs58::decode(&token.mint_b58).into_vec() {
            Ok(v) if v.len() == 32 => v.try_into().unwrap(),
            _ => continue,
        };
        let hot_balance = client
            .get_token_balance(&hot_wallet, &mint_bytes)
            .await
            .unwrap_or(0) as i64;

        if hot_balance <= target_micro {
            tracing::debug!(
                currency = %token.symbol,
                hot_balance,
                target_micro,
                "Hot wallet within reserve target; no sweep"
            );
            continue;
        }

        let sweep_amount = hot_balance - target_micro;
        match client
            .transfer_token(&cold_bytes, &mint_bytes, sweep_amount as u64, token.decimals)
            .await
        {
            Ok(tx_sig) => {
                tracing::info!(
                    currency = %token.symbol,
                    amount = sweep_amount,
                    target_reserve = target_micro,
                    tx = %tx_sig,
                    "Treasury sweep: hot → cold"
                );
            }
            Err(e) => {
                tracing::error!(
                    currency = %token.symbol,
                    amount = sweep_amount,
                    error = %e,
                    "Treasury sweep transfer failed"
                );
            }
        }
    }

    Ok(())
}
