type NeonSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

export type PrivateAgentRuntimeLeaseState = "active" | "stopped";

export interface PrivateAgentRuntimeLeaseRecord {
  version: 1;
  provider_id: string;
  state: PrivateAgentRuntimeLeaseState;
  last_activity_at: string;
  lease_expires_at: string;
  last_reason: string;
  updated_at: string;
}

interface LeaseRow {
  provider_id: string;
  state: string;
  last_activity_at: Date | string;
  lease_expires_at: Date | string;
  last_reason: string;
  updated_at: Date | string;
}

const leases = new Map<string, PrivateAgentRuntimeLeaseRecord>();

let sqlClient: NeonSql | null = null;
let schemaReady = false;

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function shouldUsePostgresStore(): boolean {
  if (process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE === "memory") return false;
  if (process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE === "postgres") return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(
    process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL,
  );
}

async function getSql(): Promise<NeonSql | null> {
  if (!shouldUsePostgresStore()) return null;
  if (sqlClient) return sqlClient;
  const databaseUrl =
    process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null;
  if (!databaseUrl) return null;
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(databaseUrl) as NeonSql;
  return sqlClient;
}

async function ensureSchema(sql: NeonSql): Promise<void> {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS private_agent_runtime_leases (
      provider_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      last_activity_at TIMESTAMPTZ NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      last_reason TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_agent_runtime_leases_expires ON private_agent_runtime_leases (lease_expires_at DESC)`;
  schemaReady = true;
}

function leaseRow(row: LeaseRow): PrivateAgentRuntimeLeaseRecord {
  return {
    version: 1,
    provider_id: row.provider_id,
    state: row.state === "active" ? "active" : "stopped",
    last_activity_at: dateString(row.last_activity_at),
    lease_expires_at: dateString(row.lease_expires_at),
    last_reason: row.last_reason,
    updated_at: dateString(row.updated_at),
  };
}

export function privateAgentRuntimeLeaseActive(
  record: PrivateAgentRuntimeLeaseRecord | null,
  now: Date = new Date(),
): boolean {
  if (!record || record.state !== "active") return false;
  return new Date(record.lease_expires_at).getTime() > now.getTime();
}

export async function markPrivateAgentRuntimeActivity(input: {
  provider_id: string;
  reason: string;
  lease_ms: number;
  now?: Date;
}): Promise<PrivateAgentRuntimeLeaseRecord> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseMs = Math.max(60_000, Math.floor(input.lease_ms));
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const record: PrivateAgentRuntimeLeaseRecord = {
    version: 1,
    provider_id: input.provider_id,
    state: "active",
    last_activity_at: nowIso,
    lease_expires_at: leaseExpiresAt,
    last_reason: input.reason,
    updated_at: nowIso,
  };

  const sql = await getSql();
  if (!sql) {
    leases.set(input.provider_id, record);
    return record;
  }

  await ensureSchema(sql);
  await sql`
    INSERT INTO private_agent_runtime_leases (
      provider_id,
      state,
      last_activity_at,
      lease_expires_at,
      last_reason,
      updated_at
    ) VALUES (
      ${record.provider_id},
      ${record.state},
      ${record.last_activity_at},
      ${record.lease_expires_at},
      ${record.last_reason},
      ${record.updated_at}
    )
    ON CONFLICT (provider_id) DO UPDATE SET
      state = EXCLUDED.state,
      last_activity_at = EXCLUDED.last_activity_at,
      lease_expires_at = EXCLUDED.lease_expires_at,
      last_reason = EXCLUDED.last_reason,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function markPrivateAgentRuntimeStopped(input: {
  provider_id: string;
  reason: string;
  now?: Date;
}): Promise<PrivateAgentRuntimeLeaseRecord> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const existing = await getPrivateAgentRuntimeLease(input.provider_id);
  const record: PrivateAgentRuntimeLeaseRecord = {
    version: 1,
    provider_id: input.provider_id,
    state: "stopped",
    last_activity_at: existing?.last_activity_at ?? nowIso,
    lease_expires_at: nowIso,
    last_reason: input.reason,
    updated_at: nowIso,
  };

  const sql = await getSql();
  if (!sql) {
    leases.set(input.provider_id, record);
    return record;
  }

  await ensureSchema(sql);
  await sql`
    INSERT INTO private_agent_runtime_leases (
      provider_id,
      state,
      last_activity_at,
      lease_expires_at,
      last_reason,
      updated_at
    ) VALUES (
      ${record.provider_id},
      ${record.state},
      ${record.last_activity_at},
      ${record.lease_expires_at},
      ${record.last_reason},
      ${record.updated_at}
    )
    ON CONFLICT (provider_id) DO UPDATE SET
      state = EXCLUDED.state,
      lease_expires_at = EXCLUDED.lease_expires_at,
      last_reason = EXCLUDED.last_reason,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateAgentRuntimeLease(
  providerId: string,
): Promise<PrivateAgentRuntimeLeaseRecord | null> {
  const sql = await getSql();
  if (!sql) return leases.get(providerId) ?? null;

  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_agent_runtime_leases
    WHERE provider_id = ${providerId}
    LIMIT 1
  `) as LeaseRow[];
  return rows[0] ? leaseRow(rows[0]) : null;
}

export function resetPrivateAgentRuntimeLeaseStoreForTests() {
  leases.clear();
  if (process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE !== "postgres") {
    sqlClient = null;
    schemaReady = false;
  }
}
