//! Integration tests for the spending circuit breaker.
//!
//! Verifies that consecutive payment failures lock agent spending and that
//! manual unlock re-enables it.

use said_integration_tests::make_wallet;
use said_types::{PayCurrency, SpendingPolicy};

const DEFAULT_THRESHOLD: u32 = 3;

// ── Failure recording ──────────────────────────────────────────────────────

#[test]
fn consecutive_failures_increment() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    let b1 = wallet
        .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
        .unwrap();
    assert_eq!(b1.consecutive_failures, 1);
    assert!(!b1.tripped);

    let b2 = wallet
        .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
        .unwrap();
    assert_eq!(b2.consecutive_failures, 2);
    assert!(!b2.tripped);
}

#[test]
fn circuit_breaker_trips_after_threshold() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    for i in 0..DEFAULT_THRESHOLD {
        let b = wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
        let expected_tripped = i + 1 >= DEFAULT_THRESHOLD;
        assert_eq!(
            b.tripped,
            expected_tripped,
            "tripped mismatch at failure {}",
            i + 1
        );
    }

    // Circuit breaker is now tripped — check_circuit_breaker should fail
    let err = wallet.check_circuit_breaker(agent.id).unwrap_err();
    assert!(err.to_string().contains("circuit breaker"));
}

#[test]
fn tripped_at_is_set_when_circuit_trips() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    let state = wallet.get_circuit_breaker(agent.id);
    assert!(state.tripped_at.is_some());
}

// ── Unlock ─────────────────────────────────────────────────────────────────

#[test]
fn unlock_clears_tripped_state() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    // Confirm tripped
    assert!(wallet.check_circuit_breaker(agent.id).is_err());

    // Unlock
    wallet.unlock_circuit_breaker(agent.id).unwrap();

    // Now passes
    wallet.check_circuit_breaker(agent.id).unwrap();

    let state = wallet.get_circuit_breaker(agent.id);
    assert!(!state.tripped);
    assert_eq!(state.consecutive_failures, 0);
    assert!(state.tripped_at.is_none());
}

#[test]
fn unlock_on_untripped_agent_is_noop() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    // No failures — unlock should be a no-op
    wallet.unlock_circuit_breaker(agent.id).unwrap();
    wallet.check_circuit_breaker(agent.id).unwrap(); // still OK
}

// ── Success resets counter ────────────────────────────────────────────────

#[test]
fn success_resets_consecutive_failure_count() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    // Two failures
    wallet
        .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
        .unwrap();
    wallet
        .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
        .unwrap();

    // One success — resets counter but does NOT auto-unlock if already tripped
    wallet.record_payment_success(agent.id).unwrap();

    let state = wallet.get_circuit_breaker(agent.id);
    assert_eq!(state.consecutive_failures, 0);
    assert!(
        !state.tripped,
        "should not have tripped (only 2 failures < threshold 3)"
    );
}

#[test]
fn success_does_not_auto_unlock_tripped_breaker() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    // Trip the breaker
    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    // A "success" (e.g. manual retry that worked) resets the counter but leaves it tripped
    wallet.record_payment_success(agent.id).unwrap();

    let state = wallet.get_circuit_breaker(agent.id);
    assert!(
        state.tripped,
        "tripped breaker should not auto-clear on success — requires manual unlock"
    );
    assert_eq!(state.consecutive_failures, 0);
}

// ── Circuit breaker blocks spending checks ─────────────────────────────────

#[test]
fn tripped_circuit_breaker_blocks_check_spending_limit() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 1_000)
        .unwrap_err();
    assert!(err.to_string().contains("circuit breaker") || err.to_string().contains("consecutive"));
}

#[test]
fn after_unlock_spending_limit_check_passes() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    wallet.unlock_circuit_breaker(agent.id).unwrap();

    wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 1_000)
        .unwrap();
}

// ── spending_status reflects circuit breaker ───────────────────────────────

#[test]
fn spending_status_shows_tripped_breaker() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    let status = wallet.spending_status(agent.id).unwrap();
    assert!(status.circuit_breaker_tripped);
    assert_eq!(status.consecutive_failures, DEFAULT_THRESHOLD);
    assert!(status.tripped_at.is_some());
}

#[test]
fn spending_status_shows_untripped_breaker() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    let status = wallet.spending_status(agent.id).unwrap();
    assert!(!status.circuit_breaker_tripped);
    assert_eq!(status.consecutive_failures, 0);
    assert!(status.tripped_at.is_none());
}

// ── Configurable threshold ─────────────────────────────────────────────────

#[test]
fn threshold_of_one_trips_on_first_failure() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    let b = wallet.record_payment_failure(agent.id, 1).unwrap();
    assert!(b.tripped);
    assert_eq!(b.consecutive_failures, 1);
}

#[test]
fn high_threshold_does_not_trip_early() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    // 4 failures with threshold=10 — should not trip
    for _ in 0..4 {
        let b = wallet.record_payment_failure(agent.id, 10).unwrap();
        assert!(!b.tripped);
    }

    wallet.check_circuit_breaker(agent.id).unwrap();
}

// ── Multiple agents ────────────────────────────────────────────────────────

#[test]
fn circuit_breakers_are_isolated_per_agent() {
    let (wallet, _dir) = make_wallet();
    let agent_a = wallet
        .create_agent_wallet("agent-a", SpendingPolicy::default())
        .unwrap();
    let agent_b = wallet
        .create_agent_wallet("agent-b", SpendingPolicy::default())
        .unwrap();

    // Trip agent-a
    for _ in 0..DEFAULT_THRESHOLD {
        wallet
            .record_payment_failure(agent_a.id, DEFAULT_THRESHOLD)
            .unwrap();
    }

    // agent-b should be unaffected
    wallet.check_circuit_breaker(agent_b.id).unwrap();
    assert!(wallet.check_circuit_breaker(agent_a.id).is_err());
}
