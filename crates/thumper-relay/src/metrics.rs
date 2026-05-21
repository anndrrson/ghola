use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

#[derive(Clone)]
pub struct RelayMetrics {
    inner: Arc<MetricsInner>,
}

struct MetricsInner {
    commands_total: AtomicU64,
    commands_by_type: dashmap::DashMap<String, AtomicU64>,
    errors_total: AtomicU64,
    response_time_sum_ms: AtomicU64,
    response_count: AtomicU64,
    started_at: Instant,
}

#[derive(Serialize)]
pub struct MetricsSnapshot {
    pub commands_total: u64,
    pub commands_by_type: std::collections::HashMap<String, u64>,
    pub errors_total: u64,
    pub avg_response_time_ms: f64,
    pub uptime_secs: u64,
    pub devices_connected: usize,
    pub mcp_clients_connected: usize,
    pub gpu_providers_connected: usize,
}

impl RelayMetrics {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(MetricsInner {
                commands_total: AtomicU64::new(0),
                commands_by_type: dashmap::DashMap::new(),
                errors_total: AtomicU64::new(0),
                response_time_sum_ms: AtomicU64::new(0),
                response_count: AtomicU64::new(0),
                started_at: Instant::now(),
            }),
        }
    }

    pub fn record_command(&self, command_type: &str) {
        self.inner.commands_total.fetch_add(1, Ordering::Relaxed);
        self.inner
            .commands_by_type
            .entry(command_type.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_error(&self) {
        self.inner.errors_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_response_time(&self, ms: u64) {
        self.inner
            .response_time_sum_ms
            .fetch_add(ms, Ordering::Relaxed);
        self.inner.response_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(
        &self,
        device_count: usize,
        mcp_client_count: usize,
        gpu_provider_count: usize,
    ) -> MetricsSnapshot {
        let total = self.inner.commands_total.load(Ordering::Relaxed);
        let errors = self.inner.errors_total.load(Ordering::Relaxed);
        let resp_sum = self.inner.response_time_sum_ms.load(Ordering::Relaxed);
        let resp_count = self.inner.response_count.load(Ordering::Relaxed);
        let avg_ms = if resp_count > 0 {
            resp_sum as f64 / resp_count as f64
        } else {
            0.0
        };

        let by_type: std::collections::HashMap<String, u64> = self
            .inner
            .commands_by_type
            .iter()
            .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
            .collect();

        MetricsSnapshot {
            commands_total: total,
            commands_by_type: by_type,
            errors_total: errors,
            avg_response_time_ms: avg_ms,
            uptime_secs: self.inner.started_at.elapsed().as_secs(),
            devices_connected: device_count,
            mcp_clients_connected: mcp_client_count,
            gpu_providers_connected: gpu_provider_count,
        }
    }
}
