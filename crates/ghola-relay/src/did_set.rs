//! # DID set holder — relay-side
//!
//! In-memory cache of the set of registered Ghola DIDs. Polled from
//! thumper-cloud's `GET /v1/did-set` endpoint by a background tokio task
//! at startup (and every [`REFRESH_INTERVAL_SECS`] thereafter).
//!
//! ## Privacy constraint — in-memory only
//!
//! This module **must not** persist the DID set to disk, log it, or
//! ship it anywhere observable. The whole point of Phase 3 is that the
//! relay never learns the user → prompt mapping; if we logged the DID
//! set on a 60-second cadence, an operator with log access could
//! correlate "DID X joined the set at T" with "DID X sent a request at
//! T+5min" and reconstruct the user identity by cross-referencing
//! signup time in the cloud's audit log.
//!
//! We therefore log only the *count* and *digest* of the set when we
//! refresh, never the contents.
//!
//! ## Failure mode
//!
//! If the cloud is unreachable on startup, the holder begins with an
//! empty set and **rejects all sealed inference**. Operators set
//! `GHOLA_CLOUD_DID_SET_URL`/`GHOLA_CLOUD_RELAY_API_KEY` env vars
//! to enable; leaving them unset bypasses the refresh task and the
//! middleware fails closed.
//!
//! Once the first successful fetch lands, subsequent fetch failures
//! are logged but the existing set stays in memory (stale-tolerant,
//! refresh-soft).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use parking_lot_or_std::RwLock;
use serde::Deserialize;

/// How often the relay polls thumper-cloud for a fresh snapshot.
pub const REFRESH_INTERVAL_SECS: u64 = 60;

/// Shape of the JSON response from thumper-cloud's `/v1/did-set` endpoint.
/// Mirrors `crates/thumper-cloud/src/routes/did_snapshot.rs::DidSetSnapshot`.
#[derive(Debug, Deserialize)]
struct WireSnapshot {
    #[allow(dead_code)]
    version: String,
    #[allow(dead_code)]
    count: usize,
    dids: Vec<String>,
    #[allow(dead_code)]
    snapshot_at_unix: i64,
    digest_hex: String,
}

/// Holder for the membership set. Cheap to clone (internally `Arc`).
#[derive(Clone, Default)]
pub struct DidSet {
    inner: Arc<RwLock<DidSetInner>>,
}

#[derive(Default)]
struct DidSetInner {
    set: HashSet<String>,
    /// Last digest fingerprint we logged; used to suppress chatty logs
    /// when the set hasn't changed.
    last_digest: String,
    /// Unix timestamp of the most recent successful refresh, or 0 if
    /// never refreshed.
    last_refresh_unix: i64,
    /// True iff at least one refresh has succeeded.
    bootstrapped: bool,
}

impl DidSet {
    /// Construct an empty holder. Until `replace_from_snapshot` is called
    /// (typically by the background refresh task) `contains` returns
    /// `false` for everything and `is_bootstrapped` returns `false`.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(DidSetInner::default())),
        }
    }

    /// Returns true if the given DID is in the cached set. False on cold
    /// start (before the first successful refresh).
    pub fn contains(&self, did: &str) -> bool {
        let g = self.inner.read();
        g.set.contains(did)
    }

    /// Has the holder been populated at least once?
    pub fn is_bootstrapped(&self) -> bool {
        self.inner.read().bootstrapped
    }

    /// Returns true iff the holder is bootstrapped AND the cached set is
    /// younger than `max_staleness_secs` (where age is measured as
    /// `now_unix - last_refresh_unix`).
    ///
    /// Returns false when:
    ///   - The holder has never been refreshed (cold start).
    ///   - The most recent successful refresh is older than the bound.
    ///
    /// Without this bound, a thumper-cloud outage would leave the relay
    /// serving against an indefinitely stale cache — a DID revoked
    /// cloud-side would keep access until the cloud came back. Callers
    /// should fail closed (reject all requests) when this returns false.
    pub fn is_fresh(&self, now_unix: i64, max_staleness_secs: u64) -> bool {
        let g = self.inner.read();
        if !g.bootstrapped {
            return false;
        }
        // `last_refresh_unix` is monotonically set to "now at refresh
        // time"; if the clock skews backwards `now_unix - last` may go
        // negative — treat that as "fresh" (we just refreshed) rather
        // than fail closed on clock noise.
        let age = now_unix.saturating_sub(g.last_refresh_unix);
        if age < 0 {
            return true;
        }
        (age as u64) < max_staleness_secs
    }

    /// Returns `(count, last_refresh_unix)`. For metrics.
    pub fn stats(&self) -> (usize, i64) {
        let g = self.inner.read();
        (g.set.len(), g.last_refresh_unix)
    }

    /// Test-only: insert a DID directly and mark the holder as
    /// bootstrapped. Used by integration tests that don't want to spin
    /// up a thumper-cloud stub.
    ///
    /// This is intentionally `pub` (not `pub(crate)`) so the
    /// `tests/sealed_auth.rs` integration test can call it. It MUST NOT
    /// be called from production code paths — the only writer in
    /// production is the background refresh task's `replace`.
    pub fn insert_for_test(&self, did: String) {
        let mut g = self.inner.write();
        g.set.insert(did);
        g.bootstrapped = true;
        g.last_refresh_unix = chrono::Utc::now().timestamp();
    }

    fn replace(&self, snapshot: WireSnapshot, now_unix: i64) {
        let mut g = self.inner.write();
        let changed = g.last_digest != snapshot.digest_hex;
        g.set = snapshot.dids.into_iter().collect();
        g.last_digest = snapshot.digest_hex.clone();
        g.last_refresh_unix = now_unix;
        g.bootstrapped = true;
        if changed {
            tracing::info!(
                count = g.set.len(),
                digest = %snapshot.digest_hex,
                "did_set refreshed (changed)"
            );
        } else {
            tracing::debug!(
                count = g.set.len(),
                digest = %snapshot.digest_hex,
                "did_set refreshed (unchanged)"
            );
        }
    }
}

