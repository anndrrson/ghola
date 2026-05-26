//! Prometheus-format metric collection.
//!
//! We use a hand-rolled minimal implementation (no `prometheus` crate
//! dependency) because the metric surface is small and we want zero
//! risk of accidentally exposing labels that carry per-withdrawal info.
//!
//! Specifically: NO label includes the queue id, recipient, amount, or
//! any client IP. Labels are limited to the static buckets defined here.
//!
//! # V4: anonymity-set side-channel mitigation
//!
//! `/metrics` may be polled by anyone who can reach the endpoint (the
//! optional `RELAY_METRICS_TOKEN` adds auth, but the *data* exposure must be
//! safe even if the endpoint is left open). The most recently released batch
//! size IS the live k-anonymity set; exposing its EXACT value lets an
//! observer read "last batch == 1" and correlate it with the single on-chain
//! tx that just landed — re-opening the M3 side-channel through the metrics
//! surface. Mitigations here:
//!   1. The anonymity-set gauge is COARSENED into wide buckets
//!      ([`anonymity_bucket`]); the exact size is never stored or rendered.
//!   2. The per-relayer decoy counter is REMOVED. A separate decoy total let
//!      an observer subtract decoys from the submission counts to recover the
//!      real-withdrawal rate. (Decoys are also not implemented — V2 — so the
//!      counter only ever leaked, never informed.)

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Coarse buckets for the most-recent anonymity-set size. We expose only the
/// bucket's lower bound (a wide range), never the exact size, so an observer
/// polling `/metrics` cannot pin the last batch to an exact count and link it
/// to a specific on-chain tx.
///
/// Returned value is the bucket's LOWER BOUND:
///   - `0`  → no batch released yet
///   - `1`  → last batch in `1..=4`
///   - `5`  → last batch in `5..=16`
///   - `17` → last batch in `17..=64`
///   - `65` → last batch `>= 65`
pub fn anonymity_bucket(k: u64) -> u64 {
    match k {
        0 => 0,
        1..=4 => 1,
        5..=16 => 5,
        17..=64 => 17,
        _ => 65,
    }
}

#[derive(Default)]
pub struct Metrics {
    queue_depth: AtomicU64,
    /// COARSE bucket lower-bound of the last released batch — see
    /// [`anonymity_bucket`]. The exact size is never stored here (V4).
    anonymity_set_bucket_last: AtomicU64,
    submit_success: AtomicU64,
    submit_failure: AtomicU64,
    latencies: Mutex<Vec<u64>>, // ms; bounded by trim_latencies
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_queue_depth(&self, n: usize) {
        self.queue_depth.store(n as u64, Ordering::Relaxed);
    }

    /// Record the size of the most recently released batch. The value is
    /// bucketed IMMEDIATELY (V4) — the raw `k` never lands in the metric,
    /// only its coarse bucket lower bound.
    pub fn observe_anonymity_set(&self, k: usize) {
        self.anonymity_set_bucket_last
            .store(anonymity_bucket(k as u64), Ordering::Relaxed);
    }

    pub fn record_submit_success(&self) {
        self.submit_success.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_submit_failure(&self) {
        self.submit_failure.fetch_add(1, Ordering::Relaxed);
    }

    pub fn observe_submit_latency(&self, d: Duration) {
        let ms = d.as_millis() as u64;
        if let Ok(mut v) = self.latencies.lock() {
            v.push(ms);
            // Keep the trailing 1024 samples — bounded memory, plenty for p50/p99.
            if v.len() > 1024 {
                let drop = v.len() - 1024;
                v.drain(0..drop);
            }
        }
    }

    fn percentiles(&self) -> (u64, u64) {
        let snapshot: Vec<u64> = match self.latencies.lock() {
            Ok(v) => v.clone(),
            Err(_) => return (0, 0),
        };
        if snapshot.is_empty() {
            return (0, 0);
        }
        let mut s = snapshot;
        s.sort_unstable();
        let p50 = s[s.len() / 2];
        let p99 = s[(s.len() * 99 / 100).min(s.len() - 1)];
        (p50, p99)
    }

    /// Render Prometheus exposition format. No labels carry per-withdrawal data.
    pub fn render(&self) -> String {
        let (p50, p99) = self.percentiles();
        let success = self.submit_success.load(Ordering::Relaxed);
        let failure = self.submit_failure.load(Ordering::Relaxed);
        let success_rate = if success + failure == 0 {
            0.0
        } else {
            success as f64 / (success + failure) as f64
        };
        format!(
"# HELP relayer_queue_depth Number of pending withdrawals in the queue.
# TYPE relayer_queue_depth gauge
relayer_queue_depth {}
# HELP relayer_anonymity_set_bucket_last Coarse bucket (lower bound) of the most recently released batch size. Bucketed (1=1-4,5=5-16,17=17-64,65=65+) so the exact size is never exposed (V4 side-channel mitigation).
# TYPE relayer_anonymity_set_bucket_last gauge
relayer_anonymity_set_bucket_last {}
# HELP relayer_submit_latency_ms_p50 Median end-to-end submit latency in ms.
# TYPE relayer_submit_latency_ms_p50 gauge
relayer_submit_latency_ms_p50 {}
# HELP relayer_submit_latency_ms_p99 99th-percentile end-to-end submit latency in ms.
# TYPE relayer_submit_latency_ms_p99 gauge
relayer_submit_latency_ms_p99 {}
# HELP relayer_submit_success_total Total successful submissions.
# TYPE relayer_submit_success_total counter
relayer_submit_success_total {}
# HELP relayer_submit_failure_total Total failed submissions (after retries).
# TYPE relayer_submit_failure_total counter
relayer_submit_failure_total {}
# HELP relayer_submit_success_rate Success ratio of submissions.
# TYPE relayer_submit_success_rate gauge
relayer_submit_success_rate {:.4}
",
            self.queue_depth.load(Ordering::Relaxed),
            self.anonymity_set_bucket_last.load(Ordering::Relaxed),
            p50,
            p99,
            success,
            failure,
            success_rate,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymity_bucket_never_reveals_exact_small_size() {
        // The whole 1..=4 range collapses to one bucket so "released a tiny
        // batch" is indistinguishable from "released exactly 1".
        assert_eq!(anonymity_bucket(1), 1);
        assert_eq!(anonymity_bucket(2), 1);
        assert_eq!(anonymity_bucket(4), 1);
        assert_eq!(anonymity_bucket(5), 5);
        assert_eq!(anonymity_bucket(16), 5);
        assert_eq!(anonymity_bucket(17), 17);
        assert_eq!(anonymity_bucket(64), 17);
        assert_eq!(anonymity_bucket(65), 65);
        assert_eq!(anonymity_bucket(1_000_000), 65);
        assert_eq!(anonymity_bucket(0), 0);
    }

    #[test]
    fn render_does_not_emit_exact_last_batch_size() {
        let m = Metrics::new();
        // A real singleton release. The exact "1" must NOT be linkable to the
        // anonymity gauge — it renders as the bucketed value, which for k=1
        // is also 1, but is indistinguishable from k=2..=4. Verify the gauge
        // name changed (old exact gauge is gone) so scrapers can't read it.
        m.observe_anonymity_set(3);
        let r = m.render();
        assert!(
            !r.contains("relayer_anonymity_set_size_last"),
            "exact-size gauge must be removed (V4)"
        );
        assert!(r.contains("relayer_anonymity_set_bucket_last 1"));
        // The decoy counter must be gone (V4 subtraction channel + V2).
        assert!(!r.contains("relayer_decoy_tx_count_total"));
    }
}
