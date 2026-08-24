import { createHash } from "node:crypto";
import {
  advanceCarryPosition,
  appendCarryValueLedgerEntry,
  createCarryPosition,
  createCarryValueLedger,
  finalizeCarryValueLedger,
} from "@ghola/execution-core";
import { preflightCarryPair } from "./carry-preflight.js";

const OWNER = /^[A-Za-z0-9:_-]{8,180}$/;

export async function createStoredCarryPosition({
  state,
  owner_commitment: ownerCommitment,
  position_input: positionInput,
  opportunity,
  monitoring_context: monitoringContext,
  qualification_pilot: qualificationPilot = null,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const normalizedPilot = normalizeQualificationPilot({ qualificationPilot, positionInput, opportunity, env });
  if (!normalizedPilot.ok) return denied(normalizedPilot.error);
  const opportunityError = validateCreationOpportunity(positionInput, opportunity, nowMs, normalizedPilot.value);
  if (opportunityError) return denied(opportunityError);
  const normalizedMonitoring = normalizeMonitoringContext(monitoringContext, positionInput, ownerCommitment);
  if (!normalizedMonitoring.ok) return normalizedMonitoring;
  try {
    const position = createCarryPosition({ ...positionInput, version: 1, now_ms: nowMs });
    const ledger = createCarryValueLedger({
      version: 1,
      position_id: position.position_id,
      modeled: {
        gross_funding_micro_usdc: opportunity.projected_gross_funding_micro_usdc,
        trading_cost_micro_usdc: opportunity.projected_trading_cost_micro_usdc,
        capital_cost_micro_usdc: opportunity.projected_capital_cost_micro_usdc,
        risk_buffer_micro_usdc: opportunity.risk_buffer_micro_usdc,
      },
      now_ms: nowMs,
    });
    const record = {
      version: 1,
      record_version: 1,
      owner_commitment: ownerCommitment,
      position,
      opportunity: publicOpportunity(opportunity),
      monitoring_context: normalizedMonitoring.context,
      value_ledger: ledger,
      value_evidence: {
        entry: { status: "pending_exact_receipts" },
        funding: {
          status: "pending_authoritative_settlement_history",
          cursor_ms_by_venue: {
            [position.long_venue_id]: nowMs,
            [position.short_venue_id]: nowMs,
          },
        },
        exit: { status: "pending_exact_receipts" },
        costs_complete: false,
      },
      ...(normalizedPilot.value ? { qualification_pilot: normalizedPilot.value } : {}),
      lifecycle_events: [],
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    const stored = await state.putCarryPositionRecord(record, { expected_version: null });
    return publicStoredResult(stored);
  } catch (error) {
    return denied(typeof error?.code === "string" ? error.code : "carry_position_invalid");
  }
}

function validateCreationOpportunity(positionInput, opportunity, nowMs, qualificationPilot = null) {
  if (!opportunity || opportunity.version !== 1 || opportunity.eligible !== true || !Array.isArray(opportunity.reasons) || opportunity.reasons.length > 0) return "carry_opportunity_not_eligible";
  if (opportunity.live_creation_ready !== true && qualificationPilot === null) return "carry_live_creation_not_qualified";
  if (opportunity.all_venues_ready !== true) return "carry_venue_accounts_not_ready";
  if (opportunity.asset !== positionInput?.asset
    || opportunity.long_venue_id !== positionInput?.long_venue_id
    || opportunity.short_venue_id !== positionInput?.short_venue_id
    || opportunity.long_venue_id === opportunity.short_venue_id) return "carry_opportunity_position_mismatch";
  if (opportunity.notional_micro_usdc !== positionInput?.target_notional_micro_usdc) return "carry_opportunity_notional_mismatch";
  const maxAgeMs = positionInput?.risk_mandate?.max_data_age_ms;
  if (!Number.isInteger(opportunity.checked_at_ms)
    || !Number.isInteger(maxAgeMs)
    || maxAgeMs <= 0
    || opportunity.checked_at_ms > nowMs + 5_000
    || nowMs - opportunity.checked_at_ms > maxAgeMs) return "carry_opportunity_stale";
  const minRunwayMs = positionInput?.risk_mandate?.min_margin_runway_ms;
  if (!Number.isInteger(minRunwayMs)
    || !Number.isInteger(opportunity.long_margin_runway_ms)
    || !Number.isInteger(opportunity.short_margin_runway_ms)
    || opportunity.long_margin_runway_ms < minRunwayMs
    || opportunity.short_margin_runway_ms < minRunwayMs) return "carry_margin_runway_insufficient";
  const modeledAmounts = [
    opportunity.notional_micro_usdc,
    opportunity.capital_committed_micro_usdc,
    opportunity.projected_gross_funding_micro_usdc,
    opportunity.projected_trading_cost_micro_usdc,
    opportunity.projected_capital_cost_micro_usdc,
    opportunity.risk_buffer_micro_usdc,
  ];
  if (!modeledAmounts.every((value) => Number.isInteger(value) && value >= 0)
    || !Number.isInteger(opportunity.horizon_ms)
    || opportunity.horizon_ms <= 0
    || !Number.isInteger(opportunity.break_even_ms)
    || opportunity.break_even_ms < 0
    || !Number.isInteger(opportunity.projected_net_value_micro_usdc)
    || opportunity.projected_net_value_micro_usdc <= 0
    || !Number.isInteger(opportunity.projected_net_value_bps)
    || opportunity.projected_net_value_bps < positionInput?.risk_mandate?.min_expected_net_benefit_bps
    || opportunity.break_even_ms > opportunity.horizon_ms) return "carry_expected_value_insufficient";
  return null;
}

function normalizeQualificationPilot({ qualificationPilot, positionInput, opportunity, env }) {
  if (qualificationPilot === null || qualificationPilot === undefined) return { ok: true, value: null };
  if (qualificationPilot?.enabled !== true) return { ok: false, error: "carry_qualification_pilot_invalid" };
  if (env.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED !== "true") return { ok: false, error: "carry_qualification_pilot_disabled" };
  const candidate = String(qualificationPilot.candidate_venue_id || "");
  if (opportunity?.qualification_pilot_ready !== true
    || opportunity?.qualification_pilot_candidate_venue_id !== candidate
    || ![positionInput?.long_venue_id, positionInput?.short_venue_id].includes(candidate)) {
    return { ok: false, error: "carry_qualification_pilot_not_ready" };
  }
  const cap = boundedPilotNotional(env.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC);
  if (!Number.isSafeInteger(positionInput?.target_notional_micro_usdc) || positionInput.target_notional_micro_usdc > cap) {
    return { ok: false, error: "carry_qualification_pilot_notional_exceeds_cap" };
  }
  return {
    ok: true,
    value: Object.freeze({
      version: 1,
      status: "pending",
      candidate_venue_id: candidate,
      max_notional_micro_usdc: cap,
      requires_separate_live_confirmation: true,
    }),
  };
}

function boundedPilotNotional(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) ? Math.max(5_000_000, Math.min(100_000_000, parsed)) : 25_000_000;
}

export async function advanceStoredCarryPosition({ state, position_id: positionId, owner_commitment: ownerCommitment, event, now_ms: nowMs = Date.now() }) {
  const record = await ownedRecord(state, positionId, ownerCommitment);
  if (!record.ok) return record;
  const advanced = advanceCarryPosition({ position: record.record.position, event, now_ms: nowMs });
  if (!advanced.ok) return advanced;
  if (advanced.duplicate) return { ok: true, duplicate: true, record: publicRecord(record.record) };
  const recordedEvent = { ...event, recorded_at_ms: nowMs };
  const next = {
    ...record.record,
    position: advanced.position,
    lifecycle_events: [...record.record.lifecycle_events, recordedEvent].slice(-256),
    ...(event.type === "observation" ? { latest_observation: publicObservation(recordedEvent) } : {}),
    ...(event.type === "exit_reconciled" ? { final_reconciliation_evidence: publicReconciliationEvidence(event, nowMs) } : {}),
    updated_at: new Date(nowMs).toISOString(),
  };
  return storeUpdate(state, next, record.record.record_version);
}

export async function appendStoredCarryValueEntry({ state, position_id: positionId, owner_commitment: ownerCommitment, entry, now_ms: nowMs = Date.now() }) {
  const record = await ownedRecord(state, positionId, ownerCommitment);
  if (!record.ok) return record;
  const appended = appendCarryValueLedgerEntry({ ledger: record.record.value_ledger, entry, now_ms: nowMs });
  if (!appended.ok) return appended;
  if (appended.duplicate) return { ok: true, duplicate: true, record: publicRecord(record.record) };
  return storeUpdate(state, {
    ...record.record,
    value_ledger: appended.ledger,
    updated_at: new Date(nowMs).toISOString(),
  }, record.record.record_version);
}

export async function finalizeStoredCarryValueLedger({ state, position_id: positionId, owner_commitment: ownerCommitment, evidence, now_ms: nowMs = Date.now() }) {
  const record = await ownedRecord(state, positionId, ownerCommitment);
  if (!record.ok) return record;
  if (record.record.position.status !== "reconciled") return denied("carry_position_not_reconciled");
  const finalized = finalizeCarryValueLedger({ ledger: record.record.value_ledger, evidence, now_ms: nowMs });
  if (!finalized.ok) return finalized;
  return storeUpdate(state, {
    ...record.record,
    value_ledger: finalized.ledger,
    updated_at: new Date(nowMs).toISOString(),
  }, record.record.record_version);
}

export async function getStoredCarryPosition({ state, position_id: positionId, owner_commitment: ownerCommitment }) {
  const owned = await ownedRecord(state, positionId, ownerCommitment);
  return owned.ok ? { ok: true, record: publicRecord(owned.record) } : owned;
}

export async function listStoredCarryPositions({ state, owner_commitment: ownerCommitment, status, limit = 100 }) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const records = await state.listCarryPositionRecords({ owner_commitment: ownerCommitment, status, limit });
  return { ok: true, records: records.map(publicRecord) };
}

