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
import { stablePrivateAccountJson } from "./private-account";

type NeonSql = Awaited<ReturnType<typeof import("@neondatabase/serverless")["neon"]>>;

export interface LiveTradingLaunchControl {
  version: 2;
  revision: number;
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

type LiveTradingLaunchControlWrite = Omit<LiveTradingLaunchControl, "revision"> & {
  revision?: number;
};

export type LiveTradingLaunchTransition =
  | {
      kind: "set";
      expected_revision: number;
      control: Omit<LiveTradingLaunchControl, "revision">;
    }
  | {
      kind: "kill";
      updated_by: string;
      updated_at: string;
      evidence_commitment: string;
    }
  | {
      kind: "reset";
      expected_revision: number;
      updated_by: string;
      updated_at: string;
      evidence_commitment: string;
    };

export type LiveTradingLaunchTransitionResult =
  | { ok: true; control: LiveTradingLaunchControl }
  | {
      ok: false;
      error: "launch_revision_conflict" | "launch_killed_absorbing" | "launch_reset_state_invalid";
      control: LiveTradingLaunchControl;
    };

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
  version: 3;
  contract_version: typeof LIVE_TRADING_CONTRACT_VERSION;
  graduation_id: string;
  owner_commitment: string;
  account_commitment: string;
  vault_commitment: string;
  web_git_sha: string;
  worker_git_sha: string;
  worker_image_digest: string;
  config_fingerprint: string;
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

export type LiveTradingWorkOrderReconciliationStatus =
  | "pending"
  | "submitted"
  | "reconciled"
  | "no_fill"
  | "not_dispatched";

export interface LiveTradingProvenFill {
  filled_base_size: string;
  average_fill_price: string;
  fee_usd: string;
  protection:
    | { status: "not_requested" }
    | {
        status: "proven";
        grouping: "normalTpsl";
        trigger_source: "mark";
        trigger_order_type: "bounded_limit";
        max_slippage_bps: number;
      };
}

/**
 * Durable, ciphertext-only recovery material for one exact terminal order.
 * The worker request is never rebuilt from browser input during reconciliation.
 */
export interface LiveTradingWorkOrderReconciliation {
  version: 1;
  work_order_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  vault_commitment: string;
  vault_policy_commitment: string;
  order_policy_commitment: string;
  plan_digest: string;
  request_commitment: string;
  worker_request_digest: string;
  market: string;
  require_protection: boolean;
  protection_slippage_bps: number | null;
  worker_recipient: string;
  worker_image_digest: string;
  instruction_expires_at: string;
  reservation_id: string | null;
  status: LiveTradingWorkOrderReconciliationStatus;
  result_commitment: string | null;
  order_id: string | null;
  /** Present only when an authenticated worker receipt passed terminal venue-proof checks. */
  proven_fill?: LiveTradingProvenFill | null;
  worker_request: Record<string, unknown>;
  worker_claim_absence_probe?: {
    first_observed_at: string;
    last_observed_at: string;
    observation_count: number;
  } | null;
  created_at: string;
  updated_at: string;
}

export const LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS = 30_000;

export type LiveTradingDispatchAbsenceInspection =
  | { status: "evidence_present"; work_order_record: boolean; reservation: boolean }
  | { status: "pending"; first_observed_at: string; checked_at: string }
  | { status: "proven"; proof_commitment: string; first_observed_at: string; checked_at: string };

const launchMemory = new Map<string, LiveTradingLaunchControl>();
const evidenceMemory = new Map<string, LiveTradingCapabilityEvidence>();
const graduationMemory = new Map<string, LiveTradingAccountGraduation>();
const reservationMemory = new Map<string, LiveTradingNotionalReservation>();
const workOrderReconciliationMemory = new Map<string, LiveTradingWorkOrderReconciliation>();
type LiveTradingDispatchAbsenceProbe = {
  first_observed_at: string;
  last_checked_at: string;
  proven_at?: string;
};

const dispatchAbsenceProbeMemory = new Map<string, LiveTradingDispatchAbsenceProbe>();
let memoryQueue = Promise.resolve();
let sqlClient: NeonSql | null = null;
let schemaReady = false;
let schemaPromise: Promise<void> | null = null;

export async function getLiveTradingLaunchControl(): Promise<LiveTradingLaunchControl> {
  const sql = await getSql();
  if (!sql) return launchMemory.get("global") ?? defaultLaunchControl();
  await ensureSchema(sql);
  const rows = await sql`
    SELECT control, revision FROM live_trading_launch_control WHERE control_id = 'global' LIMIT 1
  ` as Array<{ control: LiveTradingLaunchControl | string; revision: number | string }>;
  return rows[0] ? launchControlFromRow(rows[0]) : defaultLaunchControl();
}

export async function putLiveTradingLaunchControl(
  control: LiveTradingLaunchControlWrite,
): Promise<LiveTradingLaunchControl> {
  if (control.state === "killed") {
    const killed = await transitionLiveTradingLaunchControl({
      kind: "kill",
      updated_by: control.updated_by,
      updated_at: control.updated_at,
      evidence_commitment: control.evidence_commitment ?? "legacy_kill_without_evidence_commitment",
    });
    return killed.control;
  }
  const current = await getLiveTradingLaunchControl();
  const expectedRevision = validRevision(control.revision) ? control.revision : current.revision;
  const result = await transitionLiveTradingLaunchControl({
    kind: "set",
    expected_revision: expectedRevision,
    control,
  });
  if (!result.ok) throw new Error(result.error);
  return result.control;
}

/** Atomic launch mutation boundary. `killed` is absorbing except for reset. */
export async function transitionLiveTradingLaunchControl(
  input: LiveTradingLaunchTransition,
): Promise<LiveTradingLaunchTransitionResult> {
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = launchMemory.get("global") ?? defaultLaunchControl();
      const decision = applyLaunchTransition(current, input);
      if (decision.ok) launchMemory.set("global", decision.control);
      return decision;
    });
  }
  await ensureSchema(sql);
  const rows = input.kind === "kill"
    ? await postgresKillLaunchControl(sql, input)
    : input.kind === "reset"
      ? await postgresResetLaunchControl(sql, input)
      : await postgresSetLaunchControl(sql, input);
  if (rows[0]) return { ok: true, control: launchControlFromRow(rows[0]) };
  const current = await getLiveTradingLaunchControl();
  if (input.kind === "reset") {
    return {
      ok: false,
      error: current.revision !== input.expected_revision
        ? "launch_revision_conflict"
        : "launch_reset_state_invalid",
      control: current,
    };
  }
  return {
    ok: false,
    error: current.state === "killed" ? "launch_killed_absorbing" : "launch_revision_conflict",
    control: current,
  };
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
  release?: LiveTradingReleaseIdentity;
}): Promise<LiveTradingAccountGraduation | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(graduationMemory.values())
      .filter((record) => record.owner_commitment === input.owner_commitment &&
        record.account_commitment === input.account_commitment &&
        record.vault_commitment === input.vault_commitment &&
        activeGraduationMatchesContract(record, input.release))
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
    .find((record) => activeGraduationMatchesContract(record, input.release)) ?? null;
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
  | { ok: false; error: "order_notional_cap_exceeded" | "rolling_notional_cap_exceeded" | "idempotency_conflict" | "dispatch_absence_proven" | "unresolved_work_order" }
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
      const absenceProbe = dispatchAbsenceProbeMemory.get(`${input.owner_commitment}:${input.request_commitment}`);
      if (absenceProbe?.proven_at) {
        return { ok: false as const, error: "dispatch_absence_proven" as const };
      }
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
      const unresolved = Array.from(workOrderReconciliationMemory.values()).find((record) =>
        record.owner_commitment === input.owner_commitment &&
        record.account_commitment === input.account_commitment &&
        (record.status === "pending" || record.status === "submitted"));
      if (unresolved) {
        return { ok: false as const, error: "unresolved_work_order" as const };
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
  const transactionResults = await sql.transaction((tx) => [
    tx`
      SELECT
        pg_advisory_xact_lock(hashtextextended(${input.account_commitment}, 0)),
        pg_advisory_xact_lock(hashtextextended(${`${input.owner_commitment}:${input.request_commitment}`}, 0))
    `,
    tx`
    WITH absence_tombstone AS (
      SELECT EXISTS (
        SELECT 1 FROM live_trading_dispatch_absence_probes
        WHERE owner_commitment = ${input.owner_commitment}
          AND plan_digest = ${input.request_commitment}
          AND probe ? 'proven_at'
      ) AS proven
    ), unresolved_work_order AS (
      SELECT EXISTS (
        SELECT 1 FROM live_trading_work_order_reconciliations
        WHERE owner_commitment = ${input.owner_commitment}
          AND account_commitment = ${input.account_commitment}
          AND plan_digest <> ${input.request_commitment}
          AND status IN ('pending', 'submitted')
      ) AS present
    ), existing AS (
      SELECT reservation FROM live_trading_notional_reservations
      WHERE reservation_id = ${reservationId}
    ), rolling AS (
      SELECT COALESCE(SUM(notional_usd), 0)::double precision AS total
      FROM live_trading_notional_reservations
      WHERE account_commitment = ${input.account_commitment}
        AND created_at >= ${cutoff}
        AND (
          status = 'filled' OR
          (status = 'reserved' AND (
            expires_at > ${createdAt} OR EXISTS (
              SELECT 1 FROM live_trading_work_order_reconciliations
              WHERE status IN ('pending', 'submitted', 'reconciled')
                AND record->>'reservation_id' = live_trading_notional_reservations.reservation_id
            )
          ))
        )
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
        AND NOT (SELECT proven FROM absence_tombstone)
        AND NOT (SELECT present FROM unresolved_work_order)
        AND rolling.total + ${input.notional_usd} <= ${input.rolling_24h_notional_usd}
      ON CONFLICT (reservation_id) DO NOTHING
      RETURNING reservation
    )
    SELECT 'inserted' AS disposition, reservation, (SELECT total FROM rolling) + ${input.notional_usd} AS rolling_total FROM inserted
    UNION ALL
    SELECT 'existing' AS disposition, reservation, (SELECT total FROM rolling) AS rolling_total FROM existing
    UNION ALL
    SELECT 'tombstoned' AS disposition, NULL::jsonb AS reservation, (SELECT total FROM rolling) AS rolling_total
    FROM absence_tombstone WHERE proven
    UNION ALL
    SELECT 'unresolved' AS disposition, NULL::jsonb AS reservation, (SELECT total FROM rolling) AS rolling_total
    FROM unresolved_work_order WHERE present
  `,
  ]);
  const rows = transactionResults[1] as Array<{
    disposition: string;
    reservation: LiveTradingNotionalReservation | string;
    rolling_total: number;
  }>;
  const tombstoned = rows.find((row) => row.disposition === "tombstoned");
  if (tombstoned) {
    return { ok: false, error: "dispatch_absence_proven" };
  }
  const unresolved = rows.find((row) => row.disposition === "unresolved");
  if (unresolved) return { ok: false, error: "unresolved_work_order" };
  const selected = rows.find((row) => row.disposition === "inserted" || row.disposition === "existing");
  if (!selected) return { ok: false, error: "rolling_notional_cap_exceeded" };
  const reservation = parseJsonRow<LiveTradingNotionalReservation>(selected.reservation);
  if (selected.disposition === "existing" &&
    !replayableReservation(reservation, input, now)) {
    return { ok: false, error: "idempotency_conflict" };
  }
  return {
    ok: true,
    disposition: selected.disposition === "inserted" ? "created" : "replayed",
    reservation,
    rolling_notional_usd: Number(selected.rolling_total),
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

export function liveTradingWorkerRequestDigest(request: Record<string, unknown>) {
  return `sha256:${createHash("sha256").update(stablePrivateAccountJson(request)).digest("hex")}`;
}

export async function putLiveTradingWorkOrderReconciliation(
  record: LiveTradingWorkOrderReconciliation,
): Promise<boolean> {
  if (!validWorkOrderReconciliation(record)) return false;
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const existing = workOrderReconciliationMemory.get(record.work_order_commitment);
      if (existing && !sameWorkOrderBinding(existing, record)) return false;
      const otherUnresolved = Array.from(workOrderReconciliationMemory.values()).some((candidate) =>
        candidate.work_order_commitment !== record.work_order_commitment &&
        candidate.owner_commitment === record.owner_commitment &&
        candidate.account_commitment === record.account_commitment &&
        (candidate.status === "pending" || candidate.status === "submitted"));
      if (!existing && otherUnresolved) return false;
      const absenceProbe = dispatchAbsenceProbeMemory.get(`${record.owner_commitment}:${record.plan_digest}`);
      if (!existing && absenceProbe?.proven_at) return false;
      if (existing && (workOrderStatusRank(existing.status) > workOrderStatusRank(record.status) ||
        workOrderStatusRank(existing.status) === 2)) return workOrderUpdateSatisfied(existing, record);
      workOrderReconciliationMemory.set(record.work_order_commitment, record);
      settleMemoryReservationForWorkOrder(record);
      return true;
    });
  }
  await ensureSchema(sql);
  const bindingLockKey = `${record.owner_commitment}:${record.plan_digest}`;
  const transactionResults = await sql.transaction((tx) => [
    tx`SELECT
      pg_advisory_xact_lock(hashtextextended(${record.account_commitment}, 0)),
      pg_advisory_xact_lock(hashtextextended(${bindingLockKey}, 0))`,
    tx`
    WITH absence_tombstone AS (
      SELECT EXISTS (
        SELECT 1 FROM live_trading_dispatch_absence_probes
        WHERE owner_commitment = ${record.owner_commitment}
          AND plan_digest = ${record.plan_digest}
          AND probe ? 'proven_at'
      ) AS proven
    ), existing_work_order AS (
      SELECT EXISTS (
        SELECT 1 FROM live_trading_work_order_reconciliations
        WHERE work_order_commitment = ${record.work_order_commitment}
      ) AS present
    ), other_unresolved AS (
      SELECT EXISTS (
        SELECT 1 FROM live_trading_work_order_reconciliations
        WHERE owner_commitment = ${record.owner_commitment}
          AND account_commitment = ${record.account_commitment}
          AND work_order_commitment <> ${record.work_order_commitment}
          AND status IN ('pending', 'submitted')
      ) AS present
    ), upserted AS (
    INSERT INTO live_trading_work_order_reconciliations (
      work_order_commitment, owner_commitment, account_commitment, vault_commitment,
      vault_policy_commitment, order_policy_commitment, plan_digest,
      request_commitment, worker_request_digest, market, require_protection,
      protection_slippage_bps, status, record, updated_at
    ) SELECT
      ${record.work_order_commitment}, ${record.owner_commitment}, ${record.account_commitment},
      ${record.vault_commitment}, ${record.vault_policy_commitment},
      ${record.order_policy_commitment}, ${record.plan_digest}, ${record.request_commitment},
      ${record.worker_request_digest}, ${record.market}, ${record.require_protection},
      ${record.protection_slippage_bps}, ${record.status},
      ${JSON.stringify(record)}::jsonb, ${record.updated_at}
    FROM absence_tombstone, existing_work_order, other_unresolved
    WHERE (NOT absence_tombstone.proven OR existing_work_order.present)
      AND (NOT other_unresolved.present OR existing_work_order.present)
    ON CONFLICT (work_order_commitment) DO UPDATE SET
      status = CASE
        WHEN live_trading_work_order_reconciliations.status IN ('reconciled', 'no_fill', 'not_dispatched')
          THEN live_trading_work_order_reconciliations.status
        WHEN live_trading_work_order_reconciliations.status = 'submitted' AND EXCLUDED.status = 'pending'
          THEN live_trading_work_order_reconciliations.status
        ELSE EXCLUDED.status
      END,
      record = CASE
        WHEN live_trading_work_order_reconciliations.status IN ('reconciled', 'no_fill', 'not_dispatched')
          THEN live_trading_work_order_reconciliations.record
        WHEN live_trading_work_order_reconciliations.status = 'submitted' AND EXCLUDED.status = 'pending'
          THEN live_trading_work_order_reconciliations.record
        ELSE EXCLUDED.record
      END,
      updated_at = CASE
        WHEN live_trading_work_order_reconciliations.status IN ('reconciled', 'no_fill', 'not_dispatched')
          THEN live_trading_work_order_reconciliations.updated_at
        WHEN live_trading_work_order_reconciliations.status = 'submitted' AND EXCLUDED.status = 'pending'
          THEN live_trading_work_order_reconciliations.updated_at
        ELSE EXCLUDED.updated_at
      END
    WHERE live_trading_work_order_reconciliations.owner_commitment = EXCLUDED.owner_commitment
      AND live_trading_work_order_reconciliations.account_commitment = EXCLUDED.account_commitment
      AND live_trading_work_order_reconciliations.vault_commitment = EXCLUDED.vault_commitment
      AND live_trading_work_order_reconciliations.vault_policy_commitment = EXCLUDED.vault_policy_commitment
      AND live_trading_work_order_reconciliations.order_policy_commitment = EXCLUDED.order_policy_commitment
      AND live_trading_work_order_reconciliations.plan_digest = EXCLUDED.plan_digest
      AND live_trading_work_order_reconciliations.request_commitment = EXCLUDED.request_commitment
      AND live_trading_work_order_reconciliations.worker_request_digest = EXCLUDED.worker_request_digest
      AND live_trading_work_order_reconciliations.market = EXCLUDED.market
      AND live_trading_work_order_reconciliations.require_protection = EXCLUDED.require_protection
      AND live_trading_work_order_reconciliations.protection_slippage_bps IS NOT DISTINCT FROM EXCLUDED.protection_slippage_bps
      AND live_trading_work_order_reconciliations.record->>'worker_recipient' = EXCLUDED.record->>'worker_recipient'
      AND live_trading_work_order_reconciliations.record->>'worker_image_digest' = EXCLUDED.record->>'worker_image_digest'
      AND live_trading_work_order_reconciliations.record->>'instruction_expires_at' = EXCLUDED.record->>'instruction_expires_at'
      AND live_trading_work_order_reconciliations.record->>'reservation_id'
        IS NOT DISTINCT FROM EXCLUDED.record->>'reservation_id'
    RETURNING record
    ), settled AS (
      UPDATE live_trading_notional_reservations
      SET status = CASE WHEN upserted.record->>'status' = 'reconciled' THEN 'filled' ELSE 'released' END,
        reservation = jsonb_set(
          jsonb_set(
            reservation,
            '{status}',
            to_jsonb((CASE WHEN upserted.record->>'status' = 'reconciled' THEN 'filled' ELSE 'released' END)::text)
          ),
          '{updated_at}', to_jsonb(${record.updated_at}::text)
        ),
        updated_at = ${record.updated_at}
      FROM upserted
      WHERE live_trading_notional_reservations.reservation_id = upserted.record->>'reservation_id'
        AND live_trading_notional_reservations.status = 'reserved'
        AND upserted.record->>'status' IN ('reconciled', 'no_fill', 'not_dispatched')
      RETURNING live_trading_notional_reservations.reservation_id
    )
    SELECT record FROM upserted
  `,
  ]);
  const rows = transactionResults[1] as Array<{
    record: LiveTradingWorkOrderReconciliation | string;
  }>;
  if (!rows[0]) return false;
  return workOrderUpdateSatisfied(
    parseJsonRow<LiveTradingWorkOrderReconciliation>(rows[0].record),
    record,
  );
}

