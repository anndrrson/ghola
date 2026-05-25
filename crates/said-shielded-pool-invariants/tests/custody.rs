//! Family 4 — escrow custody accounting.

use said_shielded_pool_invariants::{inv_escrow_balance, CustodyEvent, InvariantViolation, Snapshot};

fn snap(balance: u64) -> Snapshot {
    let mut s = Snapshot::empty();
    s.escrow_balance = balance;
    s
}

#[test]
fn empty_history_zero_balance_ok() {
    inv_escrow_balance(&snap(0), &[]).expect("empty");
}

#[test]
fn deposits_only_close() {
    let h = vec![
        CustodyEvent::Deposit { amount: 1_000 },
        CustodyEvent::Deposit { amount: 500 },
    ];
    inv_escrow_balance(&snap(1_500), &h).expect("deposits sum");
}

#[test]
fn deposit_withdraw_close() {
    let h = vec![
        CustodyEvent::Deposit { amount: 1_000 },
        CustodyEvent::Withdraw {
            recipient_amount: 700,
            relayer_amount: 50,
        },
    ];
    // 1000 - (700 + 50) = 250
    inv_escrow_balance(&snap(250), &h).expect("close");
}

#[test]
fn missing_deposit_caught() {
    let h = vec![CustodyEvent::Deposit { amount: 1_000 }];
    // Live balance claims more than the history records.
    let err = inv_escrow_balance(&snap(2_000), &h).expect_err("mismatch");
    assert!(matches!(err, InvariantViolation::Custody(_)));
}

#[test]
fn missing_withdraw_caught() {
    let h = vec![
        CustodyEvent::Deposit { amount: 1_000 },
        CustodyEvent::Withdraw {
            recipient_amount: 200,
            relayer_amount: 10,
        },
    ];
    // History says 790 remains; we claim full 1000 — withdrawal got dropped.
    let err = inv_escrow_balance(&snap(1_000), &h).expect_err("mismatch");
    assert!(matches!(err, InvariantViolation::Custody(_)));
}

#[test]
fn overdraw_caught() {
    let h = vec![
        CustodyEvent::Deposit { amount: 100 },
        CustodyEvent::Withdraw {
            recipient_amount: 200,
            relayer_amount: 0,
        },
    ];
    // Replay goes negative — this is corruption.
    let err = inv_escrow_balance(&snap(0), &h).expect_err("negative replay");
    assert!(matches!(err, InvariantViolation::Custody(_)));
}

#[test]
fn fee_events_dont_affect_escrow_directly() {
    // FeeRetained mutates the revenue vault, not escrow — replay
    // should still close on the escrow-only flow.
    let h = vec![
        CustodyEvent::Deposit { amount: 1_000 },
        CustodyEvent::Withdraw {
            recipient_amount: 900,
            relayer_amount: 50,
        },
        CustodyEvent::FeeRetained { amount: 50 },
    ];
    inv_escrow_balance(&snap(50), &h).expect("escrow closes 1000 - 950");
}

#[test]
fn revenue_drain_doesnt_affect_escrow() {
    let h = vec![
        CustodyEvent::Deposit { amount: 500 },
        CustodyEvent::RevenueDrain {
            amount: 100,
            signer: [0xAA; 32],
        },
    ];
    inv_escrow_balance(&snap(500), &h).expect("escrow unchanged by revenue drain");
}
