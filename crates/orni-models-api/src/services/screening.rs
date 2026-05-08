//! Sanctions / risk screening for incoming deposit addresses.
//!
//! Phase 3.3 of the security plan. Backends (Chainalysis, TRM, Range, custom
//! block-lists) plug in by implementing `Screener`. The default `NoopScreener`
//! allows everything and is the production default until a real backend is
//! wired up — the abstraction lives here so routes can call into it once and
//! we don't have to refactor every deposit path when we add a real backend.
//!
//! Privacy note (Phase 4.4 alignment): the cleartext address is sent to the
//! screening API but never stored. We persist the *hashed* address + the
//! verdict in `screening_blocks`.

use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Result of a screening check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    Blocked { reason: String },
}

/// Backend trait. Implementations must be cheap to call (~100ms) — screen runs
/// inline in the deposit confirmation path.
#[async_trait::async_trait]
pub trait Screener: Send + Sync {
    /// Identifier for the backend (logged + persisted on blocks).
    fn name(&self) -> &'static str;

    /// Screen an address. Network failures should resolve to Allowed by default
    /// to avoid platform-wide deposit outage on a vendor's bad day; the deposit
    /// itself can be re-screened at withdrawal time as a backstop. Implementors
    /// that prefer fail-closed should document that explicitly.
    async fn check(&self, address: &str) -> AppResult<Verdict>;
}

/// Default backend: allows everything. The abstraction is wired up everywhere
/// it needs to be; a real backend can be swapped in by changing the construction
/// site in `state.rs` without touching any route code.
pub struct NoopScreener;

#[async_trait::async_trait]
impl Screener for NoopScreener {
    fn name(&self) -> &'static str {
        "noop"
    }

    async fn check(&self, _address: &str) -> AppResult<Verdict> {
        Ok(Verdict::Allowed)
    }
}

/// Hash a wallet address for storage. SHA-256 truncated to hex; one-way so a
/// DB breach does not reveal the on-chain graph.
pub fn hash_address(address: &str) -> String {
    let h = Sha256::digest(address.as_bytes());
    hex::encode(h)
}

/// Run screening and persist the result if blocked. Returns the verdict; the
/// caller is responsible for refusing the deposit on `Blocked`.
pub async fn screen_and_record(
    db: &PgPool,
    screener: &dyn Screener,
    user_id: Option<Uuid>,
    address: &str,
) -> AppResult<Verdict> {
    let verdict = screener.check(address).await?;
    if let Verdict::Blocked { reason } = &verdict {
        sqlx::query(
            "INSERT INTO screening_blocks (id, user_id, address_hash, backend, reason) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(hash_address(address))
        .bind(screener.name())
        .bind(reason)
        .execute(db)
        .await?;
    }
    Ok(verdict)
}

/// Convenience: screen and immediately convert a Blocked into an `AppError`.
pub async fn enforce(
    db: &PgPool,
    screener: &dyn Screener,
    user_id: Option<Uuid>,
    address: &str,
) -> AppResult<()> {
    match screen_and_record(db, screener, user_id, address).await? {
        Verdict::Allowed => Ok(()),
        Verdict::Blocked { reason } => Err(AppError::Forbidden(format!(
            "Deposit source rejected by risk screening: {}",
            reason
        ))),
    }
}