export async function getLiveTradingWorkOrderReconciliation(input: {
  owner_commitment: string;
  plan_digest: string;
}): Promise<LiveTradingWorkOrderReconciliation | null> {
  const sql = await getSql();
  if (!sql) {
    const record = Array.from(workOrderReconciliationMemory.values())
      .find((candidate) => candidate.owner_commitment === input.owner_commitment &&
        candidate.plan_digest === input.plan_digest) ?? null;
    return record && validWorkOrderReconciliation(record) ? record : null;
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT record FROM live_trading_work_order_reconciliations
    WHERE owner_commitment = ${input.owner_commitment}
      AND plan_digest = ${input.plan_digest}
    LIMIT 1
  ` as Array<{ record: LiveTradingWorkOrderReconciliation | string }>;
  const record = rows[0] ? parseJsonRow<LiveTradingWorkOrderReconciliation>(rows[0].record) : null;
  return record && validWorkOrderReconciliation(record) ? record : null;
}

export async function getUnresolvedLiveTradingWorkOrder(input: {
  owner_commitment: string;
  account_commitment: string;
}): Promise<LiveTradingWorkOrderReconciliation | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(workOrderReconciliationMemory.values())
      .filter((record) => record.owner_commitment === input.owner_commitment &&
        record.account_commitment === input.account_commitment &&
        (record.status === "pending" || record.status === "submitted"))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT record FROM live_trading_work_order_reconciliations
    WHERE owner_commitment = ${input.owner_commitment}
      AND account_commitment = ${input.account_commitment}
      AND status IN ('pending', 'submitted')
    ORDER BY updated_at ASC
    LIMIT 1
  ` as Array<{ record: LiveTradingWorkOrderReconciliation | string }>;
  const record = rows[0] ? parseJsonRow<LiveTradingWorkOrderReconciliation>(rows[0].record) : null;
  return record && validWorkOrderReconciliation(record) ? record : null;
}

/** Monotonic, plan-locked worker claim-absence evidence; never changes order status. */
export async function recordLiveTradingWorkerClaimAbsence(input: {
  owner_commitment: string;
  plan_digest: string;
  observed_at?: Date;
}): Promise<LiveTradingWorkOrderReconciliation | null> {
  const observedAt = (input.observed_at ?? new Date()).toISOString();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = Array.from(workOrderReconciliationMemory.values()).find((record) =>
        record.owner_commitment === input.owner_commitment && record.plan_digest === input.plan_digest);
      if (!current || (current.status !== "pending" && current.status !== "submitted") ||
          Date.parse(observedAt) < Date.parse(current.instruction_expires_at)) return null;
      const previous = current.worker_claim_absence_probe;
      const next = {
        ...current,
        worker_claim_absence_probe: {
          first_observed_at: previous?.first_observed_at ?? observedAt,
          last_observed_at: previous && Date.parse(previous.last_observed_at) > Date.parse(observedAt)
            ? previous.last_observed_at
            : observedAt,
          observation_count: (previous?.observation_count ?? 0) + 1,
        },
        updated_at: Date.parse(current.updated_at) > Date.parse(observedAt)
          ? current.updated_at
          : observedAt,
      };
      workOrderReconciliationMemory.set(current.work_order_commitment, next);
      return next;
    });
  }
  await ensureSchema(sql);
  const lockKey = `${input.owner_commitment}:${input.plan_digest}`;
  const results = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    tx`
      UPDATE live_trading_work_order_reconciliations
      SET record = jsonb_set(
        record,
        '{worker_claim_absence_probe}',
        jsonb_build_object(
          'first_observed_at', COALESCE(record->'worker_claim_absence_probe'->>'first_observed_at', ${observedAt}),
          'last_observed_at', GREATEST(
            COALESCE(record->'worker_claim_absence_probe'->>'last_observed_at', ${observedAt})::timestamptz,
            ${observedAt}::timestamptz
          ),
          'observation_count', COALESCE((record->'worker_claim_absence_probe'->>'observation_count')::integer, 0) + 1
        )
      ), updated_at = GREATEST(updated_at, ${observedAt}::timestamptz)
      WHERE owner_commitment = ${input.owner_commitment}
        AND plan_digest = ${input.plan_digest}
        AND status IN ('pending', 'submitted')
        AND (record->>'instruction_expires_at')::timestamptz <= ${observedAt}::timestamptz
      RETURNING record
    `,
  ]);
  const rows = results[1] as Array<{ record: LiveTradingWorkOrderReconciliation | string }>;
  const current = rows[0] ? parseJsonRow<LiveTradingWorkOrderReconciliation>(rows[0].record) : null;
  return current && validWorkOrderReconciliation(current) ? current : null;
}

