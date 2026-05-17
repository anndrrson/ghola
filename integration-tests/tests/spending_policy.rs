//! Integration tests for spending policy enforcement.
//!
//! Tests daily limits, per-transaction limits, allowlist, and the
//! interaction between spending checks and the wallet transaction log.

use said_integration_tests::{fake_sol_tx, fake_usdc_tx, make_wallet, standard_policy};
use said_types::{PayCurrency, SpendingPolicy};

// ── Per-transaction limit ──────────────────────────────────────────────────

#[test]
fn per_tx_sol_limit_blocks_large_transfer() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet.create_agent_wallet("agent", standard_policy()).unwrap();

    // 0.5 SOL is under per-tx limit of 1 SOL — OK
    wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 500_000_000)
        .unwrap();

    // 2 SOL exceeds per-tx limit of 1 SOL — rejected
    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 2_000_000_000)
        .unwrap_err();
    assert!(err.to_string().contains("per-tx"));
}

#[test]
fn per_tx_usdc_limit_blocks_large_transfer() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet.create_agent_wallet("agent", standard_policy()).unwrap();

    // $5 is under per-tx limit of $10 — OK
    wallet
        .check_spending_limit(agent.id, &PayCurrency::Usdc, 5_000_000)
        .unwrap();

    // $15 exceeds per-tx limit of $10 — rejected
    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Usdc, 15_000_000)
        .unwrap_err();
    assert!(err.to_string().contains("per-tx"));
}

// ── Daily limit ────────────────────────────────────────────────────────────

#[test]
fn daily_sol_limit_accumulates_across_transactions() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy {
        daily_limit_lamports: Some(3_000_000_000), // 3 SOL
        per_tx_limit_lamports: Some(1_500_000_000), // 1.5 SOL per tx
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    // Log 2 × 1 SOL = 2 SOL spent already
    wallet.log_transaction(fake_sol_tx(agent.id, "agent", 1_000_000_000)).unwrap();
    wallet.log_transaction(fake_sol_tx(agent.id, "agent", 1_000_000_000)).unwrap();

    // Requesting another 0.5 SOL → total 2.5 SOL, within 3 SOL limit — OK
    wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 500_000_000)
        .unwrap();

    // Requesting another 1.5 SOL → total 3.5 SOL, exceeds 3 SOL limit
    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 1_500_000_000)
        .unwrap_err();
    assert!(err.to_string().contains("daily"));
}

#[test]
fn daily_usdc_limit_accumulates_across_transactions() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy {
        daily_limit_usdc_micro: Some(20_000_000), // $20
        per_tx_limit_usdc_micro: Some(10_000_000), // $10
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    // Log 2 × $8 = $16 spent
    wallet.log_transaction(fake_usdc_tx(agent.id, "agent", 8_000_000)).unwrap();
    wallet.log_transaction(fake_usdc_tx(agent.id, "agent", 8_000_000)).unwrap();

    // Requesting $3 → $19 total, within $20 — OK
    wallet
        .check_spending_limit(agent.id, &PayCurrency::Usdc, 3_000_000)
        .unwrap();

    // Requesting $6 → $22 total, exceeds $20
    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Usdc, 6_000_000)
        .unwrap_err();
    assert!(err.to_string().contains("daily"));
}

#[test]
fn unlimited_policy_never_blocks() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy::default(); // all None → unlimited
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    // Log many large transactions
    for _ in 0..10 {
        wallet.log_transaction(fake_sol_tx(agent.id, "agent", 100_000_000_000)).unwrap();
    }

    // Still should not block since there are no limits
    wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 999_999_999_999)
        .unwrap();
}

// ── Allowlist enforcement ──────────────────────────────────────────────────

#[test]
fn allowlist_blocks_unlisted_recipient() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy {
        allowed_recipients: vec!["AllowedAddress1111111111111111111".to_string()],
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    // Calling check_spending_limit without recipient on an allowlisted policy
    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 1_000)
        .unwrap_err();
    assert!(err.to_string().contains("allowlist") || err.to_string().contains("recipient"));
}

#[test]
fn allowlist_permits_listed_recipient() {
    let (wallet, _dir) = make_wallet();
    let allowed = "AllowedAddress1111111111111111111".to_string();
    let policy = SpendingPolicy {
        allowed_recipients: vec![allowed.clone()],
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    wallet
        .check_spending_limit_with_recipient(agent.id, &PayCurrency::Sol, 1_000, Some(&allowed))
        .unwrap();
}

#[test]
fn allowlist_blocks_wrong_recipient() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy {
        allowed_recipients: vec!["AllowedAddress1111111111111111111".to_string()],
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    let err = wallet
        .check_spending_limit_with_recipient(
            agent.id,
            &PayCurrency::Sol,
            1_000,
            Some("UnknownAddress22222222222222222222"),
        )
        .unwrap_err();
    assert!(err.to_string().contains("allowlist") || err.to_string().contains("recipient"));
}

#[test]
fn empty_allowlist_allows_any_recipient() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy {
        allowed_recipients: vec![], // empty = all recipients allowed
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();

    wallet
        .check_spending_limit_with_recipient(
            agent.id,
            &PayCurrency::Sol,
            1_000,
            Some("AnyAddress999999999999999999999999"),
        )
        .unwrap();
}

// ── Inactive agent ─────────────────────────────────────────────────────────

#[test]
fn inactive_agent_is_blocked() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet.create_agent_wallet("agent", SpendingPolicy::default()).unwrap();

    wallet.deactivate_agent(agent.id).unwrap();

    let err = wallet
        .check_spending_limit(agent.id, &PayCurrency::Sol, 1_000)
        .unwrap_err();
    assert!(err.to_string().contains("inactive") || err.to_string().contains("circuit"));
}

// ── spending_status ────────────────────────────────────────────────────────

#[test]
fn spending_status_reflects_logged_transactions() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet.create_agent_wallet("agent", standard_policy()).unwrap();

    wallet.log_transaction(fake_sol_tx(agent.id, "agent", 500_000_000)).unwrap();
    wallet.log_transaction(fake_usdc_tx(agent.id, "agent", 3_000_000)).unwrap();

    let status = wallet.spending_status(agent.id).unwrap();
    assert_eq!(status.spend_today_sol_lamports, 500_000_000);
    assert_eq!(status.spend_today_usdc_micro, 3_000_000);
    assert!(!status.circuit_breaker_tripped);
    assert_eq!(status.consecutive_failures, 0);
}

#[test]
fn spending_status_remaining_budget_is_computed() {
    let (wallet, _dir) = make_wallet();
    let policy = SpendingPolicy {
        daily_limit_usdc_micro: Some(10_000_000), // $10
        ..Default::default()
    };
    let agent = wallet.create_agent_wallet("agent", policy).unwrap();
    wallet.log_transaction(fake_usdc_tx(agent.id, "agent", 3_000_000)).unwrap();

    let status = wallet.spending_status(agent.id).unwrap();
    // Remaining = $10 - $3 = $7
    assert_eq!(status.remaining_usdc_micro, Some(7_000_000));
}

#[test]
fn spending_status_no_limit_gives_none_remaining() {
    let (wallet, _dir) = make_wallet();
    let agent = wallet
        .create_agent_wallet("agent", SpendingPolicy::default())
        .unwrap();

    let status = wallet.spending_status(agent.id).unwrap();
    assert_eq!(status.remaining_sol_lamports, None);
    assert_eq!(status.remaining_usdc_micro, None);
}
