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

const STATE_VERSION = 1;
const STATE_MUTATION_QUEUES = new Map();
const COINBASE_OMNIBUS_LIFECYCLE = "coinbase_omnibus_reservation_v1";
const COINBASE_OMNIBUS_PLACE_OPERATIONS = new Set([
  "spot_limit_order",
  "spot_market_order",
]);
const OMNIBUS_TERMINAL_STATUSES = new Set(["settled", "released"]);
const RESERVATION_MAX_DECIMAL_PLACES = 8;
const RESERVATION_MAX_SCALED_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

function emptyState() {
  return {
    version: STATE_VERSION,
    sessions: {},
    idempotency: {},
    policy_counts: {},
    policy_amounts: {},
    execution_claims: {},
    execution_attempts: {},
    capability_jtis: {},
    autopilot_sessions: {},
    autopilot_events: {},
    autopilot_decisions: {},
    autopilot_positions: {},
    autopilot_opportunities: {},
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
      execution_claims: loaded.execution_claims || {},
      execution_attempts: loaded.execution_attempts || {},
      capability_jtis: loaded.capability_jtis || {},
      autopilot_sessions: loaded.autopilot_sessions || {},
      autopilot_events: loaded.autopilot_events || {},
      autopilot_decisions: loaded.autopilot_decisions || {},
      autopilot_positions: loaded.autopilot_positions || {},
      autopilot_opportunities: loaded.autopilot_opportunities || {},
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
    return createPostgresWorkerState(databaseUrl, {
      driver: env.PRIVATE_AGENT_POSTGRES_DRIVER || env.GHOLA_PRIVATE_AGENT_POSTGRES_DRIVER || "auto",
    });
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

  function mutate(updater) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = normalizeState(load());
      const result = updater(state);
      if (result && typeof result.then === "function") {
        throw new Error("sqlite state mutation updater must be synchronous");
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
    mutate,
  });
}

function postgresUrlIsLoopback(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function postgresTemplateClient(pool) {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await pool.query({ text, values });
    return result.rows;
  };
}

