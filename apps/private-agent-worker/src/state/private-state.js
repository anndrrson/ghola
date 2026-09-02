import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { finalizeRevenueEvidenceEvent } from "../execution/revenue-evidence.js";
import { hasExactCarryFlatReconciliation } from "../execution/carry-reconciliation.js";

const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    sessions: {},
    idempotency: {},
    policy_counts: {},
    policy_amounts: {},
    execution_attempts: {},
    capability_jtis: {},
    autopilot_sessions: {},
    autopilot_events: {},
    autopilot_decisions: {},
    autopilot_positions: {},
    autopilot_opportunities: {},
    executor_records: {},
    tick_snapshots: {},
    multi_leg_sagas: {},
    carry_positions: {},
    carry_exposure_reservations: {},
    carry_lifecycle_events: {},
    revenue_evidence: [],
    hyperliquid_managed_allocations: {},
    omnibus: {},
    updated_at: new Date().toISOString(),
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function createWorkerState(dir) {
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "private-agent-execution-state-v1.json");
  const hmacPath = join(dir, "private-agent-client-order-hmac.hex");
  if (!existsSync(hmacPath)) {
    writeFileSync(hmacPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  const hmacSecret = readFileSync(hmacPath, "utf8").trim();

  function load() {
    const loaded = readJson(statePath, emptyState());
    return {
      ...emptyState(),
      ...loaded,
      sessions: loaded.sessions || {},
      idempotency: loaded.idempotency || {},
      policy_counts: loaded.policy_counts || {},
      policy_amounts: loaded.policy_amounts || {},
      execution_attempts: loaded.execution_attempts || {},
      capability_jtis: loaded.capability_jtis || {},
      autopilot_sessions: loaded.autopilot_sessions || {},
      autopilot_events: loaded.autopilot_events || {},
      autopilot_decisions: loaded.autopilot_decisions || {},
      autopilot_positions: loaded.autopilot_positions || {},
      autopilot_opportunities: loaded.autopilot_opportunities || {},
      executor_records: loaded.executor_records || {},
      tick_snapshots: loaded.tick_snapshots || {},
      multi_leg_sagas: loaded.multi_leg_sagas || {},
      carry_positions: loaded.carry_positions || {},
      carry_exposure_reservations: loaded.carry_exposure_reservations || {},
      carry_lifecycle_events: loaded.carry_lifecycle_events || {},
      revenue_evidence: Array.isArray(loaded.revenue_evidence) ? loaded.revenue_evidence : [],
      hyperliquid_managed_allocations: loaded.hyperliquid_managed_allocations || {},
      omnibus: loaded.omnibus || {},
    };
  }

  function save(state) {
    writeJsonAtomic(statePath, {
      ...state,
      version: STATE_VERSION,
      updated_at: new Date().toISOString(),
    });
  }

  return createWorkerStateAdapter({
    path: statePath,
    hmacSecret,
    load,
    save,
  });
}

export function createConfiguredWorkerState(dir, env = process.env) {
  const store = String(env.PRIVATE_AGENT_STATE_STORE || env.GHOLA_PRIVATE_AGENT_STATE_STORE || "json").toLowerCase();
  if (store === "json" || store === "file") return createWorkerState(dir);
  if (store === "sqlite" || store === "sql") {
    const dbPath = env.PRIVATE_AGENT_STATE_SQLITE_PATH ||
      env.GHOLA_PRIVATE_AGENT_STATE_SQLITE_PATH ||
      join(dir, "private-agent-worker-state.sqlite");
    return createSqliteWorkerState(dbPath);
  }
  if (store === "postgres" || store === "postgresql" || store === "neon") {
    const databaseUrl = env.PRIVATE_AGENT_STATE_POSTGRES_URL ||
      env.GHOLA_PRIVATE_AGENT_STATE_POSTGRES_URL ||
      env.PRIVATE_AGENT_DATABASE_URL ||
      env.DATABASE_URL ||
      "";
    return createPostgresWorkerState(databaseUrl);
  }
  throw new Error(`unsupported PRIVATE_AGENT_STATE_STORE: ${store}`);
}

export function createSqliteWorkerState(dbPath) {
  const require = createRequire(import.meta.url);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    throw new Error(`PRIVATE_AGENT_STATE_STORE=sqlite requires node:sqlite support: ${error.message}`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS worker_state_documents (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_state_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_state_ledger (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      state_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const secretRow = db.prepare("SELECT value FROM worker_state_secrets WHERE key = ?").get("client_order_hmac");
  let hmacSecret = secretRow?.value;
  if (!hmacSecret) {
    hmacSecret = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO worker_state_secrets (key, value, created_at) VALUES (?, ?, ?)").run(
      "client_order_hmac",
      hmacSecret,
      new Date().toISOString(),
    );
  }

  function load() {
    const row = db.prepare("SELECT state_json FROM worker_state_documents WHERE id = ?").get("private-agent-execution-state-v1");
    if (!row?.state_json) return emptyState();
    try {
      return JSON.parse(row.state_json);
    } catch {
      return emptyState();
    }
  }

  function persist(state) {
    const next = {
      ...state,
      version: STATE_VERSION,
      updated_at: new Date().toISOString(),
    };
    const stateJson = JSON.stringify(next);
    const stateSha = createHash("sha256").update(stateJson).digest("hex");
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO worker_state_documents (id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run("private-agent-execution-state-v1", stateJson, now);
    db.prepare(`
      INSERT INTO worker_state_ledger (document_id, state_json, state_sha256, created_at)
      VALUES (?, ?, ?, ?)
    `).run("private-agent-execution-state-v1", stateJson, stateSha, now);
  }

  function save(state) {
    db.exec("BEGIN IMMEDIATE");
    try {
      persist(state);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function atomicUpdate(mutator) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = normalizeState(load());
      const result = mutator(state);
      if (result && typeof result.then === "function") {
        throw new Error("sqlite atomic state mutation must be synchronous");
      }
      persist(state);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return createWorkerStateAdapter({
    path: dbPath,
    hmacSecret,
    load,
    save,
    atomicUpdate,
  });
}

export function createPostgresWorkerState(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("PRIVATE_AGENT_STATE_STORE=postgres requires PRIVATE_AGENT_STATE_POSTGRES_URL or DATABASE_URL");
  }
  let sqlPromise = null;
  let poolPromise = null;
  let initPromise = null;
  let hmacSecretPromise = null;

  async function sqlClient() {
    if (!sqlPromise) {
      sqlPromise = import("@neondatabase/serverless").then(({ neon }) => neon(databaseUrl));
    }
    return sqlPromise;
  }

  async function transactionPool() {
    if (!poolPromise) {
      poolPromise = import("@neondatabase/serverless")
        .then(({ Pool }) => new Pool({ connectionString: databaseUrl }));
    }
    return poolPromise;
  }

  async function ensureInitialized() {
    const sql = await sqlClient();
    if (!initPromise) {
      initPromise = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS worker_state_documents (
            id TEXT PRIMARY KEY,
            state_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_state_secrets (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_sessions (
            session_commitment TEXT PRIMARY KEY,
            session_json JSONB NOT NULL,
            venue_id TEXT,
            vault_commitment TEXT,
            policy_commitment TEXT,
            allocation_commitment TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_venue
          ON worker_sessions (venue_id, updated_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_vault
          ON worker_sessions (vault_commitment, updated_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_policy
          ON worker_sessions (policy_commitment, updated_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_allocation
          ON worker_sessions (allocation_commitment, updated_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_idempotency (
            work_order_commitment TEXT PRIMARY KEY,
            receipt_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_carry_exposure_reservations (
            reservation_key TEXT PRIMARY KEY,
            position_id TEXT NOT NULL,
            bindings_commitment TEXT NOT NULL,
            reservation_json JSONB NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            generation INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`ALTER TABLE worker_carry_exposure_reservations ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1`;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_execution_attempts (
            work_order_commitment TEXT PRIMARY KEY,
            attempt_json JSONB NOT NULL,
            status TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_capability_jtis (
            jti TEXT PRIMARY KEY,
            expires_at_unix BIGINT NOT NULL,
            consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_policy_counts (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_policy_amounts (
            key TEXT PRIMARY KEY,
            amount DOUBLE PRECISION NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_sessions (
            autopilot_session_id TEXT PRIMARY KEY,
            owner_commitment TEXT,
            session_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_sessions_owner
          ON worker_autopilot_sessions (owner_commitment, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_events (
            event_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            event_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_events_session
          ON worker_autopilot_events (autopilot_session_id, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_decisions (
            decision_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            decision_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_decisions_session
          ON worker_autopilot_decisions (autopilot_session_id, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_positions (
            autopilot_session_id TEXT NOT NULL,
            position_key TEXT NOT NULL,
            position_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (autopilot_session_id, position_key)
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_positions_session
          ON worker_autopilot_positions (autopilot_session_id, updated_at DESC)
        `;
        await sql`
        CREATE TABLE IF NOT EXISTS worker_autopilot_opportunities (
          opportunity_id TEXT PRIMARY KEY,
          autopilot_session_id TEXT NOT NULL,
          opportunity_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
        CREATE INDEX IF NOT EXISTS idx_worker_autopilot_opportunities_session
          ON worker_autopilot_opportunities (autopilot_session_id, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_executor_records (
            executor_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            agent_controller_id TEXT,
            status TEXT,
            executor_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_executor_records_session
          ON worker_executor_records (autopilot_session_id, created_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_executor_records_controller
          ON worker_executor_records (agent_controller_id, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_tick_snapshots (
            tick_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            agent_controller_id TEXT,
            status TEXT,
            tick_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_tick_snapshots_session
          ON worker_tick_snapshots (autopilot_session_id, created_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_tick_snapshots_controller
          ON worker_tick_snapshots (agent_controller_id, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_multi_leg_sagas (
            saga_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            terminal BOOLEAN NOT NULL DEFAULT FALSE,
            last_event_sequence INTEGER NOT NULL,
            saga_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_multi_leg_sagas_active
          ON worker_multi_leg_sagas (terminal, updated_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_carry_positions (
            position_id TEXT PRIMARY KEY,
            owner_commitment TEXT NOT NULL,
            status TEXT NOT NULL,
            record_version BIGINT NOT NULL,
            record_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_positions_owner
          ON worker_carry_positions (owner_commitment, updated_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_positions_status
          ON worker_carry_positions (status, updated_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_positions_scan
          ON worker_carry_positions ((record_json->>'updated_at') DESC, position_id DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_positions_owner_scan
          ON worker_carry_positions (owner_commitment, (record_json->>'updated_at') DESC, position_id DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_positions_status_scan
          ON worker_carry_positions (status, (record_json->>'updated_at') DESC, position_id DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_positions_owner_status_scan
          ON worker_carry_positions (owner_commitment, status, (record_json->>'updated_at') DESC, position_id DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_carry_lifecycle_events (
            position_id TEXT NOT NULL,
            sequence BIGINT NOT NULL,
            event_id TEXT NOT NULL,
            previous_event_commitment TEXT,
            event_commitment TEXT NOT NULL,
            event_json JSONB NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (position_id, sequence),
            UNIQUE (position_id, event_id),
            UNIQUE (event_commitment)
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_carry_lifecycle_events_position_sequence
          ON worker_carry_lifecycle_events (position_id, sequence ASC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_revenue_events (
            revenue_event_id TEXT PRIMARY KEY,
            work_order_commitment TEXT UNIQUE,
            autopilot_session_id TEXT,
            venue_id TEXT,
            revenue_status TEXT,
            event_hash TEXT NOT NULL UNIQUE,
            previous_event_hash TEXT,
            event_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_revenue_events_created
          ON worker_revenue_events (created_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_revenue_events_session
          ON worker_revenue_events (autopilot_session_id, created_at DESC)
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_revenue_events_venue
          ON worker_revenue_events (venue_id, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_hyperliquid_managed_allocations (
            allocation_commitment TEXT PRIMARY KEY,
            allocation_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_omnibus_allocations (
            allocation_commitment TEXT PRIMARY KEY,
            allocation_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_omnibus_reservations (
            allocation_commitment TEXT NOT NULL,
            work_order_commitment TEXT NOT NULL,
            reservation_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (allocation_commitment, work_order_commitment)
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_omnibus_reservations_allocation
          ON worker_omnibus_reservations (allocation_commitment, updated_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_omnibus_fills (
            allocation_commitment TEXT NOT NULL,
            fill_commitment TEXT NOT NULL,
            fill_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (allocation_commitment, fill_commitment)
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_omnibus_fills_allocation
          ON worker_omnibus_fills (allocation_commitment, created_at DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS worker_state_ledger (
            ledger_id BIGSERIAL PRIMARY KEY,
            document_id TEXT NOT NULL,
            state_json JSONB NOT NULL,
            state_sha256 TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_worker_state_ledger_document_created
          ON worker_state_ledger (document_id, created_at DESC)
        `;
        await migrateLegacyPostgresDocument(sql);
      })();
    }
    await initPromise;
    return sql;
  }

  async function hmacSecret() {
    if (!hmacSecretPromise) {
      hmacSecretPromise = (async () => {
        const sql = await ensureInitialized();
        const generated = randomBytes(32).toString("hex");
        await sql`
          INSERT INTO worker_state_secrets (key, value)
          VALUES (${"client_order_hmac"}, ${generated})
          ON CONFLICT (key) DO NOTHING
        `;
        const rows = await sql`
          SELECT value FROM worker_state_secrets WHERE key = ${"client_order_hmac"}
        `;
        return rows[0]?.value || generated;
      })();
    }
    return hmacSecretPromise;
  }

  async function hmacHex(parts) {
    return createHmac("sha256", Buffer.from(await hmacSecret(), "hex"))
      .update(parts.filter(Boolean).join("\0"))
      .digest("hex");
  }

  return {
    path: "postgres",

    async deriveClientOrderId(prefix, workOrderCommitment) {
      return `${prefix}_${(await hmacHex([prefix, workOrderCommitment])).slice(0, 32)}`;
    },

    async deriveHyperliquidCloid(workOrderCommitment) {
      return `0x${(await hmacHex(["hyperliquid_cloid", workOrderCommitment])).slice(0, 32)}`;
    },

    async getIdempotency(workOrderCommitment) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT receipt_json, updated_at
        FROM worker_idempotency
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      if (!rows[0]) return null;
      return {
        receipt: decodeJson(rows[0].receipt_json),
        updated_at: toIso(rows[0].updated_at),
      };
    },

    async hasIdempotencyReceipt({ kind, owner_commitment, worker_image_digest, asset }) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT 1 AS found
        FROM worker_idempotency
        WHERE receipt_json->>'kind' = ${kind}
          AND receipt_json->>'owner_commitment' = ${owner_commitment}
          AND receipt_json->>'worker_image_digest' = ${worker_image_digest}
          AND receipt_json->>'asset' = ${asset}
        LIMIT 1
      `;
      return Boolean(rows[0]?.found);
    },

    async putIdempotency(workOrderCommitment, receipt) {
      const sql = await ensureInitialized();
      await sql`
        INSERT INTO worker_idempotency (work_order_commitment, receipt_json, updated_at)
        VALUES (${workOrderCommitment}, ${jsonParam(receipt)}::jsonb, NOW())
        ON CONFLICT (work_order_commitment)
        DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at
      `;
      return receipt;
    },

    async claimIdempotency(workOrderCommitment, receipt) {
      const sql = await ensureInitialized();
      const rows = await sql`
        INSERT INTO worker_idempotency (work_order_commitment, receipt_json, updated_at)
        VALUES (${workOrderCommitment}, ${jsonParam(receipt)}::jsonb, NOW())
        ON CONFLICT (work_order_commitment) DO NOTHING
        RETURNING receipt_json
      `;
      if (rows[0]) return { ok: true, receipt: decodeJson(rows[0].receipt_json) || receipt };
      const existingRows = await sql`
        SELECT receipt_json
        FROM worker_idempotency
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      return { ok: false, existing: decodeJson(existingRows[0]?.receipt_json) || null };
    },

    async claimCarryExposureReservations(positionId, bindingsCommitment, reservations) {
      await ensureInitialized();
      const client = await (await transactionPool()).connect();
      const ordered = [...reservations].sort((a, b) => a.reservation_key.localeCompare(b.reservation_key));
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["carry:exposure:claim:v2"]);
        for (const item of ordered) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [item.reservation_key]);
        const positionRows = await client.query(
          "SELECT position_id, record_json FROM worker_carry_positions FOR UPDATE",
        );
        const sagaRows = await client.query(
          "SELECT saga_id, saga_json FROM worker_multi_leg_sagas FOR UPDATE",
        );
        const persisted = assessCarryExposureClaim({
          positionId,
          bindingsCommitment,
          reservations: ordered,
          positions: Object.fromEntries(positionRows.rows.map((row) => [row.position_id, decodeJson(row.record_json)])),
          sagas: Object.fromEntries(sagaRows.rows.map((row) => [row.saga_id, decodeJson(row.saga_json)])),
        });
        if (!persisted.ok) {
          await client.query("ROLLBACK");
          return persisted;
        }
        for (const item of ordered) {
          const selected = await client.query(
            "SELECT position_id, bindings_commitment, active FROM worker_carry_exposure_reservations WHERE reservation_key=$1 FOR UPDATE",
            [item.reservation_key],
          );
          const row = selected.rows[0];
          if (row?.active && (row.position_id !== positionId || row.bindings_commitment !== bindingsCommitment)) {
            await client.query("ROLLBACK");
            return { ok: false, conflicting_position_id: row.position_id };
          }
        }
        for (const item of ordered) await client.query(
          `INSERT INTO worker_carry_exposure_reservations
             (reservation_key, position_id, bindings_commitment, reservation_json, active, updated_at)
           VALUES ($1,$2,$3,$4::jsonb,TRUE,NOW())
           ON CONFLICT (reservation_key) DO UPDATE SET
             position_id=excluded.position_id, bindings_commitment=excluded.bindings_commitment,
             reservation_json=excluded.reservation_json, active=TRUE,
             generation=CASE WHEN worker_carry_exposure_reservations.active THEN worker_carry_exposure_reservations.generation ELSE worker_carry_exposure_reservations.generation + 1 END,
             updated_at=NOW()`,
          [item.reservation_key, positionId, bindingsCommitment, JSON.stringify(item)],
        );
        await client.query("COMMIT");
        return { ok: true };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    },

    async listActiveCarryExposureReservationPositionIds() {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT DISTINCT position_id
        FROM worker_carry_exposure_reservations
        WHERE active=TRUE
        ORDER BY position_id ASC
      `;
      return rows.map((row) => row.position_id);
    },

    async releaseCarryExposureReservations(positionId, bindingsCommitment, reservationKeys, expectedFlat) {
      await ensureInitialized();
      const client = await (await transactionPool()).connect();
      const ordered = [...reservationKeys].sort();
      try {
        await client.query("BEGIN");
        for (const key of ordered) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const positionRows = await client.query(
          "SELECT record_json FROM worker_carry_positions WHERE position_id=$1 FOR UPDATE",
          [positionId],
        );
        if (!exactFlatReservationRecord(decodeJson(positionRows.rows[0]?.record_json), expectedFlat)) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "exact_flat_reconciliation_required" };
        }
        let present = 0;
        for (const key of ordered) {
          const selected = await client.query(
            "SELECT position_id, bindings_commitment, active FROM worker_carry_exposure_reservations WHERE reservation_key=$1 FOR UPDATE",
            [key],
          );
          const row = selected.rows[0];
          if (row) present += 1;
          if (row?.active && (row.position_id !== positionId || row.bindings_commitment !== bindingsCommitment)) {
            await client.query("ROLLBACK");
            return { ok: false };
          }
        }
        if (present !== 0 && present !== ordered.length) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "reservation_set_incomplete" };
        }
        await client.query(
          "UPDATE worker_carry_exposure_reservations SET active=FALSE, updated_at=NOW() WHERE reservation_key = ANY($1::text[])",
          [ordered],
        );
        await client.query("COMMIT");
        return { ok: true, already_released: present === 0 };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    },

    async releaseCarryExposureReservationsBeforeSubmit(positionId, bindingsCommitment, reservationKeys, sagaId) {
      await ensureInitialized();
      const client = await (await transactionPool()).connect();
      const ordered = [...reservationKeys].sort();
      try {
        await client.query("BEGIN");
        for (const key of ordered) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const positionRows = await client.query(
          "SELECT record_json FROM worker_carry_positions WHERE position_id=$1 FOR UPDATE",
          [positionId],
        );
        const sagaRows = await client.query(
          "SELECT saga_json FROM worker_multi_leg_sagas WHERE saga_id=$1 FOR UPDATE",
          [sagaId],
        );
        if (!exactNoSubmitReservationRecord(
          decodeJson(positionRows.rows[0]?.record_json),
          decodeJson(sagaRows.rows[0]?.saga_json),
          positionId,
          sagaId,
        )) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "durable_no_submit_proof_required" };
        }
        let present = 0;
        for (const key of ordered) {
          const selected = await client.query(
            "SELECT position_id, bindings_commitment, active FROM worker_carry_exposure_reservations WHERE reservation_key=$1 FOR UPDATE",
            [key],
          );
          const row = selected.rows[0];
          if (row) present += 1;
          if (row?.active && (row.position_id !== positionId || row.bindings_commitment !== bindingsCommitment)) {
            await client.query("ROLLBACK");
            return { ok: false };
          }
        }
        if (present !== 0 && present !== ordered.length) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "reservation_set_incomplete" };
        }
        await client.query(
          "UPDATE worker_carry_exposure_reservations SET active=FALSE, updated_at=NOW() WHERE reservation_key = ANY($1::text[])",
          [ordered],
        );
        await client.query("COMMIT");
        return { ok: true, already_released: present === 0 };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    },

    async putExecutionAttempt(workOrderCommitment, attempt) {
      const sql = await ensureInitialized();
      const next = {
        ...attempt,
        work_order_commitment: workOrderCommitment,
        updated_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_execution_attempts (work_order_commitment, attempt_json, status, updated_at)
        VALUES (${workOrderCommitment}, ${jsonParam(next)}::jsonb, ${next.status || null}, NOW())
        ON CONFLICT (work_order_commitment)
        DO UPDATE SET
          attempt_json = excluded.attempt_json,
          status = excluded.status,
          updated_at = excluded.updated_at
      `;
      return next;
    },

    async claimExecutionAttempt(workOrderCommitment, attempt) {
      const sql = await ensureInitialized();
      const next = {
        ...attempt,
        work_order_commitment: workOrderCommitment,
        updated_at: new Date().toISOString(),
      };
      const rows = await sql`
        INSERT INTO worker_execution_attempts (work_order_commitment, attempt_json, status, updated_at)
        VALUES (${workOrderCommitment}, ${jsonParam(next)}::jsonb, ${next.status || null}, NOW())
        ON CONFLICT (work_order_commitment) DO NOTHING
        RETURNING attempt_json
      `;
      if (rows[0]) {
        return { ok: true, attempt: decodeJson(rows[0].attempt_json) || next };
      }
      const existingRows = await sql`
        SELECT attempt_json
        FROM worker_execution_attempts
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      return { ok: false, existing: decodeJson(existingRows[0]?.attempt_json) || null };
    },

    async claimExecutionAttemptWithPolicyUsage(workOrderCommitment, input = {}) {
      await ensureInitialized();
      const usage = normalizePolicyUsage(input);
      const now = new Date().toISOString();
      const allowedAttempt = {
        ...(input.allowed_attempt || {}),
        work_order_commitment: workOrderCommitment,
        updated_at: now,
      };
      const deniedAttempt = {
        ...(input.denied_attempt || {}),
        work_order_commitment: workOrderCommitment,
        updated_at: now,
      };
      const lockKeys = [...new Set([
        `execution-attempt:${workOrderCommitment}`,
        ...usage.counts.map((item) => policyAdvisoryLockKey("count", item.key)),
        ...usage.amounts.map((item) => policyAdvisoryLockKey("amount", item.key)),
      ])].sort();
      const pool = await transactionPool();
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        transactionOpen = true;
        for (const lockKey of lockKeys) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [lockKey],
          );
        }

        const existingRows = await client.query(
          `SELECT attempt_json
           FROM worker_execution_attempts
           WHERE work_order_commitment = $1`,
          [workOrderCommitment],
        );
        const existing = decodeJson(existingRows.rows[0]?.attempt_json);
        const rearmExisting = input.rearm_failed_no_submit === true && isPolicyFailedNoSubmitAttempt(existing);
        if (existing && !rearmExisting) {
          await client.query("COMMIT");
          transactionOpen = false;
          return { ok: false, reason: "attempt_exists", existing };
        }

        const countRows = usage.counts.length > 0
          ? await client.query(
            "SELECT key, count FROM worker_policy_counts WHERE key = ANY($1::text[])",
            [usage.counts.map((item) => item.key)],
          )
          : { rows: [] };
        const amountRows = usage.amounts.length > 0
          ? await client.query(
            "SELECT key, amount FROM worker_policy_amounts WHERE key = ANY($1::text[])",
            [usage.amounts.map((item) => item.key)],
          )
          : { rows: [] };
        const countsByKey = new Map(
          countRows.rows.map((row) => [row.key, Number(row.count || 0)]),
        );
        const amountsByKey = new Map(
          amountRows.rows.map((row) => [row.key, Number(row.amount || 0)]),
        );
        const denials = [];
        for (const item of usage.counts) {
          const current = countsByKey.get(item.key) || 0;
          if (item.invalid || (
            Number.isInteger(item.max_count) &&
            current + item.increment > item.max_count
          )) {
            denials.push(item);
          }
        }
        for (const item of usage.amounts) {
          const current = amountsByKey.get(item.key) || 0;
          if (item.invalid || (
            Number.isFinite(item.max_amount) &&
            item.max_amount > 0 &&
            current + item.amount > item.max_amount
          )) {
            denials.push(item);
          }
        }
        const denied = denials.sort((a, b) => a.ordinal - b.ordinal)[0] || null;
        if (denied && rearmExisting) {
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            ok: false,
            reason: "policy_denied",
            denied: policyDenialResult(denied),
            attempt: existing,
          };
        }
        const selectedAttempt = denied
          ? policyDeniedAttempt(deniedAttempt, denied)
          : rearmExisting ? rearmedPolicyAttempt(allowedAttempt, existing, now) : allowedAttempt;
        const claimed = rearmExisting
          ? await client.query(
            `UPDATE worker_execution_attempts
             SET attempt_json = $2::jsonb, status = $3, updated_at = NOW()
             WHERE work_order_commitment = $1
               AND status = 'failed_no_submit'
               AND attempt_json = $4::jsonb
             RETURNING attempt_json`,
            [
              workOrderCommitment,
              jsonParam(selectedAttempt),
              selectedAttempt.status || null,
              jsonParam(existing),
            ],
          )
          : await client.query(
            `INSERT INTO worker_execution_attempts (
               work_order_commitment,
               attempt_json,
               status,
               updated_at
             )
             VALUES ($1, $2::jsonb, $3, NOW())
             ON CONFLICT (work_order_commitment) DO NOTHING
             RETURNING attempt_json`,
            [workOrderCommitment, jsonParam(selectedAttempt), selectedAttempt.status || null],
          );
        if (!claimed.rows[0]) {
          const racedRows = await client.query(
            `SELECT attempt_json
             FROM worker_execution_attempts
             WHERE work_order_commitment = $1`,
            [workOrderCommitment],
          );
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            ok: false,
            reason: "attempt_exists",
            existing: decodeJson(racedRows.rows[0]?.attempt_json) || null,
          };
        }
        if (denied) {
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            ok: false,
            reason: "policy_denied",
            denied: policyDenialResult(denied),
            attempt: decodeJson(claimed.rows[0].attempt_json) || selectedAttempt,
          };
        }

        for (const item of usage.counts) {
          await client.query(
            `INSERT INTO worker_policy_counts (key, count, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET
               count = worker_policy_counts.count + excluded.count,
               updated_at = NOW()`,
            [item.key, item.increment],
          );
        }
        for (const item of usage.amounts) {
          await client.query(
            `INSERT INTO worker_policy_amounts (key, amount, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET
               amount = worker_policy_amounts.amount + excluded.amount,
               updated_at = NOW()`,
            [item.key, item.amount],
          );
        }
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          ok: true,
          attempt: decodeJson(claimed.rows[0].attempt_json) || selectedAttempt,
        };
      } catch (error) {
        if (transactionOpen) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the original transaction failure.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async getExecutionAttempt(workOrderCommitment) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT attempt_json
        FROM worker_execution_attempts
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      return decodeJson(rows[0]?.attempt_json) || null;
    },

    async consumeCapabilityJti(jti, expiresAtUnix) {
      const sql = await ensureInitialized();
      const now = Math.floor(Date.now() / 1000);
      const expires = Number.isInteger(expiresAtUnix) ? expiresAtUnix : now + 300;
      await sql`
        DELETE FROM worker_capability_jtis
        WHERE expires_at_unix <= ${now}
      `;
      const rows = await sql`
        INSERT INTO worker_capability_jtis (jti, expires_at_unix, consumed_at)
        VALUES (${jti}, ${expires}, NOW())
        ON CONFLICT (jti) DO NOTHING
        RETURNING jti
      `;
      return rows[0] ? { ok: true } : { ok: false, replayed: true };
    },

    async putAutopilotSession(session) {
      const sql = await ensureInitialized();
      const next = {
        ...session,
        updated_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_autopilot_sessions (
          autopilot_session_id,
          owner_commitment,
          session_json,
          created_at,
          updated_at
        )
        VALUES (
          ${next.autopilot_session_id},
          ${next.owner_commitment || null},
          ${jsonParam(next)}::jsonb,
          ${next.created_at || new Date().toISOString()},
          NOW()
        )
        ON CONFLICT (autopilot_session_id)
        DO UPDATE SET
          owner_commitment = excluded.owner_commitment,
          session_json = excluded.session_json,
          updated_at = excluded.updated_at
      `;
      return next;
    },

    async getAutopilotSession(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT session_json
        FROM worker_autopilot_sessions
        WHERE autopilot_session_id = ${sessionId}
      `;
      return decodeJson(rows[0]?.session_json) || null;
    },

    async listAutopilotSessions(ownerCommitment = null) {
      const sql = await ensureInitialized();
      const rows = ownerCommitment
        ? await sql`
          SELECT session_json
          FROM worker_autopilot_sessions
          WHERE owner_commitment = ${ownerCommitment}
          ORDER BY created_at DESC
        `
        : await sql`
          SELECT session_json
          FROM worker_autopilot_sessions
          ORDER BY created_at DESC
      `;
      return rows.map((row) => decodeJson(row.session_json)).filter(Boolean);
    },

    async claimAutopilotTickLease(sessionId, input = {}) {
      const sql = await ensureInitialized();
      const now = dateValue(input.now);
      const leaseId = stringValue(input.lease_id) ||
        stableRecordId("ticklease", { sessionId, now: now.toISOString() });
      const leaseMs = positiveInt(input.lease_ms, 60_000);
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const patch = {
        tick_lease_id: leaseId,
        tick_lease_until: leaseUntil,
        last_tick_claimed_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      const rows = await sql`
        UPDATE worker_autopilot_sessions
        SET
          session_json = session_json || ${jsonParam(patch)}::jsonb,
          updated_at = NOW()
        WHERE autopilot_session_id = ${sessionId}
          AND (
            session_json->>'tick_lease_id' IS NULL
            OR session_json->>'tick_lease_until' IS NULL
            OR (session_json->>'tick_lease_until')::timestamptz <= ${now.toISOString()}::timestamptz
            OR session_json->>'tick_lease_id' = ${leaseId}
          )
        RETURNING session_json
      `;
      if (rows[0]) {
        return {
          ok: true,
          lease_id: leaseId,
          lease_until: leaseUntil,
          session: decodeJson(rows[0].session_json),
        };
      }
      const session = await this.getAutopilotSession(sessionId);
      if (!session) return { ok: false, error: "autopilot_session_not_found" };
      return {
        ok: false,
        error: "tick_lease_active",
        lease_id: session.tick_lease_id || null,
        lease_until: session.tick_lease_until || null,
        session,
      };
    },

    async releaseAutopilotTickLease(sessionId, leaseId, input = {}) {
      const sql = await ensureInitialized();
      const now = dateValue(input.now);
      const patch = {
        last_tick_released_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      const rows = await sql`
        UPDATE worker_autopilot_sessions
        SET
          session_json = (session_json - 'tick_lease_id' - 'tick_lease_until') || ${jsonParam(patch)}::jsonb,
          updated_at = NOW()
        WHERE autopilot_session_id = ${sessionId}
          AND session_json->>'tick_lease_id' = ${stringValue(leaseId)}
        RETURNING session_json
      `;
      if (rows[0]) {
        return { ok: true, session: decodeJson(rows[0].session_json) };
      }
      const session = await this.getAutopilotSession(sessionId);
      if (!session) return { ok: false, error: "autopilot_session_not_found" };
      return { ok: false, error: "tick_lease_not_owned", session };
    },

    async appendAutopilotEvent(sessionId, event) {
      const sql = await ensureInitialized();
      const next = {
        ...event,
        autopilot_session_id: sessionId,
        event_id: event.event_id || stableRecordId("autoevt", { sessionId, event }),
        created_at: event.created_at || new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_autopilot_events (event_id, autopilot_session_id, event_json, created_at)
        VALUES (${next.event_id}, ${sessionId}, ${jsonParam(next)}::jsonb, ${next.created_at})
        ON CONFLICT (event_id) DO NOTHING
      `;
      return next;
    },

    async listAutopilotEvents(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT event_json
        FROM worker_autopilot_events
        WHERE autopilot_session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 200
      `;
      return rows.map((row) => decodeJson(row.event_json)).filter(Boolean).reverse();
    },

    async appendAutopilotDecision(sessionId, decision) {
      const sql = await ensureInitialized();
      const next = {
        ...decision,
        autopilot_session_id: sessionId,
      };
      const decisionId = decision.decision_id || stableRecordId("autodecision", { sessionId, decision });
      await sql`
        INSERT INTO worker_autopilot_decisions (decision_id, autopilot_session_id, decision_json, created_at)
        VALUES (${decisionId}, ${sessionId}, ${jsonParam(next)}::jsonb, ${decision.created_at || new Date().toISOString()})
        ON CONFLICT (decision_id) DO NOTHING
      `;
      return decision;
    },

    async listAutopilotDecisions(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT decision_json
        FROM worker_autopilot_decisions
        WHERE autopilot_session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 200
      `;
      return rows.map((row) => decodeJson(row.decision_json)).filter(Boolean).reverse();
    },

    async putAutopilotPosition(sessionId, position) {
      const sql = await ensureInitialized();
      const key = `${position.venue_id || "unknown"}:${position.market || "unknown"}`;
      const next = {
        ...position,
        updated_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_autopilot_positions (
          autopilot_session_id,
          position_key,
          position_json,
          updated_at
        )
        VALUES (${sessionId}, ${key}, ${jsonParam(next)}::jsonb, NOW())
        ON CONFLICT (autopilot_session_id, position_key)
        DO UPDATE SET position_json = excluded.position_json, updated_at = excluded.updated_at
      `;
      return next;
    },

    async listAutopilotPositions(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT position_json
        FROM worker_autopilot_positions
        WHERE autopilot_session_id = ${sessionId}
        ORDER BY updated_at DESC
        LIMIT 50
      `;
      return rows.map((row) => decodeJson(row.position_json)).filter(Boolean).reverse();
    },

    async appendAutopilotOpportunity(sessionId, opportunity) {
      const sql = await ensureInitialized();
      const next = {
        ...opportunity,
        autopilot_session_id: sessionId,
      };
      const opportunityId = opportunity.opportunity_id || stableRecordId("arbopp", { sessionId, opportunity });
      await sql`
        INSERT INTO worker_autopilot_opportunities (opportunity_id, autopilot_session_id, opportunity_json, created_at)
        VALUES (${opportunityId}, ${sessionId}, ${jsonParam(next)}::jsonb, ${opportunity.created_at || new Date().toISOString()})
        ON CONFLICT (opportunity_id) DO NOTHING
      `;
      return next;
    },

    async listAutopilotOpportunities(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT opportunity_json
        FROM worker_autopilot_opportunities
        WHERE autopilot_session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return rows.map((row) => decodeJson(row.opportunity_json)).filter(Boolean).reverse();
    },

    async putExecutorRecord(sessionId, executor) {
      const sql = await ensureInitialized();
      const next = {
        ...executor,
        autopilot_session_id: sessionId,
        updated_at: new Date().toISOString(),
      };
      const executorId = next.executor_id || stableRecordId("executor", { sessionId, executor });
      await sql`
        INSERT INTO worker_executor_records (
          executor_id,
          autopilot_session_id,
          agent_controller_id,
          status,
          executor_json,
          created_at,
          updated_at
        )
        VALUES (
          ${executorId},
          ${sessionId},
          ${next.agent_controller_id || null},
          ${next.status || null},
          ${jsonParam({ ...next, executor_id: executorId })}::jsonb,
          ${next.created_at || new Date().toISOString()},
          NOW()
        )
        ON CONFLICT (executor_id)
        DO UPDATE SET
          agent_controller_id = excluded.agent_controller_id,
          status = excluded.status,
          executor_json = excluded.executor_json,
          updated_at = excluded.updated_at
      `;
      return { ...next, executor_id: executorId };
    },

    async listExecutorRecords(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT executor_json
        FROM worker_executor_records
        WHERE autopilot_session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 200
      `;
      return rows.map((row) => decodeJson(row.executor_json)).filter(Boolean).reverse();
    },

    async putTickSnapshot(sessionId, snapshot) {
      const sql = await ensureInitialized();
      const next = {
        ...snapshot,
        autopilot_session_id: sessionId,
        updated_at: new Date().toISOString(),
      };
      const tickId = next.tick_id || stableRecordId("tick", { sessionId, snapshot });
      await sql`
        INSERT INTO worker_tick_snapshots (
          tick_id,
          autopilot_session_id,
          agent_controller_id,
          status,
          tick_json,
          created_at,
          updated_at
        )
        VALUES (
          ${tickId},
          ${sessionId},
          ${next.agent_controller_id || null},
          ${next.status || null},
          ${jsonParam({ ...next, tick_id: tickId })}::jsonb,
          ${next.created_at || new Date().toISOString()},
          NOW()
        )
        ON CONFLICT (tick_id)
        DO UPDATE SET
          agent_controller_id = excluded.agent_controller_id,
          status = excluded.status,
          tick_json = excluded.tick_json,
          updated_at = excluded.updated_at
      `;
      return { ...next, tick_id: tickId };
    },

    async listTickSnapshots(sessionId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT tick_json
        FROM worker_tick_snapshots
        WHERE autopilot_session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 100
      `;
      return rows.map((row) => decodeJson(row.tick_json)).filter(Boolean).reverse();
    },

    async putMultiLegSaga(saga, input = {}) {
      const sql = await ensureInitialized();
      const next = { ...saga, updated_at_ms: Number(saga.updated_at_ms || Date.now()) };
      const expectedSequence = input.expected_sequence;
      let rows;
      if (expectedSequence === null) {
        rows = await sql`
          INSERT INTO worker_multi_leg_sagas (
            saga_id, status, terminal, last_event_sequence, saga_json, created_at, updated_at
          )
          VALUES (
            ${next.saga_id}, ${next.status}, ${next.terminal === true},
            ${next.last_event_sequence}, ${jsonParam(next)}::jsonb,
            ${new Date(next.created_at_ms).toISOString()}, NOW()
          )
          ON CONFLICT (saga_id) DO NOTHING
          RETURNING saga_json
        `;
      } else if (Number.isInteger(expectedSequence) && expectedSequence >= 0) {
        rows = await sql`
          UPDATE worker_multi_leg_sagas
          SET
            status = ${next.status},
            terminal = ${next.terminal === true},
            last_event_sequence = ${next.last_event_sequence},
            saga_json = ${jsonParam(next)}::jsonb,
            updated_at = NOW()
          WHERE saga_id = ${next.saga_id}
            AND last_event_sequence = ${expectedSequence}
          RETURNING saga_json
        `;
      } else {
        return { ok: false, error: "saga_expected_sequence_required" };
      }
      if (rows[0]) return { ok: true, saga: decodeJson(rows[0].saga_json) };
      return {
        ok: false,
        error: "saga_version_conflict",
        saga: await this.getMultiLegSaga(next.saga_id),
      };
    },

    async getMultiLegSaga(sagaId) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT saga_json
        FROM worker_multi_leg_sagas
        WHERE saga_id = ${sagaId}
      `;
      return decodeJson(rows[0]?.saga_json) || null;
    },

    async listMultiLegSagas(input = {}) {
      const sql = await ensureInitialized();
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 200), 1_000));
      const rows = input.active_only === true
        ? await sql`
          SELECT saga_json
          FROM worker_multi_leg_sagas
          WHERE terminal = FALSE
          ORDER BY updated_at ASC
          LIMIT ${limit}
        `
        : await sql`
          SELECT saga_json
          FROM worker_multi_leg_sagas
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
      return rows.map((row) => decodeJson(row.saga_json)).filter(Boolean);
    },

    async putCarryPositionRecord(record, input = {}) {
      const sql = await ensureInitialized();
      const positionId = record?.position?.position_id;
      const expectedVersion = input.expected_version;
      const lifecycleEvent = input.lifecycle_event || null;
      if (lifecycleEvent) {
        if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
          return { ok: false, error: "carry_record_expected_version_required" };
        }
        const pool = await transactionPool();
        const client = await pool.connect();
        let transactionOpen = false;
        try {
          await client.query("BEGIN");
          transactionOpen = true;
          const currentRows = await client.query(
            `SELECT record_json, record_version
             FROM worker_carry_positions
             WHERE position_id = $1
             FOR UPDATE`,
            [positionId],
          );
          const existing = decodeJson(currentRows.rows[0]?.record_json);
          if (!existing || Number(currentRows.rows[0]?.record_version) !== expectedVersion) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return { ok: false, error: "carry_record_version_conflict", record: existing || null };
          }
          const firstRows = await client.query(
            `SELECT event_json
             FROM worker_carry_lifecycle_events
             WHERE position_id = $1
             ORDER BY sequence ASC
             LIMIT 1`,
            [positionId],
          );
          const latestRows = await client.query(
            `SELECT event_json
             FROM worker_carry_lifecycle_events
             WHERE position_id = $1
             ORDER BY sequence DESC
             LIMIT 1`,
            [positionId],
          );
          const duplicateRows = await client.query(
            `SELECT 1
             FROM worker_carry_lifecycle_events
             WHERE position_id = $1 AND event_id = $2
             LIMIT 1`,
            [positionId, lifecycleEvent.event_id],
          );
          if (duplicateRows.rows[0]) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return { ok: false, error: "carry_lifecycle_event_conflict", record: existing };
          }
          const first = decodeJson(firstRows.rows[0]?.event_json);
          const previous = decodeJson(latestRows.rows[0]?.event_json);
          const journalBoundary = [first, previous]
            .filter(Boolean)
            .filter((item, index, items) => items.findIndex((candidate) => candidate.sequence === item.sequence) === index);
          const bound = bindCarryLifecycleJournalMetadata({ existing, record, journal: journalBoundary });
          if (!bound.ok) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return { ...bound, record: existing };
          }
          const next = {
            ...bound.record,
            record_version: expectedVersion + 1,
            updated_at: new Date().toISOString(),
          };
          const append = prepareCarryLifecycleAppend({
            existing,
            next,
            event: lifecycleEvent,
            journal: journalBoundary,
          });
          if (!append.ok) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return { ...append, record: existing };
          }
          await client.query(
            `INSERT INTO worker_carry_lifecycle_events (
               position_id, sequence, event_id, previous_event_commitment,
               event_commitment, event_json, recorded_at
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [
              positionId,
              append.entry.sequence,
              append.entry.event_id,
              append.entry.previous_event_commitment,
              append.entry.event_commitment,
              jsonParam(append.entry),
              timestampOrNow(lifecycleEvent.recorded_at_ms),
            ],
          );
          const updatedRows = await client.query(
            `UPDATE worker_carry_positions
             SET owner_commitment = $1,
                 status = $2,
                 record_version = $3,
                 record_json = $4::jsonb,
                 updated_at = NOW()
             WHERE position_id = $5 AND record_version = $6
             RETURNING record_json`,
            [next.owner_commitment, next.position.status, next.record_version, jsonParam(next), positionId, expectedVersion],
          );
          if (!updatedRows.rows[0]) throw new Error("carry_record_version_conflict");
          await client.query("COMMIT");
          transactionOpen = false;
          return { ok: true, record: decodeJson(updatedRows.rows[0].record_json) };
        } catch (error) {
          if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
          if (error?.code === "23505") {
            return { ok: false, error: "carry_lifecycle_event_conflict", record: await this.getCarryPositionRecord(positionId) };
          }
          throw error;
        } finally {
          client.release();
        }
      }
      const currentRows = await sql`
        SELECT record_json, record_version
        FROM worker_carry_positions
        WHERE position_id = ${positionId}
      `;
      const existing = decodeJson(currentRows[0]?.record_json);
      if (expectedVersion === null) {
        if (existing) return { ok: false, error: "carry_record_version_conflict", record: existing };
      } else if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
        return { ok: false, error: "carry_record_expected_version_required", record: existing || null };
      } else if (!existing || Number(currentRows[0]?.record_version) !== expectedVersion) {
        return { ok: false, error: "carry_record_version_conflict", record: existing || null };
      }
      const firstRows = existing ? await sql`
        SELECT event_json
        FROM worker_carry_lifecycle_events
        WHERE position_id = ${positionId}
        ORDER BY sequence ASC
        LIMIT 1
      ` : [];
      const latestRows = existing ? await sql`
        SELECT event_json
        FROM worker_carry_lifecycle_events
        WHERE position_id = ${positionId}
        ORDER BY sequence DESC
        LIMIT 1
      ` : [];
      const journalBoundary = [decodeJson(firstRows[0]?.event_json), decodeJson(latestRows[0]?.event_json)]
        .filter(Boolean)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.sequence === item.sequence) === index);
      const bound = bindCarryLifecycleJournalMetadata({ existing, record, journal: journalBoundary });
      if (!bound.ok) return { ...bound, record: existing || null };
      const lifecycleBinding = prepareCarryLifecycleAppend({
        existing,
        next: bound.record,
        event: null,
        journal: journalBoundary,
      });
      if (!lifecycleBinding.ok) return { ...lifecycleBinding, record: existing || null };
      let rows;
      if (expectedVersion === null) {
        const next = { ...bound.record, record_version: 1, updated_at: new Date().toISOString() };
        rows = await sql`
          INSERT INTO worker_carry_positions (
            position_id, owner_commitment, status, record_version, record_json, created_at, updated_at
          )
          VALUES (
            ${positionId}, ${next.owner_commitment}, ${next.position.status}, 1,
            ${jsonParam(next)}::jsonb, ${next.created_at || new Date().toISOString()}, NOW()
          )
          ON CONFLICT (position_id) DO NOTHING
          RETURNING record_json
        `;
      } else if (Number.isInteger(expectedVersion) && expectedVersion > 0) {
        const next = { ...bound.record, record_version: expectedVersion + 1, updated_at: new Date().toISOString() };
        rows = await sql`
          UPDATE worker_carry_positions
          SET owner_commitment = ${next.owner_commitment},
              status = ${next.position.status},
              record_version = ${next.record_version},
              record_json = ${jsonParam(next)}::jsonb,
              updated_at = NOW()
          WHERE position_id = ${positionId}
            AND record_version = ${expectedVersion}
          RETURNING record_json
        `;
      } else {
        return { ok: false, error: "carry_record_expected_version_required" };
      }
      if (rows[0]) return { ok: true, record: decodeJson(rows[0].record_json) };
      return {
        ok: false,
        error: "carry_record_version_conflict",
        record: await this.getCarryPositionRecord(positionId),
      };
    },

    async getCarryPositionRecord(positionId) {
      const rows = await sql`
        SELECT record_json
        FROM worker_carry_positions
        WHERE position_id = ${positionId}
      `;
      return decodeJson(rows[0]?.record_json) || null;
    },

    async listCarryPositionRecords(input = {}) {
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 100), 500));
      const owner = stringValue(input.owner_commitment);
      const status = stringValue(input.status);
      const beforeUpdatedAt = stringValue(input.before_updated_at);
      const beforePositionId = stringValue(input.before_position_id);
      const cursor = Boolean(beforeUpdatedAt && beforePositionId);
      const rows = cursor && owner && status
        ? await sql`
          SELECT record_json FROM worker_carry_positions
          WHERE owner_commitment = ${owner} AND status = ${status}
            AND ((record_json->>'updated_at') < ${beforeUpdatedAt}
              OR ((record_json->>'updated_at') = ${beforeUpdatedAt} AND position_id < ${beforePositionId}))
          ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
        `
        : cursor && owner
          ? await sql`
            SELECT record_json FROM worker_carry_positions
            WHERE owner_commitment = ${owner}
              AND ((record_json->>'updated_at') < ${beforeUpdatedAt}
                OR ((record_json->>'updated_at') = ${beforeUpdatedAt} AND position_id < ${beforePositionId}))
            ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
          `
          : cursor && status
            ? await sql`
              SELECT record_json FROM worker_carry_positions
              WHERE status = ${status}
                AND ((record_json->>'updated_at') < ${beforeUpdatedAt}
                  OR ((record_json->>'updated_at') = ${beforeUpdatedAt} AND position_id < ${beforePositionId}))
              ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
            `
            : cursor
              ? await sql`
                SELECT record_json FROM worker_carry_positions
                WHERE ((record_json->>'updated_at') < ${beforeUpdatedAt}
                  OR ((record_json->>'updated_at') = ${beforeUpdatedAt} AND position_id < ${beforePositionId}))
                ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
              `
              : owner && status
        ? await sql`
          SELECT record_json FROM worker_carry_positions
          WHERE owner_commitment = ${owner} AND status = ${status}
          ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
        `
        : owner
          ? await sql`
            SELECT record_json FROM worker_carry_positions
            WHERE owner_commitment = ${owner}
            ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
          `
          : status
            ? await sql`
              SELECT record_json FROM worker_carry_positions
              WHERE status = ${status}
              ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
            `
            : await sql`
              SELECT record_json FROM worker_carry_positions
              ORDER BY record_json->>'updated_at' DESC, position_id DESC LIMIT ${limit}
            `;
      return rows.map((row) => decodeJson(row.record_json)).filter(Boolean);
    },

    async listCarryLifecycleEvents(input = {}) {
      const sql = await ensureInitialized();
      const positionId = stringValue(input.position_id);
      if (!positionId) return [];
      const afterSequence = Math.max(0, Number.parseInt(String(input.after_sequence || 0), 10) || 0);
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 1_000), 1_000));
      const rows = await sql`
        SELECT event_json
        FROM worker_carry_lifecycle_events
        WHERE position_id = ${positionId} AND sequence > ${afterSequence}
        ORDER BY sequence ASC
        LIMIT ${limit}
      `;
      return rows.map((row) => decodeJson(row.event_json)).filter(Boolean);
    },

    async appendRevenueEvidence(event) {
      const sql = await ensureInitialized();
      if (event?.work_order_commitment) {
        const existing = await sql`
          SELECT event_json
          FROM worker_revenue_events
          WHERE work_order_commitment = ${event.work_order_commitment}
        `;
        const existingEvent = decodeJson(existing[0]?.event_json);
        if (existingEvent) return existingEvent;
      }
      const latest = await sql`
        SELECT event_json
        FROM worker_revenue_events
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const latestEvent = decodeJson(latest[0]?.event_json);
      const countRows = await sql`
        SELECT COUNT(*)::int AS count
        FROM worker_revenue_events
      `;
      const finalized = finalizeRevenueEvidenceEvent(event, {
        previousEventHash: latestEvent?.event_hash || null,
        sequence: Number(countRows[0]?.count || 0) + 1,
      });
      await sql`
        INSERT INTO worker_revenue_events (
          revenue_event_id,
          work_order_commitment,
          autopilot_session_id,
          venue_id,
          revenue_status,
          event_hash,
          previous_event_hash,
          event_json,
          created_at
        )
        VALUES (
          ${finalized.revenue_event_id},
          ${finalized.work_order_commitment || null},
          ${finalized.autopilot_session_id || null},
          ${finalized.venue_id || null},
          ${finalized.revenue_status || null},
          ${finalized.event_hash},
          ${finalized.previous_event_hash || null},
          ${jsonParam(finalized)}::jsonb,
          ${finalized.created_at || new Date().toISOString()}
        )
        ON CONFLICT (revenue_event_id) DO NOTHING
      `;
      return finalized;
    },

    async listRevenueEvidence(input = {}) {
      const sql = await ensureInitialized();
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 200), 1000));
      const rows = await sql`
        SELECT event_json
        FROM worker_revenue_events
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return filterRevenueEvidenceRows(
        rows.map((row) => decodeJson(row.event_json)).filter(Boolean).reverse(),
        input,
      );
    },

    async putSession(session) {
      const sql = await ensureInitialized();
      const next = {
        ...session,
        updated_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_sessions (
          session_commitment,
          session_json,
          venue_id,
          vault_commitment,
          policy_commitment,
          allocation_commitment,
          created_at,
          updated_at
        )
        VALUES (
          ${next.session_commitment},
          ${jsonParam(next)}::jsonb,
          ${next.venue_id || null},
          ${next.vault_commitment || null},
          ${next.policy_commitment || null},
          ${next.allocation_commitment || null},
          ${next.created_at || new Date().toISOString()},
          NOW()
        )
        ON CONFLICT (session_commitment)
        DO UPDATE SET
          session_json = excluded.session_json,
          venue_id = excluded.venue_id,
          vault_commitment = excluded.vault_commitment,
          policy_commitment = excluded.policy_commitment,
          allocation_commitment = excluded.allocation_commitment,
          updated_at = excluded.updated_at
      `;
      return next;
    },

    async findSession(input) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT session_json
        FROM worker_sessions
        ORDER BY updated_at DESC
        LIMIT 1000
      `;
      return rows
        .map((row) => decodeJson(row.session_json))
        .filter(Boolean)
        .find((session) => {
          if (input.venue_id && session.venue_id !== input.venue_id) return false;
          if (input.vault_commitment && session.vault_commitment !== input.vault_commitment) return false;
          if (input.policy_commitment && session.policy_commitment !== input.policy_commitment) return false;
          if (
            input.allocation_commitment &&
            session.allocation_commitment !== input.allocation_commitment
          ) {
            return false;
          }
          return true;
        }) || null;
    },

    async putHyperliquidManagedAllocation(allocation) {
      const sql = await ensureInitialized();
      const record = {
        allocation,
        updated_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_hyperliquid_managed_allocations (allocation_commitment, allocation_json, updated_at)
        VALUES (${allocation.allocation_commitment}, ${jsonParam(record)}::jsonb, NOW())
        ON CONFLICT (allocation_commitment)
        DO UPDATE SET allocation_json = excluded.allocation_json, updated_at = excluded.updated_at
      `;
      return record;
    },

    async getHyperliquidManagedAllocation(allocationCommitment) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT allocation_json
        FROM worker_hyperliquid_managed_allocations
        WHERE allocation_commitment = ${allocationCommitment}
      `;
      return decodeJson(rows[0]?.allocation_json) || null;
    },

    async incrementPolicyCount(key, maxCount) {
      const sql = await ensureInitialized();
      const lockKey = policyAdvisoryLockKey("count", key);
      if (Number.isInteger(maxCount)) {
        if (maxCount <= 0) return { ok: false, count: 0 };
        const rows = await sql`
          WITH lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired
          ),
          changed AS (
            INSERT INTO worker_policy_counts (key, count, updated_at)
            SELECT ${key}, 1, NOW() FROM lock
            ON CONFLICT (key)
            DO UPDATE SET
              count = worker_policy_counts.count + 1,
              updated_at = NOW()
            WHERE worker_policy_counts.count < ${maxCount}
            RETURNING count
          )
          SELECT TRUE AS ok, count FROM changed
          UNION ALL
          SELECT FALSE AS ok, COALESCE(current.count, 0) AS count
          FROM lock
          LEFT JOIN worker_policy_counts current ON current.key = ${key}
          WHERE NOT EXISTS (SELECT 1 FROM changed)
          LIMIT 1
        `;
        return { ok: Boolean(rows[0]?.ok), count: Number(rows[0]?.count || 0) };
      }
      const rows = await sql`
        WITH lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired
        ),
        changed AS (
          INSERT INTO worker_policy_counts (key, count, updated_at)
          SELECT ${key}, 1, NOW() FROM lock
          ON CONFLICT (key)
          DO UPDATE SET count = worker_policy_counts.count + 1, updated_at = NOW()
          RETURNING count
        )
        SELECT count FROM changed
      `;
      return { ok: true, count: Number(rows[0]?.count || 0) };
    },

    async incrementPolicyAmount(key, amount, maxAmount) {
      const sql = await ensureInitialized();
      const parsedAmount = Number.parseFloat(String(amount || "0"));
      const parsedMax = Number.parseFloat(String(maxAmount || "0"));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return { ok: false, amount: 0 };
      }
      const lockKey = policyAdvisoryLockKey("amount", key);
      if (Number.isFinite(parsedMax) && parsedMax > 0) {
        const rows = await sql`
          WITH lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired
          ),
          changed AS (
            INSERT INTO worker_policy_amounts (key, amount, updated_at)
            SELECT ${key}, ${parsedAmount}, NOW()
            FROM lock
            WHERE ${parsedAmount} <= ${parsedMax}
            ON CONFLICT (key)
            DO UPDATE SET
              amount = worker_policy_amounts.amount + ${parsedAmount},
              updated_at = NOW()
            WHERE worker_policy_amounts.amount + ${parsedAmount} <= ${parsedMax}
            RETURNING amount
          )
          SELECT TRUE AS ok, amount FROM changed
          UNION ALL
          SELECT FALSE AS ok, COALESCE(current.amount, 0) AS amount
          FROM lock
          LEFT JOIN worker_policy_amounts current ON current.key = ${key}
          WHERE NOT EXISTS (SELECT 1 FROM changed)
          LIMIT 1
        `;
        return { ok: Boolean(rows[0]?.ok), amount: Number(rows[0]?.amount || 0) };
      }
      const rows = await sql`
        WITH lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired
        ),
        changed AS (
          INSERT INTO worker_policy_amounts (key, amount, updated_at)
          SELECT ${key}, ${parsedAmount}, NOW() FROM lock
          ON CONFLICT (key)
          DO UPDATE SET amount = worker_policy_amounts.amount + ${parsedAmount}, updated_at = NOW()
          RETURNING amount
        )
        SELECT amount FROM changed
      `;
      return { ok: true, amount: Number(rows[0]?.amount || 0) };
    },

    async putOmnibusAllocation(allocation) {
      const sql = await ensureInitialized();
      await upsertOmnibusAllocation(sql, allocation);
      return readOmnibusAllocation(sql, allocation.allocation_commitment);
    },

    async getOmnibusAllocation(allocationCommitment) {
      const sql = await ensureInitialized();
      return readOmnibusAllocation(sql, allocationCommitment);
    },

    async reserveOmnibus(input) {
      const sql = await ensureInitialized();
      await upsertOmnibusAllocation(sql, input.allocation || {
        allocation_commitment: input.allocation_commitment,
      });
      const reservation = {
        work_order_commitment: input.work_order_commitment,
        notional_bucket: input.notional_bucket,
        status: "reserved",
        created_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_omnibus_reservations (
          allocation_commitment,
          work_order_commitment,
          reservation_json,
          updated_at
        )
        VALUES (
          ${input.allocation_commitment},
          ${input.work_order_commitment},
          ${jsonParam(reservation)}::jsonb,
          NOW()
        )
        ON CONFLICT (allocation_commitment, work_order_commitment)
        DO UPDATE SET reservation_json = excluded.reservation_json, updated_at = excluded.updated_at
      `;
      return reservation;
    },

    async releaseOmnibus(input) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT reservation_json
        FROM worker_omnibus_reservations
        WHERE allocation_commitment = ${input.allocation_commitment}
          AND work_order_commitment = ${input.work_order_commitment}
      `;
      const existing = decodeJson(rows[0]?.reservation_json);
      if (!existing) return;
      const next = {
        ...existing,
        status: "released",
        updated_at: new Date().toISOString(),
      };
      await sql`
        UPDATE worker_omnibus_reservations
        SET reservation_json = ${jsonParam(next)}::jsonb, updated_at = NOW()
        WHERE allocation_commitment = ${input.allocation_commitment}
          AND work_order_commitment = ${input.work_order_commitment}
      `;
    },

    async settleOmnibusFill(input) {
      const sql = await ensureInitialized();
      await upsertOmnibusAllocation(sql, {
        allocation_commitment: input.allocation_commitment,
      });
      const fill = {
        fill_commitment: input.fill_commitment,
        work_order_commitment: input.work_order_commitment,
        fee_bucket: input.fee_bucket || null,
        notional_bucket: input.notional_bucket || null,
        created_at: new Date().toISOString(),
      };
      await sql`
        INSERT INTO worker_omnibus_fills (
          allocation_commitment,
          fill_commitment,
          fill_json,
          created_at
        )
        VALUES (${input.allocation_commitment}, ${input.fill_commitment}, ${jsonParam(fill)}::jsonb, NOW())
        ON CONFLICT (allocation_commitment, fill_commitment)
        DO UPDATE SET fill_json = excluded.fill_json
      `;
      const reservationRows = await sql`
        SELECT reservation_json
        FROM worker_omnibus_reservations
        WHERE allocation_commitment = ${input.allocation_commitment}
          AND work_order_commitment = ${input.work_order_commitment}
      `;
      const reservation = decodeJson(reservationRows[0]?.reservation_json);
      if (reservation) {
        const nextReservation = {
          ...reservation,
          status: "settled",
          updated_at: new Date().toISOString(),
        };
        await sql`
          UPDATE worker_omnibus_reservations
          SET reservation_json = ${jsonParam(nextReservation)}::jsonb, updated_at = NOW()
          WHERE allocation_commitment = ${input.allocation_commitment}
            AND work_order_commitment = ${input.work_order_commitment}
        `;
      }
      return fill;
    },
  };
}

function jsonParam(value) {
  return JSON.stringify(value ?? null);
}

function policyAdvisoryLockKey(type, key) {
  return `policy-${type}:${key}`;
}

function decodeJson(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function stableRecordId(prefix, value) {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 32)}`;
}

export function finalizeCarryLifecycleEventRecord({
  position_id: positionId,
  event,
  previous_event_commitment: previousEventCommitment = null,
}) {
  const normalizedPositionId = stringValue(positionId);
  if (!normalizedPositionId) throw new Error("carry_lifecycle_position_id_required");
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("carry_lifecycle_event_required");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    throw new Error("carry_lifecycle_event_sequence_invalid");
  }
  if (typeof event.event_id !== "string" || !event.event_id.trim()) {
    throw new Error("carry_lifecycle_event_id_required");
  }
  if (previousEventCommitment !== null && !stringValue(previousEventCommitment)) {
    throw new Error("carry_lifecycle_previous_commitment_invalid");
  }
  const material = {
    version: 1,
    position_id: normalizedPositionId,
    sequence: event.sequence,
    event_id: event.event_id,
    previous_event_commitment: previousEventCommitment,
    event: structuredClone(event),
  };
  return {
    ...material,
    event_commitment: `carry:lifecycle-event:${createHash("sha256")
      .update(canonicalStateJson(material))
      .digest("hex")}`,
  };
}

function prepareCarryLifecycleAppend({ existing, next, event, journal }) {
  const originSequence = next?.lifecycle_journal?.origin_sequence;
  if (next?.lifecycle_journal?.version !== 1
    || !Number.isSafeInteger(originSequence)
    || originSequence <= 0) {
    return { ok: false, error: "carry_lifecycle_journal_metadata_invalid" };
  }
  if (!event) {
    const eventOwnedFields = [
      "position",
      "lifecycle_events",
      "latest_observation",
      "final_reconciliation_evidence",
    ];
    if (existing && eventOwnedFields.some((field) =>
      Object.hasOwn(existing, field) !== Object.hasOwn(next, field)
      || canonicalStateJson(existing[field]) !== canonicalStateJson(next[field])
    )) {
      return { ok: false, error: "carry_lifecycle_projection_write_requires_event" };
    }
    const nextSequence = next?.position?.last_event_sequence ?? 0;
    const nextTail = Array.isArray(next?.lifecycle_events) ? next.lifecycle_events : [];
    if (!existing) {
      return nextSequence === 0 && nextTail.length === 0
        ? { ok: true, entry: null }
        : { ok: false, error: "carry_lifecycle_event_required" };
    }
    const existingTail = Array.isArray(existing.lifecycle_events) ? existing.lifecycle_events : [];
    const latest = journal.at(-1) || null;
    if (nextSequence !== (existing.position?.last_event_sequence ?? 0)
      || canonicalStateJson(nextTail) !== canonicalStateJson(existingTail)
      || (nextSequence < originSequence ? latest !== null : latest?.sequence !== nextSequence)) {
      return { ok: false, error: "carry_lifecycle_event_required" };
    }
    return { ok: true, entry: null };
  }
  const sequence = event?.sequence;
  if (!existing || !Number.isSafeInteger(existing.position?.last_event_sequence)) {
    return { ok: false, error: "carry_lifecycle_previous_position_missing" };
  }
  if (sequence !== existing.position.last_event_sequence + 1
    || next.position?.last_event_sequence !== sequence) {
    return { ok: false, error: "carry_lifecycle_event_sequence_invalid" };
  }
  const tail = Array.isArray(next.lifecycle_events) ? next.lifecycle_events : [];
  const existingTail = Array.isArray(existing.lifecycle_events) ? existing.lifecycle_events : [];
  const expectedTail = existingTail.concat(event).slice(-256);
  if (tail.length === 0
    || tail.length > 256
    || canonicalStateJson(tail) !== canonicalStateJson(expectedTail)) {
    return { ok: false, error: "carry_lifecycle_snapshot_binding_mismatch" };
  }
  const previous = journal.at(-1) || null;
  if (sequence < originSequence || (!previous && sequence !== originSequence)) {
    return { ok: false, error: "carry_lifecycle_journal_missing" };
  }
  if (previous && previous.sequence !== sequence - 1) {
    return { ok: false, error: "carry_lifecycle_journal_sequence_invalid" };
  }
  if (journal.some((item) => item.event_id === event.event_id || item.sequence === sequence)) {
    return { ok: false, error: "carry_lifecycle_event_conflict" };
  }
  try {
    return {
      ok: true,
      entry: finalizeCarryLifecycleEventRecord({
        position_id: next.position.position_id,
        event,
        previous_event_commitment: previous?.event_commitment || null,
      }),
    };
  } catch (error) {
    return { ok: false, error: error.message || "carry_lifecycle_event_invalid" };
  }
}

function bindCarryLifecycleJournalMetadata({ existing, record, journal }) {
  const existingMetadata = existing?.lifecycle_journal;
  let originSequence;
  if (existingMetadata !== undefined) {
    if (existingMetadata?.version !== 1
      || !Number.isSafeInteger(existingMetadata.origin_sequence)
      || existingMetadata.origin_sequence <= 0) {
      return { ok: false, error: "carry_lifecycle_journal_metadata_invalid" };
    }
    originSequence = existingMetadata.origin_sequence;
    if (record?.lifecycle_journal !== undefined
      && canonicalStateJson(record.lifecycle_journal) !== canonicalStateJson(existingMetadata)) {
      return { ok: false, error: "carry_lifecycle_journal_metadata_immutable" };
    }
  } else {
    const storedSequences = journal
      .map((item) => item?.sequence)
      .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0);
    originSequence = storedSequences.length > 0
      ? Math.min(...storedSequences)
      : (existing?.position?.last_event_sequence ?? 0) + 1;
  }
  if (!Number.isSafeInteger(originSequence) || originSequence <= 0) {
    return { ok: false, error: "carry_lifecycle_journal_metadata_invalid" };
  }
  return {
    ok: true,
    record: {
      ...record,
      lifecycle_journal: { version: 1, origin_sequence: originSequence },
    },
  };
}

function canonicalStateJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStateJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalStateJson(child)}`)
    .join(",")}}`;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function timestampOrNow(value) {
  if (!value) return new Date().toISOString();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function dateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = value ? new Date(value) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function leaseActive(session, now) {
  if (!session?.tick_lease_id || !session.tick_lease_until) return false;
  const until = new Date(session.tick_lease_until).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

async function upsertOmnibusAllocation(sql, allocation) {
  const next = allocation || {};
  const allocationCommitment = next.allocation_commitment;
  if (!allocationCommitment) return;
  const isPlaceholder = Object.keys(next).length <= 1;
  if (isPlaceholder) {
    await sql`
      INSERT INTO worker_omnibus_allocations (allocation_commitment, allocation_json, updated_at)
      VALUES (${allocationCommitment}, ${jsonParam(next)}::jsonb, NOW())
      ON CONFLICT (allocation_commitment) DO NOTHING
    `;
    return;
  }
  await sql`
    INSERT INTO worker_omnibus_allocations (allocation_commitment, allocation_json, updated_at)
    VALUES (${allocationCommitment}, ${jsonParam(next)}::jsonb, NOW())
    ON CONFLICT (allocation_commitment)
    DO UPDATE SET allocation_json = excluded.allocation_json, updated_at = excluded.updated_at
  `;
}

async function readOmnibusAllocation(sql, allocationCommitment) {
  const allocationRows = await sql`
    SELECT allocation_json, updated_at
    FROM worker_omnibus_allocations
    WHERE allocation_commitment = ${allocationCommitment}
  `;
  if (!allocationRows[0]) return null;
  const reservationRows = await sql`
    SELECT reservation_json
    FROM worker_omnibus_reservations
    WHERE allocation_commitment = ${allocationCommitment}
  `;
  const fillRows = await sql`
    SELECT fill_json
    FROM worker_omnibus_fills
    WHERE allocation_commitment = ${allocationCommitment}
  `;
  const reservations = {};
  for (const row of reservationRows) {
    const reservation = decodeJson(row.reservation_json);
    if (reservation?.work_order_commitment) {
      reservations[reservation.work_order_commitment] = reservation;
    }
  }
  const fills = {};
  for (const row of fillRows) {
    const fill = decodeJson(row.fill_json);
    if (fill?.fill_commitment) fills[fill.fill_commitment] = fill;
  }
  return {
    allocation: decodeJson(allocationRows[0].allocation_json),
    reservations,
    fills,
    updated_at: toIso(allocationRows[0].updated_at),
  };
}

function filterRevenueEvidenceRows(events, input = {}) {
  const sessionId = stringValue(input.autopilot_session_id || input.session_id);
  const venueId = stringValue(input.venue_id);
  const revenueStatus = stringValue(input.revenue_status);
  const fromMs = input.from ? new Date(input.from).getTime() : null;
  const toMs = input.to ? new Date(input.to).getTime() : null;
  return events.filter((event) => {
    if (sessionId && event.autopilot_session_id !== sessionId) return false;
    if (venueId && event.venue_id !== venueId) return false;
    if (revenueStatus && event.revenue_status !== revenueStatus) return false;
    const createdMs = new Date(event.created_at || 0).getTime();
    if (Number.isFinite(fromMs) && createdMs < fromMs) return false;
    if (Number.isFinite(toMs) && createdMs > toMs) return false;
    return true;
  });
}

function idempotencyReceiptMatches(receipt, expected = {}) {
  return Boolean(receipt && typeof receipt === "object" && !Array.isArray(receipt))
    && Object.entries(expected).every(([key, value]) => value == null || receipt[key] === value);
}

async function migrateLegacyPostgresDocument(sql) {
  const rows = await sql`
    SELECT state_json
    FROM worker_state_documents
    WHERE id = ${"private-agent-execution-state-v1"}
  `;
  if (!rows[0]?.state_json) return;
  const state = normalizeState(rows[0].state_json);

  for (const session of Object.values(state.sessions || {})) {
    if (!session?.session_commitment) continue;
    await sql`
      INSERT INTO worker_sessions (
        session_commitment,
        session_json,
        venue_id,
        vault_commitment,
        policy_commitment,
        allocation_commitment,
        created_at,
        updated_at
      )
      VALUES (
        ${session.session_commitment},
        ${jsonParam(session)}::jsonb,
        ${session.venue_id || null},
        ${session.vault_commitment || null},
        ${session.policy_commitment || null},
        ${session.allocation_commitment || null},
        ${timestampOrNow(session.created_at || session.updated_at)},
        ${timestampOrNow(session.updated_at)}
      )
      ON CONFLICT (session_commitment) DO NOTHING
    `;
  }

  for (const [workOrderCommitment, record] of Object.entries(state.idempotency || {})) {
    if (!record?.receipt) continue;
    await sql`
      INSERT INTO worker_idempotency (work_order_commitment, receipt_json, updated_at)
      VALUES (
        ${workOrderCommitment},
        ${jsonParam(record.receipt)}::jsonb,
        ${timestampOrNow(record.updated_at)}
      )
      ON CONFLICT (work_order_commitment) DO NOTHING
    `;
  }

  for (const [workOrderCommitment, attempt] of Object.entries(state.execution_attempts || {})) {
    if (!attempt) continue;
    await sql`
      INSERT INTO worker_execution_attempts (work_order_commitment, attempt_json, status, updated_at)
      VALUES (
        ${workOrderCommitment},
        ${jsonParam(attempt)}::jsonb,
        ${attempt.status || null},
        ${timestampOrNow(attempt.updated_at || attempt.created_at)}
      )
      ON CONFLICT (work_order_commitment) DO NOTHING
    `;
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  for (const [jti, record] of Object.entries(state.capability_jtis || {})) {
    const expiresAtUnix = Number(record?.expires_at_unix || 0);
    if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= nowUnix) continue;
    await sql`
      INSERT INTO worker_capability_jtis (jti, expires_at_unix, consumed_at)
      VALUES (${jti}, ${expiresAtUnix}, ${timestampOrNow(record.consumed_at)})
      ON CONFLICT (jti) DO NOTHING
    `;
  }

  for (const [key, record] of Object.entries(state.policy_counts || {})) {
    const count = Number(record?.count || 0);
    if (!Number.isFinite(count)) continue;
    await sql`
      INSERT INTO worker_policy_counts (key, count, updated_at)
      VALUES (${key}, ${Math.trunc(count)}, ${timestampOrNow(record.updated_at)})
      ON CONFLICT (key) DO NOTHING
    `;
  }

  for (const [key, record] of Object.entries(state.policy_amounts || {})) {
    const amount = Number(record?.amount || 0);
    if (!Number.isFinite(amount)) continue;
    await sql`
      INSERT INTO worker_policy_amounts (key, amount, updated_at)
      VALUES (${key}, ${amount}, ${timestampOrNow(record.updated_at)})
      ON CONFLICT (key) DO NOTHING
    `;
  }

  for (const session of Object.values(state.autopilot_sessions || {})) {
    if (!session?.autopilot_session_id) continue;
    await sql`
      INSERT INTO worker_autopilot_sessions (
        autopilot_session_id,
        owner_commitment,
        session_json,
        created_at,
        updated_at
      )
      VALUES (
        ${session.autopilot_session_id},
        ${session.owner_commitment || null},
        ${jsonParam(session)}::jsonb,
        ${timestampOrNow(session.created_at || session.updated_at)},
        ${timestampOrNow(session.updated_at)}
      )
      ON CONFLICT (autopilot_session_id) DO NOTHING
    `;
  }

  for (const [sessionId, events] of Object.entries(state.autopilot_events || {})) {
    for (const event of Array.isArray(events) ? events : []) {
      const eventId = event.event_id || stableRecordId("autoevt", { sessionId, event });
      await sql`
        INSERT INTO worker_autopilot_events (event_id, autopilot_session_id, event_json, created_at)
        VALUES (
          ${eventId},
          ${sessionId},
          ${jsonParam({ ...event, event_id: eventId, autopilot_session_id: sessionId })}::jsonb,
          ${timestampOrNow(event.created_at)}
        )
        ON CONFLICT (event_id) DO NOTHING
      `;
    }
  }

  for (const [sessionId, decisions] of Object.entries(state.autopilot_decisions || {})) {
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      const decisionId = decision.decision_id || stableRecordId("autodecision", { sessionId, decision });
      await sql`
        INSERT INTO worker_autopilot_decisions (decision_id, autopilot_session_id, decision_json, created_at)
        VALUES (
          ${decisionId},
          ${sessionId},
          ${jsonParam({ ...decision, autopilot_session_id: sessionId })}::jsonb,
          ${timestampOrNow(decision.created_at)}
        )
        ON CONFLICT (decision_id) DO NOTHING
      `;
    }
  }

  for (const [sessionId, positions] of Object.entries(state.autopilot_positions || {})) {
    for (const position of Array.isArray(positions) ? positions : []) {
      const positionKey = `${position.venue_id || "unknown"}:${position.market || "unknown"}`;
      await sql`
        INSERT INTO worker_autopilot_positions (
          autopilot_session_id,
          position_key,
          position_json,
          updated_at
        )
        VALUES (
          ${sessionId},
          ${positionKey},
          ${jsonParam(position)}::jsonb,
          ${timestampOrNow(position.updated_at)}
        )
        ON CONFLICT (autopilot_session_id, position_key) DO NOTHING
      `;
    }
  }

  for (const event of Array.isArray(state.revenue_evidence) ? state.revenue_evidence : []) {
    if (!event?.event_hash || !event.revenue_event_id) continue;
    await sql`
      INSERT INTO worker_revenue_events (
        revenue_event_id,
        work_order_commitment,
        autopilot_session_id,
        venue_id,
        revenue_status,
        event_hash,
        previous_event_hash,
        event_json,
        created_at
      )
      VALUES (
        ${event.revenue_event_id},
        ${event.work_order_commitment || null},
        ${event.autopilot_session_id || null},
        ${event.venue_id || null},
        ${event.revenue_status || null},
        ${event.event_hash},
        ${event.previous_event_hash || null},
        ${jsonParam(event)}::jsonb,
        ${timestampOrNow(event.created_at)}
      )
      ON CONFLICT (revenue_event_id) DO NOTHING
    `;
  }

  for (const [allocationCommitment, record] of Object.entries(state.hyperliquid_managed_allocations || {})) {
    if (!record) continue;
    await sql`
      INSERT INTO worker_hyperliquid_managed_allocations (allocation_commitment, allocation_json, updated_at)
      VALUES (
        ${allocationCommitment},
        ${jsonParam(record)}::jsonb,
        ${timestampOrNow(record.updated_at)}
      )
      ON CONFLICT (allocation_commitment) DO NOTHING
    `;
  }

  for (const [allocationCommitment, record] of Object.entries(state.omnibus || {})) {
    const allocation = record?.allocation || { allocation_commitment: allocationCommitment };
    await sql`
      INSERT INTO worker_omnibus_allocations (allocation_commitment, allocation_json, updated_at)
      VALUES (
        ${allocationCommitment},
        ${jsonParam(allocation)}::jsonb,
        ${timestampOrNow(record?.updated_at)}
      )
      ON CONFLICT (allocation_commitment) DO NOTHING
    `;
    for (const [workOrderCommitment, reservation] of Object.entries(record?.reservations || {})) {
      await sql`
        INSERT INTO worker_omnibus_reservations (
          allocation_commitment,
          work_order_commitment,
          reservation_json,
          updated_at
        )
        VALUES (
          ${allocationCommitment},
          ${workOrderCommitment},
          ${jsonParam(reservation)}::jsonb,
          ${timestampOrNow(reservation.updated_at || reservation.created_at)}
        )
        ON CONFLICT (allocation_commitment, work_order_commitment) DO NOTHING
      `;
    }
    for (const [fillCommitment, fill] of Object.entries(record?.fills || {})) {
      await sql`
        INSERT INTO worker_omnibus_fills (
          allocation_commitment,
          fill_commitment,
          fill_json,
          created_at
        )
        VALUES (
          ${allocationCommitment},
          ${fillCommitment},
          ${jsonParam(fill)}::jsonb,
          ${timestampOrNow(fill.created_at)}
        )
        ON CONFLICT (allocation_commitment, fill_commitment) DO NOTHING
      `;
    }
  }
}

export function createWorkerStateAdapter({ path, hmacSecret, load, save, atomicUpdate = null }) {
  let mutationQueue = Promise.resolve();
  async function hmacHex(parts) {
    const secret = typeof hmacSecret === "function" ? await hmacSecret() : hmacSecret;
    return createHmac("sha256", Buffer.from(secret, "hex"))
      .update(parts.filter(Boolean).join("\0"))
      .digest("hex");
  }

  async function loadState() {
    return normalizeState(await load());
  }

  function updateState(mutator) {
    const run = mutationQueue.then(async () => {
      if (typeof atomicUpdate === "function") return atomicUpdate(mutator);
      const state = await loadState();
      const result = await mutator(state);
      await save(state);
      return result;
    });
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    path,

    async deriveClientOrderId(prefix, workOrderCommitment) {
      return `${prefix}_${(await hmacHex([prefix, workOrderCommitment])).slice(0, 32)}`;
    },

    async deriveHyperliquidCloid(workOrderCommitment) {
      return `0x${(await hmacHex(["hyperliquid_cloid", workOrderCommitment])).slice(0, 32)}`;
    },

    async getIdempotency(workOrderCommitment) {
      return (await loadState()).idempotency[workOrderCommitment] || null;
    },

    async hasIdempotencyReceipt(expected) {
      return Object.values((await loadState()).idempotency).some(
        (stored) => idempotencyReceiptMatches(stored?.receipt, expected),
      );
    },

    async putIdempotency(workOrderCommitment, receipt) {
      return updateState((state) => {
        state.idempotency[workOrderCommitment] = {
          receipt,
          updated_at: new Date().toISOString(),
        };
        return receipt;
      });
    },

    async claimIdempotency(workOrderCommitment, receipt) {
      return updateState((state) => {
        const existing = state.idempotency[workOrderCommitment]?.receipt;
        if (existing) return { ok: false, existing: structuredClone(existing) };
        state.idempotency[workOrderCommitment] = {
          receipt: structuredClone(receipt),
          updated_at: new Date().toISOString(),
        };
        return { ok: true, receipt: structuredClone(receipt) };
      });
    },

    async claimCarryExposureReservations(positionId, bindingsCommitment, reservations) {
      return updateState((state) => {
        const persisted = assessCarryExposureClaim({
          positionId,
          bindingsCommitment,
          reservations,
          positions: state.carry_positions,
          sagas: state.multi_leg_sagas,
        });
        if (!persisted.ok) return persisted;
        for (const item of reservations) {
          const existing = state.carry_exposure_reservations[item.reservation_key];
          if (existing?.active && (existing.position_id !== positionId || existing.bindings_commitment !== bindingsCommitment)) {
            return { ok: false, conflicting_position_id: existing.position_id };
          }
        }
        for (const item of reservations) {
          const existing = state.carry_exposure_reservations[item.reservation_key];
          state.carry_exposure_reservations[item.reservation_key] = {
            ...structuredClone(item), position_id: positionId, bindings_commitment: bindingsCommitment, active: true,
            generation: existing?.active ? existing.generation : Number(existing?.generation || 0) + 1,
          };
        }
        return { ok: true };
      });
    },

    async listActiveCarryExposureReservationPositionIds() {
      const state = await loadState();
      return [...new Set(Object.values(state.carry_exposure_reservations)
        .filter((item) => item?.active === true)
        .map((item) => item.position_id))].sort();
    },

    async releaseCarryExposureReservations(positionId, bindingsCommitment, reservationKeys, expectedFlat) {
      return updateState((state) => {
        if (!exactFlatReservationRecord(state.carry_positions[positionId], expectedFlat)) {
          return { ok: false, reason: "exact_flat_reconciliation_required" };
        }
        let present = 0;
        for (const key of reservationKeys) {
          const existing = state.carry_exposure_reservations[key];
          if (existing) present += 1;
          if (existing?.active && (existing.position_id !== positionId || existing.bindings_commitment !== bindingsCommitment)) return { ok: false };
        }
        if (present !== 0 && present !== reservationKeys.length) return { ok: false, reason: "reservation_set_incomplete" };
        for (const key of reservationKeys) {
          if (state.carry_exposure_reservations[key]) state.carry_exposure_reservations[key].active = false;
        }
        return { ok: true, already_released: present === 0 };
      });
    },

    async releaseCarryExposureReservationsBeforeSubmit(positionId, bindingsCommitment, reservationKeys, sagaId) {
      return updateState((state) => {
        if (!exactNoSubmitReservationRecord(
          state.carry_positions[positionId],
          state.multi_leg_sagas[sagaId],
          positionId,
          sagaId,
        )) return { ok: false, reason: "durable_no_submit_proof_required" };
        let present = 0;
        for (const key of reservationKeys) {
          const existing = state.carry_exposure_reservations[key];
          if (existing) present += 1;
          if (existing?.active && (existing.position_id !== positionId || existing.bindings_commitment !== bindingsCommitment)) return { ok: false };
        }
        if (present !== 0 && present !== reservationKeys.length) return { ok: false, reason: "reservation_set_incomplete" };
        for (const key of reservationKeys) {
          if (state.carry_exposure_reservations[key]) state.carry_exposure_reservations[key].active = false;
        }
        return { ok: true, already_released: present === 0 };
      });
    },

    async putExecutionAttempt(workOrderCommitment, attempt) {
      return updateState((state) => {
        state.execution_attempts[workOrderCommitment] = {
          ...attempt,
          work_order_commitment: workOrderCommitment,
          updated_at: new Date().toISOString(),
        };
        return state.execution_attempts[workOrderCommitment];
      });
    },

    async claimExecutionAttempt(workOrderCommitment, attempt) {
      return updateState((state) => {
        const existing = state.execution_attempts[workOrderCommitment] || null;
        if (existing) return { ok: false, existing };
        const claimed = {
          ...attempt,
          work_order_commitment: workOrderCommitment,
          updated_at: new Date().toISOString(),
        };
        state.execution_attempts[workOrderCommitment] = claimed;
        return { ok: true, attempt: claimed };
      });
    },

    async claimExecutionAttemptWithPolicyUsage(workOrderCommitment, input = {}) {
      const mutate = (state) => claimExecutionAttemptWithPolicyUsageInState(
        state,
        workOrderCommitment,
        input,
      );
      return updateState(mutate);
    },

    async getExecutionAttempt(workOrderCommitment) {
      return (await loadState()).execution_attempts[workOrderCommitment] || null;
    },

    async consumeCapabilityJti(jti, expiresAtUnix) {
      return updateState((state) => {
        const now = Math.floor(Date.now() / 1000);
        for (const [key, record] of Object.entries(state.capability_jtis || {})) {
          if (Number(record?.expires_at_unix || 0) <= now) {
            delete state.capability_jtis[key];
          }
        }
        if (state.capability_jtis[jti]) return { ok: false, replayed: true };
        state.capability_jtis[jti] = {
          jti,
          expires_at_unix: Number.isInteger(expiresAtUnix) ? expiresAtUnix : now + 300,
          consumed_at: new Date().toISOString(),
        };
        return { ok: true };
      });
    },

    async putAutopilotSession(session) {
      const state = await loadState();
      state.autopilot_sessions[session.autopilot_session_id] = {
        ...session,
        updated_at: new Date().toISOString(),
      };
      await save(state);
      return state.autopilot_sessions[session.autopilot_session_id];
    },

    async getAutopilotSession(sessionId) {
      return (await loadState()).autopilot_sessions[sessionId] || null;
    },

    async listAutopilotSessions(ownerCommitment = null) {
      return Object.values((await loadState()).autopilot_sessions)
        .filter((session) => !ownerCommitment || session.owner_commitment === ownerCommitment)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    },

    async claimAutopilotTickLease(sessionId, input = {}) {
      const state = await loadState();
      const session = state.autopilot_sessions[sessionId] || null;
      if (!session) return { ok: false, error: "autopilot_session_not_found" };
      const now = dateValue(input.now);
      const leaseId = stringValue(input.lease_id) ||
        stableRecordId("ticklease", { sessionId, now: now.toISOString() });
      if (leaseActive(session, now) && session.tick_lease_id !== leaseId) {
        return {
          ok: false,
          error: "tick_lease_active",
          lease_id: session.tick_lease_id || null,
          lease_until: session.tick_lease_until || null,
          session,
        };
      }
      const leaseMs = positiveInt(input.lease_ms, 60_000);
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const next = {
        ...session,
        tick_lease_id: leaseId,
        tick_lease_until: leaseUntil,
        last_tick_claimed_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      state.autopilot_sessions[sessionId] = next;
      await save(state);
      return {
        ok: true,
        lease_id: leaseId,
        lease_until: leaseUntil,
        session: next,
      };
    },

    async releaseAutopilotTickLease(sessionId, leaseId, input = {}) {
      const state = await loadState();
      const session = state.autopilot_sessions[sessionId] || null;
      if (!session) return { ok: false, error: "autopilot_session_not_found" };
      if (session.tick_lease_id !== stringValue(leaseId)) {
        return { ok: false, error: "tick_lease_not_owned", session };
      }
      const now = dateValue(input.now);
      const next = {
        ...session,
        last_tick_released_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      delete next.tick_lease_id;
      delete next.tick_lease_until;
      state.autopilot_sessions[sessionId] = next;
      await save(state);
      return { ok: true, session: next };
    },

    async appendAutopilotEvent(sessionId, event) {
      const state = await loadState();
      const existing = Array.isArray(state.autopilot_events[sessionId])
        ? state.autopilot_events[sessionId]
        : [];
      const next = existing.concat(event).slice(-250);
      state.autopilot_events[sessionId] = next;
      await save(state);
      return event;
    },

    async listAutopilotEvents(sessionId) {
      return ((await loadState()).autopilot_events[sessionId] || []).slice(-200);
    },

    async appendAutopilotDecision(sessionId, decision) {
      const state = await loadState();
      const existing = Array.isArray(state.autopilot_decisions[sessionId])
        ? state.autopilot_decisions[sessionId]
        : [];
      const next = existing.concat(decision).slice(-250);
      state.autopilot_decisions[sessionId] = next;
      await save(state);
      return decision;
    },

    async listAutopilotDecisions(sessionId) {
      return ((await loadState()).autopilot_decisions[sessionId] || []).slice(-200);
    },

    async putAutopilotPosition(sessionId, position) {
      const state = await loadState();
      const existing = Array.isArray(state.autopilot_positions[sessionId])
        ? state.autopilot_positions[sessionId]
        : [];
      const key = `${position.venue_id || "unknown"}:${position.market || "unknown"}`;
      const next = existing
        .filter((item) => `${item.venue_id || "unknown"}:${item.market || "unknown"}` !== key)
        .concat({
          ...position,
          updated_at: new Date().toISOString(),
        })
        .slice(-50);
      state.autopilot_positions[sessionId] = next;
      await save(state);
      return next[next.length - 1];
    },

    async listAutopilotPositions(sessionId) {
      return ((await loadState()).autopilot_positions[sessionId] || []).slice(-50);
    },

    async appendAutopilotOpportunity(sessionId, opportunity) {
      const state = await loadState();
      const existing = Array.isArray(state.autopilot_opportunities[sessionId])
        ? state.autopilot_opportunities[sessionId]
        : [];
      const next = existing.concat(opportunity).slice(-100);
      state.autopilot_opportunities[sessionId] = next;
      await save(state);
      return opportunity;
    },

    async listAutopilotOpportunities(sessionId) {
      return ((await loadState()).autopilot_opportunities[sessionId] || []).slice(-50);
    },

    async putExecutorRecord(sessionId, executor) {
      const state = await loadState();
      const existing = Array.isArray(state.executor_records[sessionId])
        ? state.executor_records[sessionId]
        : [];
      const executorId = executor.executor_id || stableRecordId("executor", { sessionId, executor });
      const next = {
        ...executor,
        executor_id: executorId,
        autopilot_session_id: sessionId,
        updated_at: new Date().toISOString(),
      };
      state.executor_records[sessionId] = existing
        .filter((item) => item.executor_id !== executorId)
        .concat(next)
        .slice(-250);
      await save(state);
      return next;
    },

    async listExecutorRecords(sessionId) {
      return ((await loadState()).executor_records[sessionId] || []).slice(-200);
    },

    async putTickSnapshot(sessionId, snapshot) {
      const state = await loadState();
      const existing = Array.isArray(state.tick_snapshots[sessionId])
        ? state.tick_snapshots[sessionId]
        : [];
      const tickId = snapshot.tick_id || stableRecordId("tick", { sessionId, snapshot });
      const next = {
        ...snapshot,
        tick_id: tickId,
        autopilot_session_id: sessionId,
        updated_at: new Date().toISOString(),
      };
      state.tick_snapshots[sessionId] = existing
        .filter((item) => item.tick_id !== tickId)
        .concat(next)
        .slice(-150);
      await save(state);
      return next;
    },

    async listTickSnapshots(sessionId) {
      return ((await loadState()).tick_snapshots[sessionId] || []).slice(-100);
    },

    async putMultiLegSaga(saga, input = {}) {
      const state = await loadState();
      const existing = state.multi_leg_sagas[saga.saga_id] || null;
      const expectedSequence = input.expected_sequence;
      if (expectedSequence === null ? existing !== null : !Number.isInteger(expectedSequence)) {
        return { ok: false, error: existing ? "saga_version_conflict" : "saga_expected_sequence_required", saga: existing };
      }
      if (Number.isInteger(expectedSequence) && (!existing || existing.last_event_sequence !== expectedSequence)) {
        return { ok: false, error: "saga_version_conflict", saga: existing };
      }
      const next = { ...saga, updated_at_ms: Number(saga.updated_at_ms || Date.now()) };
      state.multi_leg_sagas[saga.saga_id] = next;
      await save(state);
      return { ok: true, saga: next };
    },

    async getMultiLegSaga(sagaId) {
      return (await loadState()).multi_leg_sagas[sagaId] || null;
    },

    async listMultiLegSagas(input = {}) {
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 200), 1_000));
      return Object.values((await loadState()).multi_leg_sagas)
        .filter((saga) => input.active_only !== true || saga.terminal !== true)
        .sort((left, right) => Number(left.updated_at_ms || 0) - Number(right.updated_at_ms || 0))
        .slice(0, limit);
    },

    async putCarryPositionRecord(record, input = {}) {
      return updateState((state) => {
        const positionId = record?.position?.position_id;
        const existing = state.carry_positions[positionId] || null;
        const expectedVersion = input.expected_version;
        if (expectedVersion === null) {
          if (existing) return { ok: false, error: "carry_record_version_conflict", record: structuredClone(existing) };
        } else if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
          return { ok: false, error: "carry_record_expected_version_required", record: structuredClone(existing) };
        } else if (!existing || existing.record_version !== expectedVersion) {
          return { ok: false, error: "carry_record_version_conflict", record: structuredClone(existing) };
        }
        const journal = Array.isArray(state.carry_lifecycle_events[positionId])
          ? state.carry_lifecycle_events[positionId]
          : [];
        const bound = bindCarryLifecycleJournalMetadata({ existing, record, journal });
        if (!bound.ok) return { ...bound, record: structuredClone(existing) };
        const next = {
          ...bound.record,
          record_version: expectedVersion === null ? 1 : expectedVersion + 1,
          updated_at: new Date().toISOString(),
        };
        const append = prepareCarryLifecycleAppend({
          existing,
          next,
          event: input.lifecycle_event || null,
          journal,
        });
        if (!append.ok) return { ...append, record: structuredClone(existing) };
        if (append.entry) state.carry_lifecycle_events[positionId] = journal.concat(append.entry);
        state.carry_positions[positionId] = next;
        return { ok: true, record: structuredClone(next) };
      });
    },

    async getCarryPositionRecord(positionId) {
      return (await loadState()).carry_positions[positionId] || null;
    },

    async listCarryPositionRecords(input = {}) {
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 100), 500));
      const owner = stringValue(input.owner_commitment);
      const status = stringValue(input.status);
      const beforeUpdatedAt = stringValue(input.before_updated_at);
      const beforePositionId = stringValue(input.before_position_id);
      return Object.values((await loadState()).carry_positions)
        .filter((record) => !owner || record.owner_commitment === owner)
        .filter((record) => !status || record.position?.status === status)
        .filter((record) => !beforeUpdatedAt || !beforePositionId ||
          String(record.updated_at || "") < beforeUpdatedAt ||
          (String(record.updated_at || "") === beforeUpdatedAt
            && String(record.position?.position_id || "") < beforePositionId))
        .sort((left, right) =>
          String(right.updated_at || "").localeCompare(String(left.updated_at || "")) ||
          String(right.position?.position_id || "").localeCompare(String(left.position?.position_id || "")))
        .slice(0, limit);
    },

    async listCarryLifecycleEvents(input = {}) {
      const positionId = stringValue(input.position_id);
      if (!positionId) return [];
      const afterSequence = Math.max(0, Number.parseInt(String(input.after_sequence || 0), 10) || 0);
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 1_000), 1_000));
      const rows = (await loadState()).carry_lifecycle_events[positionId];
      return (Array.isArray(rows) ? rows : [])
        .filter((item) => Number(item?.sequence || 0) > afterSequence)
        .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
        .slice(0, limit)
        .map((item) => structuredClone(item));
    },

    async appendRevenueEvidence(event) {
      const state = await loadState();
      const existing = Array.isArray(state.revenue_evidence) ? state.revenue_evidence : [];
      if (event?.work_order_commitment) {
        const matched = existing.find((item) => item.work_order_commitment === event.work_order_commitment);
        if (matched) return matched;
      }
      const finalized = finalizeRevenueEvidenceEvent(event, {
        previousEventHash: existing.at(-1)?.event_hash || null,
        sequence: existing.length + 1,
      });
      state.revenue_evidence = existing.concat(finalized);
      await save(state);
      return finalized;
    },

    async listRevenueEvidence(input = {}) {
      const state = await loadState();
      const limit = Math.max(1, Math.min(positiveInt(input.limit, 200), 1000));
      return filterRevenueEvidenceRows(
        (Array.isArray(state.revenue_evidence) ? state.revenue_evidence : []).slice(-limit),
        input,
      );
    },

    async putSession(session) {
      const state = await loadState();
      state.sessions[session.session_commitment] = {
        ...session,
        updated_at: new Date().toISOString(),
      };
      await save(state);
      return state.sessions[session.session_commitment];
    },

    async findSession(input) {
      const sessions = Object.values((await loadState()).sessions);
      return sessions.find((session) => {
        if (input.venue_id && session.venue_id !== input.venue_id) return false;
        if (input.vault_commitment && session.vault_commitment !== input.vault_commitment) return false;
        if (input.policy_commitment && session.policy_commitment !== input.policy_commitment) return false;
        if (
          input.allocation_commitment &&
          session.allocation_commitment !== input.allocation_commitment
        ) {
          return false;
        }
        return true;
      }) || null;
    },

    async putHyperliquidManagedAllocation(allocation) {
      const state = await loadState();
      state.hyperliquid_managed_allocations[allocation.allocation_commitment] = {
        allocation,
        updated_at: new Date().toISOString(),
      };
      await save(state);
      return state.hyperliquid_managed_allocations[allocation.allocation_commitment];
    },

    async getHyperliquidManagedAllocation(allocationCommitment) {
      return (await loadState()).hyperliquid_managed_allocations[allocationCommitment] || null;
    },

    async incrementPolicyCount(key, maxCount) {
      return updateState((state) => {
        const current = state.policy_counts[key] || { count: 0, updated_at: null };
        if (Number.isInteger(maxCount) && current.count >= maxCount) return { ok: false, count: current.count };
        const next = { count: current.count + 1, updated_at: new Date().toISOString() };
        state.policy_counts[key] = next;
        return { ok: true, count: next.count };
      });
    },

    async incrementPolicyAmount(key, amount, maxAmount) {
      const parsedAmount = Number.parseFloat(String(amount || "0"));
      const parsedMax = Number.parseFloat(String(maxAmount || "0"));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return { ok: false, amount: 0 };
      return updateState((state) => {
        const current = state.policy_amounts[key] || { amount: 0, updated_at: null };
        const nextAmount = Number(current.amount || 0) + parsedAmount;
        if (Number.isFinite(parsedMax) && parsedMax > 0 && nextAmount > parsedMax) return { ok: false, amount: Number(current.amount || 0) };
        const next = { amount: nextAmount, updated_at: new Date().toISOString() };
        state.policy_amounts[key] = next;
        return { ok: true, amount: next.amount };
      });
    },

    async putOmnibusAllocation(allocation) {
      const state = await loadState();
      state.omnibus[allocation.allocation_commitment] = {
        allocation,
        reservations: state.omnibus[allocation.allocation_commitment]?.reservations || {},
        fills: state.omnibus[allocation.allocation_commitment]?.fills || {},
        updated_at: new Date().toISOString(),
      };
      await save(state);
      return state.omnibus[allocation.allocation_commitment];
    },

    async getOmnibusAllocation(allocationCommitment) {
      return (await loadState()).omnibus[allocationCommitment] || null;
    },

    async reserveOmnibus(input) {
      const state = await loadState();
      const existing = state.omnibus[input.allocation_commitment] || {
        allocation: input.allocation || { allocation_commitment: input.allocation_commitment },
        reservations: {},
        fills: {},
      };
      existing.reservations[input.work_order_commitment] = {
        work_order_commitment: input.work_order_commitment,
        notional_bucket: input.notional_bucket,
        status: "reserved",
        created_at: new Date().toISOString(),
      };
      existing.updated_at = new Date().toISOString();
      state.omnibus[input.allocation_commitment] = existing;
      await save(state);
      return existing.reservations[input.work_order_commitment];
    },

    async releaseOmnibus(input) {
      const state = await loadState();
      const existing = state.omnibus[input.allocation_commitment];
      if (existing?.reservations?.[input.work_order_commitment]) {
        existing.reservations[input.work_order_commitment].status = "released";
        existing.reservations[input.work_order_commitment].updated_at = new Date().toISOString();
        existing.updated_at = new Date().toISOString();
        await save(state);
      }
    },

    async settleOmnibusFill(input) {
      const state = await loadState();
      const existing = state.omnibus[input.allocation_commitment] || {
        allocation: { allocation_commitment: input.allocation_commitment },
        reservations: {},
        fills: {},
      };
      existing.fills[input.fill_commitment] = {
        fill_commitment: input.fill_commitment,
        work_order_commitment: input.work_order_commitment,
        fee_bucket: input.fee_bucket || null,
        notional_bucket: input.notional_bucket || null,
        created_at: new Date().toISOString(),
      };
      if (existing.reservations[input.work_order_commitment]) {
        existing.reservations[input.work_order_commitment].status = "settled";
        existing.reservations[input.work_order_commitment].updated_at = new Date().toISOString();
      }
      existing.updated_at = new Date().toISOString();
      state.omnibus[input.allocation_commitment] = existing;
      await save(state);
      return existing.fills[input.fill_commitment];
    },
  };
}

function exactFlatReservationRecord(record, expected) {
  return record?.position?.status === "reconciled"
    && hasExactCarryFlatReconciliation(
      record.final_reconciliation_evidence,
      expected?.venue_ids,
      {
        owner_commitment: expected?.owner_commitment,
        carry_position_id: expected?.position_id,
        account_commitments: expected?.account_commitments,
        inventory_expectations: expected?.inventory_expectations,
      },
    );
}

function exactNoSubmitReservationRecord(record, saga, positionId, sagaId) {
  const venueIds = [record?.position?.long_venue_id, record?.position?.short_venue_id];
  const accountCommitments = Object.fromEntries(venueIds.map((venueId) => [
    venueId,
    record?.monitoring_context?.venue_access?.[venueId]?.account_commitment,
  ]));
  return record?.position?.position_id === positionId
    && record.position.status === "reconciled"
    && record.position.terminal_reason === "entry_failed_no_fill"
    && record.entry_saga_id === sagaId
    && saga?.saga_id === sagaId
    && saga.terminal === true
    && saga.status === "failed_no_submit"
    && saga.terminal_reason === "cancelled_before_submit"
    && saga.unhedged_deadline_ms === null
    && saga.execution_context?.carry_position_id === positionId
    && saga.execution_context?.owner_commitment === record.owner_commitment
    && Array.isArray(saga.legs)
    && saga.legs.length === 2
    && saga.legs.every((leg) => leg.submission_status === "pending"
      && leg.provider_ref_commitment === null
      && leg.filled_micro_usdc === 0)
    && exactFlatReservationRecord(record, {
      owner_commitment: record.owner_commitment,
      position_id: positionId,
      venue_ids: venueIds,
      account_commitments: accountCommitments,
    });
}

const CARRY_EXPOSURE_BEARING_STATUSES = new Set([
  "active", "rebalancing", "exiting", "frozen", "manual_intervention",
]);
const CARRY_KNOWN_STATUSES = new Set([
  "draft", "opening", "active", "rebalancing", "exiting", "reconciled", "frozen", "manual_intervention",
]);

function assessCarryExposureClaim({ positionId, bindingsCommitment, reservations, positions, sagas }) {
  const targetRecord = positions?.[positionId];
  const targetBinding = durableCarryExposureBinding(targetRecord, positionId);
  const targetSaga = targetRecord?.entry_saga_id ? sagas?.[targetRecord.entry_saga_id] : null;
  if (!targetBinding
    || targetBinding.status !== "opening"
    || !provablyPreSubmitCarryOpening(targetRecord, targetSaga, { readyOnly: true })
    || !exactCarryExposureClaimBinding(targetBinding, targetSaga, bindingsCommitment, reservations)) {
    return { ok: false, reason: "carry_exposure_target_binding_invalid" };
  }

  for (const [persistedId, record] of Object.entries(positions || {})) {
    if (persistedId === positionId) continue;
    const status = record?.position?.status;
    if (record?.position?.position_id !== persistedId || !CARRY_KNOWN_STATUSES.has(status)) {
      return {
        ok: false,
        reason: "carry_legacy_exposure_binding_unverifiable",
        conflicting_position_id: persistedId,
      };
    }
    if (status === "draft" || status === "reconciled") continue;
    const persistedBinding = durableCarryExposureBinding(record, persistedId);
    if (!persistedBinding) {
      return {
        ok: false,
        reason: "carry_legacy_exposure_binding_unverifiable",
        conflicting_position_id: persistedId,
      };
    }
    if (status === "opening") {
      const saga = record.entry_saga_id ? sagas?.[record.entry_saga_id] : null;
      if (provablyPreSubmitCarryOpening(record, saga)) continue;
    } else if (!CARRY_EXPOSURE_BEARING_STATUSES.has(status)) {
      return {
        ok: false,
        reason: "carry_legacy_exposure_binding_unverifiable",
        conflicting_position_id: persistedId,
      };
    }
    if (carryExposureBindingsOverlap(targetBinding, persistedBinding)) {
      return {
        ok: false,
        reason: "carry_legacy_exposure_overlap",
        conflicting_position_id: persistedId,
      };
    }
  }
  return { ok: true };
}

function durableCarryExposureBinding(record, expectedPositionId) {
  const position = record?.position;
  const ownerCommitment = String(record?.owner_commitment || "");
  const asset = String(position?.asset || "");
  const venueIds = [position?.long_venue_id, position?.short_venue_id];
  if (position?.position_id !== expectedPositionId
    || !/^[A-Za-z0-9:_-]{8,180}$/.test(ownerCommitment)
    || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(asset)
    || venueIds.some((venueId) => !/^[a-z0-9][a-z0-9_-]{1,47}$/.test(String(venueId || "")))
    || new Set(venueIds).size !== 2) return null;
  const accountsByVenue = Object.fromEntries(venueIds.map((venueId) => [
    venueId,
    record?.monitoring_context?.venue_access?.[venueId]?.account_commitment,
  ]));
  const accountCommitments = Object.values(accountsByVenue);
  if (accountCommitments.some((value) => !/^[A-Za-z0-9:_-]{8,180}$/.test(String(value || "")))) return null;
  return {
    position_id: expectedPositionId,
    status: position.status,
    owner_commitment: ownerCommitment,
    asset,
    venue_ids: venueIds,
    accounts_by_venue: accountsByVenue,
    account_commitments: accountCommitments,
  };
}

function provablyPreSubmitCarryOpening(record, saga, { readyOnly = false } = {}) {
  const statusAllowed = readyOnly
    ? saga?.status === "ready" && saga?.terminal === false
    : ((saga?.status === "preflighting" || saga?.status === "ready") && saga?.terminal === false)
      || (saga?.status === "failed_no_submit" && saga?.terminal === true
        && (saga?.terminal_reason === "preflight_failed" || saga?.terminal_reason === "cancelled_before_submit"));
  const exposureByAsset = saga?.signed_filled_exposure_micro_usdc_by_asset;
  return record?.position?.status === "opening"
    && typeof record.entry_saga_id === "string"
    && saga?.saga_id === record.entry_saga_id
    && statusAllowed
    && saga.recovery_mode === "unwind"
    && saga.unhedged_deadline_ms === null
    && saga.first_exposure_observed_at_ms === null
    && saga.exposure_boundary_provenance === null
    && exposureByAsset && typeof exposureByAsset === "object" && !Array.isArray(exposureByAsset)
    && Object.values(exposureByAsset).every((value) => value === 0)
    && saga.execution_context?.carry_position_id === record.position.position_id
    && saga.execution_context?.owner_commitment === record.owner_commitment
    && Array.isArray(saga.execution_context?.legs)
    && Array.isArray(saga.legs)
    && saga.legs.length === 2
    && saga.execution_context.legs.length === 2
    && saga.legs.every((leg) => leg?.submission_status === "pending"
      && leg.provider_ref_commitment === null
      && leg.filled_micro_usdc === 0
      && leg.unwind_filled_micro_usdc === 0);
}

function exactCarryExposureClaimBinding(binding, saga, bindingsCommitment, reservations) {
  const contextLegs = saga.execution_context.legs;
  const legs = saga.legs.map((leg) => {
    const context = contextLegs.find((item) => item?.leg_id === leg?.leg_id);
    return {
      venue_id: leg?.venue_id,
      leg_id: leg?.leg_id,
      work_order_commitment: context?.work_order_commitment,
    };
  });
  if (legs.some((leg, index) => leg.venue_id !== binding.venue_ids[index]
    || !/^[A-Za-z0-9:_-]{8,180}$/.test(String(leg.leg_id || ""))
    || !/^[A-Za-z0-9:_-]{8,180}$/.test(String(leg.work_order_commitment || "")))) return false;
  const expectedBindingsCommitment = `carry:exposure-bindings:${stateDigest(JSON.stringify({
    owner_commitment: binding.owner_commitment,
    asset: binding.asset,
    venue_ids: binding.venue_ids,
    accounts_by_venue: binding.accounts_by_venue,
    legs,
  })).slice(0, 40)}`;
  if (bindingsCommitment !== expectedBindingsCommitment || !Array.isArray(reservations)) return false;
  const expected = new Map([
    [`carry:exposure:owner:${stateDigest(`${binding.owner_commitment}:${binding.asset}`).slice(0, 40)}`, null],
    ...[...binding.account_commitments].sort().map((accountCommitment) => [
      `carry:exposure:account:${stateDigest(`${accountCommitment}:${binding.asset}`).slice(0, 40)}`,
      accountCommitment,
    ]),
  ]);
  if (reservations.length !== expected.size
    || new Set(reservations.map((item) => item?.reservation_key)).size !== reservations.length) return false;
  return reservations.every((item) => expected.has(item?.reservation_key)
    && (expected.get(item.reservation_key) === null
      ? item.account_commitment === undefined
      : item.account_commitment === expected.get(item.reservation_key)));
}

function carryExposureBindingsOverlap(left, right) {
  if (left.asset !== right.asset) return false;
  if (left.owner_commitment === right.owner_commitment) return true;
  const rightAccounts = new Set(right.account_commitments);
  return left.account_commitments.some((account) => rightAccounts.has(account));
}

function stateDigest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeState(value) {
  if (typeof value === "string") {
    try {
      return normalizeState(JSON.parse(value));
    } catch {
      return emptyState();
    }
  }
  const loaded = value && typeof value === "object" && !Array.isArray(value) ? value : emptyState();
  return {
    ...emptyState(),
    ...loaded,
    sessions: loaded.sessions || {},
    idempotency: loaded.idempotency || {},
    policy_counts: loaded.policy_counts || {},
    policy_amounts: loaded.policy_amounts || {},
    execution_attempts: loaded.execution_attempts || {},
    capability_jtis: loaded.capability_jtis || {},
    autopilot_sessions: loaded.autopilot_sessions || {},
    autopilot_events: loaded.autopilot_events || {},
    autopilot_decisions: loaded.autopilot_decisions || {},
    autopilot_positions: loaded.autopilot_positions || {},
    autopilot_opportunities: loaded.autopilot_opportunities || {},
    executor_records: loaded.executor_records || {},
    tick_snapshots: loaded.tick_snapshots || {},
    multi_leg_sagas: loaded.multi_leg_sagas || {},
    carry_positions: loaded.carry_positions || {},
    carry_exposure_reservations: loaded.carry_exposure_reservations || {},
    carry_lifecycle_events: loaded.carry_lifecycle_events || {},
    revenue_evidence: Array.isArray(loaded.revenue_evidence) ? loaded.revenue_evidence : [],
    hyperliquid_managed_allocations: loaded.hyperliquid_managed_allocations || {},
    omnibus: loaded.omnibus || {},
  };
}

function normalizePolicyUsage(input = {}) {
  const countsByKey = new Map();
  const amountsByKey = new Map();
  let ordinal = 0;

  for (const raw of Array.isArray(input.counts) ? input.counts : []) {
    const key = String(raw?.key ?? "");
    const incrementValue = raw?.increment ?? 1;
    const increment = Number(incrementValue);
    const maxValue = raw?.max_count;
    const maxCount = Number.isInteger(maxValue) ? maxValue : null;
    const item = {
      ...raw,
      type: "count",
      key,
      increment,
      max_count: maxCount,
      invalid: !key || !Number.isInteger(increment) || increment <= 0,
      ordinal: ordinal++,
    };
    const existing = countsByKey.get(key);
    if (!existing) {
      countsByKey.set(key, item);
      continue;
    }
    existing.increment += increment;
    existing.invalid ||= item.invalid;
    if (maxCount !== null) {
      existing.max_count = existing.max_count === null
        ? maxCount
        : Math.min(existing.max_count, maxCount);
    }
  }

  for (const raw of Array.isArray(input.amounts) ? input.amounts : []) {
    const key = String(raw?.key ?? "");
    const amount = Number(raw?.amount);
    const maxValue = Number(raw?.max_amount);
    const maxAmount = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : null;
    const item = {
      ...raw,
      type: "amount",
      key,
      amount,
      max_amount: maxAmount,
      invalid: !key || !Number.isFinite(amount) || amount <= 0,
      ordinal: ordinal++,
    };
    const existing = amountsByKey.get(key);
    if (!existing) {
      amountsByKey.set(key, item);
      continue;
    }
    existing.amount += amount;
    existing.invalid ||= item.invalid;
    if (maxAmount !== null) {
      existing.max_amount = existing.max_amount === null
        ? maxAmount
        : Math.min(existing.max_amount, maxAmount);
    }
  }

  return {
    counts: [...countsByKey.values()].sort((a, b) => a.ordinal - b.ordinal),
    amounts: [...amountsByKey.values()].sort((a, b) => a.ordinal - b.ordinal),
  };
}

function claimExecutionAttemptWithPolicyUsageInState(state, workOrderCommitment, input = {}) {
  const existing = state.execution_attempts[workOrderCommitment] || null;
  const rearmExisting = input.rearm_failed_no_submit === true && isPolicyFailedNoSubmitAttempt(existing);
  if (existing && !rearmExisting) {
    return { ok: false, reason: "attempt_exists", existing: structuredClone(existing) };
  }

  const usage = normalizePolicyUsage(input);
  const denials = [];
  for (const item of usage.counts) {
    const current = Number(state.policy_counts[item.key]?.count || 0);
    if (item.invalid || (Number.isInteger(item.max_count) && current + item.increment > item.max_count)) {
      denials.push(item);
    }
  }
  for (const item of usage.amounts) {
    const current = Number(state.policy_amounts[item.key]?.amount || 0);
    if (item.invalid || (
      Number.isFinite(item.max_amount) &&
      item.max_amount > 0 &&
      current + item.amount > item.max_amount
    )) {
      denials.push(item);
    }
  }

  const now = new Date().toISOString();
  const denied = denials.sort((a, b) => a.ordinal - b.ordinal)[0] || null;
  if (denied) {
    const attempt = rearmExisting
      ? existing
      : policyDeniedAttempt({
          ...(input.denied_attempt || {}),
          work_order_commitment: workOrderCommitment,
          updated_at: now,
        }, denied);
    if (!rearmExisting) state.execution_attempts[workOrderCommitment] = attempt;
    return {
      ok: false,
      reason: "policy_denied",
      denied: policyDenialResult(denied),
      attempt: structuredClone(attempt),
    };
  }

  for (const item of usage.counts) {
    const current = Number(state.policy_counts[item.key]?.count || 0);
    state.policy_counts[item.key] = { count: current + item.increment, updated_at: now };
  }
  for (const item of usage.amounts) {
    const current = Number(state.policy_amounts[item.key]?.amount || 0);
    state.policy_amounts[item.key] = { amount: current + item.amount, updated_at: now };
  }
  const allowedAttempt = {
    ...(input.allowed_attempt || {}),
    work_order_commitment: workOrderCommitment,
    updated_at: now,
  };
  const attempt = rearmExisting
    ? rearmedPolicyAttempt(allowedAttempt, existing, now)
    : allowedAttempt;
  state.execution_attempts[workOrderCommitment] = attempt;
  return { ok: true, attempt: structuredClone(attempt) };
}

function isPolicyFailedNoSubmitAttempt(attempt) {
  return attempt?.status === "failed_no_submit" &&
    attempt.submit_count === 0 &&
    Number(attempt.ambiguity_retry_count || 0) === 0 &&
    attempt.final_proof == null &&
    /_policy_failed_no_submit$/.test(String(attempt.result_seed?.kind || ""));
}

function policyDeniedAttempt(attempt, denied) {
  return {
    ...attempt,
    policy_denial: policyDenialResult(denied),
  };
}

function rearmedPolicyAttempt(attempt, existing, now) {
  const priorLineage = Array.isArray(existing.policy_rearm_lineage)
    ? existing.policy_rearm_lineage.slice(-7)
    : [];
  return {
    ...attempt,
    policy_rearm_count: Number.isSafeInteger(existing.policy_rearm_count)
      ? existing.policy_rearm_count + 1
      : 1,
    policy_rearm_lineage: [
      ...priorLineage,
      {
        status: existing.status,
        submit_count: existing.submit_count,
        ambiguity_retry_count: existing.ambiguity_retry_count ?? 0,
        result_seed: structuredClone(existing.result_seed || null),
        policy_denial: structuredClone(existing.policy_denial || null),
        created_at: existing.created_at || null,
        updated_at: existing.updated_at || null,
        rearmed_at: now,
      },
    ],
  };
}

function policyDenialResult(item) {
  const { invalid: _invalid, ordinal: _ordinal, ...denied } = item;
  return denied;
}
