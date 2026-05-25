//! Family 8 — revenue accumulator + drain authority.

use said_shielded_pool_invariants::{
    inv_revenue_accumulator, inv_revenue_drain_only_by_admin, InvariantViolation, Snapshot,
    VaultEvent, WithdrawEvent,
};

fn snap(rev_bal: u64) -> Snapshot {
    let mut s = Snapshot::empty();
    s.revenue_vault_balance = rev_bal;
    s
}

#[test]
fn empty_history_zero_revenue_ok() {
    inv_revenue_accumulator(&snap(0), &[], &[]).expect("empty");
}

#[test]
fn fee_accumulator_correct() {
    // 3 withdraws @ 100 bp (1%): 10000 * 1% = 100 each, total 300.
    let h = vec![
        WithdrawEvent {
            amount: 10_000,
            fee_bps: 100,
        },
        WithdrawEvent {
            amount: 10_000,
            fee_bps: 100,
        },
        WithdrawEvent {
            amount: 10_000,
            fee_bps: 100,
        },
    ];
    inv_revenue_accumulator(&snap(300), &h, &[]).expect("closes");
}

#[test]
fn fee_with_partial_drain() {
    let h = vec![WithdrawEvent {
        amount: 10_000,
        fee_bps: 200, // 2% = 200
    }];
    let drains = vec![VaultEvent {
        signer: [0xA0; 32],
        amount: 50,
    }];
    // 200 fee accumulated, 50 drained, 150 left.
    inv_revenue_accumulator(&snap(150), &h, &drains).expect("close");
}

#[test]
fn missing_fee_caught() {
    let h = vec![WithdrawEvent {
        amount: 10_000,
        fee_bps: 100,
    }];
    let err = inv_revenue_accumulator(&snap(50), &h, &[]).expect_err("under");
    assert!(matches!(err, InvariantViolation::Revenue(_)));
}

#[test]
fn excess_drain_caught() {
    let h = vec![WithdrawEvent {
        amount: 10_000,
        fee_bps: 100,
    }];
    let drains = vec![VaultEvent {
        signer: [0xA0; 32],
        amount: 500,
    }];
    let err = inv_revenue_accumulator(&snap(0), &h, &drains).expect_err("over-drain");
    assert!(matches!(err, InvariantViolation::Revenue(_)));
}

#[test]
fn drain_by_admin_ok() {
    let admin = [0xAD; 32];
    let drains = vec![
        VaultEvent {
            signer: admin,
            amount: 100,
        },
        VaultEvent {
            signer: admin,
            amount: 50,
        },
    ];
    inv_revenue_drain_only_by_admin(&drains, admin).expect("admin OK");
}

#[test]
fn drain_by_non_admin_caught() {
    let admin = [0xAD; 32];
    let attacker = [0xEE; 32];
    let drains = vec![VaultEvent {
        signer: attacker,
        amount: 100,
    }];
    let err = inv_revenue_drain_only_by_admin(&drains, admin)
        .expect_err("unauthorized");
    assert!(matches!(err, InvariantViolation::Revenue(_)));
}

#[test]
fn partial_unauthorized_drain_caught() {
    let admin = [0xAD; 32];
    let drains = vec![
        VaultEvent {
            signer: admin,
            amount: 100,
        },
        VaultEvent {
            signer: [0xFF; 32],
            amount: 50,
        },
    ];
    let err = inv_revenue_drain_only_by_admin(&drains, admin)
        .expect_err("mixed");
    assert!(matches!(err, InvariantViolation::Revenue(_)));
}
