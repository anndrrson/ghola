// @vitest-environment node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getLiveTradingLaunchControl,
  getLiveTradingWorkOrderReconciliation,
  inspectLiveTradingDispatchAbsence,
  LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS,
  liveTradingWorkerRequestDigest,
  putLiveTradingWorkOrderReconciliation,
  recordLiveTradingWorkerClaimAbsence,
  reserveLiveTradingNotional,
  resetLiveTradingStoreForTests,
  setLiveTradingSqlClientForTests,
  type LiveTradingWorkOrderReconciliation,
} from "./live-trading-store";

type QueryDescriptor = { text: string; values: unknown[] };
type QueryResult = { rows: Array<Record<string, unknown>> };
type PgClient = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
};
type PgPool = {
  connect(): Promise<PgClient>;
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
};
type PgPoolConstructor = new (options: { connectionString: string; max: number }) => PgPool;

const DATABASE_URL = process.env.GHOLA_TEST_DATABASE_URL;
const integrationDescribe = DATABASE_URL ? describe : describe.skip;
const NOW = new Date("2026-08-19T16:00:00.000Z");

integrationDescribe("live-trading store against local PostgreSQL", () => {
  let adapter: ReturnType<typeof postgresAdapter>;
  let previousStore: string | undefined;

  beforeAll(async () => {
    previousStore = process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "postgres";
    adapter = postgresAdapter(DATABASE_URL as string);
    resetLiveTradingStoreForTests();
    setLiveTradingSqlClientForTests(adapter.sql as never);
    await getLiveTradingLaunchControl();
  });

  beforeEach(async () => {
    await adapter.query(`
      TRUNCATE TABLE
        live_trading_dispatch_absence_probes,
        live_trading_work_order_reconciliations,
        live_trading_notional_reservations
    `);
  });

  afterAll(async () => {
    resetLiveTradingStoreForTests();
    if (previousStore === undefined) delete process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
    else process.env.GHOLA_PRIVATE_ACCOUNT_STORE = previousStore;
    await adapter?.close();
  });

  it("serializes a concurrent absence proof and work-order insert", async () => {
    for (let index = 0; index < 8; index += 1) {
      const record = recoveryRecord(index);
      expect(await inspectLiveTradingDispatchAbsence({
        owner_commitment: record.owner_commitment,
        plan_digest: record.plan_digest,
        now: NOW,
      })).toMatchObject({ status: "pending" });

      adapter.barrierNextTransactions(2);
      const [absence, inserted] = await Promise.all([
        inspectLiveTradingDispatchAbsence({
          owner_commitment: record.owner_commitment,
          plan_digest: record.plan_digest,
          now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
        }),
        putLiveTradingWorkOrderReconciliation(record),
      ]);

      expect(
        (absence.status === "proven" && inserted === false) ||
          (absence.status === "evidence_present" && inserted === true),
      ).toBe(true);
      expect(await getLiveTradingWorkOrderReconciliation({
        owner_commitment: record.owner_commitment,
        plan_digest: record.plan_digest,
      })).toBe(inserted ? record : null);
    }
  });

  it("makes a proven tombstone permanent and releases its orphan reservation", async () => {
    const record = recoveryRecord(8);
    const reserved = await reserve(record, "orphan_reservation", NOW);
    if (!reserved.ok) throw new Error(reserved.error);

    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: NOW,
    })).toMatchObject({ status: "pending" });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
    })).toMatchObject({ status: "proven" });

    const reservation = await adapter.query(
      "SELECT status, reservation FROM live_trading_notional_reservations WHERE reservation_id = $1",
      [reserved.reservation.reservation_id],
    );
    expect(reservation.rows[0]).toMatchObject({
      status: "released",
      reservation: { status: "released" },
    });
    expect(await reserve(
      record,
      "late_reservation",
      new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS + 1),
    )).toEqual({ ok: false, error: "dispatch_absence_proven" });
    expect(await putLiveTradingWorkOrderReconciliation(record)).toBe(false);
  });

  it("keeps the first terminal result and atomically settles its reservation", async () => {
    const record = recoveryRecord(9);
    const reserved = await reserve(record, "terminal_reservation", NOW);
    if (!reserved.ok) throw new Error(reserved.error);
    const pending = { ...record, reservation_id: reserved.reservation.reservation_id };
    expect(await putLiveTradingWorkOrderReconciliation(pending)).toBe(true);

    const filled = {
      ...pending,
      status: "reconciled" as const,
      result_commitment: "result_commitment_postgres_filled",
      order_id: "hyperliquid:postgres-filled",
    };
    const noFill = {
      ...pending,
      status: "no_fill" as const,
      result_commitment: "result_commitment_postgres_no_fill",
      order_id: "hyperliquid:postgres-no-fill",
    };
    adapter.barrierNextTransactions(2);
    const outcomes = await Promise.all([
      putLiveTradingWorkOrderReconciliation(filled),
      putLiveTradingWorkOrderReconciliation(noFill),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const winner = outcomes[0] ? filled : noFill;
    const loser = outcomes[0] ? noFill : filled;
    expect(await putLiveTradingWorkOrderReconciliation(winner)).toBe(true);
    expect(await putLiveTradingWorkOrderReconciliation(loser)).toBe(false);
    expect(await getLiveTradingWorkOrderReconciliation({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
    })).toEqual(winner);

    const joined = await adapter.query(`
      SELECT work.record, reservation.status AS reservation_status,
        reservation.reservation AS reservation_record
      FROM live_trading_work_order_reconciliations AS work
      JOIN live_trading_notional_reservations AS reservation
        ON reservation.reservation_id = work.record->>'reservation_id'
      WHERE work.work_order_commitment = $1
    `, [record.work_order_commitment]);
    expect(joined.rows[0]).toMatchObject({
      record: { status: winner.status },
      reservation_status: winner.status === "reconciled" ? "filled" : "released",
      reservation_record: {
        status: winner.status === "reconciled" ? "filled" : "released",
      },
    });
  });

  it("does not let stale worker-claim absence observations regress evidence", async () => {
    const record = recoveryRecord(10);
    expect(await putLiveTradingWorkOrderReconciliation(record)).toBe(true);
    const fresh = new Date(NOW.getTime() + 60_000);
    const stale = new Date(NOW.getTime() + 30_000);

    const first = await recordLiveTradingWorkerClaimAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      observed_at: fresh,
    });
    const second = await recordLiveTradingWorkerClaimAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      observed_at: stale,
    });
    expect(first?.worker_claim_absence_probe?.observation_count).toBe(1);
    expect(second?.worker_claim_absence_probe?.observation_count).toBe(2);
    expect(second?.worker_claim_absence_probe?.first_observed_at).toBe(
      first?.worker_claim_absence_probe?.first_observed_at,
    );
    expect(Date.parse(second?.worker_claim_absence_probe?.last_observed_at ?? "")).toBe(
      fresh.getTime(),
    );

    const stored = await adapter.query(`
      SELECT updated_at, record->'worker_claim_absence_probe' AS probe
      FROM live_trading_work_order_reconciliations
      WHERE work_order_commitment = $1
    `, [record.work_order_commitment]);
    expect(new Date(stored.rows[0]?.updated_at as string | Date).getTime()).toBe(fresh.getTime());
    expect(Date.parse((stored.rows[0]?.probe as { last_observed_at: string }).last_observed_at)).toBe(
      fresh.getTime(),
    );
  });

  it("freezes recipient, image, expiry, and reservation bindings", async () => {
    const record = recoveryRecord(11);
    expect(await putLiveTradingWorkOrderReconciliation(record)).toBe(true);
    for (const conflicting of [
      { ...record, worker_recipient: "phala:cvm:postgres-other" },
      { ...record, worker_image_digest: `sha256:${"f".repeat(64)}` },
      { ...record, instruction_expires_at: new Date(NOW.getTime() + 30_000).toISOString() },
      { ...record, reservation_id: "reservation_postgres_other" },
    ]) {
      expect(await putLiveTradingWorkOrderReconciliation(conflicting)).toBe(false);
    }
    expect(await getLiveTradingWorkOrderReconciliation({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
    })).toEqual(record);
  });
});

