import type {
  PrivateExecutionAgentConfig,
  PrivateExecutionReceiptV1,
} from "./private-execution";

export interface PrivateExecutionReceiptRecordV1 {
  version: 1;
  receipt_id: string;
  intent_id: string;
  agent_id: string;
  agent_label: string;
  policy_hash: string;
  proposal_hash: string;
  rail: "railgun_private_swap";
  amount_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
  provider_id: string;
  tx_ref: string;
  receipt: PrivateExecutionReceiptV1;
  created_at: string;
}

export interface PrivateExecutionUsageSummaryV1 {
  version: 1;
  agent_id: string;
  execution_count: number;
  total_volume_micro_usdc: number;
  total_fee_micro_usdc: number;
  latest_receipts: PrivateExecutionReceiptRecordV1[];
}

type NeonSql = Awaited<
  ReturnType<typeof import("@neondatabase/serverless")["neon"]>
>;

type PrivateExecutionDbRow = {
  receipt_id: string;
  intent_id: string;
  agent_id: string;
  agent_label: string;
  policy_hash: string;
  proposal_hash: string;
  rail: "railgun_private_swap";
  amount_micro_usdc: number | string;
  fee_micro_usdc: number | string;
  fee_recipient: string;
  provider_id: string;
  tx_ref: string;
  receipt: unknown;
  created_at: string | Date;
};

const memoryRecords = new Map<string, PrivateExecutionReceiptRecordV1>();

let sqlClient: NeonSql | null = null;
let schemaReady = false;

export async function recordPrivateExecutionReceipt(input: {
  receipt: PrivateExecutionReceiptV1;
  agent: PrivateExecutionAgentConfig;
  now?: Date;
}): Promise<PrivateExecutionReceiptRecordV1> {
  const record: PrivateExecutionReceiptRecordV1 = {
    version: 1,
    receipt_id: input.receipt.receipt_id,
    intent_id: input.receipt.intent_id,
    agent_id: input.agent.agent_id,
    agent_label: input.agent.label,
    policy_hash: input.receipt.policy_hash,
    proposal_hash: input.receipt.proposal_hash,
    rail: input.receipt.rail,
    amount_micro_usdc: input.receipt.amount_micro_usdc,
    fee_micro_usdc: input.receipt.fee_quote.fee_micro_usdc,
    fee_recipient: input.receipt.fee_quote.fee_recipient,
    provider_id: input.receipt.provider_id,
    tx_ref: input.receipt.tx_ref,
    receipt: input.receipt,
    created_at: (input.now ?? new Date()).toISOString(),
  };
  await putRecord(record);
  return record;
}

export async function getPrivateExecutionReceiptRecord(
  receiptId: string,
): Promise<PrivateExecutionReceiptRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return memoryRecords.get(receiptId) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_execution_receipts
    WHERE receipt_id = ${receiptId}
    LIMIT 1
  `) as PrivateExecutionDbRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function listPrivateExecutionReceipts(
  agentId: string,
  limit = 25,
): Promise<PrivateExecutionReceiptRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(memoryRecords.values())
      .filter((record) => record.agent_id === agentId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_execution_receipts
    WHERE agent_id = ${agentId}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as PrivateExecutionDbRow[];
  return rows.map(rowToRecord);
}

export async function privateExecutionUsageSummary(
  agentId: string,
): Promise<PrivateExecutionUsageSummaryV1> {
  const receipts = await listPrivateExecutionReceipts(agentId, 100);
  return {
    version: 1,
    agent_id: agentId,
    execution_count: receipts.length,
    total_volume_micro_usdc: receipts.reduce(
      (sum, record) => sum + record.amount_micro_usdc,
      0,
    ),
    total_fee_micro_usdc: receipts.reduce(
      (sum, record) => sum + record.fee_micro_usdc,
      0,
    ),
    latest_receipts: receipts.slice(0, 10),
  };
}

export async function resetPrivateExecutionStoreForTests() {
  memoryRecords.clear();
  if (process.env.GHOLA_PRIVATE_EXECUTION_STORE !== "postgres") {
    sqlClient = null;
    schemaReady = false;
  }
}

async function putRecord(record: PrivateExecutionReceiptRecordV1): Promise<void> {
  const sql = await getSql();
  if (!sql) {
    memoryRecords.set(record.receipt_id, record);
    return;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_execution_receipts (
      receipt_id,
      intent_id,
      agent_id,
      agent_label,
      policy_hash,
      proposal_hash,
      rail,
      amount_micro_usdc,
      fee_micro_usdc,
      fee_recipient,
      provider_id,
      tx_ref,
      receipt,
      created_at
    ) VALUES (
      ${record.receipt_id},
      ${record.intent_id},
      ${record.agent_id},
      ${record.agent_label},
      ${record.policy_hash},
      ${record.proposal_hash},
      ${record.rail},
      ${record.amount_micro_usdc},
      ${record.fee_micro_usdc},
      ${record.fee_recipient},
      ${record.provider_id},
      ${record.tx_ref},
      ${JSON.stringify(record.receipt)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (receipt_id) DO UPDATE SET
      tx_ref = EXCLUDED.tx_ref,
      receipt = EXCLUDED.receipt
  `;
}

async function getSql(): Promise<NeonSql | null> {
  if (!shouldUsePostgresStore()) return null;
  if (sqlClient) return sqlClient;
  const databaseUrl =
    process.env.GHOLA_PRIVATE_EXECUTION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null;
  if (!databaseUrl) return null;
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(databaseUrl);
  return sqlClient;
}

function shouldUsePostgresStore(): boolean {
  if (process.env.GHOLA_PRIVATE_EXECUTION_STORE === "memory") return false;
  if (process.env.GHOLA_PRIVATE_EXECUTION_STORE === "postgres") return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(
    process.env.GHOLA_PRIVATE_EXECUTION_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL,
  );
}

async function ensureSchema(sql: NeonSql): Promise<void> {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS private_execution_receipts (
      receipt_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_label TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      rail TEXT NOT NULL,
      amount_micro_usdc BIGINT NOT NULL,
      fee_micro_usdc BIGINT NOT NULL,
      fee_recipient TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      tx_ref TEXT NOT NULL,
      receipt JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_private_execution_agent_created
    ON private_execution_receipts (agent_id, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_private_execution_intent
    ON private_execution_receipts (intent_id)
  `;
  schemaReady = true;
}

function rowToRecord(row: PrivateExecutionDbRow): PrivateExecutionReceiptRecordV1 {
  return {
    version: 1,
    receipt_id: row.receipt_id,
    intent_id: row.intent_id,
    agent_id: row.agent_id,
    agent_label: row.agent_label,
    policy_hash: row.policy_hash,
    proposal_hash: row.proposal_hash,
    rail: row.rail,
    amount_micro_usdc: Number(row.amount_micro_usdc),
    fee_micro_usdc: Number(row.fee_micro_usdc),
    fee_recipient: row.fee_recipient,
    provider_id: row.provider_id,
    tx_ref: row.tx_ref,
    receipt: parseJson<PrivateExecutionReceiptV1>(row.receipt),
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  };
}

function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