export function createPostgresWorkerState(databaseUrl, { driver = "auto" } = {}) {
  if (!databaseUrl) {
    throw new Error("PRIVATE_AGENT_STATE_STORE=postgres requires PRIVATE_AGENT_STATE_POSTGRES_URL or DATABASE_URL");
  }
  let sqlPromise = null;
  let poolPromise = null;
  let initPromise = null;
  let hmacSecretPromise = null;

  async function sqlClient() {
    if (!sqlPromise) {
      const useNodePostgres = driver === "pg" || driver === "node-postgres" ||
        (driver === "auto" && postgresUrlIsLoopback(databaseUrl));
      if (useNodePostgres) {
        poolPromise = import("pg").then(({ Pool }) => new Pool({
          connectionString: databaseUrl,
          max: 8,
          connectionTimeoutMillis: 5_000,
        }));
        sqlPromise = poolPromise.then(postgresTemplateClient);
      } else {
        sqlPromise = import("@neondatabase/serverless").then(({ neon }) => neon(databaseUrl));
      }
    }
    return sqlPromise;
  }

  async function ensureInitialized() {
    const sql = await sqlClient();
    if (!initPromise) {
      initPromise = (async () => {
        let initSql = sql;
        let initClient = null;
        if (poolPromise) {
          initClient = await (await poolPromise).connect();
          await initClient.query("SELECT pg_advisory_lock($1)", [1_917_420_811]);
          initSql = postgresTemplateClient(initClient);
        }
        try {
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_state_documents (
            id TEXT PRIMARY KEY,
            state_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_state_secrets (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
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
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_venue
          ON worker_sessions (venue_id, updated_at DESC)
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_vault
          ON worker_sessions (vault_commitment, updated_at DESC)
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_policy
          ON worker_sessions (policy_commitment, updated_at DESC)
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_sessions_allocation
          ON worker_sessions (allocation_commitment, updated_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_idempotency (
            work_order_commitment TEXT PRIMARY KEY,
            receipt_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_execution_claims (
            work_order_commitment TEXT PRIMARY KEY,
            claim_token TEXT NOT NULL,
            status TEXT NOT NULL,
            claim_json JSONB NOT NULL,
            attempt_json JSONB,
            receipt_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_execution_attempts (
            work_order_commitment TEXT PRIMARY KEY,
            attempt_json JSONB NOT NULL,
            status TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_capability_jtis (
            jti TEXT PRIMARY KEY,
            expires_at_unix BIGINT NOT NULL,
            consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_policy_counts (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_policy_amounts (
            key TEXT PRIMARY KEY,
            amount DOUBLE PRECISION NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_sessions (
            autopilot_session_id TEXT PRIMARY KEY,
            owner_commitment TEXT,
            session_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_sessions_owner
          ON worker_autopilot_sessions (owner_commitment, created_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_events (
            event_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            event_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_events_session
          ON worker_autopilot_events (autopilot_session_id, created_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_decisions (
            decision_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            decision_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_decisions_session
          ON worker_autopilot_decisions (autopilot_session_id, created_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_positions (
            autopilot_session_id TEXT NOT NULL,
            position_key TEXT NOT NULL,
            position_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (autopilot_session_id, position_key)
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_positions_session
          ON worker_autopilot_positions (autopilot_session_id, updated_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_autopilot_opportunities (
            opportunity_id TEXT PRIMARY KEY,
            autopilot_session_id TEXT NOT NULL,
            opportunity_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_autopilot_opportunities_session
          ON worker_autopilot_opportunities (autopilot_session_id, created_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_hyperliquid_managed_allocations (
            allocation_commitment TEXT PRIMARY KEY,
            allocation_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_omnibus_allocations (
            allocation_commitment TEXT PRIMARY KEY,
            allocation_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_omnibus_reservations (
            allocation_commitment TEXT NOT NULL,
            work_order_commitment TEXT NOT NULL,
            reservation_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (allocation_commitment, work_order_commitment)
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_omnibus_reservations_allocation
          ON worker_omnibus_reservations (allocation_commitment, updated_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_omnibus_fills (
            allocation_commitment TEXT NOT NULL,
            fill_commitment TEXT NOT NULL,
            fill_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (allocation_commitment, fill_commitment)
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_omnibus_fills_allocation
          ON worker_omnibus_fills (allocation_commitment, created_at DESC)
        `;
        await initSql`
          CREATE TABLE IF NOT EXISTS worker_state_ledger (
            ledger_id BIGSERIAL PRIMARY KEY,
            document_id TEXT NOT NULL,
            state_json JSONB NOT NULL,
            state_sha256 TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await initSql`
          CREATE INDEX IF NOT EXISTS idx_worker_state_ledger_document_created
          ON worker_state_ledger (document_id, created_at DESC)
        `;
        await migrateLegacyPostgresDocument(initSql);
        } finally {
          if (initClient) {
            await initClient.query("SELECT pg_advisory_unlock($1)", [1_917_420_811]).catch(() => {});
            initClient.release();
          }
        }
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

    async close() {
      if (poolPromise) await (await poolPromise).end();
    },

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

    async claimExecution(workOrderCommitment, context = {}) {
      const sql = await ensureInitialized();
      const claimToken = randomBytes(24).toString("hex");
      const now = new Date().toISOString();
      const requestedContext = sanitizeExecutionClaimContext(context);
      if (!validExecutionRequestDigest(requestedContext.request_digest)) {
        return { status: "context_mismatch" };
      }
      const claim = {
        work_order_commitment: workOrderCommitment,
        claim_token: claimToken,
        status: "in_progress",
        context: requestedContext,
        created_at: now,
        updated_at: now,
      };
      const inserted = await sql`
        INSERT INTO worker_execution_claims (
          work_order_commitment,
          claim_token,
          status,
          claim_json,
          created_at,
          updated_at
        )
        SELECT
          ${workOrderCommitment},
          ${claimToken},
          ${"in_progress"},
          ${jsonParam(claim)}::jsonb,
          NOW(),
          NOW()
        WHERE NOT EXISTS (
          SELECT 1
          FROM worker_execution_attempts
          WHERE work_order_commitment = ${workOrderCommitment}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM worker_idempotency
          WHERE work_order_commitment = ${workOrderCommitment}
        )
        ON CONFLICT (work_order_commitment) DO NOTHING
        RETURNING claim_json
      `;
      if (inserted[0]) {
        return {
          status: "claimed",
          claim_token: claimToken,
          claim: decodeJson(inserted[0].claim_json) || claim,
        };
      }

      const existingRows = await sql`
        SELECT
          (
            SELECT receipt_json
            FROM worker_idempotency
            WHERE work_order_commitment = ${workOrderCommitment}
          ) AS completed_receipt,
          (
            SELECT receipt_json
            FROM worker_execution_claims
            WHERE work_order_commitment = ${workOrderCommitment}
          ) AS claim_receipt,
          (
            SELECT status
            FROM worker_execution_claims
            WHERE work_order_commitment = ${workOrderCommitment}
          ) AS claim_status,
          (
            SELECT claim_json
            FROM worker_execution_claims
            WHERE work_order_commitment = ${workOrderCommitment}
          ) AS claim_json,
          EXISTS (
            SELECT 1
            FROM worker_execution_attempts
            WHERE work_order_commitment = ${workOrderCommitment}
          ) AS has_attempt
      `;
      const existing = existingRows[0] || {};
      const completedReceipt = decodeJson(existing.completed_receipt);
      const claimReceipt = decodeJson(existing.claim_receipt);
      const claimRecord = decodeJson(existing.claim_json);
      if (!executionClaimBindingMatches(requestedContext, {
        claim: claimRecord,
        receipt: completedReceipt || claimReceipt,
      })) {
        return { status: "context_mismatch" };
      }
      if (completedReceipt) return { status: "completed", receipt: completedReceipt };
      if (existing.claim_status === "completed" && claimReceipt) {
        return { status: "completed", receipt: claimReceipt };
      }
      if (existing.claim_status === "rejected" && claimRecord?.rejection) {
        return { status: "rejected", rejection: claimRecord.rejection };
      }
      return {
        status: (existing.claim_status || existing.has_attempt)
          ? "reconcile_required"
          : "in_progress",
      };
    },

    async recordExecutionClaimEvidence(workOrderCommitment, claimToken, { attempt, receipt }) {
      const sql = await ensureInitialized();
      const now = new Date().toISOString();
      const completionDigest = executionCompletionRequestDigest(attempt, receipt);
      if (!completionDigest) throw executionClaimContextConflict();
      const nextAttempt = {
        ...attempt,
        work_order_commitment: workOrderCommitment,
        updated_at: now,
      };
      const rows = await sql`
        WITH owned AS (
          UPDATE worker_execution_claims
          SET
            attempt_json = ${jsonParam(nextAttempt)}::jsonb,
            receipt_json = ${jsonParam(receipt)}::jsonb,
            updated_at = NOW()
          WHERE work_order_commitment = ${workOrderCommitment}
            AND claim_token = ${claimToken}
            AND status = ${"in_progress"}
            AND claim_json -> 'context' ->> 'request_digest' = ${completionDigest}
          RETURNING work_order_commitment, receipt_json
        ), attempt_write AS (
          INSERT INTO worker_execution_attempts (
            work_order_commitment,
            attempt_json,
            status,
            updated_at
          )
          SELECT
            ${workOrderCommitment},
            ${jsonParam(nextAttempt)}::jsonb,
            ${nextAttempt.status || null},
            NOW()
          FROM owned
          WHERE TRUE
          ON CONFLICT (work_order_commitment)
          DO UPDATE SET
            attempt_json = excluded.attempt_json,
            status = excluded.status,
            updated_at = excluded.updated_at
          RETURNING work_order_commitment
        )
        SELECT owned.receipt_json
        FROM owned
        JOIN attempt_write USING (work_order_commitment)
      `;
      const stored = decodeJson(rows[0]?.receipt_json);
      if (!stored) throw executionClaimConflict();
      return stored;
    },

    async completeExecutionClaim(workOrderCommitment, claimToken, { attempt, receipt }) {
      const sql = await ensureInitialized();
      const now = new Date().toISOString();
      const completionDigest = executionCompletionRequestDigest(attempt, receipt);
      if (!completionDigest) throw executionClaimContextConflict();
      const nextAttempt = {
        ...attempt,
        work_order_commitment: workOrderCommitment,
        updated_at: now,
      };
      const rows = await sql`
        WITH owned AS (
          UPDATE worker_execution_claims
          SET
            status = ${"completed"},
            attempt_json = ${jsonParam(nextAttempt)}::jsonb,
            receipt_json = ${jsonParam(receipt)}::jsonb,
            updated_at = NOW()
          WHERE work_order_commitment = ${workOrderCommitment}
            AND claim_token = ${claimToken}
            AND status = ${"in_progress"}
            AND claim_json -> 'context' ->> 'request_digest' = ${completionDigest}
          RETURNING work_order_commitment
        ), attempt_write AS (
          INSERT INTO worker_execution_attempts (
            work_order_commitment,
            attempt_json,
            status,
            updated_at
          )
          SELECT
            ${workOrderCommitment},
            ${jsonParam(nextAttempt)}::jsonb,
            ${nextAttempt.status || null},
            NOW()
          FROM owned
          WHERE TRUE
          ON CONFLICT (work_order_commitment)
          DO UPDATE SET
            attempt_json = excluded.attempt_json,
            status = excluded.status,
            updated_at = excluded.updated_at
          RETURNING work_order_commitment
        ), receipt_write AS (
          INSERT INTO worker_idempotency (work_order_commitment, receipt_json, updated_at)
          SELECT ${workOrderCommitment}, ${jsonParam(receipt)}::jsonb, NOW()
          FROM owned
          WHERE TRUE
          ON CONFLICT (work_order_commitment)
          DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at
          RETURNING receipt_json
        )
        SELECT receipt_json
        FROM receipt_write
      `;
      const completed = decodeJson(rows[0]?.receipt_json);
      if (completed) return completed;
      const cachedRows = await sql`
        SELECT receipt_json
        FROM worker_idempotency
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      const cached = decodeJson(cachedRows[0]?.receipt_json);
      if (cached) {
        if (cached.execution_request_digest !== completionDigest) {
          throw executionClaimContextConflict();
        }
        return cached;
      }
      throw executionClaimConflict();
    },

    async markExecutionClaimReconcileRequired(
      workOrderCommitment,
      claimToken,
      attempt = {},
      evidence = null,
    ) {
      const sql = await ensureInitialized();
      const failure = sanitizeExecutionClaimFailure(attempt);
      const evidenceDigest = evidence
        ? executionCompletionRequestDigest(evidence.attempt, evidence.receipt)
        : null;
      if (evidence && !evidenceDigest) throw executionClaimContextConflict();
      const suppliedAttempt = evidence?.attempt
        ? {
          ...evidence.attempt,
          work_order_commitment: workOrderCommitment,
          updated_at: new Date().toISOString(),
        }
        : {};
      const failurePatch = {
        ...failure,
        reconciliation_failure: failure,
        work_order_commitment: workOrderCommitment,
        status: "reconcile_required",
        updated_at: new Date().toISOString(),
      };
      const suppliedReceipt = evidence?.receipt || null;
      const rows = await sql`
        WITH owned AS (
          UPDATE worker_execution_claims
          SET
            status = ${"reconcile_required"},
            attempt_json = COALESCE(attempt_json, '{}'::jsonb) ||
              ${jsonParam(suppliedAttempt)}::jsonb ||
              ${jsonParam(failurePatch)}::jsonb,
            receipt_json = COALESCE(
              ${suppliedReceipt ? jsonParam(suppliedReceipt) : null}::jsonb,
              receipt_json
            ),
            updated_at = NOW()
          WHERE work_order_commitment = ${workOrderCommitment}
            AND claim_token = ${claimToken}
            AND status = ${"in_progress"}
            AND (${evidenceDigest}::text IS NULL OR claim_json -> 'context' ->> 'request_digest' = ${evidenceDigest})
          RETURNING work_order_commitment, attempt_json
        ), attempt_write AS (
          INSERT INTO worker_execution_attempts (
            work_order_commitment,
            attempt_json,
            status,
            updated_at
          )
          SELECT
            work_order_commitment,
            attempt_json,
            ${"reconcile_required"},
            NOW()
          FROM owned
          WHERE TRUE
          ON CONFLICT (work_order_commitment)
          DO UPDATE SET
            attempt_json = excluded.attempt_json,
            status = excluded.status,
            updated_at = excluded.updated_at
          RETURNING work_order_commitment
        )
        SELECT work_order_commitment
        FROM attempt_write
      `;
      return { ok: Boolean(rows[0]) };
    },

    async rejectExecutionClaim(workOrderCommitment, claimToken, rejection) {
      const sql = await ensureInitialized();
      const sanitized = sanitizeExecutionClaimFailure(rejection);
      const rows = await sql`
        UPDATE worker_execution_claims
        SET
          status = ${"rejected"},
          claim_json = claim_json || ${jsonParam({
            status: "rejected",
            rejection: sanitized,
          })}::jsonb,
          updated_at = NOW()
        WHERE work_order_commitment = ${workOrderCommitment}
          AND claim_token = ${claimToken}
          AND status = ${"in_progress"}
        RETURNING work_order_commitment
      `;
      return { ok: Boolean(rows[0]) };
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

    async getExecutionAttempt(workOrderCommitment) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT attempt_json
        FROM worker_execution_attempts
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      return decodeJson(rows[0]?.attempt_json) || null;
    },

    async getExecutionClaimEvidence(workOrderCommitment) {
      const sql = await ensureInitialized();
      const rows = await sql`
        SELECT status, claim_json, attempt_json, receipt_json
        FROM worker_execution_claims
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      if (!rows[0]) return null;
      const claim = decodeJson(rows[0].claim_json);
      return {
        status: rows[0].status,
        context: claim?.context || null,
        attempt: decodeJson(rows[0].attempt_json),
        receipt: decodeJson(rows[0].receipt_json),
      };
    },

    async resolveExecutionClaim(workOrderCommitment, { attempt, receipt }) {
      const sql = await ensureInitialized();
      const completionDigest = executionCompletionRequestDigest(attempt, receipt);
      if (!completionDigest) throw executionClaimContextConflict();
      assertTerminalExecutionResolution(receipt);
      const now = new Date().toISOString();
      const nextAttempt = {
        ...attempt,
        work_order_commitment: workOrderCommitment,
        status: receipt.status,
        updated_at: now,
      };
      const rows = await sql`
        WITH resolved AS (
          UPDATE worker_execution_claims
          SET
            status = ${"completed"},
            attempt_json = ${jsonParam(nextAttempt)}::jsonb,
            receipt_json = ${jsonParam(receipt)}::jsonb,
            updated_at = NOW()
          WHERE work_order_commitment = ${workOrderCommitment}
            AND status IN (${"in_progress"}, ${"reconcile_required"}, ${"completed"})
            AND claim_json -> 'context' ->> 'request_digest' = ${completionDigest}
          RETURNING work_order_commitment
        ), attempt_write AS (
          INSERT INTO worker_execution_attempts (
            work_order_commitment,
            attempt_json,
            status,
            updated_at
          )
          SELECT
            ${workOrderCommitment},
            ${jsonParam(nextAttempt)}::jsonb,
            ${receipt.status},
            NOW()
          FROM resolved
          ON CONFLICT (work_order_commitment)
          DO UPDATE SET
            attempt_json = excluded.attempt_json,
            status = excluded.status,
            updated_at = excluded.updated_at
          RETURNING work_order_commitment
        ), receipt_write AS (
          INSERT INTO worker_idempotency (work_order_commitment, receipt_json, updated_at)
          SELECT ${workOrderCommitment}, ${jsonParam(receipt)}::jsonb, NOW()
          FROM resolved
          ON CONFLICT (work_order_commitment)
          DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at
          RETURNING work_order_commitment, receipt_json
        )
        SELECT receipt_write.receipt_json
        FROM receipt_write
        JOIN attempt_write USING (work_order_commitment)
      `;
      const completed = decodeJson(rows[0]?.receipt_json);
      if (completed) return completed;
      const existingRows = await sql`
        SELECT receipt_json
        FROM worker_idempotency
        WHERE work_order_commitment = ${workOrderCommitment}
      `;
      const existing = decodeJson(existingRows[0]?.receipt_json);
      if (existing?.execution_request_digest === completionDigest &&
        existing?.final_proof?.final_fill_proven === true) {
        return existing;
      }
      throw executionClaimConflict();
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
      if (Number.isInteger(maxCount)) {
        if (maxCount <= 0) return { ok: false, count: 0 };
        const rows = await sql`
          INSERT INTO worker_policy_counts (key, count, updated_at)
          VALUES (${key}, 1, NOW())
          ON CONFLICT (key)
          DO UPDATE SET
            count = worker_policy_counts.count + 1,
            updated_at = NOW()
          WHERE worker_policy_counts.count < ${maxCount}
          RETURNING count
        `;
        if (rows[0]) return { ok: true, count: Number(rows[0].count || 0) };
        const current = await sql`
          SELECT count FROM worker_policy_counts WHERE key = ${key}
        `;
        return { ok: false, count: Number(current[0]?.count || 0) };
      }
      const rows = await sql`
        INSERT INTO worker_policy_counts (key, count, updated_at)
        VALUES (${key}, 1, NOW())
        ON CONFLICT (key)
        DO UPDATE SET count = worker_policy_counts.count + 1, updated_at = NOW()
        RETURNING count
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
      if (Number.isFinite(parsedMax) && parsedMax > 0) {
        const rows = await sql`
          INSERT INTO worker_policy_amounts (key, amount, updated_at)
          SELECT ${key}, ${parsedAmount}, NOW()
          WHERE ${parsedAmount}::double precision <= ${parsedMax}::double precision
          ON CONFLICT (key)
          DO UPDATE SET
            amount = worker_policy_amounts.amount + ${parsedAmount},
            updated_at = NOW()
          WHERE worker_policy_amounts.amount + ${parsedAmount} <= ${parsedMax}
          RETURNING amount
        `;
        if (rows[0]) return { ok: true, amount: Number(rows[0].amount || 0) };
        const current = await sql`
          SELECT amount FROM worker_policy_amounts WHERE key = ${key}
        `;
        return { ok: false, amount: Number(current[0]?.amount || 0) };
      }
      const rows = await sql`
        INSERT INTO worker_policy_amounts (key, amount, updated_at)
        VALUES (${key}, ${parsedAmount}, NOW())
        ON CONFLICT (key)
        DO UPDATE SET amount = worker_policy_amounts.amount + ${parsedAmount}, updated_at = NOW()
        RETURNING amount
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

    async getCoinbaseOmnibusReservation(input) {
      const sql = await ensureInitialized();
      const allocationCommitment = requiredReservationText(
        input?.allocation_commitment,
        "allocation_commitment",
      );
      const workOrderCommitment = requiredReservationText(
        input?.work_order_commitment,
        "work_order_commitment",
      );
      const rows = await sql`
        SELECT reservation_json
        FROM worker_omnibus_reservations
        WHERE allocation_commitment = ${allocationCommitment}
          AND work_order_commitment = ${workOrderCommitment}
      `;
      const reservation = decodeJson(rows[0]?.reservation_json);
      return reservation?.lifecycle === COINBASE_OMNIBUS_LIFECYCLE ? reservation : null;
    },

    async transitionCoinbaseOmnibusReservation(input) {
      const sql = await ensureInitialized();
      const scope = coinbaseOmnibusReservationScope(input);
      const allocation = coinbaseOmnibusTransitionAllocation(input, scope.allocation_commitment);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const rows = await sql`
          SELECT reservation_json
          FROM worker_omnibus_reservations
          WHERE allocation_commitment = ${scope.allocation_commitment}
            AND work_order_commitment = ${scope.work_order_commitment}
        `;
        const current = decodeJson(rows[0]?.reservation_json);
        if (current && current.lifecycle !== COINBASE_OMNIBUS_LIFECYCLE) {
          throw omnibusReservationError(
            "legacy omnibus reservation requires reconciliation before lifecycle migration",
            "COINBASE_OMNIBUS_LEGACY_RESERVATION",
          );
        }
        const next = applyCoinbaseOmnibusReservationTransition(current, input);
        if (next === current) return current;

        if (!current) {
          const inserted = await sql`
            WITH reservation_write AS (
              INSERT INTO worker_omnibus_reservations (
                allocation_commitment,
                work_order_commitment,
                reservation_json,
                updated_at
              )
              VALUES (
                ${scope.allocation_commitment},
                ${scope.work_order_commitment},
                ${jsonParam(next)}::jsonb,
                NOW()
              )
              ON CONFLICT (allocation_commitment, work_order_commitment) DO NOTHING
              RETURNING reservation_json
            ), allocation_write AS (
              INSERT INTO worker_omnibus_allocations (
                allocation_commitment,
                allocation_json,
                updated_at
              )
              SELECT
                ${scope.allocation_commitment},
                ${jsonParam(allocation)}::jsonb,
                NOW()
              FROM reservation_write
              ON CONFLICT (allocation_commitment) DO NOTHING
              RETURNING allocation_commitment
            )
            SELECT reservation_write.reservation_json
            FROM reservation_write
            LEFT JOIN allocation_write ON TRUE
          `;
          if (inserted[0]) return decodeJson(inserted[0].reservation_json) || next;
          continue;
        }

        const updated = await sql`
          UPDATE worker_omnibus_reservations
          SET reservation_json = ${jsonParam(next)}::jsonb, updated_at = NOW()
          WHERE allocation_commitment = ${scope.allocation_commitment}
            AND work_order_commitment = ${scope.work_order_commitment}
            AND reservation_json = ${jsonParam(current)}::jsonb
          RETURNING reservation_json
        `;
        if (updated[0]) return decodeJson(updated[0].reservation_json) || next;
      }
      throw omnibusReservationError(
        "coinbase omnibus reservation changed concurrently; retry reconciliation",
        "COINBASE_OMNIBUS_CONCURRENT_TRANSITION",
      );
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
        DO NOTHING
      `;
      const storedRows = await sql`
        SELECT reservation_json
        FROM worker_omnibus_reservations
        WHERE allocation_commitment = ${input.allocation_commitment}
          AND work_order_commitment = ${input.work_order_commitment}
      `;
      return decodeJson(storedRows[0]?.reservation_json) || reservation;
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
      if (existing.lifecycle === COINBASE_OMNIBUS_LIFECYCLE) {
        throw omnibusReservationError(
          "strict coinbase omnibus reservations require terminal release proof",
          "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
        );
      }
      if (OMNIBUS_TERMINAL_STATUSES.has(existing.status)) return existing;
      const next = {
        ...existing,
        status: "released",
        updated_at: new Date().toISOString(),
      };
      const updated = await sql`
        UPDATE worker_omnibus_reservations
        SET reservation_json = ${jsonParam(next)}::jsonb, updated_at = NOW()
        WHERE allocation_commitment = ${input.allocation_commitment}
          AND work_order_commitment = ${input.work_order_commitment}
          AND COALESCE(reservation_json ->> 'status', '') NOT IN ('settled', 'released')
        RETURNING reservation_json
      `;
      return decodeJson(updated[0]?.reservation_json) || existing;
    },

    async settleOmnibusFill(input) {
      const sql = await ensureInitialized();
      await upsertOmnibusAllocation(sql, {
        allocation_commitment: input.allocation_commitment,
      });
      const reservationRows = await sql`
        SELECT reservation_json
        FROM worker_omnibus_reservations
        WHERE allocation_commitment = ${input.allocation_commitment}
          AND work_order_commitment = ${input.work_order_commitment}
      `;
      const reservation = decodeJson(reservationRows[0]?.reservation_json);
      if (reservation?.lifecycle === COINBASE_OMNIBUS_LIFECYCLE) {
        throw omnibusReservationError(
          "strict coinbase omnibus fills require an amount-aware transition",
          "COINBASE_OMNIBUS_INVALID_TRANSITION",
        );
      }
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
      if (reservation && !OMNIBUS_TERMINAL_STATUSES.has(reservation.status)) {
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
            AND COALESCE(reservation_json ->> 'status', '') NOT IN ('settled', 'released')
        `;
      }
      return fill;
    },
  };
}

/**
 * Pure, fail-closed Coinbase omnibus reservation transition.
 *
 * The caller must repeat the complete placement scope for every mutation. Release
 * transitions additionally require provider evidence bound to the stored scope.
 */
export function applyCoinbaseOmnibusReservationTransition(current, event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw omnibusReservationError(
      "coinbase omnibus reservation transition is required",
      "COINBASE_OMNIBUS_INVALID_TRANSITION",
      400,
    );
  }
  const transition = requiredReservationText(event.transition, "transition");
  const scope = coinbaseOmnibusReservationScope(event);
  const scopeCommitment = stableRecordId("coinbase_omnibus_scope", scope);

  if (transition === "reserve") {
    if (!COINBASE_OMNIBUS_PLACE_OPERATIONS.has(scope.operation_class)) {
      throw omnibusReservationError(
        "coinbase omnibus capacity may only be reserved for placement operations",
        "COINBASE_OMNIBUS_INVALID_OPERATION",
        400,
      );
    }
    const reservedAmount = reservationDecimal(event.reserved_amount, "reserved_amount");
    if (current) {
      const accounting = assertCoinbaseReservationRecord(current, scopeCommitment);
      if (!reservationDecimalsEqual(accounting.reserved, reservedAmount)) {
        throw omnibusReservationError(
          "coinbase omnibus reservation amount conflicts with existing scope",
          "COINBASE_OMNIBUS_RESERVATION_CONFLICT",
        );
      }
      return current;
    }
    const now = timestampOrNow(event.at);
    const zero = zeroReservationDecimal();
    return {
      lifecycle: COINBASE_OMNIBUS_LIFECYCLE,
      allocation_commitment: scope.allocation_commitment,
      work_order_commitment: scope.work_order_commitment,
      scope,
      scope_commitment: scopeCommitment,
      status: "reserved",
      reserved_amount: reservationDecimalNumber(reservedAmount),
      reserved_amount_decimal: reservedAmount.canonical,
      filled_amount: 0,
      filled_amount_decimal: zero.canonical,
      released_amount: 0,
      released_amount_decimal: zero.canonical,
      remaining_amount: reservationDecimalNumber(reservedAmount),
      remaining_amount_decimal: reservedAmount.canonical,
      fill_amounts: {},
      fill_amount_decimals: {},
      release_proof: null,
      created_at: now,
      updated_at: now,
    };
  }

  if (!current) {
    throw omnibusReservationError(
      "coinbase omnibus reservation was not found",
      "COINBASE_OMNIBUS_RESERVATION_NOT_FOUND",
      404,
    );
  }
  const accounting = assertCoinbaseReservationRecord(current, scopeCommitment);

  if (transition === "fill") {
    const fillCommitment = requiredReservationText(event.fill_commitment, "fill_commitment");
    const fillAmount = reservationDecimal(event.fill_amount, "fill_amount");
    const fillAmounts = current.fill_amounts && typeof current.fill_amounts === "object"
      ? current.fill_amounts
      : {};
    const fillAmountDecimals = current.fill_amount_decimals &&
      typeof current.fill_amount_decimals === "object"
      ? current.fill_amount_decimals
      : {};
    if (Object.prototype.hasOwnProperty.call(fillAmounts, fillCommitment) ||
      Object.prototype.hasOwnProperty.call(fillAmountDecimals, fillCommitment)) {
      const storedFillAmount = reservationDecimal(
        fillAmountDecimals[fillCommitment] ?? fillAmounts[fillCommitment],
        "stored fill_amount",
      );
      if (!reservationDecimalsEqual(storedFillAmount, fillAmount)) {
        throw omnibusReservationError(
          "coinbase omnibus fill commitment conflicts with its recorded amount",
          "COINBASE_OMNIBUS_FILL_CONFLICT",
        );
      }
      return current;
    }
    assertReservationNotTerminal(current);
    const nextFilledAmount = addReservationDecimals(accounting.filled, fillAmount);
    const nextCommittedAmount = addReservationDecimals(nextFilledAmount, accounting.released);
    if (compareReservationDecimals(nextCommittedAmount, accounting.reserved) > 0) {
      throw omnibusReservationError(
        "coinbase omnibus fill exceeds the reserved amount",
        "COINBASE_OMNIBUS_OVERFILL",
      );
    }
    const boundedFilledAmount = reservationDecimalsEqual(nextCommittedAmount, accounting.reserved)
      ? subtractReservationDecimals(accounting.reserved, accounting.released)
      : nextFilledAmount;
    const remainingAmount = subtractReservationDecimals(
      subtractReservationDecimals(accounting.reserved, boundedFilledAmount),
      accounting.released,
    );
    const settled = reservationDecimalIsZero(remainingAmount);
    const now = timestampOrNow(event.at);
    return {
      ...current,
      status: settled ? "settled" : "partially_filled",
      filled_amount: reservationDecimalNumber(boundedFilledAmount),
      filled_amount_decimal: boundedFilledAmount.canonical,
      remaining_amount: reservationDecimalNumber(remainingAmount),
      remaining_amount_decimal: remainingAmount.canonical,
      fill_amounts: {
        ...fillAmounts,
        [fillCommitment]: reservationDecimalNumber(fillAmount),
      },
      fill_amount_decimals: {
        ...fillAmountDecimals,
        [fillCommitment]: fillAmount.canonical,
      },
      updated_at: now,
      settled_at: settled ? now : current.settled_at,
    };
  }

  if (transition === "release") {
    const proof = coinbaseOmnibusReleaseProof(event.proof, current, accounting);
    if (current.status === "released" && current.release_proof) {
      const storedProof = coinbaseOmnibusReleaseProof(
        current.release_proof,
        current,
        accounting,
      );
      if (stableRecordId("coinbase_omnibus_release_proof", storedProof) ===
        stableRecordId("coinbase_omnibus_release_proof", proof)) {
        return current;
      }
    }
    assertReservationNotTerminal(current);
    if (reservationDecimalIsZero(accounting.remaining)) {
      throw omnibusReservationError(
        "coinbase omnibus reservation has no remainder to release",
        "COINBASE_OMNIBUS_NO_REMAINDER",
      );
    }
    const releasedAmount = addReservationDecimals(accounting.released, accounting.remaining);
    const now = timestampOrNow(event.at);
    return {
      ...current,
      status: "released",
      released_amount: reservationDecimalNumber(releasedAmount),
      released_amount_decimal: releasedAmount.canonical,
      remaining_amount: 0,
      remaining_amount_decimal: zeroReservationDecimal().canonical,
      release_proof: proof,
      updated_at: now,
      released_at: now,
    };
  }

  throw omnibusReservationError(
    "coinbase omnibus reservation transition is unsupported",
    "COINBASE_OMNIBUS_INVALID_TRANSITION",
    400,
  );
}

function coinbaseOmnibusReservationScope(value) {
  const venueId = value.venue_id == null ? "coinbase_advanced" : String(value.venue_id).trim();
  const executionMode = value.execution_mode == null
    ? "partner_omnibus"
    : String(value.execution_mode).trim();
  if (venueId !== "coinbase_advanced" || executionMode !== "partner_omnibus") {
    throw omnibusReservationError(
      "coinbase omnibus reservation scope is invalid",
      "COINBASE_OMNIBUS_SCOPE_MISMATCH",
      400,
    );
  }
  const side = requiredReservationText(value.side, "side").toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw omnibusReservationError(
      "coinbase omnibus reservation side is invalid",
      "COINBASE_OMNIBUS_SCOPE_MISMATCH",
      400,
    );
  }
  return {
    venue_id: venueId,
    execution_mode: executionMode,
    allocation_commitment: requiredReservationText(
      value.allocation_commitment,
      "allocation_commitment",
    ),
    work_order_commitment: requiredReservationText(
      value.work_order_commitment,
      "work_order_commitment",
    ),
    operation_class: requiredReservationText(value.operation_class, "operation_class"),
    client_order_id: requiredReservationText(value.client_order_id, "client_order_id"),
    product_id: requiredReservationText(value.product_id, "product_id").toUpperCase(),
    side,
  };
}

function coinbaseOmnibusTransitionAllocation(input, allocationCommitment) {
  if (!input.allocation) return { allocation_commitment: allocationCommitment };
  if (!input.allocation || typeof input.allocation !== "object" || Array.isArray(input.allocation) ||
    requiredReservationText(
      input.allocation.allocation_commitment,
      "allocation.allocation_commitment",
    ) !== allocationCommitment) {
    throw omnibusReservationError(
      "coinbase omnibus allocation metadata targets a different allocation",
      "COINBASE_OMNIBUS_SCOPE_MISMATCH",
      400,
    );
  }
  return {
    ...input.allocation,
    allocation_commitment: allocationCommitment,
  };
}

function assertCoinbaseReservationRecord(current, expectedScopeCommitment) {
  if (current.lifecycle !== COINBASE_OMNIBUS_LIFECYCLE ||
    current.scope_commitment !== expectedScopeCommitment) {
    throw omnibusReservationError(
      "coinbase omnibus reservation scope does not match the stored placement",
      "COINBASE_OMNIBUS_SCOPE_MISMATCH",
    );
  }
  return coinbaseOmnibusReservationAccounting(current);
}

function coinbaseOmnibusReservationAccounting(current) {
  const reserved = storedReservationDecimal(current, "reserved_amount", false);
  const filled = storedReservationDecimal(current, "filled_amount", true);
  const released = storedReservationDecimal(current, "released_amount", true);
  const remaining = storedReservationDecimal(current, "remaining_amount", true);
  const committed = addReservationDecimals(addReservationDecimals(filled, released), remaining);
  const fillAmounts = current.fill_amounts && typeof current.fill_amounts === "object"
    ? current.fill_amounts
    : {};
  const fillAmountDecimals = current.fill_amount_decimals &&
    typeof current.fill_amount_decimals === "object"
    ? current.fill_amount_decimals
    : {};
  let fillTotal = zeroReservationDecimal();
  for (const fillCommitment of new Set([
    ...Object.keys(fillAmounts),
    ...Object.keys(fillAmountDecimals),
  ])) {
    const decimal = reservationDecimal(
      fillAmountDecimals[fillCommitment] ?? fillAmounts[fillCommitment],
      "stored fill_amount",
    );
    if (Object.prototype.hasOwnProperty.call(fillAmounts, fillCommitment) &&
      Object.prototype.hasOwnProperty.call(fillAmountDecimals, fillCommitment) &&
      Number.isFinite(fillAmounts[fillCommitment])) {
      const numericAmount = Number(decimal.canonical);
      if (!Number.isFinite(numericAmount) || !Object.is(numericAmount, fillAmounts[fillCommitment])) {
        throw invalidOmnibusReservationState();
      }
    }
    fillTotal = addReservationDecimals(fillTotal, decimal);
  }
  if (!reservationDecimalsEqual(committed, reserved) ||
    !reservationDecimalsEqual(fillTotal, filled)) {
    throw invalidOmnibusReservationState();
  }

  const filledIsZero = reservationDecimalIsZero(filled);
  const releasedIsZero = reservationDecimalIsZero(released);
  const remainingIsZero = reservationDecimalIsZero(remaining);
  const statusIsValid = (current.status === "reserved" && filledIsZero &&
      releasedIsZero && !remainingIsZero) ||
    (current.status === "partially_filled" && !filledIsZero &&
      releasedIsZero && !remainingIsZero) ||
    (current.status === "settled" && !filledIsZero &&
      releasedIsZero && remainingIsZero) ||
    (current.status === "released" && remainingIsZero &&
      !reservationDecimalIsZero(released));
  if (!statusIsValid) throw invalidOmnibusReservationState();
  return { reserved, filled, released, remaining };
}

function invalidOmnibusReservationState() {
  return omnibusReservationError(
    "coinbase omnibus reservation accounting state is invalid",
    "COINBASE_OMNIBUS_INVALID_STATE",
  );
}

function assertReservationNotTerminal(current) {
  if (OMNIBUS_TERMINAL_STATUSES.has(current.status)) {
    throw omnibusReservationError(
      "coinbase omnibus reservation is terminal",
      "COINBASE_OMNIBUS_TERMINAL",
    );
  }
  if (current.status !== "reserved" && current.status !== "partially_filled") {
    throw omnibusReservationError(
      "coinbase omnibus reservation state is invalid",
      "COINBASE_OMNIBUS_INVALID_STATE",
    );
  }
}

function coinbaseOmnibusReleaseProof(value, current, accounting) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidOmnibusReleaseProof();
  }
  const kind = requiredReservationText(value.kind, "proof.kind");
  const proofCommitment = requiredReservationText(
    value.proof_commitment,
    "proof.proof_commitment",
  );
  const scopeCommitment = requiredReservationText(
    value.scope_commitment,
    "proof.scope_commitment",
  );
  const targetClientOrderId = requiredReservationText(
    value.target_client_order_id,
    "proof.target_client_order_id",
  );
  if (scopeCommitment !== current.scope_commitment ||
    targetClientOrderId !== current.scope?.client_order_id) {
    throw omnibusReservationError(
      "coinbase omnibus release proof targets a different placement",
      "COINBASE_OMNIBUS_SCOPE_MISMATCH",
    );
  }

  if (kind === "rejected_before_submit") {
    if (value.submission_attempted !== false ||
      !reservationDecimalIsZero(accounting.filled)) {
      throw invalidOmnibusReleaseProof();
    }
    return {
      kind,
      proof_commitment: proofCommitment,
      scope_commitment: scopeCommitment,
      target_client_order_id: targetClientOrderId,
      submission_attempted: false,
      reason_code: requiredReservationText(value.reason_code, "proof.reason_code"),
    };
  }

  if (kind !== "cancel_confirmed" && kind !== "reconcile_terminal") {
    throw invalidOmnibusReleaseProof();
  }
  const terminalStatus = requiredReservationText(
    value.terminal_status,
    "proof.terminal_status",
  ).toLowerCase();
  const providerOrderId = requiredReservationText(
    value.provider_order_id,
    "proof.provider_order_id",
  );
  const allowedStatuses = kind === "cancel_confirmed"
    ? new Set(["cancelled"])
    : new Set(["cancelled", "expired", "failed", "rejected"]);
  const observedFilledAmount = reservationDecimal(
    value.observed_filled_amount_decimal ?? value.observed_filled_amount,
    "proof.observed_filled_amount",
    true,
  );
  if (!allowedStatuses.has(terminalStatus) ||
    !reservationDecimalsEqual(observedFilledAmount, accounting.filled)) {
    throw invalidOmnibusReleaseProof();
  }
  return {
    kind,
    proof_commitment: proofCommitment,
    scope_commitment: scopeCommitment,
    target_client_order_id: targetClientOrderId,
    terminal_status: terminalStatus,
    observed_filled_amount: reservationDecimalNumber(observedFilledAmount),
    observed_filled_amount_decimal: observedFilledAmount.canonical,
    provider_order_id: providerOrderId,
  };
}

function requiredReservationText(value, field) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 512) {
    throw omnibusReservationError(
      `coinbase omnibus ${field} is invalid`,
      "COINBASE_OMNIBUS_INVALID_INPUT",
      400,
    );
  }
  return value.trim();
}

function reservationDecimal(value, field, allowZero = false) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw invalidReservationAmount(field);
  }
  let text = typeof value === "number" ? String(value) : value.trim();
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw invalidReservationAmount(field);
    const fixed = value.toFixed(RESERVATION_MAX_DECIMAL_PLACES);
    text = fixed.replace(/0+$/, "").replace(/\.$/, "");
    if (Number(text) !== value) throw invalidReservationAmount(field);
  }
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match) throw invalidReservationAmount(field);
  const whole = BigInt(match[1]);
  const fraction = (match[2] || "").replace(/0+$/, "");
  if (fraction.length > RESERVATION_MAX_DECIMAL_PLACES) throw invalidReservationAmount(field);
  const scale = fraction.length;
  const units = (whole * (10n ** BigInt(scale))) + BigInt(fraction || "0");
  if (units > RESERVATION_MAX_SCALED_UNITS || (!allowZero && units === 0n)) {
    throw invalidReservationAmount(field);
  }
  return reservationDecimalFromUnits(units, scale);
}

function storedReservationDecimal(current, field, allowZero) {
  const decimalField = `${field}_decimal`;
  const decimal = reservationDecimal(current[decimalField] ?? current[field], `stored ${field}`, allowZero);
  if (current[decimalField] !== undefined && current[field] !== undefined &&
    Number.isFinite(current[field])) {
    const numericAmount = Number(decimal.canonical);
    if (!Number.isFinite(numericAmount) || !Object.is(numericAmount, current[field])) {
      throw invalidOmnibusReservationState();
    }
  }
  return decimal;
}

function zeroReservationDecimal() {
  return { units: 0n, scale: 0, canonical: "0" };
}

function reservationDecimalFromUnits(units, scale) {
  let nextUnits = units;
  let nextScale = scale;
  while (nextScale > 0 && nextUnits % 10n === 0n) {
    nextUnits /= 10n;
    nextScale -= 1;
  }
  const digits = nextUnits.toString();
  const canonical = nextScale === 0
    ? digits
    : `${digits.length > nextScale ? digits.slice(0, -nextScale) : "0"}.${digits.padStart(nextScale, "0").slice(-nextScale)}`;
  return { units: nextUnits, scale: nextScale, canonical };
}

function alignReservationDecimals(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    leftUnits: left.units * (10n ** BigInt(scale - left.scale)),
    rightUnits: right.units * (10n ** BigInt(scale - right.scale)),
    scale,
  };
}

function addReservationDecimals(left, right) {
  const aligned = alignReservationDecimals(left, right);
  return reservationDecimalFromUnits(aligned.leftUnits + aligned.rightUnits, aligned.scale);
}

function subtractReservationDecimals(left, right) {
  const aligned = alignReservationDecimals(left, right);
  if (aligned.leftUnits < aligned.rightUnits) throw invalidOmnibusReservationState();
  return reservationDecimalFromUnits(aligned.leftUnits - aligned.rightUnits, aligned.scale);
}

function compareReservationDecimals(left, right) {
  const aligned = alignReservationDecimals(left, right);
  return aligned.leftUnits === aligned.rightUnits ? 0 : aligned.leftUnits > aligned.rightUnits ? 1 : -1;
}

function reservationDecimalsEqual(left, right) {
  return compareReservationDecimals(left, right) === 0;
}

function reservationDecimalIsZero(value) {
  return value.units === 0n;
}

function reservationDecimalNumber(value) {
  const parsed = Number(value.canonical);
  if (!Number.isFinite(parsed) || parsed.toFixed(value.scale) !== value.canonical) {
    throw invalidReservationAmount("stored amount");
  }
  return parsed;
}

function invalidReservationAmount(field) {
  return omnibusReservationError(
    `coinbase omnibus ${field} must be a safe finite decimal amount`,
    "COINBASE_OMNIBUS_INVALID_AMOUNT",
    400,
  );
}

function invalidOmnibusReleaseProof() {
  return omnibusReservationError(
    "coinbase omnibus remainder release requires exact terminal provider proof",
    "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
  );
}

function omnibusReservationError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function jsonParam(value) {
  return JSON.stringify(value ?? null);
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

  for (const [workOrderCommitment, claim] of Object.entries(state.execution_claims || {})) {
    if (!claim?.claim_token) continue;
    await sql`
      INSERT INTO worker_execution_claims (
        work_order_commitment,
        claim_token,
        status,
        claim_json,
        attempt_json,
        receipt_json,
        created_at,
        updated_at
      )
      VALUES (
        ${workOrderCommitment},
        ${claim.claim_token},
        ${claim.status || "reconcile_required"},
        ${jsonParam(claim)}::jsonb,
        ${claim.attempt ? jsonParam(claim.attempt) : null}::jsonb,
        ${claim.receipt ? jsonParam(claim.receipt) : null}::jsonb,
        ${timestampOrNow(claim.created_at)},
        ${timestampOrNow(claim.updated_at || claim.created_at)}
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

export function createWorkerStateAdapter({ path, hmacSecret, load, save, mutate = null }) {
  async function hmacHex(parts) {
    const secret = typeof hmacSecret === "function" ? await hmacSecret() : hmacSecret;
    return createHmac("sha256", Buffer.from(secret, "hex"))
      .update(parts.filter(Boolean).join("\0"))
      .digest("hex");
  }

  async function loadState() {
    return normalizeState(await load());
  }

  async function mutateState(updater) {
    return serializeStateMutation(path, async () => {
      if (typeof mutate === "function") {
        return mutate(updater);
      }
      const state = await loadState();
      const result = updater(state);
      if (result && typeof result.then === "function") {
        throw new Error("state mutation updater must be synchronous");
      }
      await save(state);
      return result;
    });
  }

  const adapter = {
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

    async claimExecution(workOrderCommitment, context = {}) {
      return mutateState((state) => {
        const requestedContext = sanitizeExecutionClaimContext(context);
        if (!validExecutionRequestDigest(requestedContext.request_digest)) {
          return { status: "context_mismatch" };
        }
        const cached = state.idempotency[workOrderCommitment]?.receipt;
        const existing = state.execution_claims[workOrderCommitment];
        if (cached || existing || state.execution_attempts[workOrderCommitment]) {
          if (!executionClaimBindingMatches(requestedContext, { claim: existing, receipt: cached })) {
            return { status: "context_mismatch" };
          }
        }
        if (cached) return { status: "completed", receipt: cached };
        if (existing?.status === "completed" && existing.receipt) {
          return { status: "completed", receipt: existing.receipt };
        }
        if (existing?.status === "rejected" && existing.rejection) {
          return { status: "rejected", rejection: existing.rejection };
        }
        if (existing || state.execution_attempts[workOrderCommitment]) {
          return { status: "reconcile_required" };
        }
        const now = new Date().toISOString();
        const claimToken = randomBytes(24).toString("hex");
        const claim = {
          work_order_commitment: workOrderCommitment,
          claim_token: claimToken,
          status: "in_progress",
          context: requestedContext,
          created_at: now,
          updated_at: now,
        };
        state.execution_claims[workOrderCommitment] = claim;
        return { status: "claimed", claim_token: claimToken, claim };
      });
    },

    async recordExecutionClaimEvidence(workOrderCommitment, claimToken, { attempt, receipt }) {
      return mutateState((state) => {
        const existing = state.execution_claims[workOrderCommitment];
        const completionDigest = executionCompletionRequestDigest(attempt, receipt);
        if (!completionDigest) throw executionClaimContextConflict();
        if (!existing || existing.status !== "in_progress" || existing.claim_token !== claimToken) {
          throw executionClaimConflict();
        }
        if (existing.context?.request_digest !== completionDigest) {
          throw executionClaimContextConflict();
        }
        const now = new Date().toISOString();
        const nextAttempt = {
          ...attempt,
          work_order_commitment: workOrderCommitment,
          updated_at: now,
        };
        state.execution_attempts[workOrderCommitment] = nextAttempt;
        state.execution_claims[workOrderCommitment] = {
          ...existing,
          attempt: nextAttempt,
          receipt,
          evidence_recorded_at: now,
          updated_at: now,
        };
        return receipt;
      });
    },

    async completeExecutionClaim(workOrderCommitment, claimToken, { attempt, receipt }) {
      return mutateState((state) => {
        const existing = state.execution_claims[workOrderCommitment];
        const completionDigest = executionCompletionRequestDigest(attempt, receipt);
        if (!completionDigest) throw executionClaimContextConflict();
        if (existing?.status === "completed" && existing.receipt) {
          if (
            existing.context?.request_digest !== completionDigest ||
            !executionClaimBindingMatches(existing.context, { claim: existing, receipt: existing.receipt })
          ) {
            throw executionClaimContextConflict();
          }
          return existing.receipt;
        }
        if (!existing || existing.status !== "in_progress" || existing.claim_token !== claimToken) {
          throw executionClaimConflict();
        }
        if (existing.context?.request_digest !== completionDigest) {
          throw executionClaimContextConflict();
        }
        const now = new Date().toISOString();
        const nextAttempt = {
          ...attempt,
          work_order_commitment: workOrderCommitment,
          updated_at: now,
        };
        state.execution_attempts[workOrderCommitment] = nextAttempt;
        state.idempotency[workOrderCommitment] = { receipt, updated_at: now };
        state.execution_claims[workOrderCommitment] = {
          ...existing,
          status: "completed",
          attempt: nextAttempt,
          receipt,
          updated_at: now,
        };
        return receipt;
      });
    },

    async markExecutionClaimReconcileRequired(
      workOrderCommitment,
      claimToken,
      attempt = {},
      evidence = null,
    ) {
      return mutateState((state) => {
        const existing = state.execution_claims[workOrderCommitment];
        if (!existing || existing.status !== "in_progress" || existing.claim_token !== claimToken) {
          return { ok: false };
        }
        const failure = sanitizeExecutionClaimFailure(attempt);
        const evidenceDigest = evidence
          ? executionCompletionRequestDigest(evidence.attempt, evidence.receipt)
          : null;
        if (evidence && !evidenceDigest) throw executionClaimContextConflict();
        if (evidenceDigest && existing.context?.request_digest !== evidenceDigest) {
          throw executionClaimContextConflict();
        }
        const now = new Date().toISOString();
        const nextAttempt = {
          ...(existing.attempt || state.execution_attempts[workOrderCommitment] || {}),
          ...(evidence?.attempt || {}),
          ...failure,
          reconciliation_failure: failure,
          work_order_commitment: workOrderCommitment,
          status: "reconcile_required",
          updated_at: now,
        };
        state.execution_attempts[workOrderCommitment] = nextAttempt;
        state.execution_claims[workOrderCommitment] = {
          ...existing,
          status: "reconcile_required",
          attempt: nextAttempt,
          receipt: evidence?.receipt || existing.receipt || null,
          updated_at: now,
        };
        return { ok: true };
      });
    },

    async rejectExecutionClaim(workOrderCommitment, claimToken, rejection) {
      return mutateState((state) => {
        const existing = state.execution_claims[workOrderCommitment];
        if (!existing || existing.status !== "in_progress" || existing.claim_token !== claimToken) {
          return { ok: false };
        }
        state.execution_claims[workOrderCommitment] = {
          ...existing,
          status: "rejected",
          rejection: sanitizeExecutionClaimFailure(rejection),
          updated_at: new Date().toISOString(),
        };
        return { ok: true };
      });
    },

    async putIdempotency(workOrderCommitment, receipt) {
      return mutateState((state) => {
        state.idempotency[workOrderCommitment] = {
          receipt,
          updated_at: new Date().toISOString(),
        };
        return receipt;
      });
    },

    async putExecutionAttempt(workOrderCommitment, attempt) {
      return mutateState((state) => {
        state.execution_attempts[workOrderCommitment] = {
          ...attempt,
          work_order_commitment: workOrderCommitment,
          updated_at: new Date().toISOString(),
        };
        return state.execution_attempts[workOrderCommitment];
      });
    },

    async getExecutionAttempt(workOrderCommitment) {
      return (await loadState()).execution_attempts[workOrderCommitment] || null;
    },

    async getExecutionClaimEvidence(workOrderCommitment) {
      const claim = (await loadState()).execution_claims[workOrderCommitment];
      if (!claim) return null;
      return {
        status: claim.status,
        context: claim.context || null,
        attempt: claim.attempt || null,
        receipt: claim.receipt || null,
      };
    },

    async resolveExecutionClaim(workOrderCommitment, { attempt, receipt }) {
      return mutateState((state) => {
        const claim = state.execution_claims[workOrderCommitment];
        const completionDigest = executionCompletionRequestDigest(attempt, receipt);
        if (!completionDigest) throw executionClaimContextConflict();
        assertTerminalExecutionResolution(receipt);
        const cached = state.idempotency[workOrderCommitment]?.receipt;
        if (cached?.execution_request_digest === completionDigest &&
          cached?.final_proof?.final_fill_proven === true) {
          return cached;
        }
        if (!claim || !["in_progress", "reconcile_required", "completed"].includes(claim.status)) {
          throw executionClaimConflict();
        }
        if (claim.context?.request_digest !== completionDigest) {
          throw executionClaimContextConflict();
        }
        const now = new Date().toISOString();
        const nextAttempt = {
          ...attempt,
          work_order_commitment: workOrderCommitment,
          status: receipt.status,
          updated_at: now,
        };
        state.execution_attempts[workOrderCommitment] = nextAttempt;
        state.idempotency[workOrderCommitment] = { receipt, updated_at: now };
        state.execution_claims[workOrderCommitment] = {
          ...claim,
          status: "completed",
          attempt: nextAttempt,
          receipt,
          updated_at: now,
        };
        return receipt;
      });
    },

    async consumeCapabilityJti(jti, expiresAtUnix) {
      return mutateState((state) => {
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
      return mutateState((state) => {
        state.autopilot_sessions[session.autopilot_session_id] = {
          ...session,
          updated_at: new Date().toISOString(),
        };
        return state.autopilot_sessions[session.autopilot_session_id];
      });
    },

    async getAutopilotSession(sessionId) {
      return (await loadState()).autopilot_sessions[sessionId] || null;
    },

    async listAutopilotSessions(ownerCommitment = null) {
      return Object.values((await loadState()).autopilot_sessions)
        .filter((session) => !ownerCommitment || session.owner_commitment === ownerCommitment)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    },

    async appendAutopilotEvent(sessionId, event) {
      return mutateState((state) => {
        const existing = Array.isArray(state.autopilot_events[sessionId])
          ? state.autopilot_events[sessionId]
          : [];
        state.autopilot_events[sessionId] = existing.concat(event).slice(-250);
        return event;
      });
    },

    async listAutopilotEvents(sessionId) {
      return ((await loadState()).autopilot_events[sessionId] || []).slice(-200);
    },

    async appendAutopilotDecision(sessionId, decision) {
      return mutateState((state) => {
        const existing = Array.isArray(state.autopilot_decisions[sessionId])
          ? state.autopilot_decisions[sessionId]
          : [];
        state.autopilot_decisions[sessionId] = existing.concat(decision).slice(-250);
        return decision;
      });
    },

    async listAutopilotDecisions(sessionId) {
      return ((await loadState()).autopilot_decisions[sessionId] || []).slice(-200);
    },

    async putAutopilotPosition(sessionId, position) {
      return mutateState((state) => {
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
        return next[next.length - 1];
      });
    },

    async listAutopilotPositions(sessionId) {
      return ((await loadState()).autopilot_positions[sessionId] || []).slice(-50);
    },

    async appendAutopilotOpportunity(sessionId, opportunity) {
      return mutateState((state) => {
        const existing = Array.isArray(state.autopilot_opportunities[sessionId])
          ? state.autopilot_opportunities[sessionId]
          : [];
        state.autopilot_opportunities[sessionId] = existing.concat(opportunity).slice(-100);
        return opportunity;
      });
    },

    async listAutopilotOpportunities(sessionId) {
      return ((await loadState()).autopilot_opportunities[sessionId] || []).slice(-50);
    },

    async putSession(session) {
      return mutateState((state) => {
        state.sessions[session.session_commitment] = {
          ...session,
          updated_at: new Date().toISOString(),
        };
        return state.sessions[session.session_commitment];
      });
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
      return mutateState((state) => {
        state.hyperliquid_managed_allocations[allocation.allocation_commitment] = {
          allocation,
          updated_at: new Date().toISOString(),
        };
        return state.hyperliquid_managed_allocations[allocation.allocation_commitment];
      });
    },

    async getHyperliquidManagedAllocation(allocationCommitment) {
      return (await loadState()).hyperliquid_managed_allocations[allocationCommitment] || null;
    },

    async incrementPolicyCount(key, maxCount) {
      return mutateState((state) => {
        const current = state.policy_counts[key] || { count: 0, updated_at: null };
        if (Number.isInteger(maxCount) && current.count >= maxCount) {
          return { ok: false, count: current.count };
        }
        const next = {
          count: current.count + 1,
          updated_at: new Date().toISOString(),
        };
        state.policy_counts[key] = next;
        return { ok: true, count: next.count };
      });
    },

    async incrementPolicyAmount(key, amount, maxAmount) {
      return mutateState((state) => {
        const parsedAmount = Number.parseFloat(String(amount || "0"));
        const parsedMax = Number.parseFloat(String(maxAmount || "0"));
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return { ok: false, amount: 0 };
        }
        const current = state.policy_amounts[key] || { amount: 0, updated_at: null };
        const nextAmount = Number(current.amount || 0) + parsedAmount;
        if (Number.isFinite(parsedMax) && parsedMax > 0 && nextAmount > parsedMax) {
          return { ok: false, amount: Number(current.amount || 0) };
        }
        const next = {
          amount: nextAmount,
          updated_at: new Date().toISOString(),
        };
        state.policy_amounts[key] = next;
        return { ok: true, amount: next.amount };
      });
    },

    async putOmnibusAllocation(allocation) {
      return mutateState((state) => {
        state.omnibus[allocation.allocation_commitment] = {
          allocation,
          reservations: state.omnibus[allocation.allocation_commitment]?.reservations || {},
          fills: state.omnibus[allocation.allocation_commitment]?.fills || {},
          updated_at: new Date().toISOString(),
        };
        return state.omnibus[allocation.allocation_commitment];
      });
    },

    async getOmnibusAllocation(allocationCommitment) {
      return (await loadState()).omnibus[allocationCommitment] || null;
    },

    async getCoinbaseOmnibusReservation(input) {
      const allocationCommitment = requiredReservationText(
        input?.allocation_commitment,
        "allocation_commitment",
      );
      const workOrderCommitment = requiredReservationText(
        input?.work_order_commitment,
        "work_order_commitment",
      );
      const allocation = (await loadState()).omnibus[allocationCommitment];
      const reservation = allocation?.reservations?.[workOrderCommitment];
      return reservation?.lifecycle === COINBASE_OMNIBUS_LIFECYCLE ? reservation : null;
    },

    async transitionCoinbaseOmnibusReservation(input) {
      return mutateState((state) => {
        const scope = coinbaseOmnibusReservationScope(input);
        const allocation = coinbaseOmnibusTransitionAllocation(input, scope.allocation_commitment);
        const existing = state.omnibus[scope.allocation_commitment] || {
          allocation,
          reservations: {},
          fills: {},
        };
        const current = existing.reservations[scope.work_order_commitment] || null;
        if (current && current.lifecycle !== COINBASE_OMNIBUS_LIFECYCLE) {
          throw omnibusReservationError(
            "legacy omnibus reservation requires reconciliation before lifecycle migration",
            "COINBASE_OMNIBUS_LEGACY_RESERVATION",
          );
        }
        const next = applyCoinbaseOmnibusReservationTransition(current, input);
        existing.reservations[scope.work_order_commitment] = next;
        existing.updated_at = next.updated_at;
        state.omnibus[scope.allocation_commitment] = existing;
        return next;
      });
    },

    async reserveOmnibus(input) {
      return mutateState((state) => {
        const existing = state.omnibus[input.allocation_commitment] || {
          allocation: input.allocation || { allocation_commitment: input.allocation_commitment },
          reservations: {},
          fills: {},
        };
        if (!existing.reservations[input.work_order_commitment]) {
          existing.reservations[input.work_order_commitment] = {
            work_order_commitment: input.work_order_commitment,
            notional_bucket: input.notional_bucket,
            status: "reserved",
            created_at: new Date().toISOString(),
          };
        }
        existing.updated_at = new Date().toISOString();
        state.omnibus[input.allocation_commitment] = existing;
        return existing.reservations[input.work_order_commitment];
      });
    },

    async releaseOmnibus(input) {
      return mutateState((state) => {
        const existing = state.omnibus[input.allocation_commitment];
        const reservation = existing?.reservations?.[input.work_order_commitment];
        if (reservation?.lifecycle === COINBASE_OMNIBUS_LIFECYCLE) {
          throw omnibusReservationError(
            "strict coinbase omnibus reservations require terminal release proof",
            "COINBASE_OMNIBUS_INVALID_RELEASE_PROOF",
          );
        }
        if (existing?.reservations?.[input.work_order_commitment] &&
          !OMNIBUS_TERMINAL_STATUSES.has(
            existing.reservations[input.work_order_commitment].status,
          )) {
          existing.reservations[input.work_order_commitment].status = "released";
          existing.reservations[input.work_order_commitment].updated_at = new Date().toISOString();
          existing.updated_at = new Date().toISOString();
          return existing.reservations[input.work_order_commitment];
        }
        return existing?.reservations?.[input.work_order_commitment];
      });
    },

    async settleOmnibusFill(input) {
      return mutateState((state) => {
        const existing = state.omnibus[input.allocation_commitment] || {
          allocation: { allocation_commitment: input.allocation_commitment },
          reservations: {},
          fills: {},
        };
        if (existing.reservations[input.work_order_commitment]?.lifecycle ===
          COINBASE_OMNIBUS_LIFECYCLE) {
          throw omnibusReservationError(
            "strict coinbase omnibus fills require an amount-aware transition",
            "COINBASE_OMNIBUS_INVALID_TRANSITION",
          );
        }
        existing.fills[input.fill_commitment] = {
          fill_commitment: input.fill_commitment,
          work_order_commitment: input.work_order_commitment,
          fee_bucket: input.fee_bucket || null,
          notional_bucket: input.notional_bucket || null,
          created_at: new Date().toISOString(),
        };
        if (existing.reservations[input.work_order_commitment] &&
          !OMNIBUS_TERMINAL_STATUSES.has(
            existing.reservations[input.work_order_commitment].status,
          )) {
          existing.reservations[input.work_order_commitment].status = "settled";
          existing.reservations[input.work_order_commitment].updated_at = new Date().toISOString();
        }
        existing.updated_at = new Date().toISOString();
        state.omnibus[input.allocation_commitment] = existing;
        return existing.fills[input.fill_commitment];
      });
    },
  };
  return adapter;
}

function serializeStateMutation(path, task) {
  const key = String(path || "worker-state");
  const previous = STATE_MUTATION_QUEUES.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(() => undefined, () => undefined);
  STATE_MUTATION_QUEUES.set(key, tail);
  tail.then(() => {
    if (STATE_MUTATION_QUEUES.get(key) === tail) STATE_MUTATION_QUEUES.delete(key);
  });
  return run;
}

function sanitizeExecutionClaimContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const context = {};
  for (const key of ["venue_id", "platform_class", "execution_mode", "operation_class"]) {
    if (typeof value[key] === "string" && value[key].length <= 128) context[key] = value[key];
  }
  if (validExecutionRequestDigest(value.request_digest)) {
    context.request_digest = value.request_digest.toLowerCase();
  }
  return context;
}

function validExecutionRequestDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function executionClaimBindingMatches(requestedContext, { claim, receipt }) {
  const requestedDigest = requestedContext?.request_digest;
  if (!validExecutionRequestDigest(requestedDigest)) return false;
  const storedDigests = [
    claim?.context?.request_digest,
    receipt?.execution_request_digest,
  ].filter((value) => value !== undefined && value !== null);
  return storedDigests.length > 0 && storedDigests.every((digest) =>
    validExecutionRequestDigest(digest) && digest.toLowerCase() === requestedDigest.toLowerCase());
}

function executionCompletionRequestDigest(attempt, receipt) {
  const attemptDigest = attempt?.execution_request_digest;
  const receiptDigest = receipt?.execution_request_digest;
  if (!validExecutionRequestDigest(attemptDigest) || !validExecutionRequestDigest(receiptDigest)) return null;
  return attemptDigest.toLowerCase() === receiptDigest.toLowerCase()
    ? receiptDigest.toLowerCase()
    : null;
}

function assertTerminalExecutionResolution(receipt) {
  const proof = receipt?.final_proof;
  if (
    !receipt || typeof receipt !== "object" ||
    !proof || typeof proof !== "object" ||
    proof.final_venue_execution_proven !== true ||
    proof.final_fill_proven !== true ||
    typeof proof.terminal_status !== "string" ||
    !proof.terminal_status.trim()
  ) {
    throw executionClaimConflict();
  }
}

function sanitizeExecutionClaimFailure(value) {
  const failure = sanitizeExecutionClaimContext(value);
  const errorCode = typeof value?.error_code === "string"
    ? value.error_code.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96)
    : "EXECUTION_CLAIM_REJECTED";
  const errorMessage = typeof value?.error_message === "string"
    ? value.error_message.slice(0, 240)
    : "execution rejected";
  const errorStatus = Number.isInteger(value?.error_status) && value.error_status >= 400 && value.error_status <= 599
    ? value.error_status
    : 400;
  return {
    ...failure,
    error_code: errorCode,
    error_message: errorMessage,
    error_status: errorStatus,
    created_at: typeof value?.created_at === "string"
      ? value.created_at
      : new Date().toISOString(),
  };
}

function executionClaimConflict() {
  const error = new Error("execution claim is unresolved; reconciliation required");
  error.code = "EXECUTION_CLAIM_RECONCILE_REQUIRED";
  error.status = 409;
  return error;
}

function executionClaimContextConflict() {
  const error = new Error("work order is bound to a different execution request");
  error.code = "EXECUTION_CLAIM_CONTEXT_MISMATCH";
  error.status = 409;
  return error;
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
    execution_claims: loaded.execution_claims || {},
    execution_attempts: loaded.execution_attempts || {},
    capability_jtis: loaded.capability_jtis || {},
    autopilot_sessions: loaded.autopilot_sessions || {},
    autopilot_events: loaded.autopilot_events || {},
    autopilot_decisions: loaded.autopilot_decisions || {},
    autopilot_positions: loaded.autopilot_positions || {},
    autopilot_opportunities: loaded.autopilot_opportunities || {},
    hyperliquid_managed_allocations: loaded.hyperliquid_managed_allocations || {},
    omnibus: loaded.omnibus || {},
  };
}