export async function runCarryMonitoringTick({
  state,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  readFundingSettlements,
  preflight = preflightCarryPair,
  now_ms: nowMs = Date.now(),
}) {
  const records = (await Promise.all(["active", "rebalancing"].map((status) =>
    state.listCarryPositionRecords({ status, limit: 500 })
  ))).flat();
  const results = [];
  for (const record of records) {
    if (!record.monitoring_context?.venue_access) {
      results.push({ position_id: record.position?.position_id, ok: false, error: "carry_monitor_context_missing" });
      continue;
    }
    const result = await observeStoredCarryPosition({
      state,
      owner_commitment: record.owner_commitment,
      position_id: record.position.position_id,
      venue_access: record.monitoring_context.venue_access,
      recipient,
      verifyOrder,
      readHyperliquidSnapshot,
      readHyperliquidCarryMetrics,
      readFundingSettlements,
      preflight,
      now_ms: nowMs,
    });
    results.push({ position_id: record.position.position_id, ...result });
  }
  return { ok: results.every((result) => result.ok), checked: records.length, results };
}

export function startCarryMonitoringLoop({
  state,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  readFundingSettlements,
  preflight = preflightCarryPair,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  if (String(env.PRIVATE_AGENT_CARRY_MONITOR_ENABLED ?? "true").toLowerCase() === "false") return { stop() {} };
  const intervalMs = boundedMs(env.PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS, 5_000, 300_000, 30_000);
  const initialDelayMs = boundedMs(env.PRIVATE_AGENT_CARRY_MONITOR_INITIAL_DELAY_MS, 0, 60_000, 5_000);
  let timer = null;
  let stopped = false;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runCarryMonitoringTick({
        state,
        recipient,
        verifyOrder,
        readHyperliquidSnapshot,
        readHyperliquidCarryMetrics,
        readFundingSettlements,
        preflight,
        now_ms: now(),
      }).catch(() => null);
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };
  schedule(initialDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function observeStoredCarryPosition({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  venue_access: venueAccess,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  readFundingSettlements,
  preflight = preflightCarryPair,
  now_ms: nowMs = Date.now(),
}) {
  const owned = await ownedRecord(state, positionId, ownerCommitment);
  if (!owned.ok) return owned;
  const position = owned.record.position;
  if (position.status !== "active" && position.status !== "rebalancing") {
    return denied("carry_position_not_monitorable");
  }
  if (!venueAccess?.[position.long_venue_id] || !venueAccess?.[position.short_venue_id]) {
    return denied("carry_monitor_access_missing");
  }
  const sequence = position.last_event_sequence + 1;
  const eventBase = `carry:monitor:${digest(`${position.position_id}:${sequence}`).slice(0, 32)}`;
  let observation;
  try {
    observation = await preflight({
      body: {
        version: 1,
        phase: "monitoring",
        owner_commitment: ownerCommitment,
        work_order_commitment: `carry_monitor_${digest(`${position.position_id}:${sequence}:${nowMs}`).slice(0, 32)}`,
        asset: position.asset,
        long_venue_id: position.long_venue_id,
        short_venue_id: position.short_venue_id,
        notional_usd: String(position.target_notional_micro_usdc / 1_000_000),
        horizon_days: String(Math.max(1, Math.ceil(Number(owned.record.opportunity?.horizon_ms || 86_400_000) / 86_400_000))),
        venue_access: venueAccess,
      },
      recipient,
      state,
      verifyOrder,
      readHyperliquidSnapshot,
      readHyperliquidCarryMetrics,
      now: () => nowMs,
    });
  } catch (error) {
    const frozen = await advanceStoredCarryPosition({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      event: {
        version: 1,
        event_id: `${eventBase}:unavailable`,
        sequence,
        type: "observation_unavailable",
        reason: safeError(error),
      },
      now_ms: nowMs,
    });
    return frozen.ok ? { ...frozen, observation_ok: false, observation: null } : frozen;
  }
  const opportunity = observation?.economic_opportunity || {};
  const runways = Object.fromEntries((observation?.margin_runways || []).map((runway) => [runway.venue_id, runway.runway_ms]));
  const advanced = await advanceStoredCarryPosition({
    state,
    position_id: positionId,
    owner_commitment: ownerCommitment,
    event: {
      version: 1,
      event_id: `${eventBase}:verified`,
      sequence,
      type: "observation",
      as_of_ms: opportunity.checked_at_ms,
      expected_net_value_bps: opportunity.projected_net_value_bps,
      margin_runway_ms_by_venue: runways,
      qualification_reasons: observation.qualification_reasons,
      transaction_broadcast: false,
    },
    now_ms: nowMs,
  });
  if (!advanced.ok || typeof readFundingSettlements !== "function") {
    return advanced.ok ? { ...advanced, observation_ok: true, observation } : advanced;
  }
  const funding = await collectStoredCarryFundingEvidence({
    state,
    ownerCommitment,
    positionId,
    venueAccess,
    recipient,
    readFundingSettlements,
    nowMs,
  });
  return { ...advanced, record: funding.record || advanced.record, observation_ok: true, observation, funding: funding.summary };
}

export async function collectStoredCarryFundingEvidence({ state, ownerCommitment, positionId, venueAccess, recipient, readFundingSettlements, nowMs, final = false }) {
  const initial = await state.getCarryPositionRecord(positionId);
  if (!initial) return { record: null, summary: { status: "position_missing" } };
  const venues = [initial.position.long_venue_id, initial.position.short_venue_id];
  const cursors = { ...(initial.value_evidence?.funding?.cursor_ms_by_venue || {}) };
  const venueStatus = {};
  for (const venueId of venues) {
    let cursor = Number(cursors[venueId] || initial.position.created_at_ms || nowMs);
    let caughtUp = true;
    try {
      for (let page = 0; cursor < nowMs && page < 16; page += 1) {
        const end = Math.min(nowMs, cursor + 7 * 86_400_000);
        const access = venueAccess[venueId];
        const rows = await readFundingSettlements({
          body: {
            ...access,
            venue_id: venueId,
            asset: initial.position.asset,
            start_time_ms: cursor,
            end_time_ms: end,
          },
          recipient,
          state,
        });
        for (const row of Array.isArray(rows) ? rows : []) {
          const amountMicro = signedQuoteMicro(row.amount_quote);
          const quoteAsset = String(row.quote_asset || "").toUpperCase();
          const occurredAt = Number(row.occurred_at_ms);
          if (amountMicro === null
            || !new Set(["USD", "USDC", "USDT"]).has(quoteAsset)
            || !Number.isSafeInteger(occurredAt)
            || occurredAt < cursor
            || occurredAt > end) throw new Error("funding_settlement_evidence_invalid");
          const appended = await appendFundingEntryWithRetry({
            state,
            ownerCommitment,
            positionId,
            venueId,
            row,
            amountMicro,
            nowMs,
          });
          if (!appended) throw new Error("funding_settlement_persistence_failed");
        }
        cursor = end;
      }
      caughtUp = cursor >= nowMs;
      if (caughtUp) cursors[venueId] = nowMs;
      venueStatus[venueId] = caughtUp ? "current" : "history_backfill_pending";
    } catch (error) {
      venueStatus[venueId] = safeError(error);
    }
  }
  let storedRecord = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) break;
    const allCurrent = venues.every((venueId) => venueStatus[venueId] === "current");
    const stored = await state.putCarryPositionRecord({
      ...current,
      value_evidence: {
        ...(current.value_evidence || {}),
        funding: {
          status: allCurrent && final && current.position.status === "reconciled"
            ? "complete_through_exit"
            : allCurrent ? "current" : "pending_authoritative_settlement_history",
          cursor_ms_by_venue: cursors,
          venue_status: venueStatus,
          checked_at_ms: nowMs,
        },
        costs_complete: false,
      },
    }, { expected_version: current.record_version });
    if (stored.ok) { storedRecord = stored.record; break; }
  }
  return {
    record: storedRecord ? publicRecord(storedRecord) : null,
    summary: { status: venues.every((venueId) => venueStatus[venueId] === "current") ? "current" : "pending", venue_status: venueStatus },
  };
}

