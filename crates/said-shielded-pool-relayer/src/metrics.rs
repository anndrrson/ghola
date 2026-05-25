//! Prometheus-format metric collection.
//!
//! We use a hand-rolled minimal implementation (no `prometheus` crate
//! dependency) because the metric surface is small and we want zero
//! risk of accidentally exposing labels that carry per-withdrawal info.
//!
//! Specifically: NO label includes the queue id, recipient, amount, or
//! any client IP. Labels are limited to the static buckets defined here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct Metrics {
    queue_depth: AtomicU64,
    anonymity_set_size_last: AtomicU64,
    submit_success: AtomicU64,
    submit_failure: AtomicU64,
    decoy_count: AtomicU64,
    latencies: Mutex<Vec<u64>>, // ms; bounded by trim_latencies
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_queue_depth(&self, n: usize) {
        self.queue_depth.store(n as u64, Ordering::Relaxed);
    }

    pub fn observe_anonymity_set(&self, k: usize) {
        self.anonymity_set_size_last.store(k as u64, Ordering::Relaxed);
    }

    pub fn record_submit_success(&self) {
        self.submit_success.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_submit_failure(&self) {
        self.submit_failure.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_decoy(&self) {
        self.decoy_count.fetch_add(1, Ordering::Relaxed);
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
# HELP relayer_anonymity_set_size_last Size of the most recently released batch.
# TYPE relayer_anonymity_set_size_last gauge
relayer_anonymity_set_size_last {}
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
# HELP relayer_decoy_tx_count_total Total decoy transactions submitted.
# TYPE relayer_decoy_tx_count_total counter
relayer_decoy_tx_count_total {}
",
            self.queue_depth.load(Ordering::Relaxed),
            self.anonymity_set_size_last.load(Ordering::Relaxed),
            p50,
            p99,
            success,
            failure,
            success_rate,
            self.decoy_count.load(Ordering::Relaxed),
        )
    }
}
