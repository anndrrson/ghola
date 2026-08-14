import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCoinbaseOmnibusReservationTransition,
  createSqliteWorkerState,
  createWorkerState,
} from "../src/state/private-state.js";

const TEMP_DIRS = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coinbase omnibus reservation transitions", () => {
  it("reserves capacity only for Coinbase placement operations", () => {
    for (const operationClass of ["cancel", "fills", "reconcile", "preview_order", "read"]) {
      assert.throws(
        () => applyCoinbaseOmnibusReservationTransition(null, placement({
          operation_class: operationClass,
        })),
        (error) => error.code === "COINBASE_OMNIBUS_INVALID_OPERATION",
      );
    }

    const market = applyCoinbaseOmnibusReservationTransition(null, placement({
      operation_class: "spot_market_order",
    }));
    const limit = applyCoinbaseOmnibusReservationTransition(null, placement({
      operation_class: "spot_limit_order",
      work_order_commitment: "work_limit",
      client_order_id: "client_limit",
    }));
    assert.equal(market.status, "reserved");
    assert.equal(limit.status, "reserved");
  });

  it("keeps unknown outcomes reserved and requires exact release proof", () => {
    const reserved = applyCoinbaseOmnibusReservationTransition(null, placement());

    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(reserved, scoped({ transition: "release" })),
      (error) => error.code === "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
    );
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(reserved, scoped({ transition: "unknown" })),
      (error) => error.code === "COINBASE_OMNIBUS_INVALID_TRANSITION",
    );
    assert.equal(reserved.status, "reserved");
    assert.equal(reserved.remaining_amount, 100);
  });

  it("moves monotonically through partial fills and releases only the proven remainder", () => {
    const reserved = applyCoinbaseOmnibusReservationTransition(null, placement());
    const partial = applyCoinbaseOmnibusReservationTransition(reserved, scoped({
      transition: "fill",
      fill_commitment: "fill_35_5",
      fill_amount: "35.5",
    }));
    assert.equal(partial.status, "partially_filled");
    assert.equal(partial.filled_amount, 35.5);
    assert.equal(partial.remaining_amount, 64.5);

    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(partial, releaseEvent(partial, {
        observed_filled_amount: "0",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
    );
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(partial, releaseEvent(partial, {
        target_client_order_id: "different_client",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_SCOPE_MISMATCH",
    );

    const released = applyCoinbaseOmnibusReservationTransition(
      partial,
      releaseEvent(partial),
    );
    assert.equal(released.status, "released");
    assert.equal(released.filled_amount, 35.5);
    assert.equal(released.released_amount, 64.5);
    assert.equal(released.remaining_amount, 0);

    assert.equal(
      applyCoinbaseOmnibusReservationTransition(released, releaseEvent(released)),
      released,
    );
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(released, releaseEvent(released, {
        provider_order_id: "different_order_same_claimed_proof",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_TERMINAL",
    );
    assert.equal(
      applyCoinbaseOmnibusReservationTransition(released, placement()),
      released,
    );
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(released, scoped({
        transition: "fill",
        fill_commitment: "late_fill",
        fill_amount: "1",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_TERMINAL",
    );
  });

  it("settles exact cumulative fills without double-counting retries or allowing overfill", () => {
    const reserved = applyCoinbaseOmnibusReservationTransition(null, placement({
      reserved_amount: "0.3",
    }));
    const firstFillEvent = scoped({
      transition: "fill",
      fill_commitment: "fill_point_one",
      fill_amount: "0.1",
    });
    const partial = applyCoinbaseOmnibusReservationTransition(reserved, firstFillEvent);
    assert.equal(
      applyCoinbaseOmnibusReservationTransition(partial, firstFillEvent),
      partial,
    );
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(partial, {
        ...firstFillEvent,
        fill_amount: "0.2",
      }),
      (error) => error.code === "COINBASE_OMNIBUS_FILL_CONFLICT",
    );
    const settled = applyCoinbaseOmnibusReservationTransition(partial, scoped({
      transition: "fill",
      fill_commitment: "fill_point_two",
      fill_amount: "0.2",
    }));
    assert.equal(settled.status, "settled");
    assert.equal(settled.filled_amount, 0.3);
    assert.equal(settled.remaining_amount, 0);
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(settled, releaseEvent(settled)),
      (error) => error.code === "COINBASE_OMNIBUS_TERMINAL",
    );

    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(reserved, scoped({
        transition: "fill",
        fill_commitment: "overfill",
        fill_amount: "0.4",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_OVERFILL",
    );
  });

  it("accounts exact fixed decimals without tolerance-based overfill", () => {
    const large = applyCoinbaseOmnibusReservationTransition(null, placement({
      reserved_amount: "9000000000000000",
    }));
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(large, scoped({
        transition: "fill",
        fill_commitment: "large_overfill",
        fill_amount: "9000000000000008",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_OVERFILL",
    );

    const dust = applyCoinbaseOmnibusReservationTransition(null, placement({
      reserved_amount: "0.00000001",
    }));
    const released = applyCoinbaseOmnibusReservationTransition(dust, scoped({
      transition: "release",
      proof: {
        kind: "rejected_before_submit",
        proof_commitment: "dust_rejection_proof",
        scope_commitment: dust.scope_commitment,
        target_client_order_id: "client_1",
        submission_attempted: false,
        reason_code: "SESSION_POLICY_REJECTED",
      },
    }));
    assert.equal(released.status, "released");
    assert.equal(released.released_amount_decimal, "0.00000001");

    const numericDust = applyCoinbaseOmnibusReservationTransition(null, placement({
      reserved_amount: 0.00000001,
    }));
    assert.equal(numericDust.reserved_amount_decimal, "0.00000001");

    const trailingZeros = applyCoinbaseOmnibusReservationTransition(null, placement({
      reserved_amount: "1.000000000000000000",
    }));
    assert.equal(trailingZeros.reserved_amount_decimal, "1");

    const precise = applyCoinbaseOmnibusReservationTransition(null, placement({
      reserved_amount: "1.12345678",
    }));
    const partial = applyCoinbaseOmnibusReservationTransition(precise, scoped({
      transition: "fill",
      fill_commitment: "precise_fill",
      fill_amount: "0.12345678",
    }));
    assert.equal(partial.filled_amount_decimal, "0.12345678");
    assert.equal(partial.remaining_amount_decimal, "1");
  });

  it("releases a rejected-before-submit placement but never a submitted or filled one", () => {
    const reserved = applyCoinbaseOmnibusReservationTransition(null, placement());
    const event = scoped({
      transition: "release",
      proof: {
        kind: "rejected_before_submit",
        proof_commitment: "policy_rejection_proof",
        scope_commitment: reserved.scope_commitment,
        target_client_order_id: "client_1",
        submission_attempted: false,
        reason_code: "SESSION_POLICY_REJECTED",
      },
    });
    const released = applyCoinbaseOmnibusReservationTransition(reserved, event);
    assert.equal(released.status, "released");
    assert.equal(released.released_amount, 100);

    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(reserved, {
        ...event,
        proof: { ...event.proof, submission_attempted: true },
      }),
      (error) => error.code === "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
    );
    const partial = applyCoinbaseOmnibusReservationTransition(reserved, scoped({
      transition: "fill",
      fill_commitment: "fill_before_rejection",
      fill_amount: "1",
    }));
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(partial, event),
      (error) => error.code === "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
    );
  });

  it("rejects unsafe amounts and scope changes", () => {
    for (const amount of [
      "1e2",
      "01",
      "NaN",
      "0.000000001",
      "9007199254740991.9",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
    ]) {
      assert.throws(
        () => applyCoinbaseOmnibusReservationTransition(null, placement({
          reserved_amount: amount,
        })),
        (error) => error.code === "COINBASE_OMNIBUS_INVALID_AMOUNT",
      );
    }
    const reserved = applyCoinbaseOmnibusReservationTransition(null, placement());
    assert.throws(
      () => applyCoinbaseOmnibusReservationTransition(reserved, scoped({
        transition: "fill",
        product_id: "ETH-USD",
        fill_commitment: "wrong_scope_fill",
        fill_amount: "1",
      })),
      (error) => error.code === "COINBASE_OMNIBUS_SCOPE_MISMATCH",
    );
  });
});

describe("coinbase omnibus reservation state adapters", () => {
  it("serializes amount-aware transitions and reads the strict JSON record", async () => {
    const dir = tempDir();
    const state = createWorkerState(dir);
    await state.transitionCoinbaseOmnibusReservation(placement());
    await Promise.all([
      state.transitionCoinbaseOmnibusReservation(scoped({
        transition: "fill",
        fill_commitment: "parallel_fill_40",
        fill_amount: "40",
      })),
      state.transitionCoinbaseOmnibusReservation(scoped({
        transition: "fill",
        fill_commitment: "parallel_fill_60",
        fill_amount: "60",
      })),
    ]);

    const stored = await createWorkerState(dir).getCoinbaseOmnibusReservation({
      allocation_commitment: "allocation_1",
      work_order_commitment: "work_1",
    });
    assert.equal(stored.status, "settled");
    assert.equal(stored.filled_amount, 100);
    await assert.rejects(
      state.releaseOmnibus({
        allocation_commitment: "allocation_1",
        work_order_commitment: "work_1",
      }),
      (error) => error.code === "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
    );
  });

  it("uses canonical commitment keys across JSON and SQLite", async () => {
    const states = [
      createWorkerState(tempDir()),
      createSqliteWorkerState(join(tempDir(), "canonical-worker-state.sqlite")),
    ];
    for (const state of states) {
      const reserved = await state.transitionCoinbaseOmnibusReservation(placement());
      const replay = await state.transitionCoinbaseOmnibusReservation(placement({
        allocation_commitment: " allocation_1 ",
        work_order_commitment: " work_1 ",
      }));
      assert.equal(replay.scope_commitment, reserved.scope_commitment);
      assert.deepEqual(
        Object.keys((await state.getOmnibusAllocation("allocation_1")).reservations),
        ["work_1"],
      );
      assert.equal(
        (await state.getCoinbaseOmnibusReservation({
          allocation_commitment: " allocation_1 ",
          work_order_commitment: " work_1 ",
        })).scope_commitment,
        reserved.scope_commitment,
      );
    }
  });

  it("rejects allocation metadata whose identity differs from transition scope", async () => {
    const states = [
      createWorkerState(tempDir()),
      createSqliteWorkerState(join(tempDir(), "bound-worker-state.sqlite")),
    ];
    for (const state of states) {
      await assert.rejects(
        state.transitionCoinbaseOmnibusReservation(placement({
          allocation: {
            allocation_commitment: "different_allocation",
            owner_commitment: "different_owner",
          },
        })),
        (error) => error.code === "COINBASE_OMNIBUS_SCOPE_MISMATCH",
      );
      assert.equal(await state.getOmnibusAllocation("allocation_1"), null);
    }
  });

  it("persists the strict lifecycle through SQLite without external services", async () => {
    const dbPath = join(tempDir(), "worker-state.sqlite");
    const state = createSqliteWorkerState(dbPath);
    const reserved = await state.transitionCoinbaseOmnibusReservation(placement());
    await state.transitionCoinbaseOmnibusReservation(releaseEvent(reserved, {
      kind: "reconcile_terminal",
      terminal_status: "expired",
      proof_commitment: "reconcile_expired_proof",
    }));

    const stored = await createSqliteWorkerState(dbPath).getCoinbaseOmnibusReservation({
      allocation_commitment: "allocation_1",
      work_order_commitment: "work_1",
    });
    assert.equal(stored.status, "released");
    assert.equal(stored.released_amount, 100);
    assert.equal(stored.release_proof.kind, "reconcile_terminal");
  });

  it("keeps compatibility reservations terminal once settled or released", async () => {
    const state = createWorkerState(tempDir());
    const key = {
      allocation_commitment: "legacy_allocation",
      work_order_commitment: "legacy_work",
    };
    await state.reserveOmnibus({ ...key, notional_bucket: "25" });
    await state.settleOmnibusFill({ ...key, fill_commitment: "legacy_fill" });
    await state.releaseOmnibus(key);
    await state.reserveOmnibus({ ...key, notional_bucket: "50" });
    assert.equal(
      (await state.getOmnibusAllocation(key.allocation_commitment))
        .reservations[key.work_order_commitment].status,
      "settled",
    );

    const releasedKey = { ...key, work_order_commitment: "legacy_released" };
    await state.reserveOmnibus({ ...releasedKey, notional_bucket: "25" });
    await state.releaseOmnibus(releasedKey);
    await state.settleOmnibusFill({ ...releasedKey, fill_commitment: "late_legacy_fill" });
    assert.equal(
      (await state.getOmnibusAllocation(key.allocation_commitment))
        .reservations[releasedKey.work_order_commitment].status,
      "released",
    );
  });
});

function placement(overrides = {}) {
  return {
    transition: "reserve",
    venue_id: "coinbase_advanced",
    execution_mode: "partner_omnibus",
    allocation_commitment: "allocation_1",
    work_order_commitment: "work_1",
    operation_class: "spot_market_order",
    client_order_id: "client_1",
    product_id: "BTC-USD",
    side: "buy",
    reserved_amount: "100",
    at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function scoped(overrides = {}) {
  const { reserved_amount: _reservedAmount, ...scope } = placement();
  return { ...scope, ...overrides };
}

function releaseEvent(reservation, proofOverrides = {}) {
  return scoped({
    transition: "release",
    proof: {
      kind: "cancel_confirmed",
      proof_commitment: "cancel_proof_1",
      scope_commitment: reservation.scope_commitment,
      target_client_order_id: "client_1",
      terminal_status: "cancelled",
      observed_filled_amount: reservation.filled_amount,
      provider_order_id: "coinbase_order_1",
      ...proofOverrides,
    },
  });
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ghola-coinbase-reservation-"));
  TEMP_DIRS.push(dir);
  return dir;
}