/**
 * Delayed negative proof for a request that never reached the app. The dispatch
 * path durably writes its work-order record before any worker call, so absence
 * of that record excludes a worker claim/idempotency attempt. An orphaned
 * billing reservation is released only when the same locked grace probe is
 * promoted to a permanent late-dispatch tombstone.
 */
export async function inspectLiveTradingDispatchAbsence(input: {
  owner_commitment: string;
  plan_digest: string;
  now?: Date;
  grace_ms?: number;
}): Promise<LiveTradingDispatchAbsenceInspection> {
  if (!safeBinding(input.owner_commitment) || !/^sha256:[a-f0-9]{64}$/u.test(input.plan_digest)) {
    return { status: "evidence_present", work_order_record: true, reservation: true };
  }
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const graceMs = Number.isInteger(input.grace_ms) && (input.grace_ms as number) >= LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS
    ? input.grace_ms as number
    : LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS;
  const sql = await getSql();
  let workOrderRecord = false;
  let reservation = false;
  let probe: LiveTradingDispatchAbsenceProbe | null = null;
  if (!sql) {
    return memoryCritical(async () => {
      workOrderRecord = Array.from(workOrderReconciliationMemory.values()).some((record) =>
        record.owner_commitment === input.owner_commitment && record.plan_digest === input.plan_digest);
      reservation = Array.from(reservationMemory.values()).some((record) =>
        record.owner_commitment === input.owner_commitment && record.request_commitment === input.plan_digest);
      if (workOrderRecord) return { status: "evidence_present", work_order_record: true, reservation };
      const key = `${input.owner_commitment}:${input.plan_digest}`;
      probe = dispatchAbsenceProbeMemory.get(key) ?? { first_observed_at: checkedAt, last_checked_at: checkedAt };
      probe = markDispatchAbsenceProven({ ...probe, last_checked_at: checkedAt }, now, graceMs);
      dispatchAbsenceProbeMemory.set(key, probe);
      if (probe.proven_at) {
        for (const [reservationId, record] of reservationMemory.entries()) {
          if (record.owner_commitment === input.owner_commitment &&
              record.request_commitment === input.plan_digest && record.status === "reserved") {
            reservationMemory.set(reservationId, { ...record, status: "released", updated_at: checkedAt });
          }
        }
      }
      return dispatchAbsenceResult(input.owner_commitment, input.plan_digest, probe, now, graceMs);
    });
  }
  await ensureSchema(sql);
  const lockKey = `${input.owner_commitment}:${input.plan_digest}`;
  const candidate = { first_observed_at: checkedAt, last_checked_at: checkedAt };
  const proveBefore = new Date(now.getTime() - graceMs).toISOString();
  const transactionResults = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    tx`
    WITH evidence AS (
      SELECT
        EXISTS (
          SELECT 1 FROM live_trading_work_order_reconciliations
          WHERE owner_commitment = ${input.owner_commitment} AND plan_digest = ${input.plan_digest}
        ) AS work_order_record,
        EXISTS (
          SELECT 1 FROM live_trading_notional_reservations
          WHERE owner_commitment = ${input.owner_commitment}
            AND reservation->>'request_commitment' = ${input.plan_digest}
        ) AS reservation
    ), inserted AS (
      INSERT INTO live_trading_dispatch_absence_probes (
        owner_commitment, plan_digest, probe, updated_at
      )
      SELECT ${input.owner_commitment}, ${input.plan_digest}, ${JSON.stringify(candidate)}::jsonb, ${checkedAt}
      FROM evidence
      WHERE NOT work_order_record
      ON CONFLICT (owner_commitment, plan_digest) DO UPDATE SET
        probe = CASE
          WHEN live_trading_dispatch_absence_probes.probe ? 'proven_at' THEN
            jsonb_set(
              live_trading_dispatch_absence_probes.probe,
              '{last_checked_at}',
              to_jsonb(${checkedAt}::text)
            )
          WHEN (live_trading_dispatch_absence_probes.probe->>'first_observed_at')::timestamptz <= ${proveBefore}::timestamptz THEN
            jsonb_set(
              jsonb_set(
                live_trading_dispatch_absence_probes.probe,
                '{last_checked_at}',
                to_jsonb(${checkedAt}::text)
              ),
              '{proven_at}',
              to_jsonb(${checkedAt}::text)
            )
          ELSE jsonb_set(
            live_trading_dispatch_absence_probes.probe,
            '{last_checked_at}',
            to_jsonb(${checkedAt}::text)
          )
        END,
        updated_at = ${checkedAt}
      RETURNING probe
    ), released AS (
      UPDATE live_trading_notional_reservations
      SET status = 'released',
        reservation = jsonb_set(
          jsonb_set(reservation, '{status}', to_jsonb('released'::text)),
          '{updated_at}', to_jsonb(${checkedAt}::text)
        ),
        updated_at = ${checkedAt}
      WHERE owner_commitment = ${input.owner_commitment}
        AND reservation->>'request_commitment' = ${input.plan_digest}
        AND status = 'reserved'
        AND EXISTS (SELECT 1 FROM inserted WHERE probe ? 'proven_at')
      RETURNING reservation_id
    )
    SELECT evidence.work_order_record, evidence.reservation,
      COALESCE(
        (SELECT probe FROM inserted LIMIT 1),
        (SELECT probe FROM live_trading_dispatch_absence_probes
          WHERE owner_commitment = ${input.owner_commitment} AND plan_digest = ${input.plan_digest}
          LIMIT 1)
      ) AS probe
    FROM evidence
  `,
  ]);
  const rows = transactionResults[1] as Array<{
    work_order_record: boolean;
    reservation: boolean;
    probe: LiveTradingDispatchAbsenceProbe | string | null;
  }>;
  workOrderRecord = rows[0]?.work_order_record === true;
  reservation = rows[0]?.reservation === true;
  if (workOrderRecord) return { status: "evidence_present", work_order_record: true, reservation };
  probe = rows[0]?.probe ? parseJsonRow<LiveTradingDispatchAbsenceProbe>(rows[0].probe) : null;
  if (!probe || !Number.isFinite(Date.parse(probe.first_observed_at))) {
    return { status: "pending", first_observed_at: checkedAt, checked_at: checkedAt };
  }
  return dispatchAbsenceResult(input.owner_commitment, input.plan_digest, probe, now, graceMs);
}

