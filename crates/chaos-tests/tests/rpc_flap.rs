//! Scenario: transient RPC failures -> exponential backoff recovers.
//!
//! Uses a hand-rolled `Submitter` mock that returns `Err` for the first
//! N attempts then `Ok`, and verifies `submit_with_retry` semantics
//! indirectly via the `Batcher`'s `submit_batch` entry point.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use said_shielded_pool_relayer::config::Config;
use said_shielded_pool_relayer::metrics::Metrics;
use said_shielded_pool_relayer::queue::{
    ProofBlob, QueuedAccountMeta, QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus,
};
use said_shielded_pool_relayer::submit::{submit_batch, Submitter};

#[derive(Default)]
struct FlapSubmitter {
    fail_first: u32,
    attempts: AtomicU32,
    attempt_log: parking_lot_compat::Mutex<Vec<Instant>>,
}

#[async_trait]
impl Submitter for FlapSubmitter {
    async fn submit_one(
        &self,
        _w: &QueuedWithdrawal,
    ) -> said_shielded_pool_relayer::Result<()> {
        let n = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        self.attempt_log.lock().push(Instant::now());
        if n <= self.fail_first {
            Err(said_shielded_pool_relayer::Error::Submit(format!(
                "flap {n}"
            )))
        } else {
            Ok(())
        }
    }
    async fn submit_decoy(&self) -> said_shielded_pool_relayer::Result<()> {
        Ok(())
    }
}

// Tiny shim so we don't pull parking_lot just for tests. We use std::sync::Mutex.
mod parking_lot_compat {
    pub struct Mutex<T>(std::sync::Mutex<T>);
    impl<T: Default> Default for Mutex<T> {
        fn default() -> Self {
            Self(std::sync::Mutex::new(T::default()))
        }
    }
    impl<T> Mutex<T> {
        pub fn lock(&self) -> std::sync::MutexGuard<'_, T> {
            self.0.lock().unwrap()
        }
    }
}

fn dummy_withdrawal() -> QueuedWithdrawal {
    QueuedWithdrawal {
        id: uuid::Uuid::new_v4(),
        proof_bundle: ProofBlob(serde_json::json!({})),
        recipient: [1u8; 32],
        fee: 5000,
        relayer_fee: 1000,
        instruction_data: vec![0u8; 1],
        accounts: vec![QueuedAccountMeta {
            pubkey: "11111111111111111111111111111111".into(),
            is_signer: false,
            is_writable: false,
        }],
        accepted_at: chrono::Utc::now(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    }
}

fn cfg(max_retries: u32, initial_ms: u64, max_ms: u64) -> Arc<Config> {
    use std::path::PathBuf;
    Arc::new(Config {
        port: 0,
        rpc_url: "http://127.0.0.1:1".into(),
        keypair_path: PathBuf::from("/nonexistent"),
        queue_db_path: PathBuf::from("/tmp/no.db"),
        batch_size: 8,
        min_delay: Duration::from_secs(1),
        max_delay: Duration::from_secs(2),
        anonymity_threshold: 1,
        decoy_rate_per_hour: 0.0,
        jitter_lambda: 1.0,
        max_retries,
        retry_initial_delay_ms: initial_ms,
        retry_max_delay_ms: max_ms,
        pool_program_id: said_shielded_pool_relayer::config::DEFAULT_POOL_PROGRAM_ID.into(),
        max_queue_depth: 10_000,
        relay_rate_limit_per_min: 0,
        dedup_ttl_secs: said_shielded_pool_relayer::config::DEFAULT_DEDUP_TTL_SECS,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_recovers_after_n_failures_with_backoff() {
    let submitter = Arc::new(FlapSubmitter {
        fail_first: 3,
        ..Default::default()
    });
    let queue = WithdrawalQueue::open_temporary().unwrap();
    let metrics = Arc::new(Metrics::new());
    let w = dummy_withdrawal();
    queue.insert(&w).unwrap();

    let cfg = cfg(5, 50, 1000);
    let start = Instant::now();
    let res = submit_batch(
        submitter.as_ref(),
        &queue,
        &cfg,
        &metrics,
        vec![w.clone()],
    )
    .await;
    let elapsed = start.elapsed();
    res.expect("submit_batch ok");

    // Submitter saw exactly 4 attempts (3 failures + 1 success).
    let attempts = submitter.attempts.load(Ordering::SeqCst);
    assert_eq!(attempts, 4, "expected 4 submit attempts, saw {attempts}");

    // Total elapsed must reflect roughly initial + 2*initial + 4*initial =
    // 7 * 50ms = 350ms of *sleep* (plus jitter delay). We accept >= 100ms
    // as a very loose lower bound to keep the test stable across CI.
    assert!(
        elapsed >= Duration::from_millis(100),
        "elapsed {elapsed:?} too short — backoff not enforced?"
    );

    // The final status must be Confirmed.
    let final_status = queue.get(w.id).unwrap().unwrap().status;
    assert_eq!(final_status, WithdrawalStatus::Confirmed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_fails_after_max_retries_exhausted() {
    let submitter = Arc::new(FlapSubmitter {
        fail_first: 100,
        ..Default::default()
    });
    let queue = WithdrawalQueue::open_temporary().unwrap();
    let metrics = Arc::new(Metrics::new());
    let w = dummy_withdrawal();
    queue.insert(&w).unwrap();

    let cfg = cfg(3, 10, 50);
    let _ = submit_batch(
        submitter.as_ref(),
        &queue,
        &cfg,
        &metrics,
        vec![w.clone()],
    )
    .await;

    let attempts = submitter.attempts.load(Ordering::SeqCst);
    assert_eq!(attempts, 3, "expected exactly max_retries attempts");
    let final_status = queue.get(w.id).unwrap().unwrap().status;
    assert_eq!(final_status, WithdrawalStatus::Failed);
}
