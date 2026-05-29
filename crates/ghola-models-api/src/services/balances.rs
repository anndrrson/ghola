//! Multi-currency user balance service.
//!
//! Single source of truth for reading and mutating per-user stablecoin balances.
//! Backed by the `currency_balances(user_id, currency, balance)` table; routes
//! must not touch the table directly.

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use ghola_models_types::CurrencyBalance;

/// Read all currency balances for a user. Currencies the user has never held
/// are omitted. Order is the platform's accepted-tokens order so the primary
/// stablecoin appears first in pickers.
pub async fn list_balances(db: &PgPool, config: &Config, user_id: Uuid) -> AppResult<Vec<CurrencyBalance>> {
    let rows: Vec<CurrencyBalance> = sqlx::query_as(
        "SELECT currency, balance FROM currency_balances WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    // Reorder to match config.accepted_tokens (primary first, etc.).
    let mut by_symbol: std::collections::HashMap<String, i64> =
        rows.into_iter().map(|r| (r.currency, r.balance)).collect();
    let mut ordered = Vec::with_capacity(config.accepted_tokens.len());
    for token in &config.accepted_tokens {
        let balance = by_symbol.remove(&token.symbol).unwrap_or(0);
        ordered.push(CurrencyBalance {
            currency: token.symbol.clone(),
            balance,
        });
    }
    // Append any leftover symbols (e.g., a deprecated token the user still holds).
    for (currency, balance) in by_symbol {
        ordered.push(CurrencyBalance { currency, balance });
    }
    Ok(ordered)
}

/// Read a single currency's balance for a user. Returns 0 if no row exists.
pub async fn get_balance(db: &PgPool, user_id: Uuid, currency: &str) -> AppResult<i64> {
    let symbol = currency.to_uppercase();
    let balance: Option<i64> = sqlx::query_scalar(
        "SELECT balance FROM currency_balances WHERE user_id = $1 AND currency = $2",
    )
    .bind(user_id)
    .bind(&symbol)
    .fetch_optional(db)
    .await?;
    Ok(balance.unwrap_or(0))
}

/// Add `amount` to the user's balance in `currency`. Inserts the row if missing.
pub async fn credit(db: &PgPool, user_id: Uuid, currency: &str, amount: i64) -> AppResult<()> {
    if amount <= 0 {
        return Ok(());
    }
    let symbol = currency.to_uppercase();
    sqlx::query(
        r#"INSERT INTO currency_balances (user_id, currency, balance, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, currency) DO UPDATE
           SET balance = currency_balances.balance + EXCLUDED.balance, updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(&symbol)
    .bind(amount)
    .execute(db)
    .await?;
    Ok(())
}

/// Atomically deduct `amount` from the user's balance in `currency`. Returns
/// the new balance on success, or `AppError::InsufficientBalance` if the user
/// did not have enough.
pub async fn debit(db: &PgPool, user_id: Uuid, currency: &str, amount: i64) -> AppResult<i64> {
    if amount <= 0 {
        return get_balance(db, user_id, currency).await;
    }
    let symbol = currency.to_uppercase();
    let new_balance: Option<i64> = sqlx::query_scalar(
        r#"UPDATE currency_balances SET balance = balance - $3, updated_at = NOW()
           WHERE user_id = $1 AND currency = $2 AND balance >= $3
           RETURNING balance"#,
    )
    .bind(user_id)
    .bind(&symbol)
    .bind(amount)
    .fetch_optional(db)
    .await?;
    new_balance.ok_or(AppError::InsufficientBalance)
}

/// Debit `amount` from the user's balance, preferring `preferred_currency` and
/// falling back to other accepted (and non-paused) currencies in the platform's
/// configured order. Returns the currency that was actually debited and the
/// new balance.
///
/// Used by paid routes (chat, openai-compat) where the request doesn't carry
/// an explicit currency and the user just wants to spend whatever they have.
pub async fn debit_preferred(
    db: &PgPool,
    config: &Config,
    user_id: Uuid,
    amount: i64,
    preferred_currency: Option<&str>,
) -> AppResult<(String, i64)> {
    // Build the currency try-order: preferred first, then config order.
    let mut order: Vec<String> = Vec::with_capacity(config.accepted_tokens.len() + 1);
    if let Some(pref) = preferred_currency {
        order.push(pref.to_uppercase());
    }
    for token in &config.accepted_tokens {
        if token.paused {
            continue;
        }
        let s = token.symbol.to_uppercase();
        if !order.contains(&s) {
            order.push(s);
        }
    }

    for currency in &order {
        match debit(db, user_id, currency, amount).await {
            Ok(new_balance) => return Ok((currency.clone(), new_balance)),
            Err(AppError::InsufficientBalance) => continue,
            Err(other) => return Err(other),
        }
    }
    Err(AppError::InsufficientBalance)
}