async function appendFundingEntryWithRetry({ state, ownerCommitment, positionId, venueId, row, amountMicro, nowMs }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) return false;
    const settlementId = digest(`${venueId}:${row.settlement_id}:${row.occurred_at_ms}:${row.amount_quote}`);
    const result = await appendStoredCarryValueEntry({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      entry: {
        version: 1,
        entry_id: `carry:value:funding:${settlementId.slice(0, 32)}`,
        sequence: current.value_ledger.last_sequence + 1,
        entry_type: "funding",
        direction: amountMicro < 0 ? "debit" : "credit",
        amount_micro_usdc: Math.abs(amountMicro),
        venue_id: venueId,
        leg_id: null,
        occurred_at_ms: Number(row.occurred_at_ms),
        evidence_commitment: `carry:value:funding:evidence:${settlementId.slice(0, 32)}`,
      },
      now_ms: nowMs,
    });
    if (result.ok) return true;
    if (result.error !== "carry_record_version_conflict") return false;
  }
  return false;
}

async function ownedRecord(state, positionId, ownerCommitment) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const record = await state.getCarryPositionRecord(String(positionId || ""));
  if (!record) return denied("carry_position_not_found");
  if (record.owner_commitment !== ownerCommitment) return denied("carry_position_owner_mismatch");
  return { ok: true, record };
}

