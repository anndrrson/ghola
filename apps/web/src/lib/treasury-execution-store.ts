import type {
  TreasuryApprovalV1,
  TreasuryExecutionReceiptV1,
  TreasuryPartnerReconciliationV1,
  TreasuryPartnerSubmissionV1,
  TreasuryProposalV1,
  TreasurySimulationResponseV1,
} from "./treasury-execution";

export type TreasuryRecordState =
  | "simulated"
  | "submitted"
  | "settled"
  | "cancelled"
  | "failed";

export interface TreasuryIntentRecordV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  state: TreasuryRecordState;
  policy_hash: string;
  intent_hash: string;
  proposal_hash: string;
  proposal: TreasuryProposalV1;
  approval?: TreasuryApprovalV1;
  receipt?: TreasuryExecutionReceiptV1;
  partner_refs: string[];
  partner_submissions: TreasuryPartnerSubmissionV1[];
  partner_reconciliations: TreasuryPartnerReconciliationV1[];
  blocking_reasons: string[];
  created_at: string;
  updated_at: string;
}

type NeonSql = Awaited<
  ReturnType<typeof import("@neondatabase/serverless")["neon"]>
>;
type TreasuryDbRow = {
  intent_id: string;
  owner_did: string;
  state: TreasuryRecordState;
  policy_hash: string;
  intent_hash: string | null;
  proposal_hash: string;
  proposal: unknown;
  approval: unknown | null;
  receipt: unknown | null;
  partner_refs: unknown | null;
  partner_submissions: unknown | null;
  partner_reconciliations: unknown | null;
  blocking_reasons: unknown | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const memoryRecords = new Map<string, TreasuryIntentRecordV1>();

let sqlClient: NeonSql | null = null;
let schemaReady = false;

export async function recordTreasurySimulation(
  simulation: TreasurySimulationResponseV1,
  now = new Date(),
): Promise<TreasuryIntentRecordV1> {
  const existing = await getTreasuryIntentRecord(simulation.proposal.intent_id);
  const record: TreasuryIntentRecordV1 = {
    version: 1,
    intent_id: simulation.proposal.intent_id,
    owner_did: simulation.proposal.owner_did,
    state: simulation.ok ? "simulated" : "failed",
    policy_hash: simulation.policy_hash,
    intent_hash: simulation.intent_hash,
    proposal_hash: simulation.proposal_hash,
    proposal: simulation.proposal,
    ...(simulation.approval ? { approval: simulation.approval } : {}),
    partner_refs: existing?.partner_refs ?? [],
    partner_submissions: existing?.partner_submissions ?? [],
    partner_reconciliations: existing?.partner_reconciliations ?? [],
    blocking_reasons: simulation.ok
      ? []
      : [simulation.exposure_report.blocked_reason ?? "simulation_blocked"],
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  await putTreasuryIntentRecord(record);
  return record;
}

export async function recordTreasuryExecution(input: {
  receipt: TreasuryExecutionReceiptV1;
  submissions: TreasuryPartnerSubmissionV1[];
  now?: Date;
}): Promise<TreasuryIntentRecordV1> {
  const existing = await getTreasuryIntentRecord(input.receipt.intent_id);
  const now = input.now ?? new Date();
  const proposal =
    existing?.proposal ??
    ({
      version: 1,
      proposal_id: input.receipt.proposal_hash,
      intent_id: input.receipt.intent_id,
      owner_did: input.receipt.owner_did,
      objective: "maintain_runway",
      created_at: input.receipt.executed_at,
      horizon_days: 0,
      amount_micro_usd: input.receipt.amount_micro_usd,
      routes: [],
      approval_required: true,
      public_fallback_allowed: false,
    } satisfies TreasuryProposalV1);
  const record: TreasuryIntentRecordV1 = {
    version: 1,
    intent_id: input.receipt.intent_id,
    owner_did: input.receipt.owner_did,
    state: "submitted",
    policy_hash: input.receipt.policy_hash,
    intent_hash: existing?.intent_hash ?? "",
    proposal_hash: input.receipt.proposal_hash,
    proposal,
    ...(existing?.approval ? { approval: existing.approval } : {}),
    receipt: input.receipt,
    partner_refs: input.receipt.partner_refs,
    partner_submissions: input.submissions,
    partner_reconciliations: [],
    blocking_reasons: [],
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  await putTreasuryIntentRecord(record);
  return record;
}

export async function recordTreasuryReconciliation(input: {
  intentId: string;
  reconciliations: TreasuryPartnerReconciliationV1[];
  now?: Date;
}): Promise<TreasuryIntentRecordV1> {
  const existing = await getTreasuryIntentRecord(input.intentId);
  if (!existing) throw new Error(`treasury intent ${input.intentId} not found`);
  const state = treasuryStateForReconciliations(input.reconciliations);
  const blockingReasons = existing.blocking_reasons.filter(
    (reason) => reason !== "partner_reconciliation_failed",
  );
  if (state === "failed") blockingReasons.push("partner_reconciliation_failed");
  const record: TreasuryIntentRecordV1 = {
    ...existing,
    state,
    partner_reconciliations: input.reconciliations,
    blocking_reasons: blockingReasons,
    updated_at: (input.now ?? new Date()).toISOString(),
  };
  await putTreasuryIntentRecord(record);
  return record;
}

export async function getTreasuryIntentRecord(
  intentId: string,
): Promise<TreasuryIntentRecordV1 | null> {
  const sql = await getTreasurySql();
  if (!sql) return memoryRecords.get(intentId) ?? null;
  await ensureTreasurySchema(sql);
  const rows = (await sql`
    SELECT
      intent_id,
      owner_did,
      state,
      policy_hash,
      intent_hash,
      proposal_hash,
      proposal,
      approval,
      receipt,
      partner_refs,
      partner_submissions,
      partner_reconciliations,
      blocking_reasons,
      created_at,
      updated_at
    FROM treasury_intents
    WHERE intent_id = ${intentId}
    LIMIT 1
  `) as TreasuryDbRow[];
  return rows[0] ? rowToTreasuryRecord(rows[0]) : null;
}

export async function resetTreasuryExecutionStoreForTests() {
  memoryRecords.clear();
  if (process.env.GHOLA_TREASURY_STORE !== "postgres") {
    sqlClient = null;
    schemaReady = false;
  }
}

async function putTreasuryIntentRecord(
  record: TreasuryIntentRecordV1,
): Promise<void> {
  const sql = await getTreasurySql();
  if (!sql) {
    memoryRecords.set(record.intent_id, record);
    return;
  }
  await ensureTreasurySchema(sql);
  await sql`
    INSERT INTO treasury_intents (
      intent_id,
      owner_did,
      state,
      policy_hash,
      intent_hash,
      proposal_hash,
      proposal,
      approval,
      receipt,
      partner_refs,
      partner_submissions,
      partner_reconciliations,
      blocking_reasons,
      created_at,
      updated_at
    ) VALUES (
      ${record.intent_id},
      ${record.owner_did},
      ${record.state},
      ${record.policy_hash},
      ${record.intent_hash},
      ${record.proposal_hash},
      ${JSON.stringify(record.proposal)}::jsonb,
      ${record.approval ? JSON.stringify(record.approval) : null}::jsonb,
      ${record.receipt ? JSON.stringify(record.receipt) : null}::jsonb,
      ${JSON.stringify(record.partner_refs)}::jsonb,
      ${JSON.stringify(record.partner_submissions)}::jsonb,
      ${JSON.stringify(record.partner_reconciliations)}::jsonb,
      ${JSON.stringify(record.blocking_reasons)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (intent_id) DO UPDATE SET
      owner_did = EXCLUDED.owner_did,
      state = EXCLUDED.state,
      policy_hash = EXCLUDED.policy_hash,
      intent_hash = EXCLUDED.intent_hash,
      proposal_hash = EXCLUDED.proposal_hash,
      proposal = EXCLUDED.proposal,
      approval = EXCLUDED.approval,
      receipt = EXCLUDED.receipt,
      partner_refs = EXCLUDED.partner_refs,
      partner_submissions = EXCLUDED.partner_submissions,
      partner_reconciliations = EXCLUDED.partner_reconciliations,
      blocking_reasons = EXCLUDED.blocking_reasons,
      updated_at = EXCLUDED.updated_at
  `;
}

async function getTreasurySql(): Promise<NeonSql | null> {
  if (!shouldUsePostgresStore()) return null;
  if (sqlClient) return sqlClient;
  const databaseUrl = treasuryDatabaseUrl();
  if (!databaseUrl) return null;
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(databaseUrl);
  return sqlClient;
}

function shouldUsePostgresStore(): boolean {
  if (process.env.GHOLA_TREASURY_STORE === "memory") return false;
  if (process.env.GHOLA_TREASURY_STORE === "postgres") return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(treasuryDatabaseUrl());
}

function treasuryDatabaseUrl(): string | null {
  return (
    process.env.GHOLA_TREASURY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null
  );
}

async function ensureTreasurySchema(sql: NeonSql): Promise<void> {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS treasury_intents (
      intent_id TEXT PRIMARY KEY,
      owner_did TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('simulated', 'submitted', 'settled', 'cancelled', 'failed')),
      policy_hash TEXT NOT NULL,
      intent_hash TEXT NOT NULL DEFAULT '',
      proposal_hash TEXT NOT NULL,
      proposal JSONB NOT NULL,
      approval JSONB,
      receipt JSONB,
      partner_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      partner_submissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      partner_reconciliations JSONB NOT NULL DEFAULT '[]'::jsonb,
      blocking_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    ALTER TABLE treasury_intents
    ADD COLUMN IF NOT EXISTS partner_reconciliations JSONB NOT NULL DEFAULT '[]'::jsonb
  `;
  await sql`
    ALTER TABLE treasury_intents
    DROP CONSTRAINT IF EXISTS treasury_intents_state_check
  `;
  await sql`
    ALTER TABLE treasury_intents
    ADD CONSTRAINT treasury_intents_state_check
    CHECK (state IN ('simulated', 'submitted', 'settled', 'cancelled', 'failed'))
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_treasury_intents_owner_updated
    ON treasury_intents (owner_did, updated_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_treasury_intents_proposal_hash
    ON treasury_intents (proposal_hash)
  `;
  schemaReady = true;
}

function rowToTreasuryRecord(row: TreasuryDbRow): TreasuryIntentRecordV1 {
  return {
    version: 1,
    intent_id: row.intent_id,
    owner_did: row.owner_did,
    state: row.state,
    policy_hash: row.policy_hash,
    intent_hash: row.intent_hash ?? "",
    proposal_hash: row.proposal_hash,
    proposal: parseJson<TreasuryProposalV1>(row.proposal),
    ...optionalJson("approval", row.approval),
    ...optionalJson("receipt", row.receipt),
    partner_refs: parseJson<string[]>(row.partner_refs, []),
    partner_submissions: parseJson<TreasuryPartnerSubmissionV1[]>(
      row.partner_submissions,
      [],
    ),
    partner_reconciliations: parseJson<TreasuryPartnerReconciliationV1[]>(
      row.partner_reconciliations,
      [],
    ),
    blocking_reasons: parseJson<string[]>(row.blocking_reasons, []),
    created_at: timestampToIso(row.created_at),
    updated_at: timestampToIso(row.updated_at),
  };
}

function optionalJson<K extends "approval" | "receipt">(
  key: K,
  value: unknown,
): K extends "approval"
  ? { approval?: TreasuryApprovalV1 }
  : { receipt?: TreasuryExecutionReceiptV1 } {
  if (value === null || value === undefined) return {} as never;
  return { [key]: parseJson(value) } as never;
}

function parseJson<T>(value: unknown, fallback?: T): T {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error("missing treasury JSON value");
  }
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function timestampToIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function treasuryStateForReconciliations(
  reconciliations: TreasuryPartnerReconciliationV1[],
): TreasuryRecordState {
  if (reconciliations.length === 0) return "submitted";
  if (reconciliations.some((item) => item.reconciliation_state === "failed")) {
    return "failed";
  }
  if (reconciliations.every((item) => item.reconciliation_state === "cancelled")) {
    return "cancelled";
  }
  if (reconciliations.every((item) => item.reconciliation_state === "settled")) {
    return "settled";
  }
  return "submitted";
}