export function resetLiveTradingStoreForTests() {
  launchMemory.clear();
  evidenceMemory.clear();
  graduationMemory.clear();
  reservationMemory.clear();
  workOrderReconciliationMemory.clear();
  dispatchAbsenceProbeMemory.clear();
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

type LaunchControlRow = {
  control: LiveTradingLaunchControl | string;
  revision?: number | string;
};

function applyLaunchTransition(
  current: LiveTradingLaunchControl,
  input: LiveTradingLaunchTransition,
): LiveTradingLaunchTransitionResult {
  if (input.kind === "kill") {
    return {
      ok: true,
      control: launchAuditUpdate(current, {
        state: "killed",
        revision: nextLaunchRevision(current.revision),
        updated_by: input.updated_by,
        updated_at: input.updated_at,
        evidence_commitment: input.evidence_commitment,
      }),
    };
  }
  if (input.kind === "reset") {
    if (current.revision !== input.expected_revision) {
      return { ok: false, error: "launch_revision_conflict", control: current };
    }
    if (current.state !== "killed") {
      return { ok: false, error: "launch_reset_state_invalid", control: current };
    }
    return {
      ok: true,
      control: launchAuditUpdate(current, {
        state: "disabled",
        revision: nextLaunchRevision(current.revision),
        updated_by: input.updated_by,
        updated_at: input.updated_at,
        evidence_commitment: input.evidence_commitment,
      }),
    };
  }
  if (current.state === "killed") {
    return { ok: false, error: "launch_killed_absorbing", control: current };
  }
  if (current.revision !== input.expected_revision) {
    return { ok: false, error: "launch_revision_conflict", control: current };
  }
  return {
    ok: true,
    control: {
      ...input.control,
      revision: nextLaunchRevision(current.revision),
      created_at: current.revision === 0 ? input.control.created_at : current.created_at,
    },
  };
}

function launchAuditUpdate(
  current: LiveTradingLaunchControl,
  audit: Pick<LiveTradingLaunchControl, "state" | "revision" | "updated_by" | "updated_at" | "evidence_commitment">,
): LiveTradingLaunchControl {
  return { ...current, ...audit };
}

async function postgresSetLaunchControl(
  sql: NeonSql,
  input: Extract<LiveTradingLaunchTransition, { kind: "set" }>,
): Promise<LaunchControlRow[]> {
  if (!validRevision(input.expected_revision)) return [];
  const candidate: LiveTradingLaunchControl = {
    ...input.control,
    revision: nextLaunchRevision(input.expected_revision),
  };
  return await sql`
    INSERT INTO live_trading_launch_control (control_id, state, revision, control, updated_at)
    SELECT 'global', ${candidate.state}, ${candidate.revision}, ${JSON.stringify(candidate)}::jsonb, ${candidate.updated_at}
    WHERE ${input.expected_revision} = 0
    ON CONFLICT (control_id) DO UPDATE SET
      state = EXCLUDED.state,
      revision = EXCLUDED.revision,
      control = jsonb_set(
        EXCLUDED.control,
        '{created_at}',
        COALESCE(live_trading_launch_control.control->'created_at', EXCLUDED.control->'created_at')
      ),
      updated_at = EXCLUDED.updated_at
    WHERE live_trading_launch_control.state <> 'killed'
      AND live_trading_launch_control.revision = ${input.expected_revision}
    RETURNING control, revision
  ` as LaunchControlRow[];
}

async function postgresKillLaunchControl(
  sql: NeonSql,
  input: Extract<LiveTradingLaunchTransition, { kind: "kill" }>,
): Promise<LaunchControlRow[]> {
  const initial = launchAuditUpdate(defaultLaunchControl(), {
    state: "killed",
    revision: 1,
    updated_by: input.updated_by,
    updated_at: input.updated_at,
    evidence_commitment: input.evidence_commitment,
  });
  initial.created_at = input.updated_at;
  const patch = {
    state: "killed",
    updated_by: input.updated_by,
    updated_at: input.updated_at,
    evidence_commitment: input.evidence_commitment,
  };
  return await sql`
    INSERT INTO live_trading_launch_control (control_id, state, revision, control, updated_at)
    VALUES ('global', 'killed', 1, ${JSON.stringify(initial)}::jsonb, ${input.updated_at})
    ON CONFLICT (control_id) DO UPDATE SET
      state = 'killed',
      revision = live_trading_launch_control.revision + 1,
      control = live_trading_launch_control.control || ${JSON.stringify(patch)}::jsonb ||
        jsonb_build_object('revision', live_trading_launch_control.revision + 1),
      updated_at = EXCLUDED.updated_at
    RETURNING control, revision
  ` as LaunchControlRow[];
}

async function postgresResetLaunchControl(
  sql: NeonSql,
  input: Extract<LiveTradingLaunchTransition, { kind: "reset" }>,
): Promise<LaunchControlRow[]> {
  if (!validRevision(input.expected_revision)) return [];
  const patch = {
    state: "disabled",
    updated_by: input.updated_by,
    updated_at: input.updated_at,
    evidence_commitment: input.evidence_commitment,
  };
  return await sql`
    UPDATE live_trading_launch_control
    SET state = 'disabled',
      revision = revision + 1,
      control = control || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('revision', revision + 1),
      updated_at = ${input.updated_at}
    WHERE control_id = 'global'
      AND state = 'killed'
      AND revision = ${input.expected_revision}
    RETURNING control, revision
  ` as LaunchControlRow[];
}

function launchControlFromRow(row: LaunchControlRow): LiveTradingLaunchControl {
  const control = parseJsonRow<LiveTradingLaunchControl>(row.control);
  const storedRevision = Number(row.revision ?? control.revision ?? 0);
  return { ...control, revision: validRevision(storedRevision) ? storedRevision : 0 };
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nextLaunchRevision(current: number) {
  if (!validRevision(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("live_trading_launch_revision_exhausted");
  }
  return current + 1;
}

function defaultLaunchControl(): LiveTradingLaunchControl {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    revision: 0,
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
  const unresolvedReservationIds = new Set(
    Array.from(workOrderReconciliationMemory.values())
      .filter((record) => record.status === "pending" || record.status === "submitted" || record.status === "reconciled")
      .flatMap((record) => record.reservation_id ? [record.reservation_id] : []),
  );
  return Array.from(reservationMemory.values())
    .filter((record) => record.account_commitment === accountCommitment &&
      Date.parse(record.created_at) >= cutoff &&
      (record.status === "filled" || (record.status === "reserved" && (
        Date.parse(record.expires_at) > now.getTime() || unresolvedReservationIds.has(record.reservation_id)
      ))))
    .reduce((total, record) => total + record.notional_usd, 0);
}

function parseJsonRow<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function sameNumber(left: number, right: number) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.000001;
}

function activeGraduationMatchesContract(
  record: LiveTradingAccountGraduation,
  release?: LiveTradingReleaseIdentity,
) {
  const structurallyBound = record.version === 3 &&
    record.contract_version === LIVE_TRADING_CONTRACT_VERSION &&
    /^[a-f0-9]{7,64}$/u.test(record.web_git_sha) &&
    /^[a-f0-9]{7,64}$/u.test(record.worker_git_sha) &&
    /^(?:sha256:)?[a-f0-9]{64}$/u.test(record.worker_image_digest) &&
    typeof record.config_fingerprint === "string" && record.config_fingerprint.length > 0;
  const exactRelease = !release || (
    release.valid &&
    record.web_git_sha === release.web_git_sha &&
    record.worker_git_sha === release.worker_git_sha &&
    record.worker_image_digest === release.worker_image_digest &&
    record.config_fingerprint === release.config_fingerprint
  );
  return structurallyBound && exactRelease && record.status === "active" &&
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
  if (!url) throw new Error("live_trading_postgres_url_required");
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(url);
  return sqlClient;
}

function shouldUsePostgres() {
  if (process.env.NODE_ENV === "test" && !sqlClient) return false;
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "memory") return false;
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "postgres") return true;
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
        revision BIGINT NOT NULL DEFAULT 0,
        control JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    tx`ALTER TABLE live_trading_launch_control ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0`,
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
    tx`
      CREATE TABLE IF NOT EXISTS live_trading_work_order_reconciliations (
        work_order_commitment TEXT PRIMARY KEY,
        owner_commitment TEXT NOT NULL,
        account_commitment TEXT NOT NULL,
        vault_commitment TEXT NOT NULL,
        vault_policy_commitment TEXT NOT NULL,
        order_policy_commitment TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        request_commitment TEXT NOT NULL,
        worker_request_digest TEXT NOT NULL,
        market TEXT NOT NULL,
        require_protection BOOLEAN NOT NULL,
        protection_slippage_bps INTEGER,
        status TEXT NOT NULL,
        record JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (owner_commitment, plan_digest)
      )
    `,
    tx`
      CREATE TABLE IF NOT EXISTS live_trading_dispatch_absence_probes (
        owner_commitment TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        probe JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_commitment, plan_digest)
      )
    `,
    tx`CREATE INDEX IF NOT EXISTS idx_live_capability_evidence ON live_trading_capability_evidence (capability, observed_at DESC)`,
    tx`CREATE INDEX IF NOT EXISTS idx_live_graduation_account ON live_trading_account_graduations (owner_commitment, account_commitment, vault_commitment, updated_at DESC)`,
    tx`CREATE INDEX IF NOT EXISTS idx_live_notional_window ON live_trading_notional_reservations (account_commitment, created_at DESC, status)`,
    tx`CREATE INDEX IF NOT EXISTS idx_live_work_order_owner_plan ON live_trading_work_order_reconciliations (owner_commitment, plan_digest)`,
  ]);
}