/// Spawn the periodic refresh task. Returns immediately; the task runs
/// until the process exits.
///
/// If `url` is `None` or `api_key` is `None` the task does nothing — the
/// relay is in "did-set disabled" mode and the middleware will fail
/// closed (which is the safe default for a security control).
pub fn spawn_refresh_task(holder: DidSet, url: Option<String>, api_key: Option<String>) {
    let Some(url) = url else {
        tracing::warn!(
            "GHOLA_CLOUD_DID_SET_URL unset — did_set refresh task disabled, \
             sealed-inference auth will reject all requests"
        );
        return;
    };
    let Some(api_key) = api_key else {
        tracing::warn!(
            "GHOLA_CLOUD_RELAY_API_KEY unset — did_set refresh task disabled, \
             sealed-inference auth will reject all requests"
        );
        return;
    };

    tokio::spawn(async move {
        // Immediate first fetch (no leading sleep) so the relay is usable
        // shortly after startup.
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        loop {
            match fetch_once(&client, &url, &api_key).await {
                Ok(snap) => {
                    let now_unix = chrono::Utc::now().timestamp();
                    holder.replace(snap, now_unix);
                }
                Err(e) => {
                    if holder.is_bootstrapped() {
                        tracing::warn!("did_set refresh failed; keeping previous snapshot: {e}");
                    } else {
                        tracing::error!(
                            "did_set initial fetch failed: {e}. \
                             Sealed-inference will reject until first success."
                        );
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(REFRESH_INTERVAL_SECS)).await;
        }
    });
}

async fn fetch_once(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Result<WireSnapshot, String> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|e| format!("did_set HTTP error: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("did_set HTTP {status}: {body}"));
    }

    let snap: WireSnapshot = resp
        .json()
        .await
        .map_err(|e| format!("did_set decode error: {e}"))?;
    Ok(snap)
}

// -- tiny std-only RwLock wrapper -----------------------------------------
//
// We don't depend on `parking_lot` in this crate, but the std `RwLock`
// API matches close enough. Stub module so `use parking_lot_or_std::RwLock`
// resolves to `std::sync::RwLock` with simplified poison handling.
mod parking_lot_or_std {
    use std::sync::RwLock as StdRwLock;
    use std::sync::RwLockReadGuard;
    use std::sync::RwLockWriteGuard;

    pub struct RwLock<T>(StdRwLock<T>);

    impl<T> RwLock<T> {
        pub fn new(t: T) -> Self {
            Self(StdRwLock::new(t))
        }
        pub fn read(&self) -> RwLockReadGuard<'_, T> {
            self.0.read().unwrap_or_else(|e| e.into_inner())
        }
        pub fn write(&self) -> RwLockWriteGuard<'_, T> {
            self.0.write().unwrap_or_else(|e| e.into_inner())
        }
    }

    impl<T: Default> Default for RwLock<T> {
        fn default() -> Self {
            Self::new(T::default())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_set_rejects_everything() {
        let s = DidSet::new();
        assert!(!s.contains("did:key:zSomeone"));
        assert!(!s.is_bootstrapped());
    }

    #[test]
    fn is_fresh_false_when_not_bootstrapped() {
        let s = DidSet::new();
        assert!(!s.is_fresh(1_000_000, 300));
    }

    #[test]
    fn is_fresh_true_within_window() {
        let s = DidSet::new();
        let snap = WireSnapshot {
            version: "v1".into(),
            count: 0,
            dids: vec![],
            snapshot_at_unix: 0,
            digest_hex: "d".into(),
        };
        s.replace(snap, 1000);
        assert!(s.is_fresh(1100, 300));
        assert!(s.is_fresh(1299, 300));
    }

    #[test]
    fn is_fresh_false_past_window() {
        let s = DidSet::new();
        let snap = WireSnapshot {
            version: "v1".into(),
            count: 0,
            dids: vec![],
            snapshot_at_unix: 0,
            digest_hex: "d".into(),
        };
        s.replace(snap, 1000);
        assert!(!s.is_fresh(1300, 300));
        assert!(!s.is_fresh(9999, 300));
    }

    #[test]
    fn is_fresh_handles_clock_skew_backwards() {
        // If `now` ends up earlier than `last_refresh_unix` (NTP step,
        // clock adjustment, …) we treat the set as fresh rather than
        // fail closed on noise.
        let s = DidSet::new();
        let snap = WireSnapshot {
            version: "v1".into(),
            count: 0,
            dids: vec![],
            snapshot_at_unix: 0,
            digest_hex: "d".into(),
        };
        s.replace(snap, 1000);
        assert!(s.is_fresh(500, 300));
    }

    #[test]
    fn replace_sets_membership() {
        let s = DidSet::new();
        let snap = WireSnapshot {
            version: "v1".into(),
            count: 2,
            dids: vec!["did:key:zA".into(), "did:key:zB".into()],
            snapshot_at_unix: 0,
            digest_hex: "deadbeef".into(),
        };
        s.replace(snap, 100);
        assert!(s.contains("did:key:zA"));
        assert!(s.contains("did:key:zB"));
        assert!(!s.contains("did:key:zC"));
        assert!(s.is_bootstrapped());
        let (count, ts) = s.stats();
        assert_eq!(count, 2);
        assert_eq!(ts, 100);
    }
}
