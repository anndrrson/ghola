import { createHash } from "node:crypto";
import {
  LIVE_TRADING_CONTRACT_VERSION,
  LIVE_TRADING_EVIDENCE_MAX_AGE_MS,
  LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD,
  LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS,
  canonicalLiveTradingCaps,
  type LiveTradingCapabilityId,
  type LiveTradingCapabilityStatus,
  type LiveTradingLaunchState,
  type LiveTradingReleaseIdentity,
} from "./live-trading-contract";

type NeonSql = Awaited<ReturnType<typeof import("@neondatabase/serverless")["neon"]>>;

export interface LiveTradingLaunchControl {
  version: 2;
  state: LiveTradingLaunchState;
  contract_version: typeof LIVE_TRADING_CONTRACT_VERSION;
  web_git_sha: string | null;
  worker_git_sha: string | null;
  worker_image_digest: string | null;
  config_fingerprint: string | null;
  public_capabilities: LiveTradingCapabilityId[];
  caps: ReturnType<typeof canonicalLiveTradingCaps>;
  evidence_commitment: string | null;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface LiveTradingCapabilityEvidence {
  version: 2;
  evidence_id: string;
  capability: LiveTradingCapabilityId;
  venue_id: "hyperliquid";
  network: "mainnet";
  status: "green" | "red";
  broadcast_performed: boolean;
  reconciled: boolean;
  final_flat: boolean;
  open_order_count: number;
  order_notional_usd: number;
  web_git_sha: string;
  worker_git_sha: string;
  worker_image_digest: string;
  config_fingerprint: string;
  receipt_commitment: string | null;
  result_commitment: string | null;
  venue_account_commitment: string | null;
  proof_subject_commitment: string | null;
  reason: string | null;
  observed_at: string;
  expires_at: string;
  created_at: string;
}

export interface LiveTradingAccountGraduation {
  version: 2;
  graduation_id: string;
  owner_commitment: string;
  account_commitment: string;
  vault_commitment: string;
  proof_evidence_commitment: string;
  proof_notional_usd: number;
  status: "active" | "revoked";
  completed_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveTradingNotionalReservation {
  version: 2;
  reservation_id: string;
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  request_commitment: string;
  notional_usd: number;
  status: "reserved" | "filled" | "released" | "failed";
  created_at: string;
  expires_at: string;
  updated_at: string;
}

const launchMemory = new Map<string, LiveTradingLaunchControl>();
const evidenceMemory = new Map<string, LiveTradingCapabilityEvidence>();
const graduationMemory = new Map<string, LiveTradingAccountGraduation>();
const reservationMemory = new Map<string, LiveTradingNotionalReservation>();
let memoryQueue = Promise.resolve();
let sqlClient: NeonSql | null = null;
let schemaReady = false;
let schemaPromise: Promise<void> | null = null;

export async function getLiveTradingLaunchControl(): Promise<LiveTradingLaunchControl> {
  const sql = await getSql();
  if (!sql) return launchMemory.get("global") ?? defaultLaunchControl();
  await ensureSchema(sql);
  const rows = await sql`
    SELECT control FROM live_trading_launch_control WHERE control_id = 'global' LIMIT 1
  ` as Array<{ control: LiveTradingLaunchControl | string }>;
  return rows[0] ? parseJsonRow(rows[0].control) : defaultLaunchControl();
}

export async function putLiveTradingLaunchControl(
  control: LiveTradingLaunchControl,
): Promise<LiveTradingLaunchControl> {
  const sql = await getSql();
  if (!sql) {
    launchMemory.set("global", control);
    return control;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO live_trading_launch_control (control_id, state, control, updated_at)
    VALUES ('global', ${control.state}, ${JSON.stringify(control)}::jsonb, ${control.updated_at})
    ON CONFLICT (control_id) DO UPDATE SET
      state = EXCLUDED.state,
      control = EXCLUDED.control,
      updated_at = EXCLUDED.updated_at
  `;
  return control;
}

export async function putLiveTradingCapabilityEvidence(
  evidence: LiveTradingCapabilityEvidence,
): Promise<LiveTradingCapabilityEvidence> {
  const sql = await getSql();
  if (!sql) {
    evidenceMemory.set(evidence.evidence_id, evidence);
    return evidence;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO live_trading_capability_evidence (
      evidence_id, capability, status, observed_at, expires_at, evidence
    ) VALUES (
      ${evidence.evidence_id}, ${evidence.capability}, ${evidence.status},
      ${evidence.observed_at}, ${evidence.expires_at}, ${JSON.stringify(evidence)}::jsonb
    )
    ON CONFLICT (evidence_id) DO NOTHING
  `;
  return evidence;
}

export async function evaluateLiveTradingCapability(input: {
  capability: LiveTradingCapabilityId;
  release: LiveTradingReleaseIdentity;
  launch_state: LiveTradingLaunchState;
  visible: boolean;
  now?: Date;
}): Promise<LiveTradingCapabilityStatus> {
  const now = input.now ?? new Date();
  const evidence = await listCapabilityEvidence(input.capability, 50);
  let consecutive = 0;
  let lastProvenAt: string | null = null;
  const reasons: string[] = [];
  const venueAccounts = new Set<string>();

  for (const report of evidence) {
    const valid = evidenceMatchesRelease(report, input.release, now);
    if (!valid.ok) {
      if (consecutive === 0) reasons.push(...valid.reason_codes);
      break;
    }
    if (!report.venue_account_commitment || venueAccounts.has(report.venue_account_commitment)) continue;
    venueAccounts.add(report.venue_account_commitment);
    consecutive += 1;
    if (!lastProvenAt) lastProvenAt = report.observed_at;
    if (consecutive >= LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS) break;
  }
  if (consecutive < LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS) reasons.push("capability_mainnet_proofs_incomplete");
  if (input.launch_state === "killed") reasons.push("live_trading_killed");
  else if (input.launch_state !== "public") reasons.push("live_trading_not_public");
  if (!input.release.valid) reasons.push(...input.release.reason_codes);

  const live = input.launch_state === "public" && input.release.valid &&
    consecutive >= LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS;
  return {
    id: input.capability,
    state: live
      ? "live"
      : input.launch_state === "killed"
        ? "paused"
        : input.launch_state === "canary"
          ? "verifying"
          : "disabled",
    visible: input.visible && live,
    consecutive_mainnet_proofs: consecutive,
    required_mainnet_proofs: LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS,
    last_proven_at: lastProvenAt,
    reason_codes: [...new Set(reasons)],
  };
}

export async function putLiveTradingAccountGraduation(
  record: LiveTradingAccountGraduation,
): Promise<LiveTradingAccountGraduation> {
  const sql = await getSql();
  if (!sql) {
    graduationMemory.set(record.graduation_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO live_trading_account_graduations (
      graduation_id, owner_commitment, account_commitment, vault_commitment,
      status, graduation, updated_at
    ) VALUES (
      ${record.graduation_id}, ${record.owner_commitment}, ${record.account_commitment},
      ${record.vault_commitment}, ${record.status}, ${JSON.stringify(record)}::jsonb, ${record.updated_at}
    )
    ON CONFLICT (graduation_id) DO UPDATE SET
      status = EXCLUDED.status,
      graduation = EXCLUDED.graduation,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getActiveLiveTradingAccountGraduation(input: {
  owner_commitment: string;
  account_commitment: string;
  vault_commitment: string;
}): Promise<LiveTradingAccountGraduation | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(graduationMemory.values())
      .filter((record) => record.owner_commitment === input.owner_commitment &&
        record.account_commitment === input.account_commitment &&
        record.vault_commitment === input.vault_commitment &&
        activeGraduationMatchesContract(record))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT graduation FROM live_trading_account_graduations
    WHERE owner_commitment = ${input.owner_commitment}
      AND account_commitment = ${input.account_commitment}
      AND vault_commitment = ${input.vault_commitment}
      AND status = 'active'
    ORDER BY updated_at DESC
  ` as Array<{ graduation: LiveTradingAccountGraduation | string }>;
  return rows
    .map((row) => parseJsonRow<LiveTradingAccountGraduation>(row.graduation))
    .find(activeGraduationMatchesContract) ?? null;
}

export async function reserveLiveTradingNotional(input: {
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  request_commitment: string;
  notional_usd: number;
  max_order_notional_usd: number;
  rolling_24h_notional_usd: number;
  now?: Date;
}): Promise<
  | { ok: true; disposition: "created" | "replayed"; reservation: LiveTradingNotionalReservation; rolling_notional_usd: number }
  | { ok: false; error: "order_notional_cap_exceeded" | "rolling_notional_cap_exceeded" | "idempotency_conflict" }
> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.request_commitment)) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (!Number.isFinite(input.notional_usd) || input.notional_usd <= 0 || input.notional_usd > input.max_order_notional_usd) {
    return { ok: false, error: "order_notional_cap_exceeded" };
  }
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const reservationId = reservationKey(input.owner_commitment, input.idempotency_key);
  const candidate: LiveTradingNotionalReservation = {
    version: 2,
    reservation_id: reservationId,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    idempotency_key: input.idempotency_key,
    request_commitment: input.request_commitment,
    notional_usd: input.notional_usd,
    status: "reserved",
    created_at: createdAt,
    expires_at: expiresAt,
    updated_at: createdAt,
  };
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const existing = reservationMemory.get(reservationId);
      if (existing) {
        if (!replayableReservation(existing, input, now)) {
          return { ok: false as const, error: "idempotency_conflict" as const };
        }
        return {
          ok: true as const,
          disposition: "replayed" as const,
          reservation: existing,
          rolling_notional_usd: rollingMemoryNotional(input.account_commitment, now),
        };
      }
      const rolling = rollingMemoryNotional(input.account_commitment, now);
      if (rolling + input.notional_usd > input.rolling_24h_notional_usd + 0.000001) {
        return { ok: false as const, error: "rolling_notional_cap_exceeded" as const };
      }
      reservationMemory.set(reservationId, candidate);
      return { ok: true as const, disposition: "created" as const, reservation: candidate, rolling_notional_usd: rolling + input.notional_usd };
    });
  }
  await ensureSchema(sql);
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.account_commitment}, 0))
    ), existing AS (
      SELECT reservation FROM live_trading_notional_reservations, lock_guard
      WHERE reservation_id = ${reservationId}
    ), rolling AS (
      SELECT COALESCE(SUM(notional_usd), 0)::double precision AS total
      FROM live_trading_notional_reservations, lock_guard
      WHERE account_commitment = ${input.account_commitment}
        AND created_at >= ${cutoff}
        AND (status = 'filled' OR (status = 'reserved' AND expires_at > ${createdAt}))
    ), inserted AS (
      INSERT INTO live_trading_notional_reservations (
        reservation_id, owner_commitment, account_commitment, idempotency_key,
        notional_usd, status, reservation, created_at, expires_at, updated_at
      )
      SELECT ${reservationId}, ${input.owner_commitment}, ${input.account_commitment},
        ${input.idempotency_key}, ${input.notional_usd}, 'reserved',
        ${JSON.stringify(candidate)}::jsonb, ${createdAt}, ${expiresAt}, ${createdAt}
      FROM rolling
      WHERE NOT EXISTS (SELECT 1 FROM existing)
        AND rolling.total + ${input.notional_usd} <= ${input.rolling_24h_notional_usd}
      ON CONFLICT (reservation_id) DO NOTHING
      RETURNING reservation
    )
    SELECT 'inserted' AS disposition, reservation, (SELECT total FROM rolling) + ${input.notional_usd} AS rolling_total FROM inserted
    UNION ALL
    SELECT 'existing' AS disposition, reservation, (SELECT total FROM rolling) AS rolling_total FROM existing
    LIMIT 1
  ` as Array<{ disposition: string; reservation: LiveTradingNotionalReservation | string; rolling_total: number }>;
  if (!rows[0]) return { ok: false, error: "rolling_notional_cap_exceeded" };
  const reservation = parseJsonRow<LiveTradingNotionalReservation>(rows[0].reservation);
  if (rows[0].disposition === "existing" &&
    !replayableReservation(reservation, input, now)) {
    return { ok: false, error: "idempotency_conflict" };
  }
  return {
    ok: true,
    disposition: rows[0].disposition === "inserted" ? "created" : "replayed",
    reservation,
    rolling_notional_usd: Number(rows[0].rolling_total),
  };
}

export async function settleLiveTradingNotionalReservation(input: {
  reservation_id: string;
  status: "filled" | "released" | "failed";
  now?: Date;
}): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  const sql = await getSql();
  if (!sql) {
    await memoryCritical(async () => {
      const current = reservationMemory.get(input.reservation_id);
      if (!current || current.status !== "reserved") return;
      reservationMemory.set(input.reservation_id, { ...current, status: input.status, updated_at: now });
    });
    return;
  }
  await ensureSchema(sql);
  await sql`
    UPDATE live_trading_notional_reservations
    SET status = ${input.status},
      reservation = jsonb_set(jsonb_set(reservation, '{status}', to_jsonb(${input.status}::text)), '{updated_at}', to_jsonb(${now}::text)),
      updated_at = ${now}
    WHERE reservation_id = ${input.reservation_id} AND status = 'reserved'
  `;
}

export function resetLiveTradingStoreForTests() {
  launchMemory.clear();
  evidenceMemory.clear();
  graduationMemory.clear();
  reservationMemory.clear();
  memoryQueue = Promise.resolve();
  sqlClient = null;
  schemaReady = false;
  schemaPromise = null;
}

export function setLiveTradingSqlClientForTests(sql: NeonSql) {
  sqlClient = sql;
  schemaReady = false;
  schemaPromise = null;
}

async function listCapabilityEvidence(capability: LiveTradingCapabilityId, limit: number) {
  const sql = await getSql();
  if (!sql) {
    return Array.from(evidenceMemory.values())
      .filter((record) => record.capability === capability)
      .sort((left, right) => right.observed_at.localeCompare(left.observed_at) ||
        right.created_at.localeCompare(left.created_at) || right.evidence_id.localeCompare(left.evidence_id))
      .slice(0, limit);
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT evidence FROM live_trading_capability_evidence
    WHERE capability = ${capability}
    ORDER BY observed_at DESC, (evidence->>'created_at') DESC, evidence_id DESC LIMIT ${limit}
  ` as Array<{ evidence: LiveTradingCapabilityEvidence | string }>;
  return rows.map((row) => parseJsonRow<LiveTradingCapabilityEvidence>(row.evidence));
}

function evidenceMatchesRelease(
  evidence: LiveTradingCapabilityEvidence,
  release: LiveTradingReleaseIdentity,
  now: Date,
): { ok: true } | { ok: false; reason_codes: string[] } {
  const reasons: string[] = [];
  if (evidence.status !== "green" || !evidence.broadcast_performed || !evidence.reconciled ||
    !evidence.final_flat || evidence.open_order_count !== 0 || !evidence.receipt_commitment ||
    !evidence.result_commitment ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.venue_account_commitment ?? "") ||
    evidence.proof_subject_commitment !== evidence.venue_account_commitment ||
    !sameNumber(evidence.order_notional_usd, LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD)) {
    reasons.push("capability_proof_failed");
  }
  if (evidence.network !== "mainnet" || evidence.venue_id !== "hyperliquid") reasons.push("capability_proof_scope_mismatch");
  if (evidence.web_git_sha !== release.web_git_sha || evidence.worker_git_sha !== release.worker_git_sha ||
    evidence.worker_image_digest !== release.worker_image_digest || evidence.config_fingerprint !== release.config_fingerprint) {
    reasons.push("capability_proof_release_mismatch");
  }
  const observedAt = Date.parse(evidence.observed_at);
  const expiresAt = Date.parse(evidence.expires_at);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || observedAt > now.getTime() ||
    expiresAt <= now.getTime() || now.getTime() - observedAt > LIVE_TRADING_EVIDENCE_MAX_AGE_MS) {
    reasons.push("capability_proof_stale");
  }
  return reasons.length ? { ok: false, reason_codes: reasons } : { ok: true };
}

function defaultLaunchControl(): LiveTradingLaunchControl {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    state: "disabled",
    contract_version: LIVE_TRADING_CONTRACT_VERSION,
    web_git_sha: null,
    worker_git_sha: null,
    worker_image_digest: null,
    config_fingerprint: null,
    public_capabilities: ["limit_order"],
    caps: canonicalLiveTradingCaps(),
    evidence_commitment: null,
    updated_by: "system:default",
    created_at: now,
    updated_at: now,
  };
}

function reservationKey(ownerCommitment: string, idempotencyKey: string) {
  return `live_reservation_${createHash("sha256").update(`${ownerCommitment}\0${idempotencyKey}`).digest("hex").slice(0, 48)}`;
}

function rollingMemoryNotional(accountCommitment: string, now: Date) {
  const cutoff = now.getTime() - 24 * 60 * 60_000;
  return Array.from(reservationMemory.values())
    .filter((record) => record.account_commitment === accountCommitment &&
      Date.parse(record.created_at) >= cutoff &&
      (record.status === "filled" || (record.status === "reserved" && Date.parse(record.expires_at) > now.getTime())))
    .reduce((total, record) => total + record.notional_usd, 0);
}

function parseJsonRow<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function sameNumber(left: number, right: number) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.000001;
}

function activeGraduationMatchesContract(record: LiveTradingAccountGraduation) {
  return record.status === "active" &&
    sameNumber(record.proof_notional_usd, LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD);
}

function replayableReservation(
  reservation: LiveTradingNotionalReservation,
  input: { account_commitment: string; notional_usd: number; request_commitment: string },
  now: Date,
) {
  return reservation.account_commitment === input.account_commitment &&
    reservation.request_commitment === input.request_commitment &&
    sameNumber(reservation.notional_usd, input.notional_usd) &&
    (reservation.status === "filled" ||
      (reservation.status === "reserved" && Date.parse(reservation.expires_at) > now.getTime()));
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
  if (!schemaPromise) {
    schemaPromise = migrateSchema(sql).then(() => {
      schemaReady = true;
    }).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function migrateSchema(sql: NeonSql) {
  await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(hashtextextended('ghola:live-trading-schema:v2', 0))`,
    tx`
      CREATE TABLE IF NOT EXISTS live_trading_launch_control (
        control_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        control JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    tx`
      CREATE TABLE IF NOT EXISTS live_trading_capability_evidence (
        evidence_id TEXT PRIMARY KEY,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        evidence JSONB NOT NULL
      )
    `,
    tx`
      CREATE TABLE IF NOT EXISTS live_trading_account_graduations (
        graduation_id TEXT PRIMARY KEY,
        owner_commitment TEXT NOT NULL,
        account_commitment TEXT NOT NULL,
        vault_commitment TEXT NOT NULL,
        status TEXT NOT NULL,
        graduation JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    tx`
      CREATE TABLE IF NOT EXISTS live_trading_notional_reservations (
        reservation_id TEXT PRIMARY KEY,
        owner_commitment TEXT NOT NULL,
        account_commitment TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        notional_usd DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL,
        reservation JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (owner_commitment, idempotency_key)
      )
    `,
    tx`CREATE INDEX IF NOT EXISTS idx_live_capability_evidence ON live_trading_capability_evidence (capability, observed_at DESC)`,
    tx`CREATE INDEX IF NOT EXISTS idx_live_graduation_account ON live_trading_account_graduations (owner_commitment, account_commitment, vault_commitment, updated_at DESC)`,
    tx`CREATE INDEX IF NOT EXISTS idx_live_notional_window ON live_trading_notional_reservations (account_commitment, created_at DESC, status)`,
  ]);
}

function memoryCritical<T>(operation: () => Promise<T>): Promise<T> {
  const next = memoryQueue.then(operation, operation);
  memoryQueue = next.then(() => undefined, () => undefined);
  return next;
}