function validWorkOrderReconciliation(record: LiveTradingWorkOrderReconciliation) {
  if (
    record.version !== 1 ||
    !/^live_trade_work_order_[a-f0-9]{48}$/u.test(record.work_order_commitment) ||
    !safeBinding(record.owner_commitment) ||
    !safeBinding(record.account_commitment) ||
    !safeBinding(record.vault_commitment) ||
    !safeBinding(record.vault_policy_commitment) ||
    !/^live_trade_order_policy_[a-f0-9]{48}$/u.test(record.order_policy_commitment) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.plan_digest) ||
    !/^live_trade_request_[a-f0-9]{48}$/u.test(record.request_commitment) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.worker_request_digest) ||
    !/^[A-Z0-9][A-Z0-9._-]{0,31}$/u.test(record.market) ||
    typeof record.require_protection !== "boolean" ||
    (record.require_protection
      ? !Number.isInteger(record.protection_slippage_bps) ||
        (record.protection_slippage_bps as number) < 0 ||
        (record.protection_slippage_bps as number) > 10_000
      : record.protection_slippage_bps !== null) ||
    !safeBinding(record.worker_recipient) ||
    !/^(?:sha256:)?[a-f0-9]{64}$/u.test(record.worker_image_digest) ||
    !Number.isFinite(Date.parse(record.instruction_expires_at)) ||
    (record.reservation_id != null && !safeBinding(record.reservation_id)) ||
    !["pending", "submitted", "reconciled", "no_fill", "not_dispatched"].includes(record.status) ||
    (record.status === "pending" &&
      (record.result_commitment !== null || record.order_id !== null)) ||
    (record.status === "submitted" &&
      (!safeBinding(record.result_commitment ?? "") || record.order_id !== null)) ||
    ((record.status === "reconciled" || record.status === "no_fill") &&
      (!safeBinding(record.result_commitment ?? "") || !safeBinding(record.order_id ?? ""))) ||
    (record.status === "not_dispatched" &&
      (!safeBinding(record.result_commitment ?? "") || record.order_id !== null)) ||
    (record.result_commitment != null && !safeBinding(record.result_commitment)) ||
    (record.order_id != null && !safeBinding(record.order_id)) ||
    !validProvenFill(record.proven_fill, record.status, record.require_protection, record.protection_slippage_bps) ||
    !record.worker_request || typeof record.worker_request !== "object" || Array.isArray(record.worker_request) ||
    liveTradingWorkerRequestDigest(record.worker_request) !== record.worker_request_digest ||
    !Number.isFinite(Date.parse(record.created_at)) ||
    !Number.isFinite(Date.parse(record.updated_at))
  ) return false;
  const claimAbsenceProbe = record.worker_claim_absence_probe;
  if (claimAbsenceProbe != null && (
    !Number.isFinite(Date.parse(claimAbsenceProbe.first_observed_at)) ||
    !Number.isFinite(Date.parse(claimAbsenceProbe.last_observed_at)) ||
    !Number.isInteger(claimAbsenceProbe.observation_count) || claimAbsenceProbe.observation_count < 1
  )) return false;
  const request = record.worker_request;
  const sessionPolicy = request.session_policy && typeof request.session_policy === "object" && !Array.isArray(request.session_policy)
    ? request.session_policy as Record<string, unknown>
    : null;
  return request.version === 1 &&
    request.reconciliation_binding_version === 1 &&
    request.owner_commitment === record.owner_commitment &&
    request.account_commitment === record.account_commitment &&
    request.vault_commitment === record.vault_commitment &&
    request.policy_commitment === record.vault_policy_commitment &&
    request.order_policy_commitment === record.order_policy_commitment &&
    sessionPolicy?.policy_commitment === record.order_policy_commitment &&
    request.plan_digest === record.plan_digest &&
    request.request_commitment === record.request_commitment &&
    request.market === record.market &&
    request.work_order_commitment === record.work_order_commitment &&
    request.operation_class === "limit_order";
}

