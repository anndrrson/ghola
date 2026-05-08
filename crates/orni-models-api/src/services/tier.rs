//! Phase 4.6: tiered compliance lane.
//!
//! Two tiers:
//!
//! - `default` — privacy-first. Per-user subaddresses (4.1), HMAC'd address
//!   storage (4.3), 30-day audit retention. No KYC. Daily withdrawal cap
//!   from §3.5 applies.
//! - `verified` — full compliance. Sanctions data retained 7 years, identity
//!   attestation tied to SAID, higher per-day limits. Triggered by:
//!   (a) cumulative volume crossing `TIER_PROMOTION_THRESHOLD_USD/month,
//!   (b) any fiat off-ramp request,
//!   (c) any single withdrawal ≥ `TIER_LARGE_WITHDRAWAL_USD`,
//!   (d) explicit user opt-in (e.g., for tax export).
//!
//! Promotion is one-way for now — moving back from verified to default is a
//! manual ops action, not user-initiated, since it implicates audit
//! retention. Demotion isn't built into this module.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Default,
    Verified,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Default => "default",
            Tier::Verified => "verified",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "verified" => Tier::Verified,
            _ => Tier::Default,
        }
    }
}

pub struct PromotionReason {
    pub kind: &'static str,
    pub detail: String,
}

impl PromotionReason {
    pub fn volume(volume_micro: i64) -> Self {
        Self {
            kind: "volume",
            detail: format!(
                "rolling-30d volume ${:.2} crossed promotion threshold",
                (volume_micro as f64) / 1_000_000.0
            ),
        }
    }
    pub fn large_withdrawal(amount_micro: i64) -> Self {
        Self {
            kind: "large_withdrawal",
            detail: format!(
                "single withdrawal ${:.2} >= verified threshold",
                (amount_micro as f64) / 1_000_000.0
            ),
        }
    }
    pub fn fiat_offramp() -> Self {
        Self {
            kind: "fiat_offramp",
            detail: "fiat off-ramp requested".into(),
        }
    }
}

/// Read the user's current tier.
pub async fn current_tier(db: &PgPool, user_id: Uuid) -> AppResult<Tier> {
    let raw: Option<String> = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(raw.map(|s| Tier::from_str(&s)).unwrap_or(Tier::Default))
}

/// Compute rolling-30d cumulative volume (deposits + withdrawals) in micro-USD.
async fn rolling_30d_volume(db: &PgPool, user_id: Uuid) -> AppResult<i64> {
    let v: i64 = sqlx::query_scalar(
        r#"SELECT
              COALESCE((SELECT SUM(amount) FROM deposits
                        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'), 0)
            + COALESCE((SELECT SUM(amount_micro_usdc) FROM settlement_queue
                        WHERE requested_by = $1 AND created_at > NOW() - INTERVAL '30 days'
                          AND approval_status != 'rejected'), 0)
        "#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    Ok(v)
}

/// Inspect this user against the promotion triggers and, if any fire, record
/// a `tier_events` row and update `users.tier`. Idempotent — calling for an
/// already-verified user is a no-op.
pub async fn check_and_promote(
    db: &PgPool,
    user_id: Uuid,
    explicit_reason: Option<PromotionReason>,
) -> AppResult<Tier> {
    let current = current_tier(db, user_id).await?;
    if current == Tier::Verified {
        return Ok(current);
    }

    let promotion_threshold_micro: i64 = std::env::var("TIER_PROMOTION_THRESHOLD_USD")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1_000)
        * 1_000_000;

    // Either an explicit trigger or the rolling-volume threshold.
    let reason = if let Some(r) = explicit_reason {
        Some(r)
    } else {
        let v = rolling_30d_volume(db, user_id).await?;
        if v >= promotion_threshold_micro {
            Some(PromotionReason::volume(v))
        } else {
            None
        }
    };

    let Some(reason) = reason else {
        return Ok(current);
    };

    sqlx::query("UPDATE users SET tier = 'verified' WHERE id = $1 AND tier != 'verified'")
        .bind(user_id)
        .execute(db)
        .await?;

    sqlx::query(
        r#"INSERT INTO tier_events (id, user_id, from_tier, to_tier, reason)
           VALUES ($1, $2, $3, 'verified', $4)"#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(current.as_str())
    .bind(format!("{}: {}", reason.kind, reason.detail))
    .execute(db)
    .await?;

    tracing::info!(
        user_id = %user_id,
        from = %current.as_str(),
        to = "verified",
        reason = %reason.kind,
        "Tier promoted"
    );

    Ok(Tier::Verified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_round_trips_through_strings() {
        for t in [Tier::Default, Tier::Verified] {
            assert_eq!(Tier::from_str(t.as_str()), t);
        }
        // Unknown strings collapse to Default — never silently promote.
        assert_eq!(Tier::from_str("anything-else"), Tier::Default);
        assert_eq!(Tier::from_str(""), Tier::Default);
    }

    #[test]
    fn promotion_reasons_carry_typed_kinds() {
        let r = PromotionReason::large_withdrawal(2_500_000_000);
        assert_eq!(r.kind, "large_withdrawal");
        assert!(r.detail.contains("2500"));
        assert_eq!(PromotionReason::fiat_offramp().kind, "fiat_offramp");
        assert_eq!(PromotionReason::volume(1_500_000_000).kind, "volume");
    }
}
