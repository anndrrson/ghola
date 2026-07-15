import {
  applyCrossVenueWorkerReport,
  requestCrossVenueCancellation,
  type CrossVenueExecutionPlan,
  type CrossVenueWorkerReport,
} from "./cross-venue-execution";
import { createHash } from "node:crypto";

type NeonSql = Awaited<ReturnType<typeof import("@neondatabase/serverless")["neon"]>>;

const memory = new Map<string, CrossVenueExecutionPlan>();
const idempotency = new Map<string, string>();
let memoryQueue = Promise.resolve();
let sqlClient: NeonSql | null = null;
let schemaReady = false;

export async function createStoredCrossVenueExecution(plan: CrossVenueExecutionPlan): Promise<{
  plan: CrossVenueExecutionPlan;
  disposition: "created" | "replayed" | "conflict";
}> {
  const sql = await getSql();
  const key = `${plan.owner_commitment}:${plan.idempotency_key}`;
  if (!sql) {
    return memoryCritical(async () => {
      const existingId = idempotency.get(key);
      if (existingId) {
        const existing = memory.get(existingId)!;
        return {
          plan: existing,
          disposition: sameRequest(existing, plan) ? "replayed" as const : "conflict" as const,
        };
      }
      memory.set(plan.execution_id, plan);
      idempotency.set(key, plan.execution_id);
      return { plan, disposition: "created" as const };
    });
  }
  await ensureSchema(sql);
  const inserted = await sql`
    INSERT INTO cross_venue_execution_plans (
      execution_id, owner_commitment, idempotency_key, opportunity_commitment,
      status, plan, created_at, updated_at
    ) VALUES (
      ${plan.execution_id}, ${plan.owner_commitment}, ${plan.idempotency_key}, ${plan.opportunity_commitment},
      ${plan.status}, ${JSON.stringify(plan)}::jsonb, ${plan.created_at}, ${plan.updated_at}
    ) ON CONFLICT (owner_commitment, idempotency_key) DO NOTHING
    RETURNING plan
  ` as Array<{ plan: CrossVenueExecutionPlan }>;
  if (inserted[0]) return { plan: planRow(inserted[0].plan), disposition: "created" };
  const existing = await getStoredCrossVenueExecution({ execution_id: plan.execution_id, owner_commitment: plan.owner_commitment });
  if (!existing) throw new Error("cross_venue_idempotency_lookup_failed");
  return { plan: existing, disposition: sameRequest(existing, plan) ? "replayed" : "conflict" };
}

export async function getStoredCrossVenueExecution(input: {
  execution_id: string;
  owner_commitment?: string;
}): Promise<CrossVenueExecutionPlan | null> {
  const sql = await getSql();
  if (!sql) {
    const plan = memory.get(input.execution_id);
    return plan && (!input.owner_commitment || plan.owner_commitment === input.owner_commitment) ? plan : null;
  }
  await ensureSchema(sql);
  const rows = (input.owner_commitment
    ? await sql`SELECT plan FROM cross_venue_execution_plans WHERE execution_id = ${input.execution_id} AND owner_commitment = ${input.owner_commitment} LIMIT 1`
    : await sql`SELECT plan FROM cross_venue_execution_plans WHERE execution_id = ${input.execution_id} LIMIT 1`) as Array<{ plan: CrossVenueExecutionPlan }>;
  return rows[0] ? planRow(rows[0].plan) : null;
}

export async function listStoredCrossVenueExecutions(input: {
  owner_commitment: string;
  limit?: number;
}): Promise<CrossVenueExecutionPlan[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(memory.values())
      .filter((plan) => plan.owner_commitment === input.owner_commitment)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT plan FROM cross_venue_execution_plans
    WHERE owner_commitment = ${input.owner_commitment}
    ORDER BY created_at DESC LIMIT ${limit}
  ` as Array<{ plan: CrossVenueExecutionPlan }>;
  return rows.map((row) => planRow(row.plan));
}

export async function hasActiveCrossVenueExposure(): Promise<boolean> {
  const active = ["planned", "submitting", "legs_open", "unhedged", "partially_hedged", "hedging", "unwinding", "manual_intervention_required"];
  const sql = await getSql();
  if (!sql) return Array.from(memory.values()).some((plan) => active.includes(plan.status));
  await ensureSchema(sql);
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1 FROM cross_venue_execution_plans WHERE status = ANY(${active}::text[])
    ) AS active
  ` as Array<{ active: boolean }>;
  return rows[0]?.active === true;
}