function sameWorkOrderBinding(
  left: LiveTradingWorkOrderReconciliation,
  right: LiveTradingWorkOrderReconciliation,
) {
  return left.owner_commitment === right.owner_commitment &&
    left.account_commitment === right.account_commitment &&
    left.vault_commitment === right.vault_commitment &&
    left.vault_policy_commitment === right.vault_policy_commitment &&
    left.order_policy_commitment === right.order_policy_commitment &&
    left.plan_digest === right.plan_digest &&
    left.request_commitment === right.request_commitment &&
    left.worker_request_digest === right.worker_request_digest &&
    left.market === right.market &&
    left.require_protection === right.require_protection &&
    left.protection_slippage_bps === right.protection_slippage_bps &&
    left.worker_recipient === right.worker_recipient &&
    left.worker_image_digest === right.worker_image_digest &&
    left.reservation_id === right.reservation_id &&
    left.instruction_expires_at === right.instruction_expires_at;
}

function workOrderStatusRank(status: LiveTradingWorkOrderReconciliationStatus) {
  return status === "reconciled" || status === "no_fill" || status === "not_dispatched"
    ? 2
    : status === "submitted" ? 1 : 0;
}

function workOrderUpdateSatisfied(
  stored: LiveTradingWorkOrderReconciliation,
  requested: LiveTradingWorkOrderReconciliation,
) {
  return sameWorkOrderBinding(stored, requested) &&
    stored.status === requested.status &&
    stored.result_commitment === requested.result_commitment &&
    stored.order_id === requested.order_id &&
    JSON.stringify(stored.proven_fill ?? null) === JSON.stringify(requested.proven_fill ?? null);
}

