//! In-memory LRU of resolved merchant routes.
//!
//! The hot path cannot afford a DB round-trip per request, but cached routes
//! must still respect revocations (kill switch, rotations). We use dashmap
//! with a short TTL — 30s default. That means a kill-switched merchant stays
//! live for at most 30s after the button is pressed. For anything more urgent,
//! the dashboard can call an explicit invalidation endpoint that evicts by slug.
//!
//! The cache stores the fully-joined row we need for the hot path: route
//! metadata + the raw encrypted credential blob. The [`Vault`] decrypt call
//! still happens on every request — we don't cache plaintext credentials in
//! memory under any circumstances.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use sqlx::PgPool;
use uuid::Uuid;

use said_turnkey::AuthMode;

/// Everything the hot path needs to proxy one request. Assembled once by
/// [`RouteCache::load`] and reused for `ttl` seconds.
#[derive(Clone)]
pub struct ResolvedRoute {
    pub service_id: Uuid,
    pub owner_id: Option<Uuid>,
    pub slug: String,
    pub origin_url: String,
    pub auth_mode: AuthMode,
    pub auth_header_name: Option<String>,
    pub price_micro_usdc: i64,
    pub platform_fee_bps: i32,
    pub proxy_enabled: bool,
    pub circuit_breaker_open: bool,
    pub circuit_breaker_until: Option<chrono::DateTime<chrono::Utc>>,
    pub vault_wallet_address: Option<String>,

    // Credential blob. Empty Vec + AuthMode::None means "no upstream auth".
    pub credential_backend: String,
    pub credential_key_version: i32,
    pub credential_ciphertext: Vec<u8>,
}

struct Entry {
    route: Arc<ResolvedRoute>,
    inserted_at: Instant,
}

pub struct RouteCache {
    map: DashMap<String, Entry>,
    ttl: Duration,
}

impl RouteCache {
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            map: DashMap::new(),
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    /// Resolve a slug to a [`ResolvedRoute`]. Returns `Ok(None)` if the slug
    /// is unknown or proxy-mode is disabled. Callers should translate that to
    /// an HTTP 404.
    pub async fn resolve(
        &self,
        db: &PgPool,
        slug: &str,
    ) -> Result<Option<Arc<ResolvedRoute>>, sqlx::Error> {
        if let Some(entry) = self.map.get(slug) {
            if entry.inserted_at.elapsed() < self.ttl {
                return Ok(Some(entry.route.clone()));
            }
        }

        let row = self.load(db, slug).await?;
        if let Some(route) = row {
            let arc = Arc::new(route);
            self.map.insert(
                slug.to_string(),
                Entry {
                    route: arc.clone(),
                    inserted_at: Instant::now(),
                },
            );
            Ok(Some(arc))
        } else {
            self.map.remove(slug);
            Ok(None)
        }
    }

    /// Evict a slug immediately. Called by the dashboard's kill switch so
    /// merchants don't wait for the TTL.
    pub fn invalidate(&self, slug: &str) {
        self.map.remove(slug);
    }

    async fn load(&self, db: &PgPool, slug: &str) -> Result<Option<ResolvedRoute>, sqlx::Error> {
        let row = sqlx::query_as::<_, RouteRow>(
            r#"
            SELECT
                sl.id AS service_id,
                sl.owner_id,
                sl.slug,
                sl.proxy_origin_url,
                sl.proxy_auth_mode,
                sl.proxy_auth_header_name,
                sl.price_micro_usdc,
                sl.platform_fee_bps,
                sl.proxy_enabled,
                sl.circuit_breaker_open,
                sl.circuit_breaker_until,
                sl.vault_wallet_address,
                mc.vault_backend AS credential_backend,
                mc.key_version AS credential_key_version,
                mc.ciphertext AS credential_ciphertext
            FROM service_listings sl
            LEFT JOIN merchant_credentials mc ON mc.id = sl.merchant_credential_id
            WHERE sl.slug = $1
            "#,
        )
        .bind(slug)
        .fetch_optional(db)
        .await?;

        Ok(row.map(|r| r.into()))
    }
}

#[derive(sqlx::FromRow)]
struct RouteRow {
    service_id: Uuid,
    owner_id: Option<Uuid>,
    slug: String,
    proxy_origin_url: Option<String>,
    proxy_auth_mode: Option<String>,
    proxy_auth_header_name: Option<String>,
    price_micro_usdc: i64,
    platform_fee_bps: i32,
    proxy_enabled: bool,
    circuit_breaker_open: bool,
    circuit_breaker_until: Option<chrono::DateTime<chrono::Utc>>,
    vault_wallet_address: Option<String>,
    credential_backend: Option<String>,
    credential_key_version: Option<i32>,
    credential_ciphertext: Option<Vec<u8>>,
}

impl From<RouteRow> for ResolvedRoute {
    fn from(r: RouteRow) -> Self {
        let auth_mode = r
            .proxy_auth_mode
            .as_deref()
            .and_then(|s| AuthMode::parse(s).ok())
            .unwrap_or(AuthMode::None);

        ResolvedRoute {
            service_id: r.service_id,
            owner_id: r.owner_id,
            slug: r.slug,
            origin_url: r.proxy_origin_url.unwrap_or_default(),
            auth_mode,
            auth_header_name: r.proxy_auth_header_name,
            price_micro_usdc: r.price_micro_usdc,
            platform_fee_bps: r.platform_fee_bps,
            proxy_enabled: r.proxy_enabled,
            circuit_breaker_open: r.circuit_breaker_open,
            circuit_breaker_until: r.circuit_breaker_until,
            vault_wallet_address: r.vault_wallet_address,
            credential_backend: r.credential_backend.unwrap_or_else(|| "none".into()),
            credential_key_version: r.credential_key_version.unwrap_or(0),
            credential_ciphertext: r.credential_ciphertext.unwrap_or_default(),
        }
    }
}