export async function getCrossVenueReconciliationHealth(now = new Date()): Promise<{
  ready: boolean;
  overdue_execution_count: number;
  oldest_unreconciled_age_ms: number;
}> {
  const active = ["submitting", "legs_open", "unhedged", "partially_hedged", "hedging", "unwinding", "manual_intervention_required"];
  const cutoff = new Date(now.getTime() - 60_000);
  const sql = await getSql();
  if (!sql) {
    const pending = Array.from(memory.values()).filter((plan) => active.includes(plan.status));
    const ages = pending.map((plan) => Math.max(0, now.getTime() - Date.parse(plan.updated_at)));
    const oldest = ages.length ? Math.max(...ages) : 0;
    return { ready: oldest <= 60_000, overdue_execution_count: ages.filter((age) => age > 60_000).length, oldest_unreconciled_age_ms: oldest };
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE updated_at < ${cutoff.toISOString()})::integer AS overdue_execution_count,
      COALESCE(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - MIN(updated_at))) * 1000, 0)::bigint AS oldest_unreconciled_age_ms
    FROM cross_venue_execution_plans WHERE status = ANY(${active}::text[])
  ` as Array<{ overdue_execution_count: number; oldest_unreconciled_age_ms: number }>;
  const overdue = Number(rows[0]?.overdue_execution_count ?? 0);
  return { ready: overdue === 0, overdue_execution_count: overdue, oldest_unreconciled_age_ms: Number(rows[0]?.oldest_unreconciled_age_ms ?? 0) };
}

export async function markCrossVenueExecutionSubmitting(input: {
  execution_id: string;
  owner_commitment: string;
  worker_receipt?: unknown;
  now?: Date;
}): Promise<CrossVenueExecutionPlan | null> {
  return mutate(input, (current) => {
    if (!["planned", "submitting"].includes(current.status)) return current;
    const now = input.now ?? new Date();
    return {
      ...current,
      status: current.status === "planned" ? "submitting" : current.status,
      worker_receipt_commitment: input.worker_receipt
        ? receiptCommitment(input.worker_receipt)
        : current.worker_receipt_commitment,
      updated_at: now.toISOString(),
    };
  });
}

export async function applyStoredCrossVenueWorkerReport(input: {
  execution_id: string;
  owner_commitment: string;
  report: CrossVenueWorkerReport;
}): Promise<{ ok: true; plan: CrossVenueExecutionPlan } | { ok: false; error: string }> {
  try {
    const plan = await mutate(input, (current) => applyCrossVenueWorkerReport(current, input.report), input.report);
    return plan ? { ok: true, plan } : { ok: false, error: "cross_venue_execution_not_found" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "cross_venue_report_invalid" };
  }
}

export async function cancelStoredCrossVenueExecution(input: {
  execution_id: string;
  owner_commitment: string;
  now?: Date;
}): Promise<CrossVenueExecutionPlan | null> {
  return mutate(input, (current) => requestCrossVenueCancellation(current, input.now));
}

export function resetCrossVenueExecutionStoreForTests() {
  memory.clear();
  idempotency.clear();
  if (!shouldUsePostgres()) {
    sqlClient = null;
    schemaReady = false;
  }
}

async function mutate(
  input: { execution_id: string; owner_commitment: string },
  update: (current: CrossVenueExecutionPlan) => CrossVenueExecutionPlan,
  report?: CrossVenueWorkerReport,
): Promise<CrossVenueExecutionPlan | null> {
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = memory.get(input.execution_id);
      if (!current || current.owner_commitment !== input.owner_commitment) return null;
      const next = update(current);
      memory.set(next.execution_id, next);
      return next;
    });
  }
  await ensureSchema(sql);
  const current = await getStoredCrossVenueExecution(input);
  if (!current) return null;
  const next = update(current);
  const expectedSequence = current.last_report_sequence;
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.execution_id}, 0))
    ), current_plan AS (
      SELECT plan FROM cross_venue_execution_plans, lock_guard
      WHERE execution_id = ${input.execution_id} AND owner_commitment = ${input.owner_commitment}
        AND COALESCE((plan->>'last_report_sequence')::integer, 0) = ${expectedSequence}
      FOR UPDATE
    ), updated AS (
      UPDATE cross_venue_execution_plans p
      SET plan = ${JSON.stringify(next)}::jsonb, status = ${next.status}, updated_at = ${next.updated_at}
      FROM current_plan
      WHERE p.execution_id = ${input.execution_id} AND p.owner_commitment = ${input.owner_commitment}
      RETURNING p.plan
    ), event AS (
      INSERT INTO cross_venue_execution_events (event_id, execution_id, sequence, report, created_at)
      SELECT ${`${input.execution_id}:${report?.sequence ?? `state:${next.updated_at}`}`}, ${input.execution_id},
        ${report?.sequence ?? null}, ${JSON.stringify(report ?? { status: next.status })}::jsonb, ${next.updated_at}
      FROM updated
      ON CONFLICT (event_id) DO NOTHING
    ) SELECT plan FROM updated
  ` as Array<{ plan: CrossVenueExecutionPlan }>;
  if (!rows[0]) throw new Error(report ? "report_sequence_conflict" : "execution_state_conflict");
  return planRow(rows[0].plan);
}

function sameRequest(left: CrossVenueExecutionPlan, right: CrossVenueExecutionPlan) {
  return left.opportunity_commitment === right.opportunity_commitment &&
    left.matched_notional_micro_usdc === right.matched_notional_micro_usdc &&
    JSON.stringify(left.risk_budget) === JSON.stringify(right.risk_budget);
}

function planRow(value: CrossVenueExecutionPlan | string): CrossVenueExecutionPlan {
  return typeof value === "string" ? JSON.parse(value) as CrossVenueExecutionPlan : value;
}

function receiptCommitment(value: unknown) {
  return `consumer_worker_receipt_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48)}`;
}

async function getSql(): Promise<NeonSql | null> {
  if (!shouldUsePostgres()) return null;
  if (sqlClient) return sqlClient;
  const url = process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(url);
  return sqlClient;
}

function shouldUsePostgres() {
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "memory") return false;
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "postgres") return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

async function ensureSchema(sql: NeonSql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS cross_venue_execution_plans (
      execution_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      opportunity_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      plan JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (owner_commitment, idempotency_key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS cross_venue_execution_events (
      event_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES cross_venue_execution_plans(execution_id),
      sequence INTEGER,
      report JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cross_venue_owner_created ON cross_venue_execution_plans (owner_commitment, created_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_venue_event_sequence ON cross_venue_execution_events (execution_id, sequence) WHERE sequence IS NOT NULL`;
  schemaReady = true;
}

function memoryCritical<T>(operation: () => Promise<T>): Promise<T> {
  const next = memoryQueue.then(operation, operation);
  memoryQueue = next.then(() => undefined, () => undefined);
  return next;
}