function validProvenFill(
  value: LiveTradingProvenFill | null | undefined,
  status: LiveTradingWorkOrderReconciliationStatus,
  requireProtection: boolean,
  protectionSlippageBps: number | null,
) {
  if (value == null) return true;
  if (status !== "reconciled" || !positiveDecimal(value.filled_base_size) ||
      !positiveDecimal(value.average_fill_price) || !unsignedDecimal(value.fee_usd)) return false;
  if (requireProtection) {
    return value.protection.status === "proven" &&
      value.protection.grouping === "normalTpsl" &&
      value.protection.trigger_source === "mark" &&
      value.protection.trigger_order_type === "bounded_limit" &&
      value.protection.max_slippage_bps === protectionSlippageBps;
  }
  return value.protection.status === "not_requested";
}

function positiveDecimal(value: string) {
  return unsignedDecimal(value) && /[1-9]/u.test(value);
}

function unsignedDecimal(value: string) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 80 && Number.isFinite(Number(value));
}

function settleMemoryReservationForWorkOrder(record: LiveTradingWorkOrderReconciliation) {
  if (!record.reservation_id ||
      (record.status !== "reconciled" && record.status !== "no_fill" && record.status !== "not_dispatched")) return;
  const reservation = reservationMemory.get(record.reservation_id);
  if (!reservation || reservation.status !== "reserved") return;
  reservationMemory.set(record.reservation_id, {
    ...reservation,
    status: record.status === "reconciled" ? "filled" : "released",
    updated_at: record.updated_at,
  });
}