async function storeUpdate(state, record, expectedVersion) {
  const stored = await state.putCarryPositionRecord(record, { expected_version: expectedVersion });
  return stored.ok
    ? { ok: true, duplicate: false, record: publicRecord(stored.record) }
    : publicStoredResult(stored);
}

function normalizeMonitoringContext(value, positionInput, ownerCommitment) {
  if (!value || value.version !== 1 || !value.venue_access || typeof value.venue_access !== "object") {
    return denied("carry_monitor_context_required");
  }
  const selected = [positionInput?.long_venue_id, positionInput?.short_venue_id];
  const venueAccess = {};
  for (const venueId of selected) {
    const access = value.venue_access[venueId];
    if (!access || access.status !== "ready" || access.owner_commitment !== ownerCommitment) {
      return denied("carry_monitor_access_invalid");
    }
    venueAccess[venueId] = {
      status: "ready",
      owner_commitment: ownerCommitment,
      account_commitment: access.account_commitment,
      vault_commitment: access.vault_commitment,
      encrypted_vault_commitment: access.encrypted_vault_commitment,
      policy_commitment: access.policy_commitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
    };
  }
  return { ok: true, context: { version: 1, venue_access: venueAccess } };
}

function publicStoredResult(stored) {
  if (!stored?.record) return stored;
  return { ...stored, record: publicRecord(stored.record) };
}