function recoveryRecord(index: number): LiveTradingWorkOrderReconciliation {
  const hex = (index + 1).toString(16);
  const workOrder = `live_trade_work_order_${hex.repeat(48).slice(0, 48)}`;
  const orderPolicy = `live_trade_order_policy_${hex.repeat(48).slice(0, 48)}`;
  const planDigest = `sha256:${hex.repeat(64).slice(0, 64)}`;
  const requestCommitment = `live_trade_request_${hex.repeat(48).slice(0, 48)}`;
  const ownerCommitment = `owner_postgres_${index}`;
  const accountCommitment = `account_postgres_${index}`;
  const request: Record<string, unknown> = {
    version: 1,
    reconciliation_binding_version: 1,
    owner_commitment: ownerCommitment,
    account_commitment: accountCommitment,
    vault_commitment: `vault_postgres_${index}`,
    policy_commitment: `vault_policy_postgres_${index}`,
    order_policy_commitment: orderPolicy,
    plan_digest: planDigest,
    request_commitment: requestCommitment,
    work_order_commitment: workOrder,
    operation_class: "limit_order",
    market: "HYPE",
    session_policy: { policy_commitment: orderPolicy },
  };
  return {
    version: 1,
    work_order_commitment: workOrder,
    owner_commitment: ownerCommitment,
    account_commitment: accountCommitment,
    vault_commitment: String(request.vault_commitment),
    vault_policy_commitment: String(request.policy_commitment),
    order_policy_commitment: orderPolicy,
    plan_digest: planDigest,
    request_commitment: requestCommitment,
    worker_request_digest: liveTradingWorkerRequestDigest(request),
    market: "HYPE",
    require_protection: false,
    protection_slippage_bps: null,
    worker_recipient: "phala:cvm:postgres-test",
    worker_image_digest: `sha256:${"e".repeat(64)}`,
    instruction_expires_at: new Date(NOW.getTime() + 15_000).toISOString(),
    reservation_id: null,
    status: "pending",
    result_commitment: null,
    order_id: null,
    worker_request: request,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function reserve(record: LiveTradingWorkOrderReconciliation, idempotencyKey: string, now: Date) {
  return reserveLiveTradingNotional({
    owner_commitment: record.owner_commitment,
    account_commitment: record.account_commitment,
    idempotency_key: idempotencyKey,
    request_commitment: record.plan_digest,
    notional_usd: 11,
    max_order_notional_usd: 100,
    rolling_24h_notional_usd: 500,
    now,
  });
}

function postgresAdapter(connectionString: string) {
  const require = createRequire(import.meta.url);
  const packagePath = fileURLToPath(new URL("../../../private-agent-worker/node_modules/pg", import.meta.url));
  const { Pool } = require(packagePath) as { Pool: PgPoolConstructor };
  const pool = new Pool({ connectionString, max: 12 });
  let nextBarrier: {
    remaining: number;
    ready: Promise<void>;
    release: () => void;
  } | null = null;

  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = compile(strings, values);
      return (await pool.query(query.text, query.values)).rows;
    },
    {
      transaction: async (builder: (tx: typeof descriptorTag) => QueryDescriptor[]) => {
        const barrier = nextBarrier;
        if (barrier) {
          barrier.remaining -= 1;
          if (barrier.remaining === 0) {
            nextBarrier = null;
            barrier.release();
          }
          await barrier.ready;
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const results: Array<Array<Record<string, unknown>>> = [];
          for (const query of builder(descriptorTag)) {
            results.push((await client.query(query.text, query.values)).rows);
          }
          await client.query("COMMIT");
          return results;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    },
  );

  return {
    sql,
    query: async (text: string, values: unknown[] = []) => (await pool.query(text, values)),
    barrierNextTransactions(participants: number) {
      let release: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextBarrier = { remaining: participants, ready, release };
    },
    close: () => pool.end(),
  };
}

function descriptorTag(strings: TemplateStringsArray, ...values: unknown[]): QueryDescriptor {
  return compile(strings, values);
}

function compile(strings: TemplateStringsArray, values: unknown[]): QueryDescriptor {
  return {
    text: strings.reduce((text, part, index) =>
      `${text}${index === 0 ? "" : `$${index}`}${part}`, ""),
    values,
  };
}
