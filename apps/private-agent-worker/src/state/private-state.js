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

  function save(state) {
    const next = {
      ...state,
      version: STATE_VERSION,
      updated_at: new Date().toISOString(),
    };
    const stateJson = JSON.stringify(next);
    const stateSha = createHash("sha256").update(stateJson).digest("hex");
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO worker_state_documents (id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
      `).run("private-agent-execution-state-v1", stateJson, now);
      db.prepare(`
        INSERT INTO worker_state_ledger (document_id, state_json, state_sha256, created_at)
        VALUES (?, ?, ?, ?)
      `).run("private-agent-execution-state-v1", stateJson, stateSha, now);
      db.exec("COMMIT");
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
  });
}

export function createPostgresWorkerState(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("PRIVATE_AGENT_STATE_STORE=postgres requires PRIVATE_AGENT_STATE_POSTGRES_URL or DATABASE_URL");
  }
  let sqlPromise = null;
  let initPromise = null;
  let hmacSecretPromise = null;

  async function sqlClient() {
    if (!sqlPromise) {
      sqlPromise = import("@neondatabase/serverless").then(({ neon }) => neon(databaseUrl));
    }
    return sqlPromise;
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
          WHERE ${parsedAmount} <= ${parsedMax}
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

export function createWorkerStateAdapter({ path, hmacSecret, load, save }) {
  async function hmacHex(parts) {
    const secret = typeof hmacSecret === "function" ? await hmacSecret() : hmacSecret;
    return createHmac("sha256", Buffer.from(secret, "hex"))
      .update(parts.filter(Boolean).join("\0"))
      .digest("hex");
  }

  async function loadState() {
    return normalizeState(await load());
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

    async putIdempotency(workOrderCommitment, receipt) {
      const state = await loadState();
      state.idempotency[workOrderCommitment] = {
        receipt,
        updated_at: new Date().toISOString(),
      };
      await save(state);
      return receipt;
    },

    async putExecutionAttempt(workOrderCommitment, attempt) {
      const state = await loadState();
      state.execution_attempts[workOrderCommitment] = {
        ...attempt,
        work_order_commitment: workOrderCommitment,
        updated_at: new Date().toISOString(),
      };
      await save(state);
      return state.execution_attempts[workOrderCommitment];
    },

    async getExecutionAttempt(workOrderCommitment) {
      return (await loadState()).execution_attempts[workOrderCommitment] || null;
    },

    async consumeCapabilityJti(jti, expiresAtUnix) {
      const state = await loadState();
      const now = Math.floor(Date.now() / 1000);
      for (const [key, record] of Object.entries(state.capability_jtis || {})) {
        if (Number(record?.expires_at_unix || 0) <= now) {
          delete state.capability_jtis[key];
        }
      }
      if (state.capability_jtis[jti]) {
        await save(state);
        return { ok: false, replayed: true };
      }
      state.capability_jtis[jti] = {
        jti,
        expires_at_unix: Number.isInteger(expiresAtUnix) ? expiresAtUnix : now + 300,
        consumed_at: new Date().toISOString(),
      };
      await save(state);
      return { ok: true };
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
      const state = await loadState();
      const current = state.policy_counts[key] || { count: 0, updated_at: null };
      if (Number.isInteger(maxCount) && current.count >= maxCount) {
        return { ok: false, count: current.count };
      }
      const next = {
        count: current.count + 1,
        updated_at: new Date().toISOString(),
      };
      state.policy_counts[key] = next;
      await save(state);
      return { ok: true, count: next.count };
    },

    async incrementPolicyAmount(key, amount, maxAmount) {
      const state = await loadState();
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
      await save(state);
      return { ok: true, amount: next.amount };
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
    hyperliquid_managed_allocations: loaded.hyperliquid_managed_allocations || {},
    omnibus: loaded.omnibus || {},
  };
}
