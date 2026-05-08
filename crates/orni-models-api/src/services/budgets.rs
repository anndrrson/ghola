//! Spending budgets — pre-charge enforcement.
//!
//! Every debit (chat, openai_compat) calls `check_or_reject` *before* it
//! deducts from `currency_balances`. If the proposed charge would push the
//! user past their daily, monthly, or lifetime cap, we return
//! `BudgetExceeded` and the route translates that into a 402 with structured
//! detail so the client can show a useful "you've hit your limit" message.
//!
//! Defaults (when no `user_budgets` row exists): $50/day, $1000/month, no
//! lifetime cap, enabled. Defaults match the `user_budgets` table column
//! defaults, so a row created at signup (or auto-inserted by the trigger)
//! gives the same answer as a missing row.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const DEFAULT_DAILY_CAP_MICRO: i64 = 50_000_000;       // $50
const DEFAULT_MONTHLY_CAP_MICRO: i64 = 1_000_000_000;  // $1,000

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct Budget {
    pub user_id: Uuid,
    pub daily_cap_micro: i64,
    pub monthly_cap_micro: i64,
    pub total_cap_micro: Option<i64>,
    pub enabled: bool,
}

impl Budget {
    /// The defaults a fresh user gets — also what `check_or_reject` falls
    /// back to when the DB has no row for this user.
    pub fn default_for(user_id: Uuid) -> Self {
        Self {
            user_id,
            daily_cap_micro: DEFAULT_DAILY_CAP_MICRO,
            monthly_cap_micro: DEFAULT_MONTHLY_CAP_MICRO,
            total_cap_micro: None,
            enabled: true,
        }
    }
}

/// Read the user's budget. Returns the defaults if no row exists.
pub async fn get(db: &PgPool, user_id: Uuid) -> AppResult<Budget> {
    let row: Option<Budget> = sqlx::query_as(
        "SELECT user_id, daily_cap_micro, monthly_cap_micro, total_cap_micro, enabled
         FROM user_budgets WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.unwrap_or_else(|| Budget::default_for(user_id)))
}

/// Update (or insert) the user's budget. Caller validates the values.
pub async fn upsert(
    db: &PgPool,
    user_id: Uuid,
    daily_cap_micro: i64,
    monthly_cap_micro: i64,
    total_cap_micro: Option<i64>,
    enabled: bool,
) -> AppResult<Budget> {
    sqlx::query(
        r#"INSERT INTO user_budgets
            (user_id, daily_cap_micro, monthly_cap_micro, total_cap_micro, enabled, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             daily_cap_micro = EXCLUDED.daily_cap_micro,
             monthly_cap_micro = EXCLUDED.monthly_cap_micro,
             total_cap_micro = EXCLUDED.total_cap_micro,
             enabled = EXCLUDED.enabled,
             updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(daily_cap_micro)
    .bind(monthly_cap_micro)
    .bind(total_cap_micro)
    .bind(enabled)
    .execute(db)
    .await?;

    get(db, user_id).await
}

/// What kind of cap was breached. Surfaced in the 402 response so the
/// frontend can show a specific message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapKind {
    Daily,
    Monthly,
    Total,
}

impl CapKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CapKind::Daily => "daily",
            CapKind::Monthly => "monthly",
            CapKind::Total => "total",
        }
    }
}

/// Snapshot of the user's spend across the rolling windows. Used by the
/// settings UI to show "you've used X of Y today".
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpendSnapshot {
    pub day_micro: i64,
    pub month_micro: i64,
    pub total_micro: i64,
}