function publicRecord(record) {
  const { monitoring_context: _monitoringContext, ...safe } = record;
  return JSON.parse(JSON.stringify(safe));
}

function publicOpportunity(value) {
  return Object.freeze({
    version: 1,
    eligible: value.eligible === true,
    reasons: Array.isArray(value.reasons) ? [...value.reasons] : [],
    asset: String(value.asset || ""),
    long_venue_id: String(value.long_venue_id || ""),
    short_venue_id: String(value.short_venue_id || ""),
    notional_micro_usdc: value.notional_micro_usdc,
    capital_committed_micro_usdc: value.capital_committed_micro_usdc,
    horizon_ms: value.horizon_ms,
    projected_gross_funding_micro_usdc: value.projected_gross_funding_micro_usdc,
    projected_trading_cost_micro_usdc: value.projected_trading_cost_micro_usdc,
    projected_capital_cost_micro_usdc: value.projected_capital_cost_micro_usdc,
    risk_buffer_micro_usdc: value.risk_buffer_micro_usdc,
    projected_net_value_micro_usdc: value.projected_net_value_micro_usdc,
    projected_net_value_bps: value.projected_net_value_bps,
    break_even_ms: value.break_even_ms,
    checked_at_ms: value.checked_at_ms,
    all_venues_ready: value.all_venues_ready === true,
    live_creation_ready: value.live_creation_ready === true,
    long_margin_runway_ms: value.long_margin_runway_ms,
    short_margin_runway_ms: value.short_margin_runway_ms,
  });
}