function dispatchAbsenceResult(
  ownerCommitment: string,
  planDigest: string,
  probe: LiveTradingDispatchAbsenceProbe,
  now: Date,
  graceMs: number,
): LiveTradingDispatchAbsenceInspection {
  const firstObservedAtMs = Date.parse(probe.first_observed_at);
  if (!probe.proven_at || !Number.isFinite(firstObservedAtMs) || now.getTime() - firstObservedAtMs < graceMs) {
    return { status: "pending", first_observed_at: probe.first_observed_at, checked_at: now.toISOString() };
  }
  const proofSeed = stablePrivateAccountJson({
    version: 1,
    owner_commitment: ownerCommitment,
    plan_digest: planDigest,
    first_observed_at: probe.first_observed_at,
    checked_at: now.toISOString(),
    work_order_record: false,
    reservation: false,
    worker_dispatch_possible_without_record: false,
    worker_claim_evidence: false,
    worker_idempotency_evidence: false,
  });
  return {
    status: "proven",
    proof_commitment: `live_trade_absence_proof_${createHash("sha256").update(proofSeed).digest("hex").slice(0, 48)}`,
    first_observed_at: probe.first_observed_at,
    checked_at: now.toISOString(),
  };
}

function markDispatchAbsenceProven(
  probe: LiveTradingDispatchAbsenceProbe,
  now: Date,
  graceMs: number,
): LiveTradingDispatchAbsenceProbe {
  if (probe.proven_at) return probe;
  const firstObservedAtMs = Date.parse(probe.first_observed_at);
  return Number.isFinite(firstObservedAtMs) && now.getTime() - firstObservedAtMs >= graceMs
    ? { ...probe, proven_at: now.toISOString() }
    : probe;
}

function safeBinding(value: string) {
  return typeof value === "string" && /^[A-Za-z0-9._:@/-]{8,240}$/u.test(value);
}

function memoryCritical<T>(operation: () => Promise<T>): Promise<T> {
  const next = memoryQueue.then(operation, operation);
  memoryQueue = next.then(() => undefined, () => undefined);
  return next;
}