/// Sum payments over the rolling windows. The whole budget enforcement
/// stack rides on this query staying fast — the schema migration adds
/// `idx_payments_user_created` to keep it indexed.
pub async fn spend_snapshot(db: &PgPool, user_id: Uuid) -> AppResult<SpendSnapshot> {
    let row: (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
        r#"SELECT
              (SELECT SUM(amount)::BIGINT FROM payments
               WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'),
              (SELECT SUM(amount)::BIGINT FROM payments
               WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'),
              (SELECT SUM(amount)::BIGINT FROM payments
               WHERE user_id = $1)"#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    Ok(SpendSnapshot {
        day_micro: row.0.unwrap_or(0),
        month_micro: row.1.unwrap_or(0),
        total_micro: row.2.unwrap_or(0),
    })
}

/// Pre-charge check. If `proposed_amount` would push the user past any
/// active cap, returns `BudgetExceeded`. If budget is disabled or the
/// charge fits, returns `Ok(())`.
///
/// IMPORTANT: this MUST run before debiting `currency_balances`. Running
/// it after means the user has already been charged when we tell them
/// "you're over the cap" — confusing and potentially unrecoverable.
pub async fn check_or_reject(
    db: &PgPool,
    user_id: Uuid,
    proposed_amount: i64,
) -> AppResult<()> {
    if proposed_amount <= 0 {
        return Ok(());
    }
    let budget = get(db, user_id).await?;
    if !budget.enabled {
        return Ok(());
    }
    let snap = spend_snapshot(db, user_id).await?;
    decide(&budget, &snap, proposed_amount)
}

/// Pure decision logic — split out from the DB-touching wrapper so it's
/// trivially unit-testable. Given a budget + current spend snapshot + a
/// proposed charge, return Ok or the specific cap kind that's breached.
pub fn decide(budget: &Budget, snap: &SpendSnapshot, proposed: i64) -> AppResult<()> {
    if !budget.enabled || proposed <= 0 {
        return Ok(());
    }
    if snap.day_micro.saturating_add(proposed) > budget.daily_cap_micro {
        return Err(AppError::BudgetExceeded {
            kind: CapKind::Daily.as_str(),
            limit_micro: budget.daily_cap_micro,
            used_micro: snap.day_micro,
        });
    }
    if snap.month_micro.saturating_add(proposed) > budget.monthly_cap_micro {
        return Err(AppError::BudgetExceeded {
            kind: CapKind::Monthly.as_str(),
            limit_micro: budget.monthly_cap_micro,
            used_micro: snap.month_micro,
        });
    }
    if let Some(total_cap) = budget.total_cap_micro {
        if snap.total_micro.saturating_add(proposed) > total_cap {
            return Err(AppError::BudgetExceeded {
                kind: CapKind::Total.as_str(),
                limit_micro: total_cap,
                used_micro: snap.total_micro,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget(daily: i64, monthly: i64, total: Option<i64>, enabled: bool) -> Budget {
        Budget {
            user_id: Uuid::nil(),
            daily_cap_micro: daily,
            monthly_cap_micro: monthly,
            total_cap_micro: total,
            enabled,
        }
    }

    fn snap(day: i64, month: i64, total: i64) -> SpendSnapshot {
        SpendSnapshot { day_micro: day, month_micro: month, total_micro: total }
    }

    #[test]
    fn under_all_caps_allows() {
        let b = budget(50_000_000, 1_000_000_000, None, true);
        let s = snap(10_000_000, 200_000_000, 500_000_000);
        assert!(decide(&b, &s, 5_000_000).is_ok());
    }

    #[test]
    fn at_exact_daily_cap_allows() {
        // boundary: rolled spend + proposed == cap is OK; > cap rejects.
        let b = budget(50_000_000, 1_000_000_000, None, true);
        let s = snap(45_000_000, 0, 0);
        assert!(decide(&b, &s, 5_000_000).is_ok());
    }

    #[test]
    fn one_over_daily_cap_rejects() {
        let b = budget(50_000_000, 1_000_000_000, None, true);
        let s = snap(45_000_000, 0, 0);
        match decide(&b, &s, 5_000_001) {
            Err(AppError::BudgetExceeded { kind, .. }) => assert_eq!(kind, "daily"),
            other => panic!("expected daily BudgetExceeded, got {other:?}"),
        }
    }

    #[test]
    fn monthly_cap_rejects_even_if_daily_room_exists() {
        let b = budget(50_000_000, 1_000_000_000, None, true);
        // Plenty of daily room, but month is at the cap.
        let s = snap(0, 999_999_999, 0);
        match decide(&b, &s, 100) {
            Err(AppError::BudgetExceeded { kind, .. }) => assert_eq!(kind, "monthly"),
            other => panic!("expected monthly BudgetExceeded, got {other:?}"),
        }
    }

    #[test]
    fn total_cap_rejects() {
        let b = budget(50_000_000, 1_000_000_000, Some(2_000_000_000), true);
        let s = snap(0, 0, 1_999_999_999);
        match decide(&b, &s, 100) {
            Err(AppError::BudgetExceeded { kind, .. }) => assert_eq!(kind, "total"),
            other => panic!("expected total BudgetExceeded, got {other:?}"),
        }
    }

    #[test]
    fn no_total_cap_means_unlimited_lifetime() {
        let b = budget(50_000_000, 1_000_000_000, None, true);
        // Trillion lifetime spend, but no total cap configured.
        let s = snap(0, 0, 1_000_000_000_000);
        assert!(decide(&b, &s, 100).is_ok());
    }

    #[test]
    fn disabled_budget_allows_anything() {
        let b = budget(1, 1, Some(1), false);
        let s = snap(999_999, 999_999, 999_999);
        assert!(decide(&b, &s, 999_999_999).is_ok());
    }

    #[test]
    fn zero_or_negative_proposed_is_noop() {
        let b = budget(50_000_000, 1_000_000_000, Some(2_000_000_000), true);
        // Already over everything — but proposed == 0 means no charge to gate.
        let s = snap(99_999_999, 9_999_999_999, 9_999_999_999_999);
        assert!(decide(&b, &s, 0).is_ok());
        assert!(decide(&b, &s, -100).is_ok());
    }

    #[test]
    fn defaults_match_table_defaults() {
        // If we ever drift the in-code defaults from the SQL column defaults,
        // a missing-row vs. fresh-row user would see different behavior.
        let b = Budget::default_for(Uuid::nil());
        assert_eq!(b.daily_cap_micro, 50_000_000);
        assert_eq!(b.monthly_cap_micro, 1_000_000_000);
        assert_eq!(b.total_cap_micro, None);
        assert!(b.enabled);
    }
}
