// Integration-test helper utilities shared across test files.

use said_core::Wallet;
use said_types::{PayCurrency, PaymentTransaction, SpendingPolicy, TxDirection, TxStatus};
use tempfile::TempDir;
use uuid::Uuid;

/// Create a throwaway wallet in a temp directory.
pub fn make_wallet() -> (Wallet, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let wallet_dir = dir.path().join(".said");
    let (wallet, _phrase) = Wallet::init(&wallet_dir, None).expect("wallet init");
    (wallet, dir)
}

/// Build a fake outgoing SOL transaction for `agent_id`.
pub fn fake_sol_tx(agent_id: Uuid, agent_label: &str, amount: u64) -> PaymentTransaction {
    PaymentTransaction {
        id: Uuid::new_v4(),
        agent_id,
        agent_label: agent_label.to_string(),
        direction: TxDirection::Send,
        currency: PayCurrency::Sol,
        amount,
        recipient: "11111111111111111111111111111111".to_string(),
        sender: "22222222222222222222222222222222".to_string(),
        signature: format!("sig_{}", Uuid::new_v4()),
        memo: None,
        status: TxStatus::Confirmed,
        created_at: chrono::Utc::now(),
    }
}

/// Build a fake outgoing USDC transaction for `agent_id`.
pub fn fake_usdc_tx(agent_id: Uuid, agent_label: &str, amount: u64) -> PaymentTransaction {
    PaymentTransaction {
        id: Uuid::new_v4(),
        agent_id,
        agent_label: agent_label.to_string(),
        direction: TxDirection::Send,
        currency: PayCurrency::Usdc,
        amount,
        recipient: "11111111111111111111111111111111".to_string(),
        sender: "22222222222222222222222222222222".to_string(),
        signature: format!("sig_{}", Uuid::new_v4()),
        memo: None,
        status: TxStatus::Confirmed,
        created_at: chrono::Utc::now(),
    }
}

/// Default policy with SOL daily 5 SOL, per-tx 1 SOL, USDC daily $50, per-tx $10.
pub fn standard_policy() -> SpendingPolicy {
    SpendingPolicy {
        daily_limit_lamports: Some(5_000_000_000),      // 5 SOL
        per_tx_limit_lamports: Some(1_000_000_000),     // 1 SOL
        daily_limit_usdc_micro: Some(50_000_000),       // $50
        per_tx_limit_usdc_micro: Some(10_000_000),      // $10
        allowed_recipients: vec![],
    }
}