function publicObservation(event) {
  return Object.freeze({
    as_of_ms: event.as_of_ms,
    expected_net_value_bps: event.expected_net_value_bps,
    margin_runway_ms_by_venue: { ...(event.margin_runway_ms_by_venue || {}) },
    qualification_reasons: Array.isArray(event.qualification_reasons) ? [...event.qualification_reasons] : [],
    transaction_broadcast: false,
    recorded_at_ms: event.recorded_at_ms,
  });
}

function publicReconciliationEvidence(event, nowMs) {
  return Object.freeze({
    gross_exposure_micro_usdc: event.gross_exposure_micro_usdc,
    open_order_count: event.open_order_count,
    account_state_checked: event.account_state_checked === true,
    transaction_broadcast: false,
    reconciliation_commitment: String(event.reconciliation_commitment || ""),
    checked_at_ms: Number.isSafeInteger(event.checked_at_ms) ? event.checked_at_ms : nowMs,
  });
}

function denied(error) {
  return { ok: false, error };
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeError(error) {
  const value = String(error?.code || error?.message || "carry_monitor_unavailable");
  return /^[a-z0-9_:-]{3,120}$/.test(value) ? value : "carry_monitor_unavailable";
}

function signedQuoteMicro(value) {
  const text = String(value ?? "").trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = String(match[3] || "").padEnd(6, "0");
  let amount = BigInt(match[2]) * 1_000_000n + BigInt(fraction.slice(0, 6) || "0");
  if (fraction[6] >= "5") amount += 1n;
  if (match[1] === "-") amount = -amount;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(amount);
}

function boundedMs(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
